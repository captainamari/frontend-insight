// @vitest-environment happy-dom

import type { FrontendInsightEventBatchV3 } from "@frontend-insight/event-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTracker, type TrackerRuntime } from "../src/index.js";

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
    navigator: { sendBeacon, userAgent: navigator.userAgent },
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
    appId: `fi_tracker_${suffix}`,
    env: "dev" as const,
    release: "0.4.0-test",
    endpoint: "https://collector.example.test/v1/events",
    registeredFeatures: ["sales_dashboard", "report_export"],
    flushIntervalMs: 60_000,
    runtime,
  };
}

async function payload(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const options = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(options?.body)) as FrontendInsightEventBatchV3;
}

describe("web tracker contract v3", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T17:10:00.000Z"));
    window.localStorage.clear();
    window.history.replaceState({}, "", "/orders/123?token=never#secret");
    setVisibility("visible");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("sends only v3 and repeats the complete canonical context on every event", async () => {
    const { runtime, fetchMock, accessedStorageKeys } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "context01"),
      deptId: "dept_ops",
      roleId: "role_admin",
      normalizePageRoute: (url) =>
        url.pathname.replace(/\/orders\/[^/]+/u, "/orders/:id"),
    });
    tracker.featureExposed("sales_dashboard");
    await tracker.flush();

    const batch = await payload(fetchMock);
    expect(batch.schemaVersion).toBe(3);
    expect(batch.events).toHaveLength(2);
    for (const event of batch.events) {
      expect(event).toMatchObject({
        appId: "fi_tracker_context01",
        env: "dev",
        release: "0.4.0-test",
        pageRoute: "/orders/:id",
        userId: null,
        deptId: "dept_ops",
        roleId: "role_admin",
        ua: expect.any(String),
        os: expect.any(String),
        browser: expect.any(String),
      });
      expect(event.pageUrl).not.toContain("?");
      expect(event.pageUrl).not.toContain("#");
      expect(event.timestamp).toBeTypeOf("number");
    }
    expect(batch.events[1]).toMatchObject({
      event: "custom",
      payload: { name: "feature_exposed", featureKey: "sales_dashboard" },
    });
    expect(accessedStorageKeys).toEqual([
      "frontend-insight.device-id.v2",
      "frontend-insight.device-id.v2",
    ]);
    tracker.destroy();
  });

  it("accepts an opaque user reference and rejects credentials or PII", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker(config(runtime, "privacy01"));
    tracker.setUser("opaque-user-123");
    tracker.featureExposed("sales_dashboard");
    tracker.setUser("Bearer forbidden-value");
    tracker.setUser("person@example.test");
    tracker.featureSucceeded("sales_dashboard");
    await tracker.flush();

    const batch = await payload(fetchMock);
    expect(
      batch.events.slice(1).every((event) => event.userId === "opaque-user-123"),
    ).toBe(true);
    expect(JSON.stringify(batch)).not.toContain("forbidden-value");
    expect(JSON.stringify(batch)).not.toContain("person@example.test");
    expect(tracker.getDiagnostics()).toMatchObject({
      droppedEvents: 2,
      lastErrorCode: "USER_ID_REJECTED",
    });
    tracker.destroy();
  });

  it("keeps concurrent operation instances independent with one terminal each", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker(config(runtime, "operation01"));
    const first = tracker.startOperation("report_export", { source: "toolbar" });
    const second = tracker.startOperation("report_export", {}, "keyboard");
    first.succeed({ bytes: 2048 });
    second.fail("request_rejected");
    second.cancel();
    await tracker.flush();

    const batch = await payload(fetchMock);
    const operations = batch.events.filter(
      (event) => typeof event.payload.operationInstanceId === "string",
    );
    const instances = new Set(
      operations.map((event) => String(event.payload.operationInstanceId)),
    );
    expect(instances.size).toBe(2);
    for (const instance of instances) {
      const names = operations
        .filter((event) => event.payload.operationInstanceId === instance)
        .map((event) => event.payload.name);
      expect(names.filter((name) => name === "feature_started")).toHaveLength(1);
      expect(
        names.filter((name) =>
          ["feature_succeeded", "feature_failed", "feature_canceled"].includes(
            String(name),
          ),
        ),
      ).toHaveLength(1);
    }
    expect(second.getState()).toBe("failed");
    expect(tracker.getDiagnostics().duplicateOperationTerminals).toBe(1);
    tracker.destroy();
  });

  it("emits privacy-bounded canonical error, API and performance events", async () => {
    const { runtime, fetchMock } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "quality01"),
      observability: {
        enabled: true,
        captureJsErrors: false,
        captureResourceErrors: false,
        captureApiErrors: false,
        captureWebVitals: false,
      },
    });
    tracker.captureException(
      new Error("Failed token=secret for person@example.test at /devices/123456"),
    );
    tracker.captureApiError({
      method: "get",
      url: "https://park.invalid/api/devices/123456?token=hidden",
      statusCode: 503,
      durationMs: 850.4,
    });
    tracker.captureResourceError({
      resourceType: "script",
      url: "https://park.invalid/assets/123456?token=hidden",
    });
    tracker.captureWebVital({ name: "lcp", value: 4_200 });
    await tracker.flush();

    const batch = await payload(fetchMock);
    expect(batch.events.slice(1).map((event) => event.event)).toEqual([
      "error",
      "api",
      "error",
      "performance",
    ]);
    expect(batch.events.at(-1)?.payload).toMatchObject({
      metric: "lcp",
      rating: "poor",
    });
    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain("person@example.test");
    expect(serialized).not.toContain("token=hidden");
    expect(serialized).not.toContain("park.invalid");
    tracker.destroy();
  });

  it("settles page visibility and uses keepalive when beacon fails", async () => {
    const { runtime, fetchMock, sendBeacon } = createRuntime({ beacon: false });
    const tracker = createTracker(config(runtime, "lifecycle01"));
    vi.advanceTimersByTime(2_500);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(1);

    expect(sendBeacon).toHaveBeenCalledOnce();
    const batch = await payload(fetchMock);
    expect(batch.events.find((event) => event.event === "page_leave")?.payload).toEqual(
      { visibleDurationMs: 2500 },
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).keepalive).toBe(true);
    tracker.destroy();
  });

  it("returns a safe no-op for invalid canonical configuration", () => {
    const { runtime } = createRuntime();
    const tracker = createTracker({
      ...config(runtime, "invalid01"),
      appId: "invalid id",
    });
    expect(() => tracker.track("feature_exposed")).not.toThrow();
    expect(tracker.getDiagnostics()).toMatchObject({
      state: "noop",
      lastErrorCode: "APP_ID_INVALID",
    });
  });
});
