import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { platform, arch, cpus, totalmem } from "node:os";
test("R6 SDK to Kafka/ClickHouse, versioned page operations and shared quality context", async ({
  page,
  request,
}, info) => {
  test.setTimeout(180000);
  const auth = await (
    await request.post("/api/auth/login", {
      data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
    })
  ).json();
  const headers = { authorization: `Bearer ${auth.accessToken}` };
  const created = await request.post("/api/projects", {
    headers,
    data: {
      name: `R6 ${info.project.name} ${randomUUID()}`,
      timezone: "America/New_York",
      origins: ["http://127.0.0.1:4174"],
    },
  });
  expect(created.status()).toBe(201);
  const project = await created.json(),
    root = `/api/projects/${project.id}`;
  const post = async (path: string, data: unknown) => {
    const r = await request.post(root + path, { headers, data });
    expect(r.status(), path).toBe(201);
    return r.json();
  };
  const module = await post("/modules", { moduleKey: "r6_module", name: "R6 module" });
  const configured = await post("/page-definitions", {
    moduleId: module.id,
    name: "R6 page A",
    pageRoute: "/r6-a",
    templateKey: "task_operation",
    isCore: true,
    criticalityWeight: 1,
    expectedFrequency: "daily",
    effectiveFrom: new Date(Date.now() - 7200000).toISOString(),
  });
  await post("/features", {
    featureKey: "r6_task",
    name: "R6 page task",
    featureType: "action",
    pageDefinitionId: configured.id,
    operationLifecycleEnabled: true,
    isKeyTask: true,
  });
  const workflow = await post("/workflow-definitions", {
    moduleId: module.id,
    workflowKey: "r6_workflow",
    name: "R6 linked workflow",
    startPolicy: "explicit_sdk",
    timeoutSeconds: 600,
    terminalPolicy: {
      completedStepKey: "done",
      failedStepKey: null,
      canceledStepKey: null,
      timeoutState: "approximate_abandoned",
    },
    steps: [
      {
        stepKey: "start",
        name: "Start",
        stepOrder: 1,
        triggerKind: "explicit_sdk",
        triggerConfig: {},
      },
      {
        stepKey: "done",
        name: "Done",
        stepOrder: 2,
        triggerKind: "operation_terminal",
        triggerConfig: { operationKey: "r6_task", state: "succeeded" },
      },
    ],
  });
  await post(`/workflow-definitions/${workflow.id}/activate`, {
    versionId: workflow.latestVersion.id,
  });
  const draftResponse = await request.post(root + "/metrics/versions", {
    headers,
    data: { type: "operational" },
  });
  expect(draftResponse.status()).toBe(201);
  const draft = await draftResponse.json();
  expect(
    (
      await request.post(root + `/metrics/versions/${draft.id}/page-usage-facts`, {
        headers,
        data: {},
      })
    ).status(),
  ).toBe(201);
  const keys = [
    "pv",
    "uv",
    "dau",
    "wau",
    "mau",
    "vv",
    "avg_usage_duration",
    "hourly_distribution",
    "bounce_rate",
  ];
  const bindings = await request.put(
    root + `/metrics/versions/${draft.id}/page-bindings`,
    { headers, data: { metricKeys: keys } },
  );
  expect(bindings.status()).toBe(200);
  await page.route("**/r6-index.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: readFileSync("packages/web-tracker/dist/index.js", "utf8"),
    }),
  );
  await page.route("**/r6-a", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><div>R6 controlled page</div>",
    }),
  );
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.method() === "POST" && r.postData())
      sent.push(r.postData()!);
  });
  const from = new Date(Date.now() - 3700000).toISOString();
  await page.goto("http://127.0.0.1:4174/r6-a");
  await page.evaluate(async (appId) => {
    const modulePath = "/r6-index.js";
    const { createTracker } = await import(modulePath);
    let now = Date.now() - 3600000;
    const runtime = {
      window,
      document,
      navigator: { userAgent: navigator.userAgent, sendBeacon: () => false },
      storage: localStorage,
      fetch: window.fetch.bind(window),
      crypto,
      now: () => now,
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
    };
    for (let i = 0; i < 3; i++) {
      history.replaceState({}, "", "/r6-a");
      const a = createTracker({
        appId,
        env: "dev",
        release: "r6-browser",
        endpoint: location.origin + "/v1/events",
        runtime,
      });
      now += 1000;
      history.pushState({}, "", "/r6-b");
      now += 1000;
      a.destroy();
      await a.flush();
      history.pushState({}, "", "/r6-a");
      const b = createTracker({
        appId,
        env: "dev",
        release: "r6-browser",
        endpoint: location.origin + "/v1/events",
        initialUserId: "u_r6_fixture",
        runtime,
      });
      now += 2000;
      b.destroy();
      await b.flush();
    }
  }, project.appId);
  const to = new Date(Date.now() - 1).toISOString();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  // Actual transport retry, same event IDs: must not increase PV/duration.
  const retry = await request.post("http://127.0.0.1:4174/v1/events", {
    headers: { origin: "http://127.0.0.1:4174" },
    data: JSON.parse(sent[0]!),
  });
  expect(retry.status()).toBe(202);
  const q = new URLSearchParams({
    env: "dev",
    range: "custom",
    from,
    to,
    pageRoute: "/r6-a",
    versionId: draft.id,
  });
  const endpoint = root + "/page-operations?";
  let result: {
    cards: { key: string; value: number | null }[];
    identity: { identified: number; anonymous: number };
    diagnostics: { coverage: number | null };
  };
  await expect
    .poll(
      async () => {
        const r = await request.get(endpoint + q, { headers });
        expect(r.status()).toBe(200);
        result = await r.json();
        if (result.diagnostics.coverage !== 1) return null;
        return result.cards.find(
          (c: { key: string; value: number | null }) => c.key === "pv",
        ).value;
      },
      { timeout: 45000 },
    )
    .toBe(6);
  expect(
    result.cards.find((c: { key: string; value: number | null }) => c.key === "uv")
      .value,
  ).toBe(2);
  expect(
    result.cards.find((c: { key: string; value: number | null }) => c.key === "vv")
      .value,
  ).toBe(6);
  expect(
    result.cards.find(
      (c: { key: string; value: number | null }) => c.key === "bounce_rate",
    ).value,
  ).toBe(0.5);
  expect(
    result.cards.find(
      (c: { key: string; value: number | null }) => c.key === "avg_usage_duration",
    ).value,
  ).toBe(4500);
  expect(result.identity).toMatchObject({ identified: 1, anonymous: 1 });
  expect(result.diagnostics.coverage).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(
    /u_r6_fixture|user_id|device_id|session_id|payload_json/,
  );
  const empty = await (
    await request.get(
      endpoint +
        new URLSearchParams({ ...Object.fromEntries(q), pageRoute: "/absent" }),
      { headers },
    )
  ).json();
  expect(empty.dataState).toBe("no_data");
  const prod = new URLSearchParams(q);
  prod.set("env", "prod");
  expect(
    (await (await request.get(endpoint + prod, { headers })).json()).dataState,
  ).toBe("no_data");
  expect(
    (await request.get(endpoint + q + "&token=private", { headers })).status(),
  ).toBe(400);
  const foreignVersion = new URLSearchParams(q);
  foreignVersion.set("versionId", randomUUID());
  expect((await request.get(endpoint + foreignVersion, { headers })).status()).toBe(
    404,
  );
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
  expect(
    (
      await request.put(root + `/metrics/versions/${draft.id}/page-bindings`, {
        headers: vh,
        data: { metricKeys: ["pv"] },
      })
    ).status(),
  ).toBe(403);
  const times: number[] = [];
  let stats;
  for (let i = 0; i < 25; i++) {
    const t = performance.now();
    const r = await request.get(endpoint + q, { headers: vh });
    expect(r.status()).toBe(200);
    const body = await r.json();
    stats = body.statistics;
    expect(stats.usageClickHouseQueries).toBe(1);
    expect(stats.clickHouseQueries).toBe(3);
    expect(stats.rowsRead).toBeLessThanOrEqual(1000000);
    if (i >= 5) times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
  expect(p95).toBeLessThanOrEqual(2000);
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("viewer@example.invalid");
  await page.getByLabel("密码").fill("LocalViewer-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/projects/);
  const url = `/projects/${project.id}/pages?${q}&tab=operations`;
  await page.goto(url);
  await expect(page.getByTestId("usage-pv").locator("strong")).toHaveText("6");
  await expect(
    page.getByRole("link", { name: "配置页面、目标与展示绑定" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "R6 linked workflow v1" }),
  ).toBeVisible();
  await expect(page.getByText("R6 page A · /r6-a")).toBeVisible();
  await page.getByRole("button", { name: "质量分析", exact: true }).click();
  await expect(page.getByLabel("页面路径", { exact: true })).toHaveValue("/r6-a");
  await expect(page).toHaveURL(/env=dev/);
  await page.getByRole("button", { name: "运营分析", exact: true }).click();
  await expect(page.getByTestId("usage-pv").locator("strong")).toHaveText("6");
  await page.reload();
  await expect(page.getByLabel("页面路径", { exact: true })).toHaveValue("/r6-a");
  await page.getByLabel("页面路径", { exact: true }).selectOption("/r6-b");
  await page.getByLabel("页面路径", { exact: true }).selectOption("/r6-a");
  await expect(page.getByTestId("usage-pv").locator("strong")).toHaveText("6");
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/r6-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        projectId: project.id,
        browser: info.project.name,
        realIntegration: "passed",
        fixture: {
          views: 9,
          selectedViews: 6,
          users: 2,
          vv: 6,
          bounce: 0.5,
          durationPerUser: 4500,
        },
        warmups: 5,
        sampleCount: 20,
        p95Ms: p95,
        statistics: stats,
        environment: {
          platform: platform(),
          arch: arch(),
          cpus: cpus().length,
          memoryBytes: totalmem(),
        },
        capacityPromise: false,
      },
      null,
      2,
    ),
  );
});
