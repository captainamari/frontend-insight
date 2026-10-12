import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

test("D2 console raw roundtrip, quality UI, permissions and bounded browser measurements", async ({
  page,
  request,
  browser,
}, info) => {
  test.setTimeout(180000);
  const auth = await (
    await request.post("/api/auth/login", {
      data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
    })
  ).json();
  const headers = { authorization: `Bearer ${auth.accessToken}` };
  const made = await request.post("/api/projects", {
    headers,
    data: {
      name: `D2 ${info.project.name} ${randomUUID()}`,
      timezone: "UTC",
      origins: ["http://127.0.0.1:4174"],
    },
  });
  expect(made.status()).toBe(201);
  const project = await made.json(),
    root = `/api/projects/${project.id}`;
  for (const file of ["index", "errors", "quality", "console"])
    await page.route(`**/d2/${file}.js`, (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: readFileSync(`packages/web-tracker/dist/${file}.js`, "utf8"),
      }),
    );
  await page.route("**/d2/fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><p>D2 synthetic fixture</p>",
    }),
  );
  type WireEvent = {
    eventId: string;
    event: string;
    payload: unknown;
    diagnostic?: {
      raw: {
        console: {
          parameters: unknown[];
          level: string;
          relativeMs: number;
          timestamp: number;
          sequence: number;
        }[];
        consoleCapture: { count: number; bytes: number; capturedAt: number };
        error: { message: string; stack: string };
      };
    };
  };
  const wire: WireEvent[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.postData())
      wire.push(...JSON.parse(r.postData()!).events);
  });
  const from = new Date(Date.now() - 1000).toISOString();
  await page.goto("http://127.0.0.1:4174/d2/fixture");
  const measurement = await page.evaluate(async (appId) => {
    const indexPath = "/d2/index.js",
      consolePath = "/d2/console.js",
      qualityPath = "/d2/quality.js";
    const { createTracker } = await import(indexPath),
      { createConsoleDiagnostics } = await import(consolePath),
      { createQualityCollectors } = await import(qualityPath);
    const tracker = createTracker({
      appId,
      env: "dev",
      release: "d2-browser",
      endpoint: location.origin + "/v1/events",
      errorDiagnostics: createConsoleDiagnostics({
        scope: { appId },
        levels: ["error", "warn", "log", "info", "debug"],
      }),
      quality: createQualityCollectors({ jsErrors: true }).factory,
      observability: { enabled: true, captureWebVitals: false },
    });
    console.error("FI_D2_SYNTHETIC console alone");
    await tracker.flush();
    const value = {
      nested: { token: "original" },
      url: "https://fixture.invalid/?token=synthetic",
      html: "<svg onload=alert(1)>文本",
    };
    console.info("FI_D2_SYNTHETIC order started\n第二行", value);
    value.nested.token = "changed";
    console.warn("FI_D2_SYNTHETIC inventory", { available: 2, requested: 3 });
    const parameter = new Error("FI_D2_SYNTHETIC parameter");
    parameter.stack =
      "Error: parameter\n at prepare (/assets/d2.js?token=synthetic:12:4)";
    console.error(parameter, null, undefined, 42n);
    const error = new TypeError("FI_D2_SYNTHETIC failure\n订单失败");
    error.stack =
      "TypeError: failure\n at placeOrder (/assets/d2.js?token=synthetic:20:6)";
    tracker.captureException(error);
    console.log("FI_D2_SYNTHETIC after first exception");
    tracker.captureException(new Error("FI_D2_SYNTHETIC second failure"));
    await tracker.flush();
    for (let i = 0; i < 55; i++) console.debug("FI_D2_SYNTHETIC evict", i);
    const cycle: Record<string, unknown> = { bigint: 9n };
    cycle.self = cycle;
    console.warn(cycle);
    console.log("FI_D2_SYNTHETIC long", "中\n\0".repeat(5000));
    tracker.captureException(new Error("FI_D2_SYNTHETIC bounded"));
    await tracker.flush();
    tracker.destroy();
    // Dedicated non-network collector, using a synthetic no-op console to isolate capture overhead.
    const host = { error() {}, warn() {}, log() {}, info() {}, debug() {} };
    const extract = createConsoleDiagnostics({ scope: { appId }, levels: ["warn"] });
    const scope = { appId };
    const runtime = { window: { console: host }, now: Date.now };
    const stop = extract.start(runtime, () => "pv_benchmark", scope);
    const p = performance;
    let resolution = Infinity;
    for (let i = 0; i < 1000; i++) {
      const a = p.now();
      let b = a;
      for (let j = 0; j < 1000 && b === a; j++) b = p.now();
      if (b > a) resolution = Math.min(resolution, b - a);
    }
    const sample = (run: () => void, count: number) => {
      const durations: number[] = [];
      for (let i = 0; i < count; i++) {
        const before = p.now();
        run();
        durations.push(p.now() - before);
      }
      durations.sort((a, b) => a - b);
      return {
        samples: count,
        p50Ms: durations[Math.floor(count * 0.5)],
        p95Ms: durations[Math.floor(count * 0.95)],
      };
    };
    const ordinary = sample(() => host.warn("ordinary", { key: "value" }), 1000);
    const complexObject = {
      items: Array.from({ length: 32 }, (_, i) => ({
        i,
        nested: { value: "中".repeat(100) },
      })),
    };
    const complex = sample(() => host.warn(complexObject), 1000);
    const highFrequency = sample(() => host.warn("high frequency", 1), 10000);
    const freeze = sample(() => extract.call(scope, error, "explicit"), 500);
    const bounded = extract.call(scope, error, "explicit").diagnostic;
    stop();
    return {
      ordinary,
      complex,
      highFrequency,
      freeze,
      timingResolutionMs: Number.isFinite(resolution) ? resolution : null,
      objectScale:
        "ordinary: 2 args/one-property object; complex: 32 items, each nested with 100 CJK chars; high frequency: 10000 calls; freeze: filled buffer + two-frame error",
      benchmark:
        "capture only, no-op original console, no network; zero samples mean below clock resolution",
      userAgent: navigator.userAgent,
      capacity: {
        count: bounded.raw.console.length,
        bytes: new TextEncoder().encode(JSON.stringify(bounded.raw.console)).length,
      },
    };
  }, project.appId);
  const sent = wire.filter((e) => e.event === "error");
  expect(sent).toHaveLength(3);
  const first = sent[0]!.diagnostic!,
    firstLogs = first.raw.console;
  expect(firstLogs.map((l) => l.level)).toEqual(["error", "info", "warn", "error"]);
  expect(firstLogs[1]!.parameters).toEqual([
    "FI_D2_SYNTHETIC order started\n第二行",
    {
      nested: { token: "original" },
      url: "https://fixture.invalid/?token=synthetic",
      html: "<svg onload=alert(1)>文本",
    },
  ]);
  expect(firstLogs[3]!.parameters).toEqual([
    expect.objectContaining({
      message: "FI_D2_SYNTHETIC parameter",
      stack: "Error: parameter\n at prepare (/assets/d2.js?token=synthetic:12:4)",
    }),
    null,
    "[undefined]",
    "[bigint:42]",
  ]);
  expect(firstLogs.map((l) => l.sequence)).toEqual([1, 2, 3, 4]);
  expect(firstLogs.every((l) => l.relativeMs <= 0)).toBe(true);
  expect(
    firstLogs.every(
      (l) => l.relativeMs === l.timestamp - first.raw.consoleCapture.capturedAt,
    ),
  ).toBe(true);
  expect(
    firstLogs.every((l, i) => i === 0 || l.relativeMs >= firstLogs[i - 1]!.relativeMs),
  ).toBe(true);
  expect(sent[1]!.diagnostic!.raw.console).toHaveLength(5);
  expect(sent[2]!.diagnostic!.raw.console.length).toBeLessThanOrEqual(50);
  expect(measurement.capacity.count).toBeLessThanOrEqual(50);
  expect(measurement.capacity.bytes).toBeLessThanOrEqual(24576);
  for (const event of sent) {
    const url = root + `/diagnostics/instances/${event.eventId}`;
    await expect
      .poll(async () => (await (await request.get(url, { headers })).json()).state, {
        timeout: 45000,
      })
      .toBe("ready");
    const response = await request.get(url, { headers });
    expect(response.headers()["cache-control"]).toContain("no-store");
    const detail = await response.json();
    expect(detail.diagnostic).toEqual(event.diagnostic);
    expect(detail.view.console.records).toEqual(event.diagnostic!.raw.console);
    if (event === sent[0])
      expect(detail.view.stack.frames[0]).toMatchObject({
        function: "placeOrder",
        file: "/assets/d2.js?token=synthetic",
        line: 20,
        column: 6,
      });
  }
  const to = new Date(Date.now() + 1000).toISOString();
  const query = new URLSearchParams({
    env: "dev",
    range: "custom",
    from,
    to,
    mode: "all",
  });
  const list = await request.get(root + "/observability/occurrences?" + query, {
    headers,
  });
  const listText = await list.text();
  expect(listText).not.toContain("FI_D2_SYNTHETIC");
  const rows = JSON.parse(listText).items;
  const item = rows.find((r: { eventId: string }) => r.eventId === sent[0]!.eventId);
  const viewer = await (
    await request.post("/api/auth/login", {
      data: { email: "viewer@example.invalid", password: "LocalViewer-1234" },
    })
  ).json();
  const vh = { authorization: `Bearer ${viewer.accessToken}` };
  await request.put(root + `/members/${viewer.user.userId}`, {
    headers,
    data: { role: "viewer" },
  });
  const detailUrl = root + `/diagnostics/instances/${sent[0]!.eventId}`;
  expect((await request.get(detailUrl, { headers: vh })).status()).toBe(403);
  expect((await request.get(detailUrl)).status()).toBe(401);
  const grantUrl = root + `/diagnostics/grants/${viewer.user.userId}`;
  await request.put(grantUrl, { headers, data: { read: true, export: false } });
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("viewer@example.invalid");
  await page.getByLabel("密码").fill("LocalViewer-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/projects/);
  await page.goto(`/projects/${project.id}/pages?` + query);
  await page
    .getByRole("button", {
      name: `打开诊断上下文 ${item.occurrenceId.slice(0, 8)}`,
      exact: true,
    })
    .click();
  await expect(page.getByTestId("diagnostic-message")).toHaveText(
    first.raw.error.message,
  );
  await expect(page.getByTestId("diagnostic-stack")).toHaveText(first.raw.error.stack);
  await expect(page.getByTestId("console-record")).toHaveCount(4);
  await expect(page.getByTestId("console-record").nth(1)).toContainText(
    '"token": "original"',
  );
  expect(await page.getByRole("dialog").locator("svg[onload]").count()).toBe(0);
  await page.getByTestId("console-record").nth(1).locator("summary").click();
  await expect(
    page.getByTestId("console-record").nth(1).locator("pre"),
  ).not.toBeVisible();
  await page.getByLabel("日志级别过滤").selectOption("debug");
  await expect(
    page.getByText("当前过滤条件下无结果；其他级别已有日志。"),
  ).toBeVisible();
  await page.getByLabel("日志级别过滤").selectOption("warn");
  await expect(page.getByTestId("console-record")).toHaveCount(1);
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
  await page
    .getByRole("button", { name: "重新授权并复制 console", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied))
    .toContain("inventory");
  const copied = JSON.parse(
    await page.evaluate(() => (window as unknown as { copied: string }).copied),
  );
  expect(copied.filter).toBe("warn");
  expect(copied.records).toEqual([firstLogs[2]]);
  await request.put(grantUrl, { headers, data: { read: false, export: false } });
  expect((await request.get(detailUrl, { headers: vh })).status()).toBe(403);
  await expect(page.getByTestId("console-record")).toHaveCount(0, { timeout: 7000 });
  await request.put(grantUrl, { headers, data: { read: true, export: false } });
  await page.getByRole("button", { name: "重新授权并读取", exact: true }).click();
  await expect(page.getByTestId("console-record")).toHaveCount(1);
  // Trigger revocation inside the next detail request, so copy must reauthorize instead of use cached text.
  await page.route(`**${detailUrl}`, async (route) => {
    await request.put(grantUrl, { headers, data: { read: false, export: false } });
    await route.continue();
  });
  await page.evaluate(() => {
    (window as unknown as { copied: string }).copied = "sentinel";
  });
  await page
    .getByRole("button", { name: "重新授权并复制 console", exact: true })
    .click();
  await expect(page.getByTestId("console-record")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { copied: string }).copied),
  ).toBe("sentinel");
  await page.unroute(`**${detailUrl}`);
  await request.put(grantUrl, { headers, data: { read: true, export: false } });
  await page.getByRole("button", { name: "重新授权并读取", exact: true }).click();
  await expect(page.getByTestId("console-record")).toHaveCount(1);
  await request.delete(root + `/members/${viewer.user.userId}`, { headers });
  expect((await request.get(detailUrl, { headers: vh })).status()).toBe(403);
  await expect(page.getByTestId("console-record")).toHaveCount(0, { timeout: 7000 });
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/d2-${info.project.name}.json`,
    JSON.stringify({
      testedCommit: process.env.GITHUB_SHA,
      browser: info.project.name,
      browserVersion: browser.version(),
      rawRoundTrips: sent.length,
      consoleUi: "passed",
      revokeAndCopy: "passed",
      memberRemoval: "passed",
      measurement,
    }),
  );
});
