// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTracker,
  type Tracker,
  type TrackerRuntime,
  type TrackerEvent,
} from "../src/index.js";
import { createQualityCollectors, type QualityOptions } from "../src/quality.js";
import { validateForIngestion } from "@frontend-insight/event-contract";
const trackers: Tracker[] = [];
afterEach(() => {
  for (const t of trackers) t.destroy();
  trackers.length = 0;
  vi.useRealTimers();
});
function fixture(
  options: QualityOptions = {
    api: true,
    resources: true,
    firstScreen: true,
    lists: true,
    jsErrors: true,
    breadcrumbs: true,
  },
) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
  const batches: { events: TrackerEvent[] }[] = [];
  const runtime: TrackerRuntime = {
    window,
    document,
    navigator: { userAgent: "Chrome", sendBeacon: () => false },
    fetch: vi.fn(async (_url, init) => {
      batches.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }) as typeof fetch,
    crypto: globalThis.crypto,
    now: Date.now,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const quality = createQualityCollectors(options);
  const config = {
    appId: `fi_${crypto.randomUUID().slice(0, 8)}`,
    env: "dev" as const,
    release: "r5a",
    endpoint: "https://collector.test/v1/events",
    runtime,
    quality: quality.factory,
  };
  const tracker = createTracker(config);
  trackers.push(tracker);
  return {
    tracker,
    quality,
    config,
    batches,
    async finish() {
      tracker.destroy();
      await tracker.flush();
      return batches.flatMap((b) => b.events);
    },
  };
}
describe("R5-A SDK collector isolation and privacy", () => {
  it("records explicit framework categories and Promise provenance without error text", async () => {
    const f = fixture();
    for (const category of ["vue", "react", "promise", "other"] as const)
      f.quality.captureException(
        new Error("PRIVATE_DOM token=SECRET a@example.com"),
        category,
      );
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", {
      value: new TypeError("PRIVATE_BODY"),
    });
    window.dispatchEvent(rejection);
    const events = await f.finish();
    expect(
      events.filter((e) => e.event === "error").map((e) => e.payload.errorCategory),
    ).toEqual(["vue", "react", "promise", "other", "promise"]);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET|a@example/);
    for (const batch of f.batches) expect(validateForIngestion(batch).ok).toBe(true);
  });
  it("captures real success, HTTP failure, timeout and business200 without inspecting response body", async () => {
    const f = fixture();
    const value = { status: 200, body: "private-response" };
    expect(await f.quality.observeApi("/save", async () => value)).toBe(value);
    await f.quality.observeApi("/save", async () => ({ status: 500 }));
    const error = new Error("private-network-body");
    error.name = "TimeoutError";
    await expect(
      f.quality.observeApi("/save", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const events = await f.finish();
    const api = events.filter((e) => e.event === "api");
    expect(api.map((e) => e.payload.failureType)).toEqual(["none", "http", "timeout"]);
    expect(events.find((e) => e.event === "page_leave").payload).toMatchObject({
      apiStarted: 3,
      apiCompleted: 3,
      qualityClosed: true,
    });
    expect(JSON.stringify(events)).not.toContain("private-");
    for (const batch of f.batches) expect(validateForIngestion(batch).ok).toBe(true);
  });
  it("does not wrap fetch or instrument when switches are off", async () => {
    const before = window.fetch,
      f = fixture({});
    await f.quality.observeApi("/save", async () => ({ status: 500 }));
    f.quality.firstScreen();
    f.quality.captureException(new Error("x"));
    expect(window.fetch).toBe(before);
    expect((await f.finish()).map((e) => e.event)).toEqual(["page_view", "page_leave"]);
  });
  it("counts actual controlled resource attempts and preserves thrown identity", async () => {
    const f = fixture();
    await f.quality.observeResource(async () => 1);
    const e = new Error("host");
    await expect(
      f.quality.observeResource(async () => {
        throw e;
      }),
    ).rejects.toBe(e);
    expect(
      (await f.finish()).find((e) => e.event === "page_leave").payload,
    ).toMatchObject({ resourceStarted: 2, resourceCompleted: 2, resourceFailed: 1 });
  });
  it("bounds breadcrumb to50 safe semantic entries only with errors and strips all arbitrary error text", async () => {
    const f = fixture();
    for (let i = 0; i < 80; i++) f.quality.action();
    f.quality.captureException(
      new Error("token=secret DOM_TEXT FORM_VALUE raw-user PRIVATE_BODY"),
    );
    const events = await f.finish(),
      error = events.find((e) => e.event === "error");
    expect(Object.keys(error.payload.breadcrumb)).toHaveLength(50);
    expect(JSON.stringify(events)).not.toMatch(
      /secret|DOM_TEXT|FORM_VALUE|raw-user|PRIVATE_BODY/,
    );
    expect(
      events.filter((e) => e.event !== "error").every((e) => !e.payload.breadcrumb),
    ).toBe(true);
  });
  it("rate limits fingerprints while disclosing suppression instead of pretending zero errors", async () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) f.quality.captureException(new Error("same"));
    const events = await f.finish();
    expect(events.filter((e) => e.event === "error")).toHaveLength(5);
    expect(events.find((e) => e.event === "page_leave").payload.qualitySuppressed).toBe(
      5,
    );
  });
  it("first screen is once per page and list completion is idempotent with exact bucket edges", async () => {
    const f = fixture();
    vi.advanceTimersByTime(20);
    f.quality.firstScreen();
    f.quality.firstScreen();
    for (const rows of [99, 100, 1000, 1001]) {
      const end = f.quality.startList(rows);
      vi.advanceTimersByTime(10);
      end();
      end();
    }
    const events = await f.finish();
    expect(events.filter((e) => e.payload.metric === "first_screen_time")).toHaveLength(
      1,
    );
    expect(
      events
        .filter((e) => e.payload.metric === "list_render_duration")
        .map((e) => e.payload.rowBucket),
    ).toEqual(["lt100", "100to1000", "100to1000", "gt1000"]);
  });
  it("reuses installations, retains original page attribution for pending API and closes before SPA enter", async () => {
    const f = fixture();
    expect(createTracker(f.config)).toBe(f.tracker);
    let resolve!: (value: { status: number }) => void;
    const pending = f.quality.observeApi(
      "/save",
      () => new Promise((r) => (resolve = r)),
    );
    history.pushState({}, "", "/next");
    resolve({ status: 200 });
    await pending;
    const events = await f.finish();
    const api = events.find((e) => e.event === "api"),
      view = events.find((e) => e.event === "page_view");
    expect(api.pageViewId).toBe(view.pageViewId);
    expect(events.findIndex((e) => e.event === "page_leave")).toBeLessThan(
      events.findIndex((e) => e.event === "page_view" && e.pageRoute === "/next"),
    );
  });
  it("does not attach a later page's breadcrumbs to a pending resource", async () => {
    const f = fixture();
    f.quality.action();
    let reject!: (reason: Error) => void;
    const pending = f.quality
      .observeResource(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      )
      .catch((error) => error);
    history.pushState({}, "", "/resource-next");
    f.quality.action();
    f.quality.action();
    const original = new Error("private");
    reject(original);
    expect(await pending).toBe(original);
    const events = await f.finish();
    const error = events.find((e) => e.event === "error");
    expect(error.pageViewId).toBe(
      events.find((e) => e.event === "page_view").pageViewId,
    );
    expect(Object.values(error.payload.breadcrumb)).toEqual(["navigation", "action"]);
  });
  it("rejects arbitrary API paths and never changes host outcomes when telemetry fails", async () => {
    const f = fixture();
    const value = { status: 200 };
    expect(await f.quality.observeApi("/save?token=private", async () => value)).toBe(
      value,
    );
    const evil = new Proxy(
      { status: 200 },
      {
        get(target, key) {
          if (key === "status") throw new Error("getter");
          return Reflect.get(target, key);
        },
      },
    );
    expect(await f.quality.observeApi("/save", async () => evil)).toBe(evil);
    expect((await f.finish()).filter((e) => e.event === "api")).toHaveLength(0);
  });
  it("keeps the original thrown Error even when its telemetry name getter throws", async () => {
    const f = fixture();
    const error = new Error("host");
    Object.defineProperty(error, "name", {
      get() {
        throw new Error("telemetry getter");
      },
    });
    try {
      await f.quality.observeApi("/save", async () => {
        throw error;
      });
      throw new Error("unexpected success");
    } catch (caught) {
      expect(caught === error).toBe(true);
    }
    const events = await f.finish();
    expect(
      events.find((e) => e.event === "page_leave")?.payload.qualitySuppressed,
    ).toBe(1);
  });
  it("distinguishes an empty template from a detector that never settled", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const options = {
      blankScreen: { routes: { [location.pathname]: "#r5a_missing_root" } },
    };
    const f = fixture(options);
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      (await f.finish()).find((e) => e.event === "page_leave")?.payload.blankScreen,
    ).toBe(true);
    const early = fixture(options);
    expect(
      (await early.finish()).find((e) => e.event === "page_leave")?.payload.blankScreen,
    ).toBeUndefined();
    vi.restoreAllMocks();
  });
  it("settles pending longtask entries before leave and disconnects on destroy", async () => {
    let disconnected = 0;
    let pending = [{ duration: 51 }, { duration: 50 }];
    class Observer {
      static supportedEntryTypes = ["longtask"];
      observe() {}
      disconnect() {
        disconnected++;
      }
      takeRecords() {
        const result = pending;
        pending = [];
        return result;
      }
    }
    const previous = window.PerformanceObserver;
    Object.defineProperty(window, "PerformanceObserver", {
      value: Observer,
      configurable: true,
      writable: true,
    });
    try {
      const f = fixture({ longtasks: true });
      const events = await f.finish();
      expect(events.find((e) => e.event === "page_leave")?.payload).toMatchObject({
        longtaskCount: 1,
        longtaskTotal: 51,
      });
      expect(disconnected).toBe(1);
    } finally {
      Object.defineProperty(window, "PerformanceObserver", {
        value: previous,
        configurable: true,
        writable: true,
      });
    }
  });
});
