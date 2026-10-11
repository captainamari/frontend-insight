import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestDiagnostics, type RequestRecord } from "../src/requests.js";
import { headersEvidence, textEvidence } from "../src/request-evidence.js";
import { jsonBytes } from "../src/console-snapshot.js";
import type { TrackerRuntime, Tracker } from "../src/types.js";
import { diagnosticBudgetError } from "@frontend-insight/event-contract/diagnostics";
const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((f) => f()));
function fixture(
  options: Partial<Parameters<typeof createRequestDiagnostics>[0]> = {},
  appId = "fi_test",
) {
  let now = 100000,
    page = "pv_first";
  const host = { warn() {}, error() {}, info() {}, log() {}, debug() {} };
  const requests = createRequestDiagnostics({
    scope: { appId },
    ...options,
  });
  const scope = { appId, endpoint: "https://fixture.invalid/v1/events" };
  const runtime = {
    window: {
      console: host,
      location: { href: "https://fixture.invalid/page?token=test" },
    },
    now: () => now,
  } as unknown as TrackerRuntime;
  const stop = requests.errorDiagnostics.start!(runtime, () => page, scope);
  stops.push(stop);
  const freeze = (e = new Error("token=exception")) =>
    requests.errorDiagnostics.call(scope, e, "explicit")!.diagnostic;
  return {
    requests,
    scope,
    host,
    runtime,
    stop,
    freeze,
    tick: (n: number) => (now += n),
    page: (p: string) => (page = p),
  };
}
const records = (f: ReturnType<typeof fixture>) =>
  f.freeze().raw.requests as RequestRecord[];
describe("D3 controlled request evidence", () => {
  it("preserves arguments, receiver, Response identity and original text without consuming streams", async () => {
    const f = fixture();
    const body = '{ "token": "synthetic", "n": [1, 2] }\n';
    const response = new Response(body, {
      status: 503,
      headers: { "x-token": "synthetic" },
    });
    const receiver = {};
    const init = {
      method: "POST",
      headers: { authorization: "Bearer synthetic" },
      body: "token=hello\n中",
    };
    const original = vi.fn(function (this: unknown, input: unknown, options: unknown) {
      expect(this).toBe(receiver);
      expect(input).toBe("/submit?token=query");
      expect(options).toBe(init);
      return Promise.resolve(response);
    }) as unknown as typeof fetch;
    const wrapped = f.requests
      .bind({ requestId: "server_req", operationInstanceId: "op_one" })
      .wrapFetch(original);
    const result = await wrapped.call(receiver, "/submit?token=query", init);
    expect(result).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(records(f)[0]!.responseBody.state).toBe("host_text_required");
    const text = await response.text();
    f.tick(10);
    f.requests.responseText(response, text);
    const r = records(f)[0]!;
    expect(r.url.value).toBe("https://fixture.invalid/submit?token=query");
    expect(r.requestBody.value).toBe(init.body);
    expect(r.responseBody.value).toBe(body);
    expect(r.responseHeaders.value).toContain("x-token: synthetic");
    expect(r.requestHeaders.value).toContain("authorization: Bearer synthetic");
    expect(r.result).toBe("http");
    expect(r.status).toBe(503);
    expect(r.bodyCapturedAt).toBe(100010);
    expect(original).toHaveBeenCalledTimes(1);
    expect(diagnosticBudgetError(f.freeze())).toBeNull();
  });
  it("freezes pending, call-time objects and queue payload; later text and requests never rewrite history", async () => {
    const f = fixture();
    let resolve!: (r: Response) => void;
    const original = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const h = { "x-test": "before" };
    const promise = f.requests.bind().wrapFetch(original as typeof fetch)("/one", {
      headers: h,
      body: "text",
    });
    h["x-test"] = "after";
    const frozen = f.freeze(),
      wire = JSON.stringify(frozen);
    expect((frozen.raw.requests as RequestRecord[])[0].result).toBe("pending");
    f.tick(5);
    resolve(new Response("late", { status: 503 }));
    const response = await promise;
    f.requests.responseText(response, await response.text());
    expect(JSON.stringify(frozen)).toBe(wire);
    expect(records(f)[0]!.requestHeaders.value).toBe("x-test: before");
    await f.requests.bind().wrapFetch(async () => new Response())("/two");
    expect(JSON.stringify(frozen)).toBe(wire);
    expect(records(f)).toHaveLength(2);
  });
  it("keeps independent explicit operation/workflow/attempt bindings through out-of-order completion", async () => {
    const f = fixture();
    const responses: ((r: Response) => void)[] = [];
    const original = () => new Promise<Response>((r) => responses.push(r));
    const a = f.requests.bind({
      operationInstanceId: "op_a",
      workflowInstanceId: "wf_a",
      stepKey: "save",
      attemptId: "try1",
    });
    const b = f.requests.bind({
      operationInstanceId: "op_b",
      workflowInstanceId: "wf_b",
      stepKey: "save",
      attemptId: "try2",
    });
    const pa = a.wrapFetch(original)("/a"),
      pb = b.wrapFetch(original)("/b");
    f.tick(10);
    responses[1]!(new Response("b", { status: 503 }));
    await pb;
    f.tick(10);
    responses[0]!(new Response("a", { status: 503 }));
    await pa;
    let d: ReturnType<typeof f.freeze> | undefined;
    a.capture(
      { captureException: (e: unknown) => (d = f.freeze(e as Error)) } as Tracker,
      new Error("failure"),
    );
    const r = d!.raw.requests as RequestRecord[];
    expect(r.map((v) => v.association.workflowInstanceId)).toEqual(["wf_a", "wf_b"]);
    expect(r.map((v) => v.basis)).toEqual(["explicit", "temporal"]);
    expect(r[0].endedAt).toBeGreaterThan(r[1].endedAt);
  });
  it("never reads getters/toJSON/custom iterators or Request streams; passes all original inputs", async () => {
    const f = fixture();
    let calls = 0;
    const init = {
      get body() {
        calls++;
        return "secret";
      },
      get headers() {
        calls++;
        return {};
      },
    };
    const response = new Response("x", { status: 503 });
    const original = vi.fn(async () => response);
    await f.requests.bind().wrapFetch(original)("/safe", init);
    expect(calls).toBe(0);
    const request = new Request("https://fixture.invalid/", {
      method: "POST",
      body: "host",
    });
    await f.requests.bind().wrapFetch(original)(request);
    expect(request.bodyUsed).toBe(false);
    expect(original.mock.calls).toHaveLength(2);
    const hostile = {
      get authorization() {
        calls++;
        return "secret";
      },
      toJSON() {
        calls++;
      },
    };
    expect(headersEvidence(hostile).state).toContain("unreadable");
    expect(calls).toBe(0);
  });
  it("preserves sync throws/rejections/abort/timeouts and never turns HTTP 500 into rejection", async () => {
    const f = fixture();
    const e = new Error("original");
    const sync = f.requests.bind().wrapFetch(() => {
      throw e;
    });
    expect(() => sync("/sync")).toThrow(e);
    for (const name of ["AbortError", "TimeoutError", "Error"]) {
      const reason = new Error("original");
      reason.name = name;
      await expect(
        f.requests.bind().wrapFetch(() => Promise.reject(reason))("/reject"),
      ).rejects.toBe(reason);
    }
    expect(records(f).map((r) => r.result)).toEqual([
      "network",
      "aborted",
      "timeout",
      "network",
    ]);
    await expect(
      f.requests.bind().wrapFetch(async () => new Response("x", { status: 500 }))(
        "/http",
      ),
    ).resolves.toBeInstanceOf(Response);
  });
  it("cleans across navigation/destroy, ignores late completion and keeps wrappers owned by host", async () => {
    const f = fixture();
    let resolve!: (r: Response) => void;
    const original = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const bound = f.requests.bind();
    const wrapped = bound.wrapFetch(original);
    const promise = wrapped("/old");
    f.page("pv_next");
    f.freeze();
    resolve(new Response("late", { status: 503 }));
    const response = await promise;
    f.requests.responseText(response, "late");
    expect(records(f)).toHaveLength(0);
    f.stop();
    expect(f.requests.stats().requests).toBe(0);
    // A returned wrapper is not installed on the host and remains a pass-through after destroy.
    expect(bound.wrapFetch(wrapped)).toBe(wrapped);
  });
  it("captures successful bodies only on exact opted-in routes; business failure requires explicit evidence", async () => {
    const f = fixture({ successBodyRoutes: ["/enabled"] });
    const wrapped = f.requests
      .bind()
      .wrapFetch(async () => new Response('{ "success": false }'));
    const a = await wrapped("/default", { body: "request" });
    f.requests.responseText(a, await a.text());
    expect(records(f)[0]!.result).toBe("success");
    expect(records(f)[0]!.responseBody.state).toBe("success_body_disabled");
    const b = await wrapped("/enabled");
    f.requests.responseText(b, await b.text());
    expect(records(f)[1]!.responseBody.value).toBe('{ "success": false }');
    const c = await wrapped("/business");
    f.requests.responseText(c, await c.text(), true);
    expect(records(f)[2]!.result).toBe("business");
  });
  it("does zero reads/clones for slow, endless, absent/dishonest length, locked and binary streams", async () => {
    const f = fixture();
    let pulled = 0;
    const stream = new ReadableStream(
      {
        pull() {
          pulled++;
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, {
      status: 503,
      headers: { "content-length": "1" },
    });
    const clone = vi.spyOn(response, "clone");
    await f.requests.bind().wrapFetch(async () => response)("/stream");
    expect(clone).not.toHaveBeenCalled();
    expect(pulled).toBe(0);
    expect(response.body?.locked).toBe(false);
    expect(f.requests.stats().activeReads).toBe(0);
    expect(f.requests.stats().pendingReads).toBe(0);
    const reader = response.body!.getReader();
    await f.requests.bind().wrapFetch(async () => response)("/locked");
    expect(response.body?.locked).toBe(true);
    reader.releaseLock();
    expect(records(f).every((r) => r.responseBody.state === "host_text_required")).toBe(
      true,
    );
  });
  it("enforces JSON UTF8 field, per-request, collection, window, action and envelope budgets", async () => {
    const f = fixture();
    const text = "中\n\0😀".repeat(1000000);
    expect(jsonBytes(textEvidence(text))).toBeLessThanOrEqual(16384);
    for (let i = 0; i < 40; i++) {
      const response = await f.requests
        .bind()
        .wrapFetch(async () => new Response("x", { status: 503 }))("/large", {
        body: text,
      });
      f.requests.responseText(response, text);
      f.requests.bind().action("action", "target", { text });
      const d = f.freeze();
      expect(diagnosticBudgetError(d)).toBeNull();
      expect(jsonBytes(d)).toBeLessThanOrEqual(65536);
    }
    expect(f.requests.stats().requests).toBeLessThanOrEqual(20);
    expect(f.requests.stats().bytes).toBeLessThanOrEqual(32768);
    expect(f.requests.stats().actionBytes).toBeLessThanOrEqual(8192);
    f.tick(60001);
    expect(records(f)).toHaveLength(0);
  });
  it("bounds pending observations, excludes SDK/upload/routes and never calls more requests for evidence", async () => {
    const f = fixture({ excludeRoutes: ["/excluded"] });
    const original = vi.fn(() => new Promise<Response>(() => {}));
    const wrapper = f.requests.bind().wrapFetch(original);
    for (let i = 0; i < 1000; i++) void wrapper("/pending");
    expect(f.requests.stats().requests).toBe(4);
    expect(original).toHaveBeenCalledTimes(1000);
    const g = fixture({ excludeRoutes: ["/excluded"] });
    const completed = async () => new Response();
    await g.requests.bind().wrapFetch(completed)("https://fixture.invalid/v1/events");
    await g.requests.bind().wrapFetch(completed)("/excluded");
    await g.requests.bind().wrapFetch(completed, "upload")("/file");
    expect(records(g)).toHaveLength(0);
    expect(g.requests.stats().removed.excluded).toBe(3);
  });
  it("keeps multiple scoped adapters isolated, duplicate wrappers stable and old generations inert", async () => {
    const a = fixture(),
      b = fixture();
    const native = async () => new Response("x", { status: 503 });
    const bound = a.requests.bind();
    const wrapped = bound.wrapFetch(native);
    expect(bound.wrapFetch(native)).toBe(wrapped);
    await wrapped("/only-a");
    expect(records(a)).toHaveLength(1);
    expect(records(b)).toHaveLength(0);
    const before = a.freeze();
    a.stop();
    const stop = a.requests.errorDiagnostics.start!(
      a.runtime,
      () => "pv_restarted",
      a.scope,
    );
    stops.push(stop);
    await wrapped("/stale");
    bound.action("stale");
    expect(records(a)).toHaveLength(0);
    await a.requests.bind().wrapFetch(native)("/current");
    expect(records(a)).toHaveLength(1);
    expect((before.raw.requests as RequestRecord[])[0]!.url.value).toContain("only-a");
    // Destruction does not replace a host function installed later by another library.
    const replacement = async () => new Response("third-party");
    (a.runtime.window as unknown as { fetch: typeof fetch }).fetch = replacement;
    stop();
    expect(a.runtime.window.fetch).toBe(replacement);
    expect(records(b)).toHaveLength(0);
  });
  it("handles actual native DOMException aborts and leaves malformed/custom headers safely unavailable", async () => {
    const f = fixture();
    const abort = new DOMException("aborted", "AbortError");
    await expect(
      f.requests.bind().wrapFetch(() => Promise.reject(abort))("/abort"),
    ).rejects.toBe(abort);
    expect(records(f)[0]!.result).toBe("aborted");
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("trap");
        },
      },
    );
    expect(headersEvidence(hostile).state).toBe("captured"); // Empty own-key set, no access or fabricated values.
    const input = new Proxy(
      { authorization: "x" },
      {
        getOwnPropertyDescriptor() {
          throw new Error("trap");
        },
      },
    );
    expect(headersEvidence(input).state).toContain("unreadable");
  });
  it("retains failed evidence ahead of successes and budgets call-time bodies kept for explicit business classification", async () => {
    const f = fixture({ maximumEntries: 2 });
    const b = f.requests.bind();
    await b.wrapFetch(async () => new Response("failed", { status: 503 }))("/failure");
    await b.wrapFetch(async () => new Response("ok"))("/ok1", { body: "first" });
    const response = await b.wrapFetch(async () => new Response("business"))("/ok2", {
      body: "token=original",
    });
    expect(records(f).map((r) => r.url.value)).toEqual([
      "https://fixture.invalid/failure",
      "https://fixture.invalid/ok2",
    ]);
    expect(records(f)[1]!.requestBody.state).toBe("success_body_disabled");
    f.requests.responseText(response, "business", true);
    expect(records(f)[1]!.requestBody.value).toBe("token=original");
    for (let i = 0; i < 20; i++)
      await b.wrapFetch(async () => new Response("ok"))("/large-success", {
        body: "中".repeat(20000),
      });
    expect(f.requests.stats().bytes).toBeLessThanOrEqual(32768);
  });
  it("rebinding a controlled wrapper switches explicit ownership without duplicate/cross-project evidence", async () => {
    const a = fixture(),
      b = fixture({}, "fi_other");
    const native = vi.fn(async () => new Response("text", { status: 503 }));
    const wa = a.requests.bind({ operationInstanceId: "op_a" }).wrapFetch(native);
    const wb = b.requests.bind({ operationInstanceId: "op_b" }).wrapFetch(wa);
    const response = await wb("/owned-b", { body: "token=only-b" });
    b.requests.responseText(response, await response.text());
    expect(native).toHaveBeenCalledTimes(1);
    expect(records(a)).toHaveLength(0);
    expect(records(b)[0]).toMatchObject({
      appId: "fi_other",
      association: { operationInstanceId: "op_b" },
      requestBody: { value: "token=only-b" },
    });
  });
  it("keeps the latest association when an adapter reuses a Response across evicted records", async () => {
    const f = fixture({ maximumEntries: 2 });
    const response = new Response("text", { status: 503 });
    const wrapped = f.requests.bind().wrapFetch(async () => response);
    await wrapped("/first");
    await wrapped("/second");
    await wrapped("/third");
    f.requests.responseText(response, "latest text");
    expect(records(f).at(-1)!.responseBody.value).toBe("latest text");
    expect(f.requests.stats().responseAssociations).toBeLessThanOrEqual(2);
  });
  it("preserves non-native adapter returns without invoking their then getter", () => {
    const f = fixture();
    let touched = 0;
    const token = {
      get then() {
        touched++;
        throw new Error("host getter");
      },
    };
    const original = (() => token) as unknown as typeof fetch;
    expect(f.requests.bind().wrapFetch(original)("/custom")).toBe(token);
    expect(touched).toBe(0);
    expect(records(f)[0]!.result).toBe("pending");
  });
});
