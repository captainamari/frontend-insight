// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleDiagnostics, type ConsoleOptions } from "../src/console.js";
import { snapshotArguments, jsonBytes } from "../src/console-snapshot.js";
import {
  createTracker,
  type Tracker,
  type TrackerRuntime,
  type TrackerEvent,
} from "../src/index.js";
import { diagnosticBudgetError } from "@frontend-insight/event-contract/diagnostics";
import { validateForIngestion } from "@frontend-insight/event-contract";
import { createQualityCollectors } from "../src/quality.js";
import { createReactErrorHandler } from "../src/errors.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f());
  vi.restoreAllMocks();
});
function fixture(
  options: Partial<ConsoleOptions> = {},
  host: Record<string, unknown> = {
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  appId = "fi_test",
) {
  const extract = createConsoleDiagnostics({ scope: { appId }, ...options });
  const scope = { appId };
  let now = 100000,
    page = "pv_first";
  const runtime = {
    window: { console: host },
    now: () => now,
  } as unknown as TrackerRuntime;
  const stop = extract.start!(runtime, () => page, scope);
  cleanup.push(stop);
  return {
    extract,
    scope,
    host: host as unknown as Console,
    stop,
    time: (n: number) => {
      now = n;
    },
    page: (p: string) => {
      page = p;
    },
    freeze: (error: unknown = new Error("token=exception")) =>
      extract.call(scope, error, "explicit")!.diagnostic,
  };
}
function logs(d: ReturnType<ReturnType<typeof fixture>["freeze"]>) {
  return d.raw.console as {
    parameters: unknown[];
    level: string;
    timestamp: number;
    relativeMs: number;
    sequence: number;
    pageViewId: string;
    issues: string[];
  }[];
}
describe("D2 console snapshots and bounded budgets", () => {
  it("defaults to warn/error, freezes each error, keeps call-time values and stable order", () => {
    const f = fixture();
    const object = { nested: { token: "synthetic" } };
    f.host.log("excluded");
    f.host.warn("first", object);
    object.nested.token = "changed";
    f.time(100010);
    f.host.error("second");
    f.time(100020);
    const first = f.freeze();
    f.host.warn("later");
    const second = f.freeze();
    expect(logs(first).map((l) => l.parameters)).toEqual([
      ["first", { nested: { token: "synthetic" } }],
      ["second"],
    ]);
    expect(logs(first).map((l) => l.relativeMs)).toEqual([-20, -10]);
    expect(logs(first).map((l) => l.sequence)).toEqual([1, 2]);
    expect(logs(second)).toHaveLength(3);
    logs(second)[0]!.parameters[0] = "mutated snapshot";
    expect(logs(first)[0]!.parameters[0]).toBe("first");
    expect(logs(f.freeze())[0]!.parameters[0]).toBe("first");
  });
  it("metadata and configuration cannot mutate another exception or instance", () => {
    const options: ConsoleOptions = { scope: { appId: "fi_test" } };
    const f = fixture(options);
    options.scope.appId = "fi_changed";
    f.host.warn("snapshot");
    const first = f.freeze();
    const meta = first.raw.consoleCapture as {
      limits: { entries: number };
      unavailableLevels: string[];
    };
    meta.limits.entries = 0;
    meta.unavailableLevels.push("warn");
    expect(f.freeze().raw.consoleCapture).toMatchObject({
      scopeAppId: "fi_test",
      limits: { entries: 50 },
      unavailableLevels: [],
    });
    expect(logs(f.freeze())).toHaveLength(1);
  });
  it("keeps errors and newest logs within the total envelope after metadata/status changes", () => {
    const f = fixture();
    for (let i = 0; i < 50; i++) f.host.warn(i, "x".repeat(2000));
    const error = new AggregateError(
      Array.from({ length: 20 }, () => ({ message: "中".repeat(5000) })),
      "essential message",
    );
    Object.defineProperty(error, "stack", {
      value: "Error: essential\n at essential (/app.js:7:8)",
      configurable: true,
    });
    const d = f.extract.call(f.scope, error, "explicit")!.diagnostic;
    expect(diagnosticBudgetError(d)).toBeNull();
    expect(d.raw.error).toMatchObject({
      message: "essential message",
      stack: "Error: essential\n at essential (/app.js:7:8)",
    });
    expect(jsonBytes(d)).toBeLessThanOrEqual(65536);
    expect(logs(d).at(-1)!.parameters[0]).toBe(49);
    expect(d.raw.consoleCapture).toMatchObject({
      count: logs(d).length,
      bytes: jsonBytes(logs(d)),
    });
  });
  it("custom levels and explicit not-enabled/empty/unavailable states", () => {
    const f = fixture({ levels: ["log", "info", "debug"] });
    expect(f.freeze().raw.consoleCapture).toMatchObject({ state: "empty" });
    f.host.error("excluded");
    f.host.log("log");
    f.host.info("info");
    f.host.debug("debug");
    expect(logs(f.freeze()).map((l) => l.level)).toEqual(["log", "info", "debug"]);
    expect(fixture({ enabled: false }).freeze().raw.consoleCapture).toMatchObject({
      state: "not_enabled",
    });
    expect(
      fixture({}, undefined, "fi_other").freeze().raw.consoleCapture,
    ).toBeDefined();
    expect(
      fixture({}, Object.preventExtensions({})).freeze().raw.consoleCapture,
    ).toMatchObject({ state: "unavailable" });
  });
  it("50-entry, 24KiB, 60-second and whole-record 2KiB caps retain newest logs", () => {
    const f = fixture({
      maximumEntries: 500,
      maximumBytes: 999999,
      windowMs: 999999,
      entryBytes: 999999,
    });
    for (let i = 0; i < 51; i++) f.host.warn(i);
    let d = f.freeze();
    expect(logs(d)).toHaveLength(50);
    expect(logs(d)[0]!.parameters).toEqual([1]);
    expect(d.raw.consoleCapture).toMatchObject({ removed: { capacity: 1 } });
    f.time(160000);
    expect(logs(f.freeze())).toHaveLength(50);
    f.time(160001);
    expect(logs(f.freeze())).toHaveLength(0);
    expect(f.freeze().raw.consoleCapture).toMatchObject({ removed: { window: 50 } });
    for (let i = 0; i < 100; i++) f.host.warn(i, '中\0\n"'.repeat(10000));
    d = f.freeze();
    expect(logs(d).at(-1)!.parameters[0]).toBe(99);
    expect(jsonBytes(logs(d))).toBeLessThanOrEqual(24576);
    expect(logs(d).every((l) => jsonBytes(l) <= 2048)).toBe(true);
    expect(diagnosticBudgetError(d)).toBeNull();
    expect(d.status).toBe("truncated");
    expect(d.raw.consoleCapture).toMatchObject({
      bytes: jsonBytes(logs(d)),
      count: logs(d).length,
    });
    expect(
      (d.raw.consoleCapture as { removed: { bytes: number } }).removed.bytes,
    ).toBeGreaterThan(0);
  });
  it("tighter or zero budgets cannot turn a console overflow into a lost error", () => {
    for (const entryBytes of [0, 50, 250, 600, 2048]) {
      const f = fixture({ entryBytes, maximumBytes: 1000, maximumEntries: 3 });
      for (let i = 0; i < 10; i++) f.host.error("中".repeat(1000));
      const d = f.freeze();
      expect(diagnosticBudgetError(d)).toBeNull();
      expect(d.raw.error).toMatchObject({ message: "token=exception" });
      expect(jsonBytes(logs(d))).toBeLessThanOrEqual(1000);
      expect(logs(d).length).toBeLessThanOrEqual(3);
    }
  });
  it("never executes getter/toJSON/conversion, handles cycles, BigInt, null and Error trees", () => {
    const getter = vi.fn(() => {
      throw new Error("getter");
    });
    const toJSON = vi.fn(() => {
      throw new Error("toJSON");
    });
    const object: Record<string, unknown> = {
      toJSON,
      bigint: 22n,
      nil: null,
      absent: undefined,
      symbol: Symbol("s"),
    };
    Object.defineProperty(object, "secret", { enumerable: true, get: getter });
    object.self = object;
    const s = snapshotArguments([object], 1400);
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(JSON.stringify(s)).toContain("bigint:22");
    expect(JSON.stringify(s)).toContain("circular");
    expect(JSON.stringify(s)).toContain("undefined");
    expect(JSON.stringify(s)).toContain("unreadable_accessor");
    const error = new AggregateError([new Error("child")], "message", {
      cause: new Error("cause"),
    });
    Object.defineProperty(error.cause, "stack", {
      value: "Error: cause\n at inner (/a.js:1:2)",
      configurable: true,
    });
    Object.defineProperty(error.errors[0], "stack", {
      value: "Error: child\n at child (/a.js:2:3)",
      configurable: true,
    });
    Object.defineProperty(error, "stack", {
      value: "Error: message\n at fn (/asset.js:12:3)",
      configurable: true,
    });
    const f = fixture();
    f.host.error(error);
    expect(logs(f.freeze())[0]!.parameters[0]).toMatchObject({
      name: "AggregateError",
      message: "message",
      stack: error.stack,
      cause: { message: "cause" },
      errors: [{ message: "child" }],
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("enumeration");
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() =>
      f.host.error(proxy, revoked.proxy, new Date(), /x/, new Map()),
    ).not.toThrow();
    expect(JSON.stringify(logs(f.freeze()))).toContain("unreadable_object");
    expect(JSON.stringify(logs(f.freeze()))).toContain("special_object");
  });
  it("Proxy descriptor/prototype failures and self-logging traps stay bounded", () => {
    const f = fixture();
    f.host.warn(
      new Proxy(
        { x: 1 },
        {
          getOwnPropertyDescriptor() {
            throw new Error("descriptor");
          },
        },
      ),
    );
    f.host.warn(
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("prototype");
          },
        },
      ),
    );
    f.host.warn(
      new Proxy(
        {},
        {
          ownKeys() {
            f.host.warn("recursive");
            return [];
          },
        },
      ),
    );
    expect(logs(f.freeze())).toHaveLength(3);
  });
});
describe("D2 wrapping, scopes and lifecycle", () => {
  it("preserves exact receiver, original references, order, return and thrown value", () => {
    const calls: unknown[] = [],
      token = {},
      original = function (this: unknown, ...args: unknown[]) {
        calls.push([this, ...args]);
        return token;
      };
    const host = {
      warn: original,
      error() {
        throw token;
      },
    };
    const f = fixture({}, host);
    const receiver = {};
    const input = { a: 1 };
    expect(f.host.warn.call(receiver, input, 2)).toBe(token);
    expect(calls[0]).toEqual([receiver, input, 2]);
    expect((calls[0] as unknown[])[1]).toBe(input);
    expect(() => f.host.error("fails")).toThrow(token);
    expect(logs(f.freeze())).toHaveLength(1);
    f.stop();
    expect(host.warn).toBe(original);
  });
  it("only completed calls precede exceptions, framework handler output comes afterwards", () => {
    let inside: ReturnType<ReturnType<typeof fixture>["freeze"]> | undefined;
    const host = {
      warn() {
        inside = f.freeze();
      },
      error: vi.fn(),
    };
    const f = fixture({}, host);
    f.host.warn("in-progress");
    expect(logs(inside!)).toHaveLength(0);
    let captured: typeof inside;
    createReactErrorHandler(
      () => {
        captured = f.freeze();
      },
      () => f.host.error("handler output"),
    )(new Error());
    expect(logs(captured!).map((l) => l.parameters)).toEqual([["in-progress"]]);
    expect(logs(f.freeze())).toHaveLength(2);
  });
  it("shares wrappers, isolates mutable records, restores third party only while owning methods", () => {
    const original = vi.fn();
    const host = { warn: original };
    const a = fixture({}, host),
      wrapper = host.warn,
      b = fixture({}, host);
    expect(host.warn).toBe(wrapper);
    a.host.warn("shared");
    logs(a.freeze())[0]!.parameters.push("mutation");
    expect(logs(b.freeze())[0]!.parameters).toEqual(["shared"]);
    a.stop();
    expect(host.warn).toBe(wrapper);
    b.host.warn("still active");
    expect(logs(b.freeze())).toHaveLength(2);
    b.stop();
    expect(host.warn).toBe(original);
    const c = fixture({}, host);
    const replacement = vi.fn();
    host.warn = replacement;
    c.stop();
    expect(host.warn).toBe(replacement);
  });
  it("cross-project conflicts clear raw buffers; page changes and reinitialization isolate", () => {
    const host = { warn: vi.fn() };
    const a = fixture({}, host);
    a.host.warn("before second owner");
    const b = fixture({}, host, "fi_other");
    a.host.warn("ambiguous");
    expect(logs(a.freeze())).toEqual([]);
    expect(logs(b.freeze())).toEqual([]);
    expect(a.freeze().raw.consoleCapture).toMatchObject({ state: "scope_conflict" });
    b.stop();
    a.host.warn("first page");
    a.page("pv_next");
    a.host.warn("next page");
    expect(logs(a.freeze()).map((l) => [l.pageViewId, l.parameters])).toEqual([
      ["pv_next", ["next page"]],
    ]);
    a.stop();
    const c = fixture({}, host);
    expect(logs(c.freeze())).toHaveLength(0);
  });
  it("safely tolerates missing/non-writable methods and does not prefix-filter business logs", () => {
    const host = { warn: vi.fn() };
    Object.defineProperty(host, "error", { value: vi.fn(), writable: false });
    const f = fixture({}, host);
    f.host.warn("[frontend-insight] SDK_INTERNAL_ERROR");
    expect(logs(f.freeze())[0]!.parameters[0]).toBe(
      "[frontend-insight] SDK_INTERNAL_ERROR",
    );
    expect(f.freeze().raw.consoleCapture).toMatchObject({
      unavailableLevels: expect.arrayContaining(["error", "log"]),
    });
  });
});

describe("D2 actual tracker wiring and inherited counts", () => {
  function trackerFixture(development = false) {
    const appId = `fi_${crypto.randomUUID().slice(0, 8)}`;
    const bodies: string[] = [];
    const quality = createQualityCollectors({ jsErrors: true });
    const config = {
      appId,
      env: "dev" as const,
      release: "d2",
      development,
      endpoint: "https://collector.test/v1/events",
      errorDiagnostics: createConsoleDiagnostics({ scope: { appId } }),
      quality: quality.factory,
      observability: { enabled: true, captureWebVitals: false },
      runtime: {
        window,
        document,
        navigator: { userAgent: "Chrome", sendBeacon: () => false },
        crypto,
        now: Date.now,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        fetch: vi.fn(async (_url, init) => {
          bodies.push(String(init?.body));
          return new Response(null, { status: 202 });
        }) as typeof fetch,
      },
    };
    const tracker = createTracker(config);
    cleanup.push(() => tracker.destroy());
    return {
      tracker,
      config,
      bodies,
      errors: () =>
        bodies
          .flatMap((b) => JSON.parse(b).events as TrackerEvent[])
          .filter((e) => e.event === "error"),
    };
  }
  it("console alone never counts; global dedup, independent errors and rate limits preserve 25 base events", async () => {
    const f = trackerFixture();
    expect(createTracker(f.config)).toBe(f.tracker);
    window.console.warn("FI_D2_SYNTHETIC token=log");
    await f.tracker.flush();
    expect(f.errors()).toHaveLength(0);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("token=global") }));
    for (let i = 0; i < 24; i++)
      f.tracker.captureException(new Error("token=independent"));
    await f.tracker.flush();
    expect(f.errors()).toHaveLength(25);
    expect(
      f.errors().filter((e) => e.diagnostic?.status === "rate_limited"),
    ).toHaveLength(5);
    expect(logs(f.errors()[0]!.diagnostic!)[0]!.parameters).toEqual([
      "FI_D2_SYNTHETIC token=log",
    ]);
    for (const body of f.bodies)
      expect(validateForIngestion(JSON.parse(body)).ok).toBe(true);
    expect(JSON.stringify(f.errors().map((e) => e.payload))).not.toContain(
      "FI_D2_SYNTHETIC",
    );
  });
  it("queued and retried exceptions cannot change after later console calls or objects mutate", async () => {
    const f = trackerFixture();
    const obj = { value: "before" };
    window.console.warn(obj);
    f.tracker.captureException(new Error("one"));
    obj.value = "after";
    window.console.warn("second");
    f.tracker.captureException(new Error("two"));
    let attempt = 0;
    vi.mocked(f.config.runtime.fetch).mockImplementation(async (_url, init) => {
      f.bodies.push(String(init?.body));
      if (++attempt === 1) {
        window.console.warn("during retry");
        throw new Error("offline");
      }
      return new Response(null, { status: 202 });
    });
    await f.tracker.flush();
    expect(f.bodies[0]).toBe(f.bodies[1]);
    const events = (JSON.parse(f.bodies[0]!).events as TrackerEvent[]).filter(
      (e) => e.event === "error",
    );
    expect(logs(events[0]!.diagnostic!)[0]!.parameters).toEqual([{ value: "before" }]);
    expect(logs(events[0]!.diagnostic!)).toHaveLength(1);
    expect(logs(events[1]!.diagnostic!)).toHaveLength(2);
  });
  it("SDK warnings bypass capture while identical business prefixes are retained", async () => {
    const f = trackerFixture(true);
    f.tracker.track("invalid name");
    createTracker({ ...f.config, appId: "INVALID" });
    window.console.warn("[frontend-insight] CUSTOM_NAME_INVALID");
    f.tracker.captureException(new Error("after warnings"));
    await f.tracker.flush();
    expect(logs(f.errors()[0]!.diagnostic!).map((l) => l.parameters)).toEqual([
      ["[frontend-insight] CUSTOM_NAME_INVALID"],
    ]);
  });
  it("destroying one actual tracker preserves another tracker after navigation", async () => {
    const f = trackerFixture();
    const second = createTracker({
      ...f.config,
      release: "d2-second",
      quality: createQualityCollectors({ jsErrors: true }).factory,
    });
    cleanup.push(() => second.destroy());
    window.console.warn("before first destroy");
    f.tracker.destroy();
    window.history.pushState({}, "", "/d2-two-active");
    window.console.warn("second new page");
    second.captureException(new Error("second"));
    await second.flush();
    expect(logs(f.errors().at(-1)!.diagnostic!).map((l) => l.parameters)).toEqual([
      ["second new page"],
    ]);
  });
  it("actual navigation/destroy/reinitialize clears captured page history", async () => {
    const f = trackerFixture();
    window.console.warn("old page");
    window.history.pushState({}, "", "/d2-next");
    window.console.warn("new page");
    f.tracker.captureException(new Error("new"));
    await f.tracker.flush();
    expect(logs(f.errors()[0]!.diagnostic!).map((l) => l.parameters)).toEqual([
      ["new page"],
    ]);
    f.tracker.destroy();
    const next: Tracker = createTracker(f.config);
    cleanup.push(() => next.destroy());
    next.captureException(new Error("reinit"));
    await next.flush();
    expect(logs(f.errors().at(-1)!.diagnostic!)).toHaveLength(0);
  });
});
