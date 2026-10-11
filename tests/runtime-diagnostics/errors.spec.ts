import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

test("D1 real SDK → services → authorized API → quality UI with raw errors and revocation", async ({
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
  const made = await request.post("/api/projects", {
    headers,
    data: {
      name: `D1 ${info.project.name} ${randomUUID()}`,
      timezone: "UTC",
      origins: ["http://127.0.0.1:4174"],
    },
  });
  expect(made.status()).toBe(201);
  const project = await made.json(),
    root = `/api/projects/${project.id}`;
  for (const file of ["index", "errors", "quality"])
    await page.route(`**/d1-${file}.js`, (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: readFileSync(`packages/web-tracker/dist/${file}.js`, "utf8"),
      }),
    );
  await page.route("**/d1-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><p>D1 synthetic fixture</p><script src='/d1-throw.js'></script>",
    }),
  );
  await page.route("**/d1-throw.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: 'window.d1Throw = function d1RealThrow() {\n  throw new TypeError("FI_D1_SYNTHETIC token=throw\\n真实抛错");\n};',
    }),
  );
  await page.route("**/d1-missing.png?token=FI_D1_SYNTHETIC", (r) =>
    r.fulfill({ status: 404, body: "" }),
  );
  type WireEvent = {
    eventId: string;
    payload: Record<string, unknown>;
    diagnostic?: { raw: Record<string, unknown>; source: string; status: string };
  };
  const wire: WireEvent[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.postData())
      wire.push(...JSON.parse(r.postData()!).events);
  });
  const from = new Date(Date.now() - 1000).toISOString();
  await page.goto("http://127.0.0.1:4174/d1-fixture");
  const measurement = await page.evaluate(async (appId) => {
    const a = "/d1-index.js",
      b = "/d1-errors.js",
      c = "/d1-quality.js";
    const { createTracker } = await import(a),
      {
        createErrorDiagnostics,
        extractError,
        createReactErrorHandler,
        installVueErrorHandler,
      } = await import(b),
      { createQualityCollectors } = await import(c);
    const quality = createQualityCollectors({ jsErrors: true });
    const config = {
      appId,
      env: "dev",
      release: "d1-browser",
      endpoint: location.origin + "/v1/events",
      quality: quality.factory,
      errorDiagnostics: createErrorDiagnostics(),
      observability: { enabled: true, captureWebVitals: false },
    };
    const tracker = createTracker(config);
    if (createTracker(config) !== tracker) throw new Error("DUPLICATE_INITIALIZATION");
    const error = new TypeError(
      "FI_D1_SYNTHETIC token=explicit\n<svg onload=alert(1)>纯文本",
    );
    error.stack =
      "TypeError: synthetic\n    at renderChart (/assets/app.js?token=FI_D1_SYNTHETIC:10:20)\n    at async next (https://fixture.invalid/run.js:30:40)";
    tracker.captureException(error);
    tracker.captureException(
      new AggregateError(
        [
          new Error("token=child"),
          { nested: { url: "https://fixture.invalid/?token=synthetic" } },
        ],
        "FI_D1_SYNTHETIC aggregate",
        { cause: new Error("token=cause\nline") },
      ),
    );
    const bad = new Error("FI_D1_SYNTHETIC parse failure");
    bad.stack = "UNKNOWN STACK token=synthetic";
    tracker.captureException(bad);
    const huge = new Error("FI_D1_SYNTHETIC truncated");
    huge.stack =
      "Error: huge\n" +
      Array.from({ length: 100 }, (_, i) => ` at fn${i} (/assets/huge.js:10:20)`).join(
        "\n",
      );
    tracker.captureException(huge);
    tracker.captureException("FI_D1_SYNTHETIC string without stack");
    createReactErrorHandler((e: unknown, s: "react") => tracker.captureException(e, s))(
      new Error("FI_D1_SYNTHETIC react"),
    );
    const app = { config: { errorHandler: () => {} } };
    const restore = installVueErrorHandler(app, (e: unknown, s: "vue") =>
      tracker.captureException(e, s),
    );
    app.config.errorHandler(new Error("FI_D1_SYNTHETIC vue"));
    restore();
    setTimeout(() => (window as unknown as { d1Throw: () => void }).d1Throw(), 0);
    void Promise.reject({
      message: "FI_D1_SYNTHETIC token=promise",
      nested: { token: "synthetic", url: "https://fixture.invalid/?token=synthetic" },
    });
    setTimeout(() => {
      void Promise.reject(null);
    }, 10);
    const img = new Image();
    img.src = "/d1-missing.png?token=FI_D1_SYNTHETIC";
    document.body.append(img);
    await new Promise((r) => setTimeout(r, 150));
    await tracker.flush();
    tracker.destroy();
    await tracker.flush();
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const start = performance.now();
      extractError(error, "explicit");
      samples.push(performance.now() - start);
    }
    samples.sort((x, y) => x - y);
    return {
      extractionP95Ms: samples[Math.floor(samples.length * 0.95)],
      samples: samples.length,
    };
  }, project.appId);
  const sent = wire.filter((e) => e.diagnostic);
  expect(sent).toHaveLength(11);
  expect(JSON.stringify(sent.map((e) => e.payload))).not.toContain("FI_D1_SYNTHETIC");
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
    const err = event.diagnostic!.raw.error as Record<string, unknown>;
    if (err.message === "FI_D1_SYNTHETIC token=explicit\n<svg onload=alert(1)>纯文本")
      expect(detail.view.stack.frames[0]).toMatchObject({
        function: "renderChart",
        file: "/assets/app.js?token=FI_D1_SYNTHETIC",
        line: 10,
        column: 20,
      });
    if (err.message === "FI_D1_SYNTHETIC token=throw\n真实抛错")
      expect(detail.view.stack.frames[0]).toMatchObject({
        function: "d1RealThrow",
        file: "http://127.0.0.1:4174/d1-throw.js",
        line: 2,
      });
    if (err.message === "FI_D1_SYNTHETIC parse failure")
      expect(detail.view.stack.state).toBe("parse_failed");
    if (err.message === "FI_D1_SYNTHETIC truncated") {
      expect(detail.capture.status).toBe("truncated");
      expect(detail.view.stack.frames).toHaveLength(32);
    }
    if (err.resourceUrl) {
      expect(detail.view.stack.state).toBe("not_applicable");
      expect(err.resourceUrl).toContain("?token=FI_D1_SYNTHETIC");
    }
    if (err.reason === null) expect(detail.view.stack.state).toBe("unavailable");
  }
  const list = await request.get(
    root + "/observability/occurrences?env=dev&range=7d&mode=all",
    { headers },
  );
  expect(await list.text()).not.toContain("FI_D1_SYNTHETIC");
  const viewer = await (
    await request.post("/api/auth/login", {
      data: { email: "viewer@example.invalid", password: "LocalViewer-1234" },
    })
  ).json();
  expect(
    (
      await request.put(root + `/members/${viewer.user.userId}`, {
        headers,
        data: { role: "viewer" },
      })
    ).ok(),
  ).toBe(true);
  const vh = { authorization: `Bearer ${viewer.accessToken}` },
    explicit = sent[0]!;
  const detailUrl = root + `/diagnostics/instances/${explicit.eventId}`;
  expect((await request.get(detailUrl, { headers: vh })).status()).toBe(403);
  expect((await request.get(detailUrl)).status()).toBe(401);
  const grantUrl = root + `/diagnostics/grants/${viewer.user.userId}`;
  expect(
    (
      await request.put(grantUrl, { headers, data: { read: true, export: false } })
    ).ok(),
  ).toBe(true);
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("viewer@example.invalid");
  await page.getByLabel("密码").fill("LocalViewer-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/projects/);
  const to = new Date(Date.now() + 1000).toISOString();
  await page.goto(
    `/projects/${project.id}/pages?` +
      new URLSearchParams({ env: "dev", range: "custom", from, to, mode: "all" }),
  );
  const rows = await (
    await request.get(
      root +
        "/observability/occurrences?" +
        new URLSearchParams({ env: "dev", range: "custom", from, to, mode: "all" }),
      { headers },
    )
  ).json();
  const item = rows.items.find(
    (i: { eventId: string }) => i.eventId === explicit.eventId,
  );
  await page
    .getByRole("button", {
      name: `打开复现条件 ${item.occurrenceId.slice(0, 8)}`,
      exact: true,
    })
    .click();
  await expect(page.getByTestId("diagnostic-message")).toHaveText(
    "FI_D1_SYNTHETIC token=explicit\n<svg onload=alert(1)>纯文本",
  );
  await expect(page.getByTestId("diagnostic-stack")).toContainText("renderChart");
  await expect(page.getByRole("table", { name: "结构化栈帧" })).toContainText("10:20");
  expect(await page.getByRole("dialog").locator("svg[onload]").count()).toBe(0);
  // Clipboard transport is environment-dependent; supply a browser clipboard sink,
  // while exercising the real button's reauthorization and exact text selection.
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
  await page.getByRole("button", { name: "复制错误消息", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied))
    .toBe("FI_D1_SYNTHETIC token=explicit\n<svg onload=alert(1)>纯文本");
  await request.put(grantUrl, { headers, data: { read: false, export: false } });
  expect((await request.get(detailUrl, { headers: vh })).status()).toBe(403);
  await expect(page.getByTestId("diagnostic-message")).toHaveCount(0, {
    timeout: 7000,
  });
  await expect(page.getByRole("dialog")).toContainText("无诊断详情权限");
  await request.put(grantUrl, { headers, data: { read: true, export: false } });
  await page.getByRole("button", { name: "重新授权并读取" }).click();
  await expect(page.getByTestId("diagnostic-message")).toBeVisible();
  await request.delete(root + `/members/${viewer.user.userId}`, { headers });
  expect((await request.get(detailUrl, { headers: vh })).status()).toBe(403);
  await expect(page.getByTestId("diagnostic-message")).toHaveCount(0, {
    timeout: 7000,
  });
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/d1-${info.project.name}.json`,
    JSON.stringify({
      testedCommit: process.env.GITHUB_SHA,
      rawRoundTrips: sent.length,
      rawUi: "passed",
      revoke: "passed",
      memberRemoval: "passed",
      ...measurement,
    }),
  );
});
