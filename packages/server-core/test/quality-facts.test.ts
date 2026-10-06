import { describe, it, expect } from "vitest";
import {
  reduceQuality,
  type QualityEvent,
  QUALITY_KEYS,
} from "../src/quality-facts.js";
import { evaluateFormula } from "../src/formula.js";
const from = Date.parse("2026-10-01T00:00:00Z"),
  to = from + 3600000,
  asOf = to + 86400001;
function cohort(count = 5): QualityEvent[] {
  const events: QualityEvent[] = [];
  for (let i = 0; i < count; i++) {
    const base = {
      at: from + i * 10000,
      received: from + i * 10000,
      pageView: `pv${i}`,
      page: "/test",
      user: "governed",
    };
    events.push({
      ...base,
      id: `v${i}`,
      event: "page_view",
      payload: {
        qualityVersion: "r5a-1",
        qualityMask: 255,
        qualityVitals: 31,
        qualitySampleRate: 1,
      },
    });
    events.push({
      ...base,
      at: base.at + 100,
      id: `a${i}`,
      event: "api",
      payload: {
        qualityVersion: "r5a-1",
        apiRequestId: `a${i}`,
        requestMethod: "GET",
        requestPath: "/controlled",
        success: i !== 0,
        statusCode: i === 0 ? 500 : 200,
        failureType: i === 0 ? "http" : "none",
        durationMs: (i + 1) * 100,
      },
    });
    events.push({
      ...base,
      at: base.at + 500,
      id: `l${i}`,
      event: "page_leave",
      payload: {
        qualityVersion: "r5a-1",
        qualityMask: 255,
        qualityVitals: 31,
        qualitySampleRate: 1,
        qualitySequence: 1,
        qualityClosed: true,
        qualityDropped: 0,
        qualityFailed: 0,
        qualitySuppressed: 0,
        apiStarted: 1,
        apiCompleted: 1,
        resourceStarted: 2,
        resourceCompleted: 2,
        resourceFailed: i === 0 ? 1 : 0,
        longtaskCount: 1,
        longtaskTotal: 70,
        blankScreen: i === 0,
        blankRule: "root-empty-3s-v1",
      },
    });
    for (const metric of [
      "lcp",
      "inp",
      "cls",
      "fcp",
      "ttfb",
      "first_screen_time",
      "list_render_duration",
    ])
      events.push({
        ...base,
        at: base.at + 200,
        id: `p${i}${metric}`,
        event: "performance",
        payload: {
          qualityVersion: "r5a-1",
          metric,
          value: i + 1,
          sampleId: `s${i}`,
          rowBucket: "lt100",
        },
      });
  }
  return events;
}
describe("R5-A real denominator and cohort reduction", () => {
  it("calculates distinct API/resource/PV denominators, not error-event counts", () => {
    const r = reduceQuality(cohort(), from, to, asOf);
    expect(r.metrics.api_error_rate).toMatchObject({
      value: 0.2,
      numerator: 1,
      denominator: 5,
    });
    expect(r.metrics.resource_error_rate).toMatchObject({
      value: 0.1,
      numerator: 1,
      denominator: 10,
    });
    expect(r.metrics.js_error_rate).toMatchObject({
      value: 0,
      numerator: 0,
      denominator: 5,
    });
    expect(r.metrics.blank_screen_rate).toMatchObject({
      value: 0.2,
      numerator: 1,
      denominator: 5,
    });
    expect(r.metrics.longtask_total?.value).toBe(350);
    expect(r.metrics.api_duration?.percentiles).toEqual({
      p50: 300,
      p75: 400,
      p90: 460,
      p99: 496,
    });
    expect(Object.keys(r.metrics)).toEqual([...QUALITY_KEYS]);
  });
  it("passes real scalar results into existing AST evaluation", () => {
    const r = reduceQuality(cohort(), from, to, asOf);
    expect(
      evaluateFormula(
        {
          type: "binary",
          operator: "+",
          left: { type: "metric", metricKey: "api_error_rate" },
          right: { type: "metric", metricKey: "resource_error_rate" },
        },
        r.inputs,
      ).value,
    ).toBeCloseTo(0.3);
  });
  it.each(["apiStarted", "resourceStarted"])(
    "never substitutes PV for zero %s",
    (key) => {
      const rows = cohort();
      for (const e of rows.filter((e) => e.event === "page_leave")) {
        e.payload[key] = 0;
        e.payload[key.replace("Started", "Completed")] = 0;
        e.payload.resourceFailed = 0;
      }
      const r = reduceQuality(
        key === "apiStarted" ? rows.filter((e) => e.event !== "api") : rows,
        from,
        to,
        asOf,
      );
      expect(
        r.metrics[key === "apiStarted" ? "api_error_rate" : "resource_error_rate"]
          ?.reason,
      ).toBe("ZERO_DENOMINATOR");
    },
  );
  it.each(["qualityDropped", "qualityFailed", "qualitySuppressed"])(
    "blocks known %s",
    (key) => {
      const rows = cohort();
      rows.find((e) => e.event === "page_leave")!.payload[key] = 1;
      expect(
        reduceQuality(rows, from, to, asOf).metrics.api_error_rate?.value,
      ).toBeNull();
    },
  );
  it("does not count HTTP200 business rejection as technical failure", () => {
    const rows = cohort();
    const api = rows.find((e) => e.event === "api")!;
    api.payload.success = true;
    api.payload.statusCode = 200;
    api.payload.failureType = "none";
    expect(reduceQuality(rows, from, to, asOf).metrics.api_error_rate?.value).toBe(0);
  });
  it("deduplicates delivery retries and refuses conflicting facts", () => {
    const rows = cohort();
    expect(
      reduceQuality([...rows, ...structuredClone(rows)], from, to, asOf).metrics
        .api_error_rate?.denominator,
    ).toBe(5);
    const changed = structuredClone(rows[0]!);
    changed.payload.qualityMask = 0;
    expect(
      reduceQuality([...rows, changed], from, to, asOf).metrics.api_error_rate?.reason,
    ).toBe("FACT_CONFLICT");
  });
  it("uses latest cumulative leave, never adds visibility snapshots", () => {
    const rows = cohort();
    const earlier = structuredClone(rows.find((e) => e.event === "page_leave")!);
    earlier.id = "early";
    earlier.payload.qualitySequence = 0;
    earlier.payload.qualityClosed = false;
    expect(
      reduceQuality([...rows, earlier], from, to, asOf).metrics.resource_error_rate
        ?.denominator,
    ).toBe(10);
  });
  it("blocks missing terminals, mixed collectors and sampled pages independently", () => {
    const rows = cohort();
    expect(
      reduceQuality(
        rows.filter((e) => e.id !== "a0"),
        from,
        to,
        asOf,
      ).metrics.api_error_rate?.reason,
    ).toBe("API_TERMINALS_MISSING");
    rows[0]!.payload.qualityMask = 0;
    expect(reduceQuality(rows, from, to, asOf).metrics.api_error_rate?.reason).toBe(
      "PARTIAL_COLLECTOR_COVERAGE",
    );
    rows[0]!.payload.qualityMask = 255;
    rows[0]!.payload.qualitySampleRate = 0.5;
    expect(reduceQuality(rows, from, to, asOf).metrics.api_error_rate?.reason).toBe(
      "INCOMPLETE_OR_SAMPLED_PAGE",
    );
  });
  it("exposes open/retention windows and minimum sample", () => {
    expect(
      reduceQuality(cohort(), from, to, to + 100).metrics.api_error_rate?.reason,
    ).toBe("LATENESS_WINDOW_OPEN");
    expect(
      reduceQuality(cohort(), from, to, asOf + 90 * 86400000).metrics.api_error_rate
        ?.reason,
    ).toBe("FACT_RETENTION_RANGE_NOT_COVERED");
    expect(
      reduceQuality(cohort(1), from, to, asOf).metrics.api_error_rate?.status,
    ).toBe("insufficient_sample");
  });
  it("does not promote missing detector outcomes to nonblank", () => {
    const rows = cohort();
    delete rows.find((e) => e.event === "page_leave")!.payload.blankScreen;
    expect(reduceQuality(rows, from, to, asOf).metrics.blank_screen_rate?.reason).toBe(
      "BLANK_RULE_NOT_SETTLED",
    );
  });
  it("refuses a regressing cumulative settlement or a conflicting sequence", () => {
    const rows = cohort(),
      later = structuredClone(rows.find((e) => e.event === "page_leave")!);
    later.id = "regression";
    later.payload.qualitySequence = 2;
    later.payload.resourceStarted = 0;
    later.payload.resourceCompleted = 0;
    expect(
      reduceQuality([...rows, later], from, to, asOf).metrics.resource_error_rate
        ?.reason,
    ).toBe("FACT_CONFLICT");
    later.payload.qualitySequence = 1;
    expect(
      reduceQuality([...rows, later], from, to, asOf).metrics.resource_error_rate
        ?.reason,
    ).toBe("FACT_CONFLICT");
  });
  it("retains the latest vital revision even when its value decreases", () => {
    const rows = cohort();
    const original = rows.find((e) => e.payload.metric === "lcp")!;
    original.payload.qualitySequence = 1;
    original.payload.value = 100;
    const later = structuredClone(original);
    later.id = "revised";
    later.payload.value = 0;
    later.payload.qualitySequence = 2;
    expect(
      reduceQuality([...rows, later], from, to, asOf).metrics.lcp?.percentiles.p50,
    ).toBe(3);
  });
  it("rejects resource exhaustion", () =>
    expect(() => reduceQuality(Array(50001).fill(cohort()[0]), from, to, asOf)).toThrow(
      "QUALITY_FACT_LIMIT",
    ));
});
