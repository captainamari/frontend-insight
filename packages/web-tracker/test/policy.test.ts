// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createTracker, type Tracker, type TrackerEvent } from "../src/index.js";
import { createDiagnosticPolicy } from "../src/policy.js";
import {
  DEFAULT_DIAGNOSTIC_POLICY as defaults,
  diagnosticRouteMatches,
  validDiagnosticPolicy,
} from "@frontend-insight/event-contract/diagnostic-policy";
const trackers: Tracker[] = [];
afterEach(() => {
  trackers.splice(0).forEach((t) => t.destroy());
  vi.useRealTimers();
});
function fixture(context = true, invalid = false) {
  const appId = `fi_${crypto.randomUUID().slice(0, 8)}`;
  let remote = {
    revision: 1,
    version: "d6-1",
    updatedAt: null,
    policy: {
      ...structuredClone(defaults),
      ...(invalid ? { envelopesPerMinute: 999 } : {}),
    },
  };
  let fail = false;
  const events: TrackerEvent[] = [];
  const replies: { resolve: (r: Response) => void }[] = [];
  let defer = false;
  const adapter = createDiagnosticPolicy({
    appId,
    env: "dev",
    endpoint: "https://collector.test/v1/events",
    ...(context
      ? {
          console: { levels: ["warn", "info"] as const },
          requests: { successBodyRoutes: ["/ok"] },
        }
      : {}),
  });
  const fetcher = vi.fn(async (url, init) => {
    if (String(url).endsWith("workflow-config")) {
      if (fail) throw new Error("offline");
      if (defer) return new Promise<Response>((resolve) => replies.push({ resolve }));
      return Response.json({ appId, env: "dev", diagnostics: remote });
    }
    if (String(url).endsWith("diagnostics-health"))
      return Response.json({ accepted: true });
    events.push(...JSON.parse(String(init?.body)).events);
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  const tracker = createTracker({
    appId,
    env: "dev",
    release: "d6-test",
    endpoint: "https://collector.test/v1/events",
    errorDiagnostics: adapter.errorDiagnostics,
    observability: { enabled: true, captureWebVitals: false },
    runtime: {
      window,
      document,
      fetch: fetcher,
      navigator: { userAgent: "Chrome", sendBeacon: () => false },
      crypto: globalThis.crypto,
      now: Date.now,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
  });
  trackers.push(tracker);
  return {
    adapter,
    tracker,
    events,
    remote,
    fetcher,
    replies,
    appId,
    setRemote: (r: typeof remote) => (remote = r),
    fail: () => (fail = true),
    defer: () => (defer = true),
  };
}
it("validates hard bounds and bounded pathname semantics", () => {
  expect(validDiagnosticPolicy(defaults)).toBe(true);
  for (const patch of [
    { envelopeBytes: 65537 },
    { envelopesPerMinute: 21 },
    { retentionDays: 0 },
    { requestRoutes: ["/(.*)"] },
    { requestRoutes: ["/a?token=x"] },
    { extra: true },
    { consoleLevels: ["warn", "warn"] },
  ])
    expect(validDiagnosticPolicy({ ...defaults, ...patch })).toBe(false);
  expect(diagnosticRouteMatches("/api/item", ["/api/**"])).toBe(true);
  expect(diagnosticRouteMatches("/api", ["/api/**"])).toBe(true);
  expect(diagnosticRouteMatches("/apix", ["/api/**"])).toBe(false);
});
it("applies policy, freezes queued raw, disables wrappers and keeps one base fact per error", async () => {
  const original = window.console.warn;
  const f = fixture();
  await f.adapter.sync();
  window.console.warn("synthetic before");
  f.tracker.captureException(new Error("before"));
  f.setRemote({
    ...f.remote,
    revision: 2,
    version: "d6-2",
    policy: { ...defaults, enabled: false },
  });
  await f.adapter.sync();
  expect(window.console.warn).toBe(original);
  f.tracker.captureException(new Error("disabled"));
  await f.tracker.flush();
  const errors = f.events.filter((e) => e.event === "error");
  expect(errors).toHaveLength(2);
  expect(errors[0]?.diagnostic?.policyVersion).toBe("d6-1");
  expect(JSON.stringify(errors[0]?.diagnostic?.raw)).toContain("synthetic before");
  expect(errors[1]?.diagnostic?.raw).toEqual({});
  f.setRemote({ ...f.remote, revision: 3, version: "d6-3" });
  await f.adapter.sync();
  expect(f.adapter.status().enabled).toContain("console");
  window.console.warn("synthetic after");
  f.tracker.captureException(new Error("after"));
  await f.tracker.flush();
  expect(f.events.filter((e) => e.event === "error")).toHaveLength(3);
  f.tracker.destroy();
  expect(window.console.warn).toBe(original);
});
it("keeps last valid policy on failures, rejects stale/out-of-order and post-destroy responses", async () => {
  const f = fixture();
  await f.adapter.sync();
  f.defer();
  const first = f.adapter.sync(),
    second = f.adapter.sync();
  f.replies[1]!.resolve(
    Response.json({
      appId: f.appId,
      env: "dev",
      diagnostics: { ...f.remote, revision: 4, version: "d6-4" },
    }),
  );
  await second;
  f.replies[0]!.resolve(
    Response.json({ appId: f.appId, env: "dev", diagnostics: f.remote }),
  );
  await first;
  expect(f.adapter.status().version).toBe("d6-4");
  f.fail();
  await f.adapter.sync();
  expect(f.adapter.status()).toMatchObject({ version: "d6-4", sync: "last_valid" });
  f.tracker.destroy();
  expect(f.adapter.status().sync).toBe("destroyed");
});
it("remote cannot install or authorize missing context modules", async () => {
  const original = window.console.warn;
  const f = fixture(false);
  await f.adapter.sync();
  expect(f.adapter.status().enabled).toEqual(["errors"]);
  expect(window.console.warn).toBe(original);
});
it("rejects invalid policy while keeping compatibility defaults at first start", async () => {
  const f = fixture(true, true);
  f.setRemote({ ...f.remote, policy: { ...defaults, envelopesPerMinute: 999 } });
  await f.adapter.sync();
  expect(f.adapter.status().revision).toBe(0);
  expect(f.adapter.status().sync).toBe("failed");
});
it("controlled fetch preserves response identity, reads no stream and clears pending evidence across policy changes", async () => {
  const f = fixture();
  await f.adapter.sync();
  const response = new Response("business text", { status: 503 });
  const text = vi.spyOn(response, "text"),
    clone = vi.spyOn(response, "clone");
  let finish!: (r: Response) => void;
  const original = vi.fn(
    () => new Promise<Response>((r) => (finish = r)),
  ) as typeof fetch;
  const pending = f.adapter.bind().wrapFetch(original)("https://app.test/fail");
  f.setRemote({
    ...f.remote,
    revision: 2,
    version: "d6-2",
    policy: { ...defaults, enabled: false },
  });
  await f.adapter.sync();
  finish(response);
  expect(await pending).toBe(response);
  expect(text).not.toHaveBeenCalled();
  expect(clone).not.toHaveBeenCalled();
  f.setRemote({ ...f.remote, revision: 3, version: "d6-3" });
  await f.adapter.sync();
  f.adapter.responseText(response, "already read");
  f.tracker.captureException(new Error("late"));
  await f.tracker.flush();
  expect(JSON.stringify(f.events)).not.toContain("already read");
  expect(original).toHaveBeenCalledTimes(1);
});
it("rejects another project's response and ignores a response after destroy", async () => {
  const f = fixture();
  await f.adapter.sync();
  f.defer();
  const pending = f.adapter.sync();
  f.replies[0]!.resolve(
    Response.json({
      appId: "fi_other",
      env: "dev",
      diagnostics: { ...f.remote, revision: 9, version: "d6-9" },
    }),
  );
  await pending;
  expect(f.adapter.status()).toMatchObject({ version: "d6-1", sync: "last_valid" });
  const late = f.adapter.sync();
  f.tracker.destroy();
  f.replies[1]!.resolve(
    Response.json({
      appId: f.appId,
      env: "dev",
      diagnostics: { ...f.remote, revision: 9, version: "d6-9" },
    }),
  );
  await late;
  expect(f.adapter.status()).toMatchObject({ version: "d6-1", sync: "destroyed" });
});
it("applies exact envelope rate, preserves errors, and bounds health attempts", async () => {
  const f = fixture();
  await f.adapter.sync();
  f.setRemote({
    ...f.remote,
    revision: 2,
    version: "d6-2",
    policy: { ...defaults, envelopesPerMinute: 1 },
  });
  await f.adapter.sync();
  f.tracker.captureException(new Error("first"));
  f.tracker.captureException(new Error("second"));
  await f.tracker.flush();
  const errors = f.events.filter((e) => e.event === "error");
  expect(errors).toHaveLength(2);
  expect(errors[0]!.diagnostic!.status).toBe("complete");
  expect(errors[1]!.diagnostic!.status).toBe("rate_limited");
  await f.adapter.reportHealth();
  await f.adapter.reportHealth();
  const calls = vi
    .mocked(f.fetcher)
    .mock.calls.filter(([url]) => String(url).endsWith("diagnostics-health"));
  expect(calls).toHaveLength(1);
  expect(new TextEncoder().encode(String(calls[0]![1]!.body)).byteLength).toBeLessThan(
    2048,
  );
});
