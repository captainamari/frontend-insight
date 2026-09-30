import { describe, expect, it } from "vitest";
import {
  evaluateModulePenetration,
  penetrationObservationWindow,
  type PopulationEvidence,
} from "../src/module-penetration.js";
const scope = {
  projectId: "project",
  env: "prod",
  identityVersion: "approved",
  activityScope: "identified_valid_classified_business_activity",
};
const from = "2026-09-01T04:00:00.000Z",
  to = "2026-09-28T04:00:00.000Z",
  timezone = "America/New_York";
const evidence = (
  window: { from: string; to: string },
  count: number,
): PopulationEvidence => ({
  ...scope,
  source: "isolated_complete_fixture",
  sourceVersion: "fixture-v1",
  window,
  count,
  coverage: "complete",
  coverageWindows: [window],
});
const valid = () => ({
  scope,
  from,
  to,
  timezone,
  observedNumerator: 8,
  numeratorEvidence: evidence({ from, to }, 8),
  denominatorEvidence: evidence(penetrationObservationWindow(to, timezone), 10),
});
describe("approved R4-A population estimate", () => {
  it("preserves local clock, milliseconds and calendar days across DST, not elapsed 2160 hours", () => {
    expect(
      penetrationObservationWindow("2026-05-01T16:15:30.123Z", timezone).from,
    ).toBe("2026-01-31T17:15:30.123Z");
    expect(
      penetrationObservationWindow("2026-12-01T17:15:30.123Z", timezone).from,
    ).toBe("2026-09-02T16:15:30.123Z");
    expect(
      penetrationObservationWindow("2026-09-28T16:00:00.000Z", "Asia/Shanghai").from,
    ).toBe("2026-06-30T16:00:00.000Z");
  });
  it("uses existing explicit earlier-overlap/forward-gap policy", () => {
    expect(
      penetrationObservationWindow("2026-06-06T06:30:00.000Z", timezone).from,
    ).toBe("2026-03-08T07:30:00.000Z");
    expect(
      penetrationObservationWindow("2027-01-30T06:30:00.000Z", timezone).from,
    ).toBe("2026-11-01T05:30:00.000Z");
  });
  it("computes an estimated ratio only from compatible complete evidence; preserves real zero", () => {
    expect(evaluateModulePenetration(valid())).toMatchObject({
      value: 0.8,
      estimated: true,
      availability: "estimated",
      directoryVersion: null,
    });
    const v = valid();
    v.numeratorEvidence.count = 0;
    expect(evaluateModulePenetration(v).value).toBe(0);
    v.denominatorEvidence.count = 0;
    expect(evaluateModulePenetration(v).reason).toBe("PENETRATION_DENOMINATOR_ZERO");
  });
  it("never promotes page-view observations or earliest-event dates to coverage", () => {
    expect(
      evaluateModulePenetration({ scope, from, to, timezone, observedNumerator: 8 }),
    ).toMatchObject({
      value: null,
      numerator: 8,
      reason: "PENETRATION_SOURCE_MISSING",
      estimated: false,
    });
    const v = valid();
    v.denominatorEvidence.coverageWindows = [
      { from: v.denominatorEvidence.window.from, to: "2026-07-01T04:00:00.000Z" },
      { from: "2026-09-01T04:00:00.000Z", to },
    ];
    expect(evaluateModulePenetration(v).reason).toBe(
      "PENETRATION_COVERAGE_INSUFFICIENT",
    );
    v.denominatorEvidence.coverage = "unknown";
    expect(evaluateModulePenetration(v).reason).toBe("PENETRATION_COVERAGE_UNKNOWN");
  });
  it("accepts adjacent complete intervals and rejects gaps down to a millisecond", () => {
    const v = valid(),
      middle = "2026-08-01T04:00:00.000Z";
    v.denominatorEvidence.coverageWindows = [
      { from: v.denominatorEvidence.window.from, to: middle },
      { from: middle, to },
    ];
    expect(evaluateModulePenetration(v).value).toBe(0.8);
    v.denominatorEvidence.coverageWindows[1]!.from = "2026-08-01T04:00:00.001Z";
    expect(evaluateModulePenetration(v).value).toBeNull();
  });
  it("preserves long-range numerator and never clamps an inconsistent ratio", () => {
    expect(
      evaluateModulePenetration({ ...valid(), from: "2025-09-28T04:00:00Z" }),
    ).toMatchObject({
      value: null,
      numerator: 8,
      reason: "PENETRATION_RANGE_INCOMPATIBLE",
    });
    const v = valid();
    v.numeratorEvidence.count = 150;
    expect(evaluateModulePenetration(v)).toMatchObject({
      value: null,
      numerator: 150,
      denominator: 10,
      reason: "PENETRATION_SOURCE_INCONSISTENT",
    });
  });
  it("checks project, env, identity, source and exact half-open observation window", () => {
    for (const key of ["projectId", "env"] as const) {
      const v = valid();
      v.denominatorEvidence[key] = "other";
      expect(evaluateModulePenetration(v).reason).toBe(
        "PENETRATION_SCOPE_INCOMPATIBLE",
      );
    }
    for (const key of ["identityVersion", "activityScope"] as const) {
      const v = valid();
      v.numeratorEvidence[key] = "other";
      expect(evaluateModulePenetration(v).reason).toBe(
        "PENETRATION_IDENTITY_SCOPE_INCOMPATIBLE",
      );
    }
    const v = valid();
    v.denominatorEvidence.sourceVersion = "other";
    expect(evaluateModulePenetration(v).reason).toBe("PENETRATION_SOURCE_INCOMPATIBLE");
    const w = valid();
    w.denominatorEvidence.window.to = "2026-09-28T04:00:00.001Z";
    expect(evaluateModulePenetration(w).reason).toBe("PENETRATION_RANGE_INCOMPATIBLE");
  });
  it("anchors every trend bucket independently and accepts exact 90-day inclusion", () => {
    const v = valid();
    v.from = v.denominatorEvidence.window.from;
    v.numeratorEvidence.window = { from: v.from, to };
    v.numeratorEvidence.coverageWindows = [v.numeratorEvidence.window];
    expect(evaluateModulePenetration(v).value).toBe(0.8);
    expect(penetrationObservationWindow("2026-09-01T04:00:00Z", timezone)).not.toEqual(
      penetrationObservationWindow(to, timezone),
    );
  });
});

describe("R4-C trusted directory denominator", () => {
  it("requires compatible full numerator and preserves source version without the 90-day approximation", () => {
    const input = valid();
    input.denominatorEvidence = {
      ...evidence({ from, to }, 10),
      source: "trusted_eligible_directory",
      sourceVersion: "directory-v1",
      directoryVersion: "directory-v1",
    };
    expect(evaluateModulePenetration(input)).toMatchObject({
      value: 0.8,
      estimated: false,
      availability: "available",
      directoryVersion: "directory-v1",
    });
    expect(
      evaluateModulePenetration({ ...input, numeratorEvidence: undefined }),
    ).toMatchObject({ value: null, reason: "PENETRATION_SOURCE_MISSING" });
    expect(
      evaluateModulePenetration({
        ...input,
        numeratorEvidence: { ...input.numeratorEvidence, coverage: "unknown" },
      }),
    ).toMatchObject({ value: null, reason: "PENETRATION_COVERAGE_UNKNOWN" });
  });
});
