import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

test("R5-B real SDK categories, scoped occurrences, cursor and keyboard product flow", async ({
  page,
  request,
}, info) => {
  test.setTimeout(150000);
  const auth = await (
    await request.post("/api/auth/login", {
      data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
    })
  ).json();
  const headers = { authorization: `Bearer ${auth.accessToken}` };
  const made = await request.post("/api/projects", {
    headers,
    data: {
      name: `R5-B ${info.project.name} ${randomUUID()}`,
      timezone: "Asia/Shanghai",
      origins: ["http://127.0.0.1:4174"],
    },
  });
  expect(made.status()).toBe(201);
  const project = await made.json(),
    root = `/api/projects/${project.id}`;
  for (const [url, file] of [
    ["**/r5b-index.js", "index.js"],
    ["**/r5b-quality.js", "quality.js"],
  ])
    await page.route(url!, (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: readFileSync(`packages/web-tracker/dist/${file}`, "utf8"),
      }),
    );
  await page.route("**/r5b-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><div>FI_R5B_PRIVATE_DOM</div>",
    }),
  );
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.method() === "POST" && r.postData())
      sent.push(r.postData()!);
  });
  const from = new Date(Date.now() - 1000).toISOString();
  await page.goto("http://127.0.0.1:4174/r5b-fixture");
  await page.evaluate(async (appId) => {
    const a = "/r5b-index.js",
      b = "/r5b-quality.js";
    const { createTracker } = await import(a),
      { createQualityCollectors } = await import(b);
    const quality = createQualityCollectors({
      jsErrors: true,
      api: true,
      resources: true,
      breadcrumbs: true,
    });
    const tracker = createTracker({
      appId,
      env: "dev",
      release: "r5b-browser",
      endpoint: location.origin + "/v1/events",
      quality: quality.factory,
    });
    quality.action();
    for (let i = 0; i < 32; i++) {
      const error = new Error(
        "token=FI_R5B_PRIVATE_TOKEN person@example.invalid FI_R5B_PRIVATE_BUSINESS_ID FI_R5B_PRIVATE_DOM",
      );
      error.stack = `Error\n at https://assets.test/assets/bundle${i}.js?token=FI_R5B_PRIVATE_QUERY`;
      quality.captureException(
        error,
        ["vue", "react", "promise", "js", "other"][i % 5],
      );
    }
    const same = new Error("FI_R5B_PRIVATE_BODY");
    same.stack = "Error\n at https://assets.test/repeat.js";
    quality.captureException(same, "vue");
    quality.captureException(same, "vue");
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        promise: Promise.resolve(),
        reason: same,
      }),
    );
    await quality.observeApi("/api/orders/123456", async () => ({
      status: 500,
      headers: "FI_R5B_PRIVATE_HEADER",
      body: "FI_R5B_PRIVATE_BODY",
    }));
    await quality.observeApi("/api/orders/123456", async () => ({
      status: 200,
      body: "business rejected",
    }));
    try {
      await quality.observeResource(async () => {
        throw same;
      });
    } catch {
      /* expected */
    }
    await tracker.flush();
    tracker.destroy();
    await tracker.flush();
  }, project.appId);
  const to = new Date(Date.now() + 1).toISOString();
  const q = new URLSearchParams({ env: "dev", range: "custom", from, to, mode: "all" });
  const endpoint = root + "/observability/occurrences?";
  let result: {
    totalOccurrences: number;
    items: {
      occurrenceId: string;
      groupId: string;
      category: string;
      occurrences: number;
      context: { requestPath: string };
    }[];
    nextCursor: string | null;
    routes: string[];
  };
  await expect
    .poll(
      async () => {
        const r = await request.get(endpoint + q, { headers });
        expect(r.status()).toBe(200);
        result = await r.json();
        return result.totalOccurrences;
      },
      { timeout: 30000 },
    )
    .toBe(37);
  expect(sent.join("\n")).not.toMatch(/FI_R5B_PRIVATE|person@example|123456/);
  const serialized = JSON.stringify(result!);
  expect(serialized).not.toMatch(
    /FI_R5B_PRIVATE|person@example|123456|user_id|device_id|session_id/,
  );
  const queryTimes: number[] = [];
  let queryStatistics: unknown;
  for (let i = 0; i < 25; i++) {
    const started = performance.now();
    const r = await request.get(endpoint + q, { headers });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.statistics.clickHouseQueries).toBe(1);
    expect(body.statistics.rowsRead).toBeLessThanOrEqual(1000000);
    queryStatistics = body.statistics;
    if (i >= 5) queryTimes.push(performance.now() - started);
  }
  queryTimes.sort((a, b) => a - b);
  const queryP95Ms = queryTimes[Math.ceil(queryTimes.length * 0.95) - 1]!;
  expect(queryP95Ms).toBeLessThanOrEqual(2000);
  const ids = result!.items.map((e) => e.occurrenceId);
  expect(result!.nextCursor).toBeTruthy();
  const next = await request.get(
    endpoint + q + "&cursor=" + encodeURIComponent(result!.nextCursor!),
    { headers },
  );
  expect(next.status()).toBe(200);
  const second = await next.json();
  expect(
    new Set([
      ...ids,
      ...second.items.map((e: { occurrenceId: string }) => e.occurrenceId),
    ]).size,
  ).toBe(37);
  expect(second.nextCursor).toBeNull();
  expect(
    (
      await request.get(
        endpoint +
          q +
          "&cursor=" +
          encodeURIComponent(result!.nextCursor!) +
          "&category=vue",
        { headers },
      )
    ).status(),
  ).toBe(400);
  for (const category of [
    "api",
    "resource",
    "vue",
    "react",
    "promise",
    "js",
    "other",
  ]) {
    const r = await request.get(endpoint + q + "&category=" + category, { headers });
    expect(r.status()).toBe(200);
    const out = await r.json();
    expect(out.items.length).toBeGreaterThan(0);
    expect(out.items.every((e: { category: string }) => e.category === category)).toBe(
      true,
    );
    if (category === "api") {
      expect(out.totalOccurrences).toBe(1);
      expect(out.items[0].context.requestPath).toBe("/api/orders/:id");
    }
  }
  expect(
    (await request.get(endpoint + q + "&pageRoute=/empty", { headers })).status(),
  ).toBe(200);
  const viewer = await (
    await request.post("/api/auth/login", {
      data: { email: "viewer@example.invalid", password: "LocalViewer-1234" },
    })
  ).json();
  const vh = { authorization: `Bearer ${viewer.accessToken}` };
  expect((await request.get(endpoint + q, { headers: vh })).status()).toBe(403);
  expect(
    (
      await request.put(root + `/members/${viewer.user.userId}`, {
        headers,
        data: { role: "viewer" },
      })
    ).ok(),
  ).toBe(true);
  expect((await request.get(endpoint + q, { headers: vh })).status()).toBe(200);
  // Rejected payloads must not become occurrence context or reach the event topic.
  expect(sent.length).toBeGreaterThan(0);
  const original = JSON.parse(sent[0]!);
  for (const field of ["headers", "body", "query", "dom", "account"]) {
    const poison = structuredClone(original);
    poison.events = [
      { ...poison.events[0], payload: { [field]: "FI_R5B_PRIVATE_REJECTED" } },
    ];
    expect(
      (
        await request.post("http://127.0.0.1:4174/v1/events", {
          headers: { origin: "http://127.0.0.1:4174" },
          data: poison,
        })
      ).status(),
    ).toBe(400);
  }
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("viewer@example.invalid");
  await page.getByLabel("密码").fill("LocalViewer-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/projects/);
  const url =
    `/projects/${project.id}/pages?` +
    new URLSearchParams({ env: "dev", range: "custom", from, to });
  const start = performance.now();
  await page.goto(url);
  await expect(page.getByRole("table", { name: "质量错误实例" })).toBeVisible();
  const firstUsableMs = performance.now() - start;
  await expect(page.getByLabel("实例范围")).toHaveValue("latest");
  await page.getByLabel("查找路径").fill("r5b");
  await page.getByLabel("页面路径", { exact: true }).selectOption("/r5b-fixture");
  await page.getByLabel("错误类别").selectOption("vue");
  await expect(page).toHaveURL(/category=vue/);
  await page.reload();
  await expect(page.getByLabel("错误类别")).toHaveValue("vue");
  const button = page.getByRole("button", { name: /^打开复现条件/ }).first();
  await expect(button).toBeVisible();
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "安全复现条件" })).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("r5b-browser");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(button).toBeFocused();
  await page.getByLabel("错误类别").selectOption("all");
  await page.getByLabel("实例范围").selectOption("all");
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect(
    page.getByRole("button", { name: "下一页", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "第一页", exact: true }).click();
  await expect(page).not.toHaveURL(/cursor=/);
  await page.locator("summary").first().click();
  await page.getByRole("button", { name: "查看此组全部实例" }).first().click();
  await expect(page.getByRole("button", { name: "返回全部错误组" })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(
    /FI_R5B_PRIVATE|person@example|123456/,
  );
  await page.screenshot({
    path: `artifacts/r5b-${info.project.name}.png`,
    fullPage: true,
  });
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/r5b-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        projectId: project.id,
        browser: info.project.name,
        firstUsableMs,
        queryP95Ms,
        queryStatistics,
        sampleCount: queryTimes.length,
        occurrences: 37,
        categories: 7,
        cursor: "passed",
        keyboard: "passed",
        scopeAndViewer: "passed",
        privacy: "passed",
        realIntegration: "passed",
      },
      null,
      2,
    ),
  );
});
