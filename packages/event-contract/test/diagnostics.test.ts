import { describe, it, expect } from "vitest";
import { validateTransportBatch } from "../src/validator.js";
import type { DiagnosticEnvelope } from "../src/index.js";
import { validBatches } from "@frontend-insight/test-fixtures";
import { diagnosticBudgetError } from "../src/diagnostics.js";
const diagnostic: DiagnosticEnvelope = {
  diagnosticVersion: 1,
  contentType: "application/json",
  source: "explicit",
  policyVersion: "d0-1",
  status: "complete",
  omittedBytes: 0,
  suppressed: 0,
  correlation: { traceId: "synthetic_trace" },
  raw: {
    message: "token=FI_D0_SYNTHETIC\nline 2",
    url: "https://fixture.invalid/x?token=synthetic#section",
    nested: { authorization: "Bearer synthetic", password: "synthetic" },
  },
};
const batch = () => {
  const b = structuredClone(validBatches[0]!);
  b.events = [
    {
      ...b.events[0]!,
      event: "error",
      payload: {
        errorType: "js",
        errorCategory: "js",
        errorName: "Error",
        errorMessage: "Explicit diagnostic",
        stackTopFrame: "",
      },
      diagnostic: structuredClone(diagnostic),
    },
  ];
  return b;
};
describe("D0 versioned raw slot", () => {
  it("round trips raw JSON and preserves existing v3", () => {
    for (const b of validBatches) expect(validateTransportBatch(b).ok).toBe(true);
    const b = batch();
    const result = validateTransportBatch(JSON.parse(JSON.stringify(b)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.events[0]!.diagnostic).toEqual(diagnostic);
  });
  it("does not exempt ordinary or metadata fields, arbitrary names, unknown versions or project mixing", () => {
    for (const change of [
      (b: ReturnType<typeof batch>) => {
        b.events[0]!.payload.errorMessage = "token=synthetic";
      },
      (b: ReturnType<typeof batch>) => {
        b.events[0]!.diagnostic!.policyVersion = "token=synthetic";
      },
      (b: ReturnType<typeof batch>) => {
        Object.assign(b.events[0]!, { other: { raw: { token: "synthetic" } } });
      },
      (b: ReturnType<typeof batch>) => {
        Object.assign(b.events[0]!.diagnostic!, { diagnosticVersion: 2 });
      },
      (b: ReturnType<typeof batch>) => {
        b.events.push({
          ...b.events[0]!,
          appId: "another_project",
          eventId: "evt_other0000",
        });
      },
    ]) {
      const b = batch();
      change(b);
      expect(validateTransportBatch(b).ok).toBe(false);
    }
  });
  it("enforces exact UTF8 envelope boundary without widening base-event budget", () => {
    const b = batch(),
      d = b.events[0]!.diagnostic!;
    d.raw = { text: "" };
    const overhead = Buffer.byteLength(JSON.stringify(d));
    d.raw.text = "a".repeat(65536 - overhead);
    expect(validateTransportBatch(b).ok).toBe(true);
    d.raw.text += "中";
    expect(validateTransportBatch(b).ok).toBe(false);
    b.events[0]!.diagnostic = structuredClone(diagnostic);
    b.events[0]!.ua = "a".repeat(9000);
    expect(validateTransportBatch(b).ok).toBe(false);
  });
  it("counts console JSON quoting, escaping and metadata inside the 2 KiB record cap", () => {
    const d = structuredClone(diagnostic);
    d.raw.console = ["a".repeat(2046)];
    expect(diagnosticBudgetError(d)).toBeNull();
    d.raw.console = ["a".repeat(2047)];
    expect(diagnosticBudgetError(d)).toBe("console_entry");
    d.raw.console = [{ parameters: ["\0".repeat(400)], level: "warn" }];
    expect(diagnosticBudgetError(d)).toBe("console_entry");
  });
  it("bounds reserved stack, cause, console, body and header sections", () => {
    for (const raw of [
      { stack: "a".repeat(16385) },
      { stack: "at frame\n".repeat(33) },
      { console: Array(51).fill("x") },
      { console: ["a".repeat(2049)] },
      { request: { responseBody: "a".repeat(16385) } },
      { request: { requestHeaders: "a".repeat(4097) } },
      { cause: { cause: { cause: { cause: { cause: {} } } } } },
    ])
      expect(diagnosticBudgetError({ ...diagnostic, raw })).not.toBeNull();
    expect(diagnosticBudgetError(diagnostic)).toBeNull();
  });
  it("requires empty raw for absent states", () => {
    const b = batch();
    b.events[0]!.diagnostic!.status = "rate_limited";
    expect(validateTransportBatch(b).ok).toBe(false);
    b.events[0]!.diagnostic!.raw = {};
    expect(validateTransportBatch(b).ok).toBe(true);
  });
});

describe("D3 request collections", () => {
  const evidence = (value = "token=synthetic") => ({
    state: "captured",
    value,
    bytes: Buffer.byteLength(JSON.stringify(value)),
  });
  const entry = () => ({
    kind: "request",
    localId: "local_1",
    sequence: 1,
    timestamp: 100,
    method: "POST",
    appId: batch().events[0]!.appId,
    pageViewId: batch().events[0]!.pageViewId,
    url: evidence("https://fixture.invalid/?token=synthetic"),
    result: "http",
    status: 503,
    association: {},
    basis: "temporal",
    requestBody: evidence(),
    responseBody: evidence(),
    requestHeaders: evidence(),
    responseHeaders: evidence(),
  });
  it("validates reserved arrays and every nested field without exempting project/page ownership", () => {
    const b = batch();
    b.events[0]!.diagnostic!.raw.requests = [entry()];
    expect(validateTransportBatch(b).ok).toBe(true);
    for (const change of [
      { appId: "fi_another" },
      { pageViewId: "pv_wrong" },
      { basis: "certain_cause" },
      { responseBody: evidence("\0".repeat(3000)) },
      { responseHeaders: evidence("中".repeat(1400)) },
      { timeline: { requestBody: "hidden" } },
    ]) {
      b.events[0]!.diagnostic!.raw.requests = [{ ...entry(), ...change }];
      expect(validateTransportBatch(b).ok).toBe(false);
    }
  });
  it("caps request count, collection bytes and timeline records including JSON escaping", () => {
    const d = structuredClone(diagnostic);
    d.raw.requests = Array.from({ length: 21 }, entry);
    expect(diagnosticBudgetError(d)).toBe("requests");
    d.raw.requests = Array.from({ length: 10 }, () => ({
      ...entry(),
      responseBody: evidence("a".repeat(3500)),
    }));
    expect(diagnosticBudgetError(d)).toBe("requests");
    d.raw.requests = [];
    d.raw.timeline = [{ context: "\n".repeat(1100) }];
    expect(diagnosticBudgetError(d)).toBe("timeline_entry");
    d.raw.timeline = Array(31).fill({});
    expect(diagnosticBudgetError(d)).toBe("timeline");
    d.raw.timeline = [];
    d.raw.requestCapture = { text: "x".repeat(2048) };
    expect(diagnosticBudgetError(d)).toBe("request_metadata");
  });
  it("counts legacy request strings with quotes and escapes and keeps raw scoped", () => {
    const d = structuredClone(diagnostic);
    d.raw.request = { responseBody: "x".repeat(16382) };
    expect(diagnosticBudgetError(d)).toBeNull();
    d.raw.request = { responseBody: "x".repeat(16383) };
    expect(diagnosticBudgetError(d)).toBe("body");
    d.raw.request = { requestHeaders: "\n".repeat(2048) };
    expect(diagnosticBudgetError(d)).toBe("headers");
  });
});
