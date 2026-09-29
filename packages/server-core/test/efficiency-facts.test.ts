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
