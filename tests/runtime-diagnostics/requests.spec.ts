import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { validateTransportBatch } from "@frontend-insight/event-contract";
import type { DiagnosticEnvelope } from "@frontend-insight/event-contract";
import type { RequestRecord } from "../../packages/web-tracker/src/requests";

test("D3 real HTTP, frozen request evidence, permissions, UI and bounded capture", async ({
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
      name: `D3 ${info.project.name} ${randomUUID()}`,
      timezone: "UTC",
      origins: ["http://127.0.0.1:4174"],
    },
  });
  expect(made.status()).toBe(201);
  const project = await made.json(),
    root = `/api/projects/${project.id}`;
  async function post(path: string, data: unknown) {
    const response = await request.post(root + path, { headers, data });
    expect(response.status(), path).toBe(201);
    return response.json();
  }
  const module = await post("/modules", {
    moduleKey: "diagnostics",
    name: "Diagnostic fixtures",
  });
  await post("/features", {
    featureKey: "report_export",
    name: "Report export",
    featureType: "action",
    operationLifecycleEnabled: true,
  });
  const workflow = await post("/workflow-definitions", {
    moduleId: module.id,
    workflowKey: "report",
    name: "Diagnostic report",
    startPolicy: "explicit_sdk",
    timeoutSeconds: 30,
    terminalPolicy: {
      completedStepKey: "done",
      failedStepKey: null,
      canceledStepKey: null,
      timeoutState: "approximate_abandoned",
    },
    steps: ["submit", "done"].map((stepKey, i) => ({
      stepKey,
      name: stepKey,
      stepOrder: i + 1,
      triggerKind: "explicit_sdk",
      triggerConfig: {},
    })),
  });
  await post(`/workflow-definitions/${workflow.id}/activate`, {
    versionId: workflow.latestVersion.id,
  });
  const transportChecks: boolean[] = [];
  const receipts: Promise<{ status: number; code: unknown }>[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/v1/events"))
      receipts.push(
        r.json().then((body) => ({ status: r.status(), code: body.code ?? null })),
      );
  });
  for (const file of ["index", "errors", "quality", "console", "requests"])
    await page.route(`**/d3/${file}.js`, (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: readFileSync(`packages/web-tracker/dist/${file}.js`, "utf8"),
      }),
    );
  await page.route("**/d3/fixture", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html><p>D3 fixture</p>" }),
  );
  // Only static module/page delivery is routed. All business HTTP and collector/API/storage are real services.
  const wire: {
    eventId: string;
    event: string;
    payload: Record<string, unknown>;
    diagnostic?: DiagnosticEnvelope;
  }[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.postData()) {
      const batch = JSON.parse(r.postData()!);
      transportChecks.push(validateTransportBatch(batch).ok);
      wire.push(...batch.events);
    }
  });
  const from = new Date(Date.now() - 1000).toISOString();
  await page.goto("http://127.0.0.1:4174/d3/fixture");
  const evidence = await page.evaluate(async (appId) => {
    const indexPath = "/d3/index.js",
      requestsPath = "/d3/requests.js",
      qualityPath = "/d3/quality.js";
    const { createTracker } = await import(indexPath),
      { createRequestDiagnostics } = await import(requestsPath),
      { createQualityCollectors } = await import(qualityPath);
    const diagnostics = createRequestDiagnostics({
      scope: { appId },
      console: { levels: ["info", "warn", "error"] },
      successBodyRoutes: ["/__diagnostic-fixture/success"],
    });
    const quality = createQualityCollectors({ api: true, jsErrors: true });
    const tracker = createTracker({
      appId,
      env: "dev",
      release: "d3-browser",
      endpoint: location.origin + "/v1/events",
      errorDiagnostics: diagnostics.errorDiagnostics,
      registeredFeatures: ["report_export"],
      workflowDefinitions: [
        {
          workflowKey: "report",
          version: 1,
          timeoutSeconds: 30,
          steps: [
            {
              stepKey: "submit",
              stepOrder: 1,
              triggerKind: "explicit_sdk",
              triggerConfig: {},
            },
            {
              stepKey: "done",
              stepOrder: 2,
              triggerKind: "explicit_sdk",
              triggerConfig: {},
            },
          ],
          terminalPolicy: {
            completedStepKey: "done",
            failedStepKey: null,
            canceledStepKey: null,
          },
        },
      ],
      quality: quality.factory,
      observability: {
        enabled: true,
        captureWebVitals: false,
        captureApiErrors: false,
      },
    });
    const workflow = tracker.startWorkflow("report");
    workflow.reachStep("submit");
    const op = workflow.startOperation("report_export"),
      binding = diagnostics.bind({
        ...op.getContext(),
        requestId: "server_synthetic",
        traceId: "trace_synthetic",
        ...workflow.getContext(),
        stepKey: "submit",
        attemptId: "try1",
      });
    const wrapped = binding.wrapFetch(window.fetch);
    binding.action("submit report", "export-button", {
      token: "FI_D3_SYNTHETIC",
      nested: { original: true },
    });
    console.info("FI_D3_SYNTHETIC before request");
    console.warn("FI_D3_SYNTHETIC upstream failure");
    const requestBody =
      'token=FI_D3_SYNTHETIC\n{ "nested": [1, 2], "html": "<b>text</b>" }';
    const response = await quality.observeApi(
      "/diagnostic-fixture/failure",
      () =>
        wrapped("/__diagnostic-fixture/failure?token=FI_D3_SYNTHETIC", {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            "x-request-token": "FI_D3_SYNTHETIC",
          },
          body: requestBody,
        }),
      "POST",
    );
    const beforeBodyUsed = response.bodyUsed;
    const responseBody = await response.text();
    diagnostics.responseText(response, responseBody);
    op.fail("technical_failure");
    const error = new TypeError("FI_D3_SYNTHETIC render failed\n订单失败");
    error.stack =
      "TypeError: failed\n at renderReport (/assets/d3.js?token=synthetic:40:7)";
    binding.capture(tracker, error);
    await tracker.flush();
    // Body and HTTP completion after this error cannot mutate its pending snapshot.
    const late = wrapped("/__diagnostic-fixture/slow?token=late");
    binding.capture(tracker, new Error("FI_D3_SYNTHETIC pending"));
    await tracker.flush();
    const lateResponse = await late;
    diagnostics.responseText(lateResponse, await lateResponse.text());
    const success = await wrapped("/__diagnostic-fixture/business");
    const successText = await success.text();
    diagnostics.responseText(success, successText);
    binding.capture(tracker, new Error("FI_D3_SYNTHETIC success metadata"));
    await tracker.flush();
    diagnostics.responseText(success, successText, true);
    binding.capture(tracker, new Error("FI_D3_SYNTHETIC explicit business failure"));
    await tracker.flush();
    const enabled = await wrapped("/__diagnostic-fixture/success");
    diagnostics.responseText(enabled, await enabled.text());
    const big = await wrapped("/__diagnostic-fixture/large");
    diagnostics.responseText(big, await big.text());
    binding.capture(tracker, new Error("FI_D3_SYNTHETIC bounded large"));
    await tracker.flush();
    // A real SSE response is untouched: the application owns its reader and cancellation.
    const stream = await wrapped("/__diagnostic-fixture/stream");
    const reader = stream.body!.getReader();
    const firstChunk = await reader.read();
    await reader.cancel();
    const binary = await wrapped("/__diagnostic-fixture/binary");
    const bytes = await binary.arrayBuffer();
    const ac = new AbortController();
    const abort = wrapped("/__diagnostic-fixture/slow", { signal: ac.signal });
    ac.abort();
    let aborted = false;
    try {
      await abort;
    } catch (e) {
      aborted = e instanceof DOMException && e.name === "AbortError";
    }
    let network = false;
    try {
      await wrapped("/__diagnostic-fixture/network");
    } catch {
      network = true;
    }
    const opaque = await wrapped("http://127.0.0.1:4173/", { mode: "no-cors" });
    const opaqueType = opaque.type;
    const redirect = await wrapped("/__diagnostic-fixture/redirect");
    diagnostics.responseText(redirect, await redirect.text());
    binding.capture(tracker, new Error("FI_D3_SYNTHETIC outcomes"));
    await tracker.flush();
    const across = wrapped("/__diagnostic-fixture/slow");
    history.pushState({}, "", "/d3/next");
    const acrossResponse = await across;
    diagnostics.responseText(acrossResponse, await acrossResponse.text());
    binding.capture(tracker, new Error("FI_D3_SYNTHETIC next page"));
    await tracker.flush();
    const capacity = diagnostics.stats();
    tracker.destroy();
    const destroyed = diagnostics.stats();
    // Capture-only benchmark; business function uses an already-created native Response.
    const benchmark = createRequestDiagnostics({ scope: { appId } });
    const scope = { appId, endpoint: location.origin + "/v1/events" };
    const stop = benchmark.errorDiagnostics.start(
      { window, now: Date.now },
      () => "pv_measure",
      scope,
    );
    const sampleResponse = new Response("synthetic", { status: 503 });
    const immediate = benchmark.bind().wrapFetch(() => Promise.resolve(sampleResponse));
    const times: number[] = [],
      freezes: number[] = [],
      bodies: number[] = [];
    let resolution = Infinity;
    // Measure clock ticks separately; work duration is not clock resolution.
    for (let i = 0; i < 10000; i++) {
      const a = performance.now(),
        b = performance.now();
      if (b > a) resolution = Math.min(resolution, b - a);
    }
    for (let i = 0; i < 1000; i++) {
      const a = performance.now();
      const result = immediate("/sample", { method: "POST", body: "synthetic" });
      times.push(performance.now() - a);
      await result;
      const b = performance.now();
      benchmark.responseText(sampleResponse, "中\n".repeat(8000));
      bodies.push(performance.now() - b);
      const c = performance.now();
      benchmark.errorDiagnostics.call(scope, error, "explicit");
      freezes.push(performance.now() - c);
    }
    const percentile = (v: number[]) => {
      v.sort((a, b) => a - b);
      return {
        samples: v.length,
        p50Ms: v[Math.floor(v.length * 0.5)],
        p95Ms: v[Math.floor(v.length * 0.95)],
      };
    };
    const highFrequency: number[] = [];
    const parallel: Promise<Response>[] = [];
    for (let i = 0; i < 5000; i++) {
      const a = performance.now();
      parallel.push(immediate("/concurrent"));
      highFrequency.push(performance.now() - a);
    }
    const duringConcurrency = benchmark.stats();
    await Promise.all(parallel);
    const measuredCapacity = benchmark.stats();
    stop();
    return {
      opaqueType,
      beforeBodyUsed,
      requestBody,
      responseBody,
      aborted,
      network,
      streamChunk: firstChunk.value?.length,
      binaryBytes: bytes.byteLength,
      capacity,
      destroyed,
      measuredCapacity,
      duringConcurrency,
      highFrequency: percentile(highFrequency),
      sync: percentile(times),
      bodySnapshot: percentile(bodies),
      freeze: percentile(freezes),
      timingResolutionMs: Number.isFinite(resolution) ? resolution : null,
      userAgent: navigator.userAgent,
    };
  }, project.appId);
  expect(
    transportChecks.every(Boolean),
    "D3 outgoing batches must satisfy the server contract",
  ).toBe(true);
  const accepted = await Promise.all(receipts);
  expect(accepted.filter((r) => r.status !== 202)).toEqual([]);
  expect(evidence.opaqueType).toBe("opaque");
  expect(evidence.beforeBodyUsed).toBe(false);
  expect(evidence.aborted).toBe(true);
  expect(evidence.network).toBe(true);
  expect(evidence.streamChunk).toBeGreaterThan(0);
  expect(evidence.binaryBytes).toBe(3);
  expect(evidence.destroyed.requests).toBe(0);
  expect(evidence.measuredCapacity.bytes).toBeLessThanOrEqual(32768);
  expect(evidence.measuredCapacity.activeReads).toBe(0);
  expect(evidence.measuredCapacity.pendingReads).toBe(0);
  const errors = wire.filter((e) => e.event === "error");
  expect(errors).toHaveLength(7);
  expect(wire.filter((e) => e.event === "api")).toHaveLength(1);
  const first = errors[0]!.diagnostic!;
  const firstRequests = first.raw.requests as RequestRecord[];
  expect(firstRequests).toHaveLength(1);
  expect(firstRequests[0]).toMatchObject({
    status: 503,
    result: "http",
    basis: "explicit",
    method: "POST",
    requestBody: { value: evidence.requestBody },
    responseBody: { value: evidence.responseBody },
  });
  expect(firstRequests[0]!.url.value).toContain("?token=FI_D3_SYNTHETIC");
  expect(firstRequests[0]!.requestHeaders.value).toContain(
    "x-request-token: FI_D3_SYNTHETIC",
  );
  expect(firstRequests[0]!.responseHeaders.value).toContain(
    "x-fixture-token: FI_D3_SYNTHETIC",
  );
  expect(firstRequests[0]!.association.operationInstanceId).toMatch(/^op_/);
  expect(firstRequests[0]!.association.workflowInstanceId).toMatch(/^wf_/);
  const capturedAt = (first.raw.requestCapture as { capturedAt: number }).capturedAt;
  expect(firstRequests[0]!.relativeMs).toBe(firstRequests[0]!.timestamp - capturedAt);
  expect((errors[1]!.diagnostic!.raw.requests as RequestRecord[]).at(-1)!.result).toBe(
    "pending",
  );
  expect(
    (errors[2]!.diagnostic!.raw.requests as RequestRecord[]).at(-1)!.responseBody.state,
  ).toBe("success_body_disabled");
  expect((errors[3]!.diagnostic!.raw.requests as RequestRecord[]).at(-1)!.result).toBe(
    "business",
  );
  expect(errors[6]!.diagnostic!.raw.requests).toEqual([]);
  for (const e of errors) {
    const url = root + `/diagnostics/instances/${e.eventId}`;
    await expect
      .poll(async () => (await (await request.get(url, { headers })).json()).state, {
        timeout: 45000,
      })
      .toBe("ready");
    const response = await request.get(url, { headers });
    expect(response.headers()["cache-control"]).toContain("no-store");
    const detail = await response.json();
    expect(detail.diagnostic).toEqual(e.diagnostic);
    expect(detail.view.requests.records).toEqual(e.diagnostic!.raw.requests);
    if (e === errors[0])
      expect(detail.view.stack.frames[0]).toMatchObject({
        function: "renderReport",
        file: "/assets/d3.js?token=synthetic",
        line: 40,
        column: 7,
      });
  }
  const query = new URLSearchParams({
    env: "dev",
    range: "custom",
    from,
    to: new Date(Date.now() + 1000).toISOString(),
    mode: "all",
  });
  const list = await request.get(root + "/observability/occurrences?" + query, {
    headers,
  });
  const text = await list.text();
  expect(text).not.toContain("FI_D3_SYNTHETIC");
  const item = JSON.parse(text).items.find(
    (r: { eventId: string }) => r.eventId === errors[0]!.eventId,
  );
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
  const detailUrl = root + `/diagnostics/instances/${errors[0]!.eventId}`,
    grantUrl = root + `/diagnostics/grants/${viewer.user.userId}`;
  expect((await request.get(detailUrl, { headers: vh })).status()).toBe(403);
  await request.put(grantUrl, { headers, data: { read: true, export: false } });
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("viewer@example.invalid");
  await page.getByLabel("密码").fill("LocalViewer-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/projects/);
  await page.goto(`/projects/${project.id}/pages?` + query);
  await page
    .getByRole("button", {
      name: `打开复现条件 ${item.occurrenceId.slice(0, 8)}`,
      exact: true,
    })
    .click();
  await expect(page.getByTestId("diagnostic-message")).toContainText(
    "FI_D3_SYNTHETIC render failed",
  );
  await expect(page.getByTestId("console-record")).toHaveCount(2);
  await expect(page.getByTestId("request-record")).toHaveCount(1);
  await page.getByTestId("request-record").locator("summary").click();
  await expect(page.getByTestId("request-record")).toContainText("显式关联");
  await expect(page.getByTestId("request-record")).toContainText(
    evidence.responseBody.trim(),
  );
  expect(await page.getByRole("dialog").locator("svg[onload]").count()).toBe(0);
  await page.getByLabel("时间线过滤").selectOption("failed");
  await expect(page.getByTestId("request-record")).toHaveCount(1);
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
    .getByRole("button", { name: "重新授权并复制请求上下文", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied))
    .toContain("FI_D3_SYNTHETIC");
  await request.put(grantUrl, { headers, data: { read: false, export: false } });
  expect((await request.get(detailUrl, { headers: vh })).status()).toBe(403);
  await expect(page.getByTestId("request-record")).toHaveCount(0, { timeout: 7000 });
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/d3-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA ?? null,
        browser: browser.version(),
        ...evidence,
        requestBody: undefined,
        responseBody: undefined,
        passed: true,
        errors: errors.length,
        apiFacts: 1,
        note: "Real HTTP and full backend. SDK performs zero body reads; app supplies already-consumed text. Timing excludes network; zero means below timer resolution.",
      },
      null,
      2,
    ),
  );
});
