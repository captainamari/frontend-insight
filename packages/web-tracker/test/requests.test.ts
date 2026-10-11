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
) {
  let now = 100000,
    page = "pv_first";
  const host = { warn() {}, error() {}, info() {}, log() {}, debug() {} };
  const requests = createRequestDiagnostics({
    scope: { appId: "fi_test" },
    ...options,
  });
  const scope = { appId: "fi_test", endpoint: "https://fixture.invalid/v1/events" };
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
    const wrapped = f.requests.bind().wrapFetch(original);
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
    expect(f.requests.bind().wrapFetch(wrapped)).toBe(wrapped);
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
});
