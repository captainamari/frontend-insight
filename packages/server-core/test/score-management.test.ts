import { describe, it, expect } from "vitest";
import { defaultScoreTemplate, selectedScoreTemplate } from "../src/score-templates.js";
import { scoreExamples } from "../src/score-examples.js";
import { evaluateScore } from "../src/score-evaluation.js";
import { scoreDigest } from "../src/score-storage.js";
import {
  expectedScoreDates,
  operationalUsageSamples,
  workflowScoreSamples,
  sessionPercentile,
  pooledWorkflowPercentile,
  type ScoreActivity,
} from "../src/score-observation.js";
import { operationalScoreFixture } from "./score-fixture.js";
function activity(
  eventId: string,
  sessionId: string,
  pageRoute: string,
  timestamp: string,
  moduleId: string | null = "m1",
  userId: string | null = "u1",
): ScoreActivity {
  return { eventId, sessionId, pageRoute, timestamp, moduleId, userId, valid: true };
}
function usage() {
  return {
    from: "2026-09-07T00:00:00Z",
    to: "2026-09-09T00:00:00Z",
    timezone: "UTC",
    targetUsers: 2,
    weekdays: [1, 2, 3, 4, 5],
    identityComplete: true,
    exposureComplete: true,
    durationMinimumSample: 2,
    pages: [
      {
        pageRoute: "/a",
        moduleId: "m1",
        isCore: true,
        criticalityWeight: 3,
        templateKey: "task_operation" as const,
      },
      {
        pageRoute: "/b",
        moduleId: "m2",
        isCore: true,
        criticalityWeight: 1,
        templateKey: "analysis_view" as const,
      },
    ],
    events: [
      activity("e1", "cross-midnight", "/a", "2026-09-07T23:55:00Z"),
      activity("e2", "cross-midnight", "/b", "2026-09-08T00:05:00Z", "m2"),
      activity("e3", "after-idle", "/a", "2026-09-08T01:00:00Z"),
    ],
  };
}
describe("R1-C approved templates and observable sample semantics", () => {
  it("inherits ISO weekdays including Sunday=7 for partial project-local dates", () => {
    expect(
      expectedScoreDates(
        "2026-09-12T20:00:00Z",
        "2026-09-13T01:00:00Z",
        "Asia/Shanghai",
        [7],
      ),
    ).toEqual(["2026-09-13"]);
    expect(
      expectedScoreDates(
        "2026-09-12T20:00:00Z",
        "2026-09-13T01:00:00Z",
        "Asia/Shanghai",
        [6],
      ),
    ).toEqual([]);
  });
  it("pins Jesse approval and all approved hand calculations without real facts", () => {
    const op = defaultScoreTemplate("operational"),
      quality = defaultScoreTemplate("quality");
    expect(op.configuration.dimensions.map((d) => d.weight)).toEqual([
      0.3, 0.25, 0.3, 0.15,
    ]);
    expect(quality.approval).toMatchObject({
      owner: "Jesse",
      approvedAt: "2026-09-09",
      parameterVersion: "quality-default-2026-09-09.1",
    });
    const fixture = scoreExamples(op.configuration);
    expect(fixture.normal?.value).toBeCloseTo(76.15, 10);
    expect(fixture.partial?.value).toBeCloseTo(82.5294117647, 10);
    expect(fixture.partial?.coverage).toBeCloseTo(0.7, 12);
    expect(fixture.gateFailure?.value).toBeNull();
    expect(scoreExamples(quality.configuration).normal?.value).toBeCloseTo(
      72.9532163743,
      10,
    );
    expect(
      scoreExamples(quality.configuration)
        .healthyZeroErrors?.dimensions.slice(0, 3)
        .map((d) => d.score),
    ).toEqual([100, 100, 100]);
    expect(fixture.noData?.value).toBeNull();
  });
  it("retains the adopted template until an explicit upgrade and rejects unknown versions", () => {
    const current = defaultScoreTemplate("quality");
    const previous = { ...current, version: "quality-previous-approved" };
    expect(selectedScoreTemplate("quality", previous)).toEqual(previous);
    expect(selectedScoreTemplate("quality", previous, previous.version)).toEqual(
      previous,
    );
    expect(selectedScoreTemplate("quality", previous, current.version)).toEqual(
      current,
    );
    expect(selectedScoreTemplate("quality", previous, "invented")).toBeNull();
    expect(selectedScoreTemplate("operational", previous)).toBeNull();
    expect(defaultScoreTemplate("operational").approval.parameterVersion).toBe(
      "operational-default-2026-09-09.1",
    );
  });
  it("does not manufacture fixture facts for custom inputs", () => {
    const config = defaultScoreTemplate("operational").configuration;
    config.dimensions[0]!.leaves[0]!.metricKey = "custom_business_metric";
    expect(scoreExamples(config).normal).toBeNull();
  });
  it("rejects single-local-date continuity in the authoritative evaluator", () => {
    const input = operationalScoreFixture();
    input.context.from = "2026-08-01T16:00:00Z";
    input.context.to = "2026-08-02T16:00:00Z";
    Object.values(input.facts).forEach((f) => (f.context = { ...input.context }));
    const result = evaluateScore(input);
    const leaf = result.dimensions
      .flatMap((d) => d.leaves)
      .find((l) => l.metricKey === "cross_day_continuity")!;
    expect(leaf.score).toBeNull();
    expect(leaf.reason).toBe("SINGLE_LOCAL_DATE_CANNOT_OBSERVE_CROSS_DAY_CONTINUITY");
  });
  it("keeps a midnight session and recomputes window P50 from vvSamples", () => {
    const input = usage(),
      r = operationalUsageSamples(input);
    expect(r.vvSamples.valid).toBe(2);
    expect(r.values.session_distinct_pages_fit).toBe(1.5);
    expect(r.values.session_module_breadth_fit).toBe(1.5);
    expect(r.values.cross_day_continuity).toBe(1);
    expect(r.values.active_user_target_attainment).toBe(0.5);
    expect(r.values.active_day_coverage).toBe(1);
    const days = [
      operationalUsageSamples({ ...input, to: "2026-09-08T00:00:00Z" }),
      operationalUsageSamples({ ...input, from: "2026-09-08T00:00:00Z" }),
    ];
    expect(days.map((d) => d.values.session_distinct_pages_fit)).toEqual([1, 1]);
    expect(r.values.session_distinct_pages_fit).not.toBe(1);
    expect(days[0]!.values.cross_day_continuity).toBeNull();
  });
  it("uses one identity and classification rule in numerator, denominator and vvSamples", () => {
    const input = usage();
    input.events.push(
      activity("anonymous", "anonymous", "/a", "2026-09-08T03:00:00Z", "m1", null),
      activity("unknown", "only-unknown", "/unknown", "2026-09-08T03:00:00Z", null),
      activity("mixed", "cross-midnight", "/unknown", "2026-09-08T00:10:00Z", null),
    );
    input.events.push(input.events[0]!);
    const r = operationalUsageSamples(input);
    expect(r.samples).toMatchObject({
      total: 6,
      valid: 3,
      excluded: 3,
      unidentified: 1,
    });
    expect(r.vvSamples).toMatchObject({ total: 3, valid: 2, excluded: 1 });
    expect(r.uv).toBe(1);
    expect(r.crossDayNumerator).toBe(1);
    expect(r.values.session_module_breadth_fit).toBe(1.5);
    expect(
      operationalUsageSamples({ ...input, identityComplete: false }).values
        .cross_day_continuity,
    ).toBeNull();
  });
  it("weights core page PV coverage and checks duration minimum after exclusion", () => {
    const input = usage();
    input.events = input.events
      .filter((e) => e.pageRoute === "/a")
      .map((e) => ({ ...e, visibleDurationMs: 60000 }));
    const r = operationalUsageSamples(input);
    expect(r.values.core_page_coverage).toBe(0.75);
    expect(r.coreNumerator).toBe(3);
    expect(r.coreDenominator).toBe(4);
    expect(r.values.page_visible_duration_fit).toBe(1);
    expect(r.durations[0]).toMatchObject({
      sampleSize: 2,
      rawDurationP50Ms: 60000,
      score: 100,
    });
    expect(
      operationalUsageSamples({ ...input, durationMinimumSample: 3 }).values
        .page_visible_duration_fit,
    ).toBeNull();
  });
  it("uses linear interpolation for vvSamples and weighted nearest rank for pooled workflow instances", () => {
    expect(sessionPercentile([1, 2, 8, 9], 0.5)).toBe(5);
    const durations = [
      { durationMs: 100, weight: 1 },
      { durationMs: 200, weight: 1 },
      { durationMs: 1000, weight: 4 },
    ];
    expect(pooledWorkflowPercentile(durations, 0.5)).toBe(1000);
    expect(
      pooledWorkflowPercentile(
        [
          { durationMs: 100, weight: 1 },
          { durationMs: 200, weight: 1 },
        ],
        0.5,
      ),
    ).toBe(100);
    expect(() =>
      pooledWorkflowPercentile([{ durationMs: 100, weight: 0 }], 0.5),
    ).toThrow();
  });
  it("computes workflow success/adverse rates and pooled P50, preserving per-type samples", () => {
    const samples = [
      ...Array.from({ length: 3 }, (_, i) => ({
        workflowInstanceId: "a" + i,
        workflowType: "A",
        state: "completed" as const,
        weight: 1,
        durationMs: 100,
      })),
      {
        workflowInstanceId: "b1",
        workflowType: "B",
        state: "completed" as const,
        weight: 1,
        durationMs: 1000,
      },
      {
        workflowInstanceId: "c1",
        workflowType: "B",
        state: "failed" as const,
        weight: 1,
        durationMs: null,
      },
    ];
    const r = workflowScoreSamples(samples);
    expect(r.p50).toBe(100);
    expect(r.completionRate).toBe(4 / 5);
    expect(r.adverseRate).toBe(1 / 5);
    expect(r.groups.map((g) => g.p50)).toEqual([100, 1000]);
    expect(r.valid).toBe(4);
    expect(r.excluded).toBe(1);
  });
  it("keeps exposure incomplete and empty observations unavailable", () => {
    const input = usage();
    const empty = operationalUsageSamples({
      ...input,
      events: [],
      exposureComplete: false,
    });
    expect(Object.values(empty.values).every((v) => v === null)).toBe(true);
    expect(workflowScoreSamples([]).completionRate).toBeNull();
    expect(
      operationalUsageSamples({ ...input, targetUsers: null }).values
        .active_user_target_attainment,
    ).toBeNull();
  });
  it("hashes JSON snapshots independent of key order and changes when dependencies change", () => {
    expect(scoreDigest({ a: 1, b: 2 })).toBe(scoreDigest({ b: 2, a: 1 }));
    expect(scoreDigest({ revision: 1 })).not.toBe(scoreDigest({ revision: 2 }));
  });
});
