// @vitest-environment happy-dom

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
    registeredFeatures: ["sales_dashboard", "report_export", "operations_wallboard"],
    flushIntervalMs: 60_000,
    runtime,
  } as const;
}

async function payload(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const options = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(options?.body)) as {
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

  it("settles visible time and falls back from beacon to keepalive fetch", async () => {
    const { runtime, fetchMock, sendBeacon } = createRuntime({ beacon: false });
    const tracker = createTracker(config(runtime, "beacon01"));
    vi.advanceTimersByTime(2_500);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(1);

    expect(sendBeacon).toHaveBeenCalledOnce();
    const batch = await payload(fetchMock);
    const leave = batch.events.find((event) => event.eventName === "page_leave");
    expect(leave?.properties).toEqual({ visibleDurationMs: 2500 });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).keepalive).toBe(true);
    expect(tracker.getDiagnostics().beaconFallbacks).toBe(1);
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
