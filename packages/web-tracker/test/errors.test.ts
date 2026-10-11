// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractError,
  createErrorDiagnostics,
  installVueErrorHandler,
  createReactErrorHandler,
} from "../src/errors.js";
import {
  createTracker,
  type Tracker,
  type TrackerEvent,
  type TrackerConfig,
} from "../src/index.js";
import { createQualityCollectors } from "../src/quality.js";
import { diagnosticBudgetError } from "@frontend-insight/event-contract/diagnostics";
import { validateForIngestion } from "@frontend-insight/event-contract";
const trackers: Tracker[] = [];
afterEach(() => {
  trackers.splice(0).forEach((t) => t.destroy());
  vi.useRealTimers();
});
function fixture() {
  const batches: { events: TrackerEvent[] }[] = [];
  const quality = createQualityCollectors({ jsErrors: true, breadcrumbs: true });
  const config: TrackerConfig = {
    appId: `fi_${crypto.randomUUID().slice(0, 8)}`,
    env: "dev",
    release: "d1-test",
    endpoint: "https://collector.test/v1/events",
    quality: quality.factory,
    errorDiagnostics: createErrorDiagnostics(),
    observability: { enabled: true, captureWebVitals: false },
    runtime: {
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
    },
  };
  const tracker = createTracker(config);
  trackers.push(tracker);
  return {
    tracker,
    quality,
    config,
    batches,
    async events() {
      await tracker.flush();
      return batches.flatMap((b) => b.events).filter((e) => e.event === "error");
    },
  };
}
describe("D1 bounded raw extraction", () => {
  it("retains raw name/message/stack/cause/AggregateError and nested synthetic values", () => {
    const cause = new Error("token=inner\n原文");
    const e = new AggregateError(
      [cause, { nested: { url: "https://fixture.invalid/a?token=synthetic" } }],
      "token=outer",
      { cause },
    );
    const d = extractError(e, "explicit");
    expect(d.status).toBe("complete");
    expect(d.raw.error).toMatchObject({
      name: "AggregateError",
      message: e.message,
      stack: e.stack,
      cause: { message: cause.message },
      errors: [
        { message: cause.message },
        { nested: { url: "https://fixture.invalid/a?token=synthetic" } },
      ],
    });
    expect(diagnosticBudgetError(d)).toBeNull();
  });
  it.each([
    "token=string\nnext",
    null,
    42,
    false,
    { nested: { password: "synthetic" } },
  ])("keeps non Error rejection %j without fabricating a stack", (value) => {
    const d = extractError(value, "promise");
    expect(JSON.stringify(d.raw)).toContain(
      typeof value === "object" && value !== null
        ? "synthetic"
        : String(value).replaceAll("\n", "\\n"),
    );
    expect((d.raw.error as Record<string, unknown>).stack).toBeUndefined();
  });
  it("never executes accessors or toJSON, handles cycles, BigInt and throwing proxies", () => {
    const getter = vi.fn(() => {
      throw new Error("host getter");
    });
    const e: Record<string, unknown> = {
      nested: { bigint: 42n },
      toJSON: vi.fn(() => {
        throw new Error("host toJSON");
      }),
    };
    Object.defineProperty(e, "message", { get: getter });
    e.self = e;
    const d = extractError(e, "explicit");
    expect(getter).not.toHaveBeenCalled();
    expect(e.toJSON).not.toHaveBeenCalled();
    expect(d.status).toBe("truncated");
    expect(JSON.stringify(d)).toContain("circular");
    expect(() =>
      extractError(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("trap");
            },
          },
        ),
        "explicit",
      ),
    ).not.toThrow();
    expect(diagnosticBudgetError(d)).toBeNull();
  });
  it("budgets JSON escaping and long unreadable property paths", () => {
    const d = extractError("\0".repeat(50000), "promise");
    expect(d.status).toBe("truncated");
    expect(diagnosticBudgetError(d)).toBeNull();
    const o = Object.create(null);
    for (let i = 0; i < 70; i++)
      Object.defineProperty(o, "x".repeat(2000) + i, {
        enumerable: true,
        get() {
          throw new Error("must not run");
        },
      });
    expect(diagnosticBudgetError(extractError(o, "explicit"))).toBeNull();
  });
  it("bounds UTF-8 stack bytes, 32 frames and four cause edges with explicit metadata", () => {
    let cause = new Error("leaf");
    for (let i = 0; i < 9; i++) cause = new Error("中".repeat(10000), { cause });
    cause.stack =
      "Error: token=synthetic\n" +
      Array.from(
        { length: 100 },
        (_, i) => ` at async fn${i} (/assets/app.js:10:20)`,
      ).join("\n");
    const d = extractError(cause, "global");
    expect(d.status).toBe("truncated");
    expect(d.omittedBytes).toBeGreaterThan(0);
    expect(diagnosticBudgetError(d)).toBeNull();
    expect(new TextEncoder().encode(JSON.stringify(d)).length).toBeLessThanOrEqual(
      65536,
    );
  });
});
describe("D1 shared collection and lifecycle", () => {
  it("both global listeners count once, independent errors keep counting after detail limit", async () => {
    const f = fixture();
    expect(createTracker(f.config)).toBe(f.tracker);
    const e = new Error("token=FI_D1_SYNTHETIC");
    window.dispatchEvent(new ErrorEvent("error", { error: e }));
    for (let i = 0; i < 24; i++)
      f.quality.captureException(new Error("token=FI_D1_SYNTHETIC"));
    const events = await f.events();
    expect(events).toHaveLength(25);
    expect(events.filter((e) => e.diagnostic?.status === "complete")).toHaveLength(20);
    expect(events.filter((e) => e.diagnostic?.status === "rate_limited")).toHaveLength(
      5,
    );
    for (const batch of f.batches) expect(validateForIngestion(batch).ok).toBe(true);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain(
      "FI_D1_SYNTHETIC",
    );
  });
  it("framework propagation deduplicates while repeated explicit and later same-object throws survive", async () => {
    const f = fixture(),
      e = new Error("same object");
    f.tracker.captureException(e, "vue");
    window.dispatchEvent(new ErrorEvent("error", { error: e }));
    f.tracker.captureException(e);
    f.tracker.captureException(e);
    await new Promise((resolve) => setTimeout(resolve, 5));
    window.dispatchEvent(new ErrorEvent("error", { error: e }));
    expect(await f.events()).toHaveLength(4);
  });
  it("destroy removes listeners and reinitialization works", async () => {
    const f = fixture();
    f.tracker.destroy();
    const before = f.batches.flatMap((b) => b.events).length;
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("after destroy") }),
    );
    await f.tracker.flush();
    expect(f.batches.flatMap((b) => b.events)).toHaveLength(before);
    const next = createTracker({
      ...f.config,
      errorDiagnostics: createErrorDiagnostics(),
    });
    trackers.push(next);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("after reinit") }));
    await next.flush();
    expect(
      f.batches.flatMap((b) => b.events).filter((e) => e.event === "error"),
    ).toHaveLength(1);
  });
  it("reused extractor isolates projects and destroy/reinit even in the same task", async () => {
    const f = fixture();
    const second = createTracker({
      ...f.config,
      appId: `fi_${crypto.randomUUID().slice(0, 8)}`,
      quality: createQualityCollectors({ jsErrors: false }).factory,
    });
    trackers.push(second);
    const e = new Error("same task across projects");
    f.tracker.captureException(e, "vue");
    second.captureException(e, "global");
    f.tracker.destroy();
    const next = createTracker({
      ...f.config,
      quality: createQualityCollectors({ jsErrors: false }).factory,
    });
    trackers.push(next);
    next.captureException(e, "global");
    await second.flush();
    await next.flush();
    expect(
      f.batches.flatMap((b) => b.events).filter((e) => e.event === "error"),
    ).toHaveLength(3);
  });
  it("null Promise reason stays null through shared listeners", async () => {
    const f = fixture();
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: null });
    window.dispatchEvent(event);
    const events = await f.events();
    expect(events).toHaveLength(1);
    expect(events[0]?.diagnostic?.raw.error).toMatchObject({
      reason: null,
      message: "null",
    });
  });
  it("framework adapters preserve receiver, arguments, returns, throws and cleanup", () => {
    const capture = vi.fn(),
      previous = vi.fn(function (this: unknown, ...args: unknown[]) {
        return [this, args];
      });
    const app = { config: { errorHandler: previous } },
      restore = installVueErrorHandler(app, capture);
    expect(installVueErrorHandler(app, capture)).toBe(restore);
    const e = new Error("framework");
    expect(app.config.errorHandler.call(app, e, "component")).toEqual([
      app,
      [e, "component"],
    ]);
    restore();
    expect(app.config.errorHandler).toBe(previous);
    const react = createReactErrorHandler(capture, () => {
      throw e;
    });
    expect(() => react(e)).toThrow(e);
    expect(capture).toHaveBeenCalledWith(e, "react");
  });
});
