import { describe, it, expect } from "vitest";
import { reduceEfficiency, type EfficiencyEvent } from "../src/efficiency-facts.js";
const page = {
  pageId: "p",
  pageRoute: "/",
  name: "page",
  moduleId: "m",
  pageRevisionId: "p1",
  moduleRevisionId: "m1",
  from: new Date(0).toISOString(),
  to: new Date(10000).toISOString(),
  included: true,
  reason: "INCLUDED",
};
const event = (
  id: string,
  at: number,
  payload: Record<string, unknown>,
): EfficiencyEvent => ({
  id,
  at,
  received: at,
  user: "hash",
  session: "session",
  page: "/",
  payload,
});
const summary = event("one", 100, {
  name: "form_summary",
  formId: "edit",
  formInstanceId: "frm_one",
  changeCount: 6,
  resetCount: 2,
  submitCount: 3,
  validationFailureCount: 1,
  counterOverflow: false,
});
describe("R4-C bounded observation reducer", () => {
  it("publishes only compatible unsampled complete controlled cohorts and preserves unknown legacy coverage", () => {
    const form = {
      ...summary,
      payload: { ...summary.payload, submitCount: 5, sampleRate: 1 },
    };
    const operations = Array.from({ length: 5 }, (_, i) => [
      event(`s${i}`, 200 + i, {
        name: "feature_started",
        featureKey: "save",
        operationInstanceId: `op_${i}`,
        businessAdapter: true,
        businessSampleRate: 1,
      }),
      event(`t${i}`, 300 + i, {
        name: "feature_succeeded",
        featureKey: "save",
        operationInstanceId: `op_${i}`,
        businessAdapter: true,
        businessSampleRate: 1,
        businessResult: i === 0 ? "rejected" : "success",
      }),
    ]).flat();
    const r = reduceEfficiency([form, ...operations], 0, 1000, 1000, [page], "m");
    expect(r.form_efficiency.value).toMatchObject([
      {
        formId: "edit",
        changesPerSubmit: 1.2,
        resetRate: 0.4,
        validationErrorRate: 0.2,
      },
    ]);
    expect(r.operation_fail_rate).toMatchObject({
      value: 0.2,
      denominator: 5,
      status: "available",
      coverage: "controlled_unsampled_operations",
    });
    expect(
      reduceEfficiency(
        operations.map((e) => ({
          ...e,
          payload: { ...e.payload, businessSampleRate: 0.5 },
        })),
        0,
        1000,
        1000,
        [page],
        "m",
      ).operation_fail_rate.value,
    ).toBeNull();
  });

  it("deduplicates transport retries and never promotes observations to formal ratios", () => {
    const r = reduceEfficiency([summary, summary], 0, 1000, 1000, [page], "m");
    expect(r.form_efficiency.observations).toMatchObject([
      { changes: 6, resets: 2, submits: 3, validationFailures: 1, lifecycles: 1 },
    ]);
    expect(r.form_efficiency.value).toBeNull();
  });
  it("excludes conflicting event IDs, identities, unclassified and unavailable revisions", () => {
    expect(
      reduceEfficiency(
        [summary, { ...summary, payload: { ...summary.payload, changeCount: 5 } }],
        0,
        1000,
        1000,
        [page],
        "m",
      ).form_efficiency.observations,
    ).toHaveLength(0);
    expect(
      reduceEfficiency([{ ...summary, user: null }], 0, 1000, 1000, [page], "m")
        .unidentified,
    ).toBe(1);
    expect(
      reduceEfficiency([summary], 0, 1000, 1000, [{ ...page, included: false }], "m")
        .form_efficiency.observations,
    ).toHaveLength(0);
  });
  it("applies both event time and received time asOf; exposes start denominator and unknown independently", () => {
    const start = event("s", 100, {
      name: "feature_started",
      featureKey: "save",
      operationInstanceId: "op_one",
      businessAdapter: true,
    });
    const end = event("e", 200, {
      name: "feature_failed",
      featureKey: "save",
      operationInstanceId: "op_one",
      businessAdapter: true,
      businessResult: "rejected",
    });
    expect(
      reduceEfficiency([end, start], 0, 150, 300, [page], "m").operation_fail_rate
        .observations,
    ).toMatchObject({ started: 1, rejected: 1, unknown: 0 });
    expect(
      reduceEfficiency([start, { ...end, received: 400 }], 0, 150, 300, [page], "m")
        .operation_fail_rate.observations,
    ).toMatchObject({ started: 1, rejected: 0, unknown: 1 });
    expect(
      reduceEfficiency([start, { ...end, user: "other" }], 0, 150, 300, [page], "m")
        .operation_fail_rate.observations.unresolved,
    ).toBe(1);
  });
});

describe("approved C01/C02 result policy", () => {
  it("excludes no-submit counters from all three ratios without discarding the disclosed lifecycle", () => {
    const submitted = {
      ...summary,
      payload: { ...summary.payload, submitCount: 5, resetCount: 12 },
    };
    const abandoned = event("abandoned", 200, {
      ...summary.payload,
      formInstanceId: "frm_abandoned",
      submitCount: 0,
      changeCount: 99,
      resetCount: 99,
      validationFailureCount: 0,
    });
    const r = reduceEfficiency([submitted, abandoned], 0, 1000, 1000, [page], "m");
    expect(r.form_efficiency.results).toMatchObject([
      {
        changesPerSubmit: 1.2,
        resetRate: 2.4,
        validationErrorRate: 0.2,
        excludedNoSubmitLifecycles: 1,
      },
    ]);
    expect(r.form_efficiency.value).toBeNull();
    expect(r.form_efficiency.reason).toBe("FORM_COVERAGE_NOT_VERIFIED");
    expect(
      reduceEfficiency([abandoned], 0, 1000, 1000, [page], "m").form_efficiency
        .results[0],
    ).toMatchObject({ reason: "ZERO_DENOMINATOR", changesPerSubmit: null });
    expect(
      reduceEfficiency(
        [{ ...submitted, payload: { ...submitted.payload, counterOverflow: true } }],
        0,
        1000,
        1000,
        [page],
        "m",
      ).form_efficiency.results[0]?.reason,
    ).toBe("FORM_COUNTER_OVERFLOW");
  });
  it("assigns the complete lifecycle to settlement time at an exact query boundary", () => {
    const e = { ...summary, at: 1000, received: 1000 };
    expect(
      reduceEfficiency([e], 0, 1000, 2000, [page], "m").form_efficiency.observations,
    ).toHaveLength(0);
    expect(
      reduceEfficiency([e], 1000, 2000, 2000, [page], "m").form_efficiency
        .observations[0]?.changes,
    ).toBe(6);
  });
  it("keeps technical failures and canceled operations in the denominator; unknown blocks a rate", () => {
    const results = ["success", "rejected", "technical_failure", "canceled", "success"];
    const events = results.flatMap((businessResult, i) => [
      event(`s${i}`, 100, {
        name: "feature_started",
        operationInstanceId: `op_${i}`,
        featureKey: "save",
        businessAdapter: true,
      }),
      event(`e${i}`, 200, {
        name: "feature_failed",
        operationInstanceId: `op_${i}`,
        featureKey: "save",
        businessAdapter: true,
        businessResult,
      }),
    ]);
    const result = reduceEfficiency(
      events,
      0,
      150,
      300,
      [page],
      "m",
    ).operation_fail_rate;
    expect(result.observedValue).toBe(0.2);
    expect(result.value).toBeNull();
    const unknown = events.filter((e) => e.id !== "e4");
    expect(
      reduceEfficiency(unknown, 0, 150, 300, [page], "m").operation_fail_rate,
    ).toMatchObject({
      observedValue: null,
      reason: "BUSINESS_RESULT_UNKNOWN",
      observations: { started: 5, unknown: 1 },
    });
  });
});
