import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

test("D4 engineer workflow: bounded search, group impact, stable links, download, live revocation", async ({
  page,
  request,
  context,
  browser,
}, info) => {
  test.setTimeout(180000);
  const admin = await (
    await request.post("/api/auth/login", {
      data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
    })
  ).json();
  const headers = { authorization: `Bearer ${admin.accessToken}` };
  const project = await (
    await request.post("/api/projects", {
      headers,
      data: {
        name: `D4 ${info.project.name} ${randomUUID()}`,
        timezone: "UTC",
        origins: ["http://127.0.0.1:4174"],
      },
    })
  ).json();
  const root = `/api/projects/${project.id}`;
  for (const file of ["index", "errors", "console", "requests"])
    await page.route(`**/d4-${file}.js`, (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: readFileSync(`packages/web-tracker/dist/${file}.js`, "utf8").replaceAll(
          '"./errors.js"',
          '"./d4-errors.js"',
        ),
      }),
    );
  // A browser harness uses built SDK modules. All data/API/UI services are real deployed containers.
  await page.route("**/d4-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><p>Synthetic D4 fixture</p>",
    }),
  );
  const wire: { eventId: string; diagnostic?: { raw: unknown }; release?: string }[] =
    [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.postData())
      wire.push(...JSON.parse(r.postData()!).events);
  });
  const from = new Date(Date.now() - 60000).toISOString();
  await page.goto("http://127.0.0.1:4174/d4-fixture");
  await page.evaluate(async (appId) => {
    const a = "/d4-index.js",
      b = "/d4-console.js";
    const { createTracker } = await import(a),
      { createConsoleDiagnostics } = await import(b);
    for (const release of ["d4-v1", "d4-v2"]) {
      const tracker = createTracker({
        appId,
        env: "dev",
        release,
        endpoint: location.origin + "/v1/events",
        errorDiagnostics: createConsoleDiagnostics({ scope: { appId } }),
      });
      console.warn("FI_D4_SYNTHETIC 前置日志", {
        html: "<img src=x onerror=alert(1)>",
        token: "synthetic",
      });
      for (let i = 0; i < 3; i++) {
        const error = new Error(
          "FI_D4_SYNTHETIC Token=查找\n中文😀 " + "x".repeat(300),
        );
        error.stack = "ODD STACK FI_D4_SYNTHETIC 不可解析";
        tracker.captureException(error);
      }
      await tracker.flush();
      tracker.destroy();
    }
  }, project.appId);
  const events = wire.filter((e) => e.diagnostic);
  expect(events).toHaveLength(6);
  const event = events[0]!.eventId,
    detailUrl = root + `/diagnostics/instances/${event}`,
    exportUrl = detailUrl + "/export";
  for (const e of events) {
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(root + `/diagnostics/instances/${e.eventId}`, {
                headers,
              })
            ).json()
          ).state,
        { timeout: 45000 },
      )
      .toBe("ready");
    expect(
      (
        await (
          await request.get(root + `/diagnostics/instances/${e.eventId}`, { headers })
        ).json()
      ).diagnostic,
    ).toEqual(e.diagnostic);
  }
  const to = new Date(Date.now() + 1000).toISOString();
  const scope = { env: "dev", from, to, category: "all" };
  const search = { ...scope, term: "token=查找\n中文😀", field: "message", limit: 1 };
  const foundResponse = await request.post(root + "/diagnostics/search", {
    headers,
    data: search,
  });
  expect(foundResponse.status()).toBe(201);
  expect(foundResponse.headers()["cache-control"]).toContain("no-store");
  const found = await foundResponse.json();
  expect(found.total).toBe(6);
  expect(found.items).toHaveLength(1);
  const second = await (
    await request.post(root + "/diagnostics/search", {
      headers,
      data: { ...search, asOf: found.asOf, offset: 1 },
    })
  ).json();
  expect(second.items[0].eventId).not.toBe(found.items[0].eventId);
  expect(
    (
      await (
        await request.post(root + "/diagnostics/search", {
          headers,
          data: { ...search, release: "d4-v1" },
        })
      ).json()
    ).total,
  ).toBe(3);
  expect(
    (
      await (
        await request.post(root + "/diagnostics/search", {
          headers,
          data: { ...search, env: "prod" },
        })
      ).json()
    ).total,
  ).toBe(0);
  expect(
    (
      await request.post(root + "/diagnostics/search", {
        headers,
        data: { ...search, from: new Date(Date.now() - 8 * 86400000).toISOString() },
      })
    ).status(),
  ).toBe(422);
  const query = new URLSearchParams({
    ...scope,
    range: "custom",
    mode: "all",
    limit: "1",
  });
  const list = await (
    await request.get(root + "/observability/occurrences?" + query, { headers })
  ).json();
  expect(list.totalOccurrences).toBe(6);
  expect(list.items).toHaveLength(1);
  const group = list.items[0].groupId;
  const impact = await (
    await request.get(
      root + `/observability/groups/${group}/impact?` + new URLSearchParams(scope),
      { headers },
    )
  ).json();
  expect(impact.selected.occurrences).toBe(6);
  expect(impact.releases.map((r: { occurrences: number }) => r.occurrences)).toEqual([
    3, 3,
  ]);
  for (const format of ["json", "text"]) {
    const response = await request.post(exportUrl, { headers, data: { format } });
    expect(response.status()).toBe(201);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["content-disposition"]).toContain("attachment");
    const text = await response.text();
    expect(text).toContain("FI_D4_SYNTHETIC");
    if (format === "json") {
      const document = JSON.parse(text);
      expect(document.evidence.diagnostic).toEqual(events[0]!.diagnostic);
      expect(JSON.parse(document.evidence.storedEnvelopeJson)).toEqual(
        events[0]!.diagnostic,
      );
    }
  }
  const viewer = await (
    await request.post("/api/auth/login", {
      data: { email: "viewer@example.invalid", password: "LocalViewer-1234" },
    })
  ).json();
  const vh = { authorization: `Bearer ${viewer.accessToken}` },
    grant = root + `/diagnostics/grants/${viewer.user.userId}`;
  // Cross-project first, then ordinary viewer, read-only, read+export.
  expect(
    (
      await request.post(root + "/diagnostics/search", { headers: vh, data: search })
    ).status(),
  ).toBe(403);
  await request.put(root + `/members/${viewer.user.userId}`, {
    headers,
    data: { role: "viewer" },
  });
  for (const [url, data] of [
    [root + "/diagnostics/search", search],
    [exportUrl, { format: "json" }],
  ] as const) {
    expect((await request.post(url, { headers: vh, data })).status()).toBe(403);
    expect((await request.post(url, { data })).status()).toBe(401);
  }
  await request.put(grant, { headers, data: { read: true, export: false } });
  expect(
    (
      await request.post(root + "/diagnostics/search", { headers: vh, data: search })
    ).status(),
  ).toBe(201);
  expect(
    (await request.post(exportUrl, { headers: vh, data: { format: "json" } })).status(),
  ).toBe(403);
  const stable = `/projects/${project.id}/diagnostics/${event}`;
  await page.goto(stable);
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await page.getByLabel("邮箱").fill("viewer@example.invalid");
  await page.getByLabel("密码").fill("LocalViewer-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByTestId("diagnostic-message")).toContainText("中文😀");
  await expect(page.getByRole("button", { name: "下载 JSON 证据" })).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId("diagnostic-stack")).toContainText("ODD STACK");
  await expect(
    page.getByText("无法解析栈格式，请查看原始编译栈。", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (s: string) => {
          (window as unknown as { copied: string }).copied = s;
        },
      },
    }),
  );
  await page.getByRole("button", { name: "复制稳定实例链接" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied))
    .toContain(stable);
  const newPage = await context.newPage();
  await newPage.goto(stable); // sessionStorage does not transfer: login then resolve again.
  if (newPage.url().includes("/login")) {
    await newPage.getByLabel("邮箱").fill("viewer@example.invalid");
    await newPage.getByLabel("密码").fill("LocalViewer-1234");
    await newPage.getByRole("button", { name: "登录", exact: true }).click();
  }
  await expect(newPage.getByTestId("diagnostic-message")).toContainText(
    "FI_D4_SYNTHETIC",
  );
  await newPage.close();
  await page.bringToFront();
  await request.put(grant, { headers, data: { read: true, export: true } });
  await page.getByRole("button", { name: "重新授权并读取", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载 JSON 证据" })).toBeEnabled();
  for (const format of ["JSON", "文本"]) {
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: `下载 ${format} 证据` }).click();
    const file = await downloaded;
    const path = await file.path();
    expect(readFileSync(path!, "utf8")).toContain("FI_D4_SYNTHETIC");
  }
  expect(await page.locator("img[onerror]").count()).toBe(0);
  await request.put(grant, { headers, data: { read: true, export: false } });
  await expect(page.getByRole("button", { name: "下载 JSON 证据" })).toBeDisabled({
    timeout: 7000,
  });
  expect(
    (await request.post(exportUrl, { headers: vh, data: { format: "json" } })).status(),
  ).toBe(403);
  expect((await request.get(exportUrl, { headers: vh })).status()).toBe(404);
  await page.goto(
    `/projects/${project.id}/pages?` +
      new URLSearchParams({ ...scope, range: "custom", mode: "all", groupId: group }),
  );
  await expect(page.getByRole("table", { name: "版本影响比较" })).toContainText(
    "d4-v1",
  );
  await page.getByLabel("搜索词", { exact: true }).fill("FI_D4_SYNTHETIC");
  await page.getByRole("button", { name: "搜索原文", exact: true }).click();
  await expect(page.getByRole("region", { name: "授权原文搜索" })).toContainText(
    "命中 6 个实例",
  );
  expect(page.url()).not.toContain("SYNTHETIC");
  await page
    .getByRole("button", { name: /查看命中实例/ })
    .first()
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  // A late authorized result must not repopulate a different environment.
  let releaseSearch!: () => void, searchSeen!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    searchSeen = resolve;
  });
  await page.route("**" + root + "/diagnostics/search", async (route) => {
    const response = await route.fetch();
    searchSeen();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.getByLabel("搜索词", { exact: true }).fill("FI_D4_SYNTHETIC");
  await page.getByRole("button", { name: "搜索原文", exact: true }).click();
  await seen;
  await page.getByLabel("项目环境", { exact: true }).selectOption("prod");
  await expect(page.getByLabel("搜索词", { exact: true })).toHaveValue("");
  releaseSearch();
  await page.unroute("**" + root + "/diagnostics/search");
  await expect(page.getByRole("button", { name: /查看命中实例/ })).toHaveCount(0);
  await page.goto(stable);
  await expect(page.getByTestId("diagnostic-message")).toBeVisible();
  await request.put(grant, { headers, data: { read: false, export: false } });
  await expect(page.getByTestId("diagnostic-message")).toHaveCount(0, {
    timeout: 7000,
  });
  expect(
    (
      await request.post(root + "/diagnostics/search", { headers: vh, data: search })
    ).status(),
  ).toBe(403);
  await request.put(grant, { headers, data: { read: true, export: true } });
  await request.delete(root + `/members/${viewer.user.userId}`, { headers });
  expect(
    (await request.post(exportUrl, { headers: vh, data: { format: "json" } })).status(),
  ).toBe(403);
  expect((await request.get(detailUrl, { headers: vh })).status()).toBe(403);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/d4-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA,
        browser: browser.version(),
        passed: true,
        events: 6,
        search: found.statistics,
        scopeCount: 6,
        formats: ["json", "text"],
        note: "Synthetic SDK → ingestion → Kafka → consumer → real API/UI; clipboard uses sink; actual file downloads verified",
      },
      null,
      2,
    ),
  );
});
