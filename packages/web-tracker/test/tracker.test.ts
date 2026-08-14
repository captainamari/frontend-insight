// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTracker,
  createTrackerWithRemoteConfig,
  type TrackerRuntime,
} from "../src/index.js";

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function createRuntime(options: { beacon?: boolean } = {}) {
  let identifier = 0;
  const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
  const sendBeacon = vi.fn(() => options.beacon ?? true);
  const accessedStorageKeys: string[] = [];
  const runtime: TrackerRuntime = {
    window,
    document,
    navigator: { sendBeacon },
    storage: {
      getItem(key) {
        accessedStorageKeys.push(key);
        return window.localStorage.getItem(key);
      },
      setItem(key, value) {
        accessedStorageKeys.push(key);
        window.localStorage.setItem(key, value);
      },
    },
    fetch: fetchMock as unknown as typeof fetch,
    crypto: {
      randomUUID: () => {
        identifier += 1;
        return `00000000-0000-4000-8000-${String(identifier).padStart(12, "0")}`;
      },
    },
    now: Date.now,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  return { runtime, fetchMock, sendBeacon, accessedStorageKeys };
}

function config(runtime: TrackerRuntime, suffix: string) {
  return {
    projectKey: `fi_public_tracker${suffix}`,
    endpoint: "https://collector.example.test/v1/events",
    releaseVersion: "test-release",
    deploymentEnvironment: "development",
    registeredFeatures: ["sales_dashboard", "report_export", "operations_wallboard"],
    flushIntervalMs: 60_000,
    runtime,
  } as const;
}

async function payload(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const options = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(options?.body)) as {
    schemaVersion: number;
    events: Array<Record<string, unknown>>;
  };
}

describe("web tracker lifecycle and privacy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T17:10:00.000Z"));
    window.localStorage.clear();
    document.title = "Orders";
    window.history.replaceState({}, "", "/orders/123?token=never#secret");
    setVisibility("visible");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("captures initial and normalized SPA routes without query or hash", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "route01"),
      normalizeRoute: (url) => url.pathname.replace(/\/orders\/[^/]+/, "/orders/:id"),
    });
    window.history.pushState({}, "", "/reports/456?email=never@example.test");
    window.history.replaceState({}, "", "/reports/456?changed=1");
    await tracker.flush();

    const batch = await payload(fetchMock);
    expect(batch.events.map((event) => event.eventName)).toEqual([
      "page_view",
      "page_leave",
      "page_view",
    ]);
    expect(batch.events.map((event) => event.route)).toEqual([
      "/orders/:id",
      "/orders/:id",
      "/reports/456",
    ]);
    expect(JSON.stringify(batch)).not.toContain("token=never");
    expect(JSON.stringify(batch)).not.toContain("email=never");
    tracker.destroy();
  });

  it("never scans cookies or unrelated browser storage", async () => {
    document.cookie = "session=Bearer-cookie-token";
    window.localStorage.setItem("Authorization", "Bearer local-token-value");
    window.sessionStorage.setItem("access_token", "header.payload.signature");
    const { runtime, fetchMock, accessedStorageKeys } = createRuntime();
    const tracker = createTracker(config(runtime, "privacy01"));
    tracker.track("report_filtered", { source: "toolbar" });
    await tracker.flush();

    const batch = await payload(fetchMock);
    expect(accessedStorageKeys).toEqual([
      "frontend-insight.visitor-id.v1",
      "frontend-insight.visitor-id.v1",
    ]);
    expect(JSON.stringify(batch)).not.toContain("local-token-value");
    expect(JSON.stringify(batch)).not.toContain("cookie-token");
    tracker.destroy();
  });

  it("adds validated static properties before the restricted beforeSend hook", async () => {
    const { runtime, fetchMock } = createRuntime();
    const seen: Array<Record<string, unknown>> = [];
    const tracker = createTracker({
      ...config(runtime, "static01"),
      staticProperties: { demo: true, deployment: "acceptance" },
      beforeSend: ({ event }) => {
        seen.push(event.properties);
        return { ...event, properties: { ...event.properties } };
      },
    });
    tracker.featureSucceeded("sales_dashboard", { demo: false, rows: 24 });
    await tracker.flush();

    const batch = await payload(fetchMock);
    expect(seen).not.toHaveLength(0);
    expect(
      batch.events.every(
        (event) =>
          (event.properties as Record<string, unknown>).demo === true &&
          (event.properties as Record<string, unknown>).deployment === "acceptance",
      ),
    ).toBe(true);
    tracker.destroy();
  });

  it("accepts opaque account references and rejects token or PII-like values", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker(config(runtime, "account01"));
    tracker.setAccount("opaque-account-123");
    tracker.featureExposed("sales_dashboard");
    tracker.setAccount("Bearer forbidden-value");
    tracker.setAccount("person@example.test");
    tracker.featureSucceeded("sales_dashboard");
    await tracker.flush();

    const batch = await payload(fetchMock);
    expect(
      batch.events.slice(1).every((event) => event.accountRef === "opaque-account-123"),
    ).toBe(true);
    expect(tracker.getDiagnostics()).toMatchObject({
      droppedEvents: 2,
      lastErrorCode: "ACCOUNT_REF_REJECTED",
    });
    tracker.destroy();
  });

  it("rotates a tab-scoped session after 30 minutes of inactivity", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker(config(runtime, "session01"));
    tracker.track("filter_changed");
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    tracker.track("filter_changed");
    await tracker.flush();

    const batch = await payload(fetchMock);
    expect(batch.events[1]?.sessionId).not.toBe(batch.events[2]?.sessionId);
    tracker.destroy();
  });

  it("pauses visible time on hidden and settles only on pagehide", async () => {
    const { runtime, fetchMock, sendBeacon } = createRuntime({ beacon: false });
    const tracker = createTracker(config(runtime, "beacon01"));
    vi.advanceTimersByTime(2_500);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(1);

    expect(sendBeacon).toHaveBeenCalledOnce();
    expect(
      (await payload(fetchMock)).events.some(
        (event) => event.eventName === "page_leave",
      ),
    ).toBe(false);
    vi.advanceTimersByTime(5_000);
    setVisibility("visible");
    vi.advanceTimersByTime(500);
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(1);

    const batch = await payload(fetchMock, 1);
    const leave = batch.events.find((event) => event.eventName === "page_leave");
    expect(leave?.properties).toEqual({ visibleDurationMs: 3000 });
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).keepalive).toBe(true);
    expect(tracker.getDiagnostics().beaconFallbacks).toBe(2);
    tracker.destroy();
  });

  it("pauses long-view accumulation while hidden", async () => {
    const { runtime, fetchMock } = createRuntime({ beacon: false });
    const tracker = createTracker({
      ...config(runtime, "longview01"),
      longViewSuccessAfterMs: 1_000,
      longViewHeartbeatMs: 2_000,
    });
    tracker.featureExposed("operations_wallboard");
    const stop = tracker.startLongView("operations_wallboard");
    vi.advanceTimersByTime(500);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(1);
    vi.advanceTimersByTime(5_000);
    setVisibility("visible");
    vi.advanceTimersByTime(2_500);
    stop();
    await tracker.flush();

    const batches = await Promise.all(
      fetchMock.mock.calls.map((_, index) => payload(fetchMock, index)),
    );
    const events = batches.flatMap((batch) => batch.events);
    expect(events.map((event) => event.eventName)).toEqual(
      expect.arrayContaining([
        "feature_long_view_started",
        "feature_succeeded",
        "feature_long_view_heartbeat",
        "feature_long_view_ended",
      ]),
    );
    const ended = events.find((event) => event.eventName === "feature_long_view_ended");
    expect(
      (ended?.properties as { visibleDurationMs: number }).visibleDurationMs,
    ).toBeLessThan(4_000);
    tracker.destroy();
  });

  it("settles a long view against its original page before navigation", async () => {
    const { runtime, fetchMock } = createRuntime({ beacon: false });
    const tracker = createTracker({
      ...config(runtime, "longview-route01"),
      longViewSuccessAfterMs: 1_000,
    });
    const stop = tracker.startLongView("operations_wallboard");
    vi.advanceTimersByTime(500);
    window.history.pushState({}, "", "/next-page");
    await tracker.flush();

    const batch = await payload(fetchMock);
    const started = batch.events.find(
      (event) => event.eventName === "feature_long_view_started",
    );
    const ended = batch.events.find(
      (event) => event.eventName === "feature_long_view_ended",
    );
    expect(ended?.pageViewId).toBe(started?.pageViewId);
    expect(ended?.properties).toEqual({ visibleDurationMs: 500 });
    stop();
    tracker.destroy();
  });

  it("produces the three feature scenario sequences", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "golden01"),
      longViewSuccessAfterMs: 1_000,
      longViewHeartbeatMs: 2_000,
    });
    tracker.featureExposed("sales_dashboard");
    tracker.featureSucceeded("sales_dashboard");
    tracker.featureExposed("report_export");
    tracker.featureStarted("report_export");
    tracker.featureSucceeded("report_export");
    tracker.featureExposed("operations_wallboard");
    const stop = tracker.startLongView("operations_wallboard");
    vi.advanceTimersByTime(3_000);
    stop();
    await tracker.flush();

    const batch = await payload(fetchMock);
    const names = batch.events.map((event) => event.eventName);
    expect(names).toEqual([
      "page_view",
      "feature_exposed",
      "feature_succeeded",
      "feature_exposed",
      "feature_started",
      "feature_succeeded",
      "feature_exposed",
      "feature_long_view_started",
      "feature_succeeded",
      "feature_long_view_heartbeat",
      "feature_long_view_ended",
    ]);
    tracker.destroy();
  });

  it("keeps concurrent operation handles independent and accepts one terminal each", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker(config(runtime, "operation01"));
    const first = tracker.startOperation(
      "report_export",
      { source: "toolbar" },
      "click",
    );
    const second = tracker.startOperation("report_export", {}, "keyboard");
    first.succeed({ bytes: 2048 });
    second.fail("request_rejected");
    second.cancel();
    await tracker.flush();

    const batch = await payload(fetchMock);
    expect(batch.schemaVersion).toBe(3);
    const operations = batch.events.filter((event) => event.operationInstanceId);
    const instanceIds = new Set(
      operations.map((event) => String(event.operationInstanceId)),
    );
    expect(instanceIds.size).toBe(2);
    for (const instanceId of instanceIds) {
      const events = operations.filter(
        (event) => event.operationInstanceId === instanceId,
      );
      expect(
        events.filter((event) => event.eventName === "feature_started"),
      ).toHaveLength(1);
      expect(
        events.filter((event) =>
          ["feature_succeeded", "feature_failed", "feature_canceled"].includes(
            String(event.eventName),
          ),
        ),
      ).toHaveLength(1);
    }
    expect(second.getState()).toBe("failed");
    expect(tracker.getDiagnostics().duplicateOperationTerminals).toBe(1);
    expect(JSON.stringify(batch)).toContain("request_rejected");
    tracker.destroy();
  });

  it("emits an explicit canceled terminal from an operation handle", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker(config(runtime, "operation-cancel01"));
    const operation = tracker.startOperation("report_export");
    operation.cancel({ source: "dialog" });
    await tracker.flush();

    const batch = await payload(fetchMock);
    const canceled = batch.events.find(
      (event) => event.eventName === "feature_canceled",
    );
    expect(canceled?.operationInstanceId).toMatch(/^op_[A-Za-z0-9_-]{16,64}$/);
    expect(canceled?.properties).toEqual({ source: "dialog" });
    tracker.destroy();
  });

  it("captures privacy-bounded JS, resource, API and Web Vital evidence", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "observability01"),
      releaseVersion: "2026.08.1",
      deploymentEnvironment: "production",
      observability: {
        enabled: true,
        captureJsErrors: false,
        captureResourceErrors: false,
        captureApiErrors: false,
        captureWebVitals: false,
      },
    });
    tracker.captureException(
      new Error(
        "Budget failed token=must-not-leak for person@example.test at https://park.invalid/devices/123456?secret=hidden",
      ),
    );
    tracker.captureResourceError({
      resourceType: "script",
      url: "https://park.invalid/assets/123456?token=hidden",
    });
    tracker.captureApiError({
      method: "get",
      url: "https://park.invalid/api/devices/123456?token=hidden",
      statusCode: 503,
      durationMs: 850.4,
    });
    tracker.captureWebVital({ name: "LCP", value: 4_200 });
    await tracker.flush();

    const batch = await payload(fetchMock);
    expect(batch.schemaVersion).toBe(3);
    const observability = batch.events.filter((event) =>
      ["error_js", "error_resource", "error_api", "web_vital"].includes(
        String(event.eventName),
      ),
    );
    expect(observability).toHaveLength(4);
    expect(observability[2]?.properties).toMatchObject({
      requestMethod: "GET",
      requestPath: "/api/devices/:id",
      statusCode: 503,
      durationMs: 850,
    });
    expect(observability[3]?.properties).toMatchObject({
      vitalName: "LCP",
      vitalRating: "poor",
    });
    expect(observability[2]).toMatchObject({
      releaseVersion: "2026.08.1",
      deploymentEnvironment: "production",
    });
    expect(observability[0]?.properties).toMatchObject({
      browserFamily: expect.any(String),
      osFamily: expect.any(String),
      viewportBucket: expect.any(String),
    });
    const serialized = JSON.stringify(observability);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("person@example.test");
    expect(serialized).not.toContain("token=hidden");
    expect(serialized).not.toContain("park.invalid");
    tracker.destroy();
  });

  it("optionally instruments failed fetches and restores the host function", async () => {
    const originalFetch = window.fetch;
    const hostFetch = vi.fn(async () => new Response(null, { status: 502 }));
    window.fetch = hostFetch as unknown as typeof fetch;
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "autofetch01"),
      observability: {
        enabled: true,
        captureJsErrors: false,
        captureResourceErrors: false,
        captureApiErrors: true,
        captureWebVitals: false,
      },
    });

    await window.fetch("/api/alarms/987654?authorization=hidden", {
      method: "POST",
    });
    await tracker.flush();
    const batch = await payload(fetchMock);
    expect(
      batch.events.find((event) => event.eventName === "error_api")?.properties,
    ).toMatchObject({
      requestMethod: "POST",
      requestPath: "/api/alarms/:id",
      statusCode: 502,
    });

    tracker.destroy();
    expect(window.fetch).toBe(hostFetch);
    window.fetch = originalFetch;
  });

  it("restores nested M8 and P1 fetch wrappers in host-safe order", async () => {
    const originalFetch = window.fetch;
    const hostFetch = vi.fn(async () => new Response(null, { status: 502 }));
    window.fetch = hostFetch as unknown as typeof fetch;
    const { runtime } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "nested-fetch01"),
      observability: {
        enabled: true,
        captureJsErrors: false,
        captureResourceErrors: false,
        captureApiErrors: true,
        captureWebVitals: false,
      },
      collectors: {
        api: {
          enabled: true,
          sampleRate: 1,
          slowThresholdMs: 100,
          globalFetch: true,
        },
      },
    });
    await window.fetch("/api/alarms/987654?authorization=hidden");
    tracker.destroy();
    expect(window.fetch).toBe(hostFetch);
    window.fetch = originalFetch;
  });

  it("keeps every P1 collector disabled by default", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker(config(runtime, "p1-default-off01"));
    tracker.captureApiRequest({
      method: "GET",
      url: "/api/orders/123?token=hidden",
      statusCode: 200,
      durationMs: 20,
    });
    tracker.captureResourceRequest({
      resourceType: "script",
      url: "/assets/app.js",
      succeeded: true,
      durationMs: 10,
    });
    tracker.markPageReady({ templateKey: "analysis_view", blankCandidate: true });
    tracker.startListRender("orders", 10)();
    tracker.recordBreadcrumbAction("orders_opened");
    window.history.pushState({}, "", "/next");
    await tracker.flush();

    const batch = await payload(fetchMock);
    const p1Names = new Set([
      "api_request_summary",
      "resource_summary",
      "page_readiness",
      "list_render",
      "long_task_summary",
    ]);
    expect(
      batch.events.filter((event) => p1Names.has(String(event.eventName))),
    ).toEqual([]);
    tracker.destroy();
  });

  it("emits privacy-bounded P1 evidence with denominators and error-only breadcrumbs", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "p1-explicit01"),
      observability: {
        enabled: true,
        captureJsErrors: false,
        captureResourceErrors: false,
        captureApiErrors: false,
        captureWebVitals: false,
      },
      collectors: {
        api: { enabled: true, sampleRate: 1, slowThresholdMs: 100 },
        resources: { enabled: true, sampleRate: 1 },
        firstScreen: { enabled: true, sampleRate: 1 },
        listRender: { enabled: true, sampleRate: 1 },
        longTasks: { enabled: true, sampleRate: 1 },
        blankScreen: { enabled: true, sampleRate: 1 },
        breadcrumbs: {
          enabled: true,
          sampleRate: 1,
          allowedActionKeys: ["orders_opened"],
        },
      },
    });
    vi.advanceTimersByTime(120);
    tracker.markPageReady({ templateKey: "analysis_view", blankCandidate: true });
    const finishList = tracker.startListRender("business-order-9988", 1_200);
    vi.advanceTimersByTime(45);
    finishList();
    tracker.captureApiRequest({
      method: "post",
      url: "/api/orders/987654?token=must-not-leak",
      statusCode: 503,
      durationMs: 240,
    });
    tracker.captureResourceRequest({
      resourceType: "script",
      url: "/assets/private-name.js?token=must-not-leak",
      succeeded: false,
      durationMs: 80,
    });
    tracker.recordBreadcrumbAction("orders_opened");
    tracker.recordBreadcrumbAction("business_order_9988");
    tracker.captureException(new Error("render failed for business order 9988"));
    window.history.pushState({}, "", "/next");
    await tracker.flush();

    const batch = await payload(fetchMock);
    const byName = (name: string) =>
      batch.events.find((event) => event.eventName === name);
    expect(byName("api_request_summary")?.properties).toMatchObject({
      requestMethod: "POST",
      requestPath: "/api/orders/:id",
      requestCount: 1,
      errorCount: 1,
      successCount: 0,
      slowCount: 1,
      sampleRate: 1,
    });
    expect(byName("page_readiness")?.properties).toMatchObject({
      templateKey: "analysis_view",
      readinessDurationMs: 120,
      readinessState: "blank_candidate",
      firstScreenCollected: true,
      blankDetectionCollected: true,
      firstScreenSampleRate: 1,
      blankDetectionSampleRate: 1,
    });
    expect(byName("list_render")?.properties).toMatchObject({
      rowCountBucket: ">1000",
      durationMs: 45,
    });
    expect(byName("resource_summary")?.properties).toMatchObject({
      totalCount: 1,
      failedCount: 1,
      observedPageViews: 1,
    });
    expect(byName("long_task_summary")?.properties).toMatchObject({
      longTaskCount: 0,
      observedPageViews: 1,
    });
    const error = byName("error_js");
    expect(error?.breadcrumbs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "action", key: "orders_opened" }),
        expect.objectContaining({
          kind: "api",
          key: "api_failed",
          path: "/api/orders/:id",
        }),
      ]),
    );
    expect(
      batch.events
        .filter((event) => !String(event.eventName).startsWith("error_"))
        .every((event) => event.breadcrumbs === undefined),
    ).toBe(true);
    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("business-order-9988");
    expect(serialized).not.toContain("business_order_9988");
    tracker.destroy();
  });

  it("does not wrap global fetch unless its collector opts in", () => {
    const originalFetch = window.fetch;
    const hostFetch = vi.fn(async () => new Response(null, { status: 200 }));
    window.fetch = hostFetch as unknown as typeof fetch;
    const { runtime } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "p1-fetch-off01"),
      collectors: { api: { enabled: true, sampleRate: 1 } },
    });
    expect(window.fetch).toBe(hostFetch);
    tracker.destroy();
    window.fetch = originalFetch;
  });

  it("loads project-authoritative collector switches before startup", async () => {
    const { runtime } = createRuntime();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/v1/collector-config/")) {
        return Response.json({
          schemaVersion: 1,
          version: 2,
          collectors: {
            api: {
              enabled: true,
              sampleRate: 1,
              slowThresholdMs: 500,
              globalFetch: false,
            },
          },
        });
      }
      return new Response(null, { status: 202 });
    });
    runtime.fetch = fetchMock as unknown as typeof fetch;
    const tracker = await createTrackerWithRemoteConfig(config(runtime, "p1-remote01"));
    tracker.captureApiRequest({
      method: "GET",
      url: "/api/reports/123?secret=hidden",
      statusCode: 200,
      durationMs: 100,
    });
    await tracker.flush();

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/v1/collector-config/fi_public_trackerp1-remote01",
    );
    const batch = await payload(fetchMock, 1);
    expect(
      batch.events.find((event) => event.eventName === "api_request_summary")
        ?.properties,
    ).toMatchObject({ requestPath: "/api/reports/:id", sampleRate: 1 });
    tracker.destroy();
  });

  it("fails closed when static properties consume or override the M8 budget", () => {
    const { runtime } = createRuntime();
    const base = {
      ...config(runtime, "observability-budget01"),
      observability: {
        enabled: true,
        captureJsErrors: false,
        captureResourceErrors: false,
        captureApiErrors: false,
        captureWebVitals: false,
      },
    } as const;
    const budget = createTracker({
      ...base,
      staticProperties: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`label${index}`, index]),
      ),
    });
    expect(budget.getDiagnostics().lastErrorCode).toBe(
      "OBSERVABILITY_PROPERTY_BUDGET_EXCEEDED",
    );
    const conflict = createTracker({
      ...base,
      staticProperties: { releaseVersion: "overridden" },
    });
    expect(conflict.getDiagnostics().lastErrorCode).toBe(
      "OBSERVABILITY_STATIC_PROPERTY_CONFLICT",
    );

    const p1Conflict = createTracker({
      ...config(runtime, "p1-static-conflict01"),
      staticProperties: { requestCount: 99 },
      collectors: { api: { enabled: true, sampleRate: 1 } },
    });
    expect(p1Conflict.getDiagnostics().lastErrorCode).toBe(
      "OBSERVABILITY_STATIC_PROPERTY_CONFLICT",
    );
  });

  it("drops unknown features, nested properties and forbidden beforeSend changes", () => {
    const { runtime } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "guard01"),
      beforeSend: ({ event }) => ({
        ...event,
        eventName: "tampered",
      }),
    });
    tracker.featureExposed("not_registered");
    tracker.track("nested_value", { nested: {} as never });
    expect(tracker.getDiagnostics().droppedEvents).toBeGreaterThanOrEqual(3);
    tracker.destroy();
  });

  it("returns the same active tracker for duplicate initialization", () => {
    const { runtime } = createRuntime();
    const first = createTracker(config(runtime, "duplicate01"));
    const second = createTracker(config(runtime, "duplicate01"));
    expect(second).toBe(first);
    first.destroy();
  });

  it("returns a safe no-op for invalid configuration", () => {
    const { runtime } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "invalid01"),
      projectKey: "secret",
    });
    expect(() => tracker.track("anything")).not.toThrow();
    expect(tracker.getDiagnostics()).toMatchObject({
      state: "noop",
      lastErrorCode: "PROJECT_KEY_INVALID",
    });
  });
});
