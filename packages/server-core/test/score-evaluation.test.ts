import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_ALIASES } from "@frontend-insight/event-contract";
import type { FormulaAst } from "../src/formula.js";
import {
  evaluateScore,
  evaluateScoreTrend,
  parseScoreConfiguration,
  scoreQueryIdentity,
  validateScoreConfiguration,
  type ScoreConfiguration,
  type ScoreInputStatus,
} from "../src/score-evaluation.js";
import { operationalScoreFixture } from "./score-fixture.js";

const config = (input: ReturnType<typeof operationalScoreFixture>) =>
  input.configuration as ScoreConfiguration;
const allLeaves = (input: ReturnType<typeof operationalScoreFixture>) =>
  config(input).dimensions.flatMap((dim) => dim.leaves);
function missing(
  input: ReturnType<typeof operationalScoreFixture>,
  ...indices: number[]
) {
  for (const index of indices) {
    const fact = input.facts[allLeaves(input)[index]!.metricKey]!;
    fact.value = null;
    fact.status = "missing";
    fact.reason = "FIXTURE_MISSING";
  }
}

describe("R1-C score evaluation foundation (synthetic facts, not production templates)", () => {
  it("normalizes all ten §18.3 leaves and returns exact two-level contributions", () => {
    const result = evaluateScore(operationalScoreFixture());
    expect(result.dimensions.map((dim) => dim.score)).toEqual([88.5, 58, 87, 60]);
    expect(
      result.dimensions.flatMap((dim) => dim.leaves.map((leaf) => leaf.score)),
    ).toEqual([80, 90, 100, 70, 50, 50, 90, 80, 50, 75]);
    expect(result.value).toBeCloseTo(76.15, 10);
    expect(result.coverage).toBeCloseTo(1, 12);
    expect(
      result.dimensions.reduce((sum, dim) => sum + (dim.contribution ?? 0), 0),
    ).toBeCloseTo(result.value!, 12);
    expect(
      result.dimensions
        .flatMap((dim) => dim.leaves)
        .reduce((sum, leaf) => sum + (leaf.contribution ?? 0), 0),
    ).toBeCloseTo(result.value!, 12);
  });
  it("reproduces the unchanged R0 fixture at exactly three dimensions and 70% coverage", () => {
    const input = operationalScoreFixture();
    missing(input, 4, 5, 8, 9);
    const legacy = JSON.parse(
      readFileSync(
        new URL(
          "../../test-fixtures/fixtures/r0/operational-score.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const result = evaluateScore(input);
    expect(result.value).toBeCloseTo(legacy.expected.operationalScore, 12);
    expect(result.coverage).toBeCloseTo(0.7, 12);
    expect(result.eligibleDimensions).toBe(3);
    expect(result.dimensions.map((dim) => dim.score)).toEqual([88.5, 70, 87, null]);
    expect(result.dimensions[1]!.leaves[0]!.effectiveWeight).toBeCloseTo(
      0.25 / 0.85,
      12,
    );
    expect(
      result.dimensions
        .flatMap((dim) => dim.leaves)
        .reduce((sum, leaf) => sum + (leaf.contribution ?? 0), 0),
    ).toBeCloseTo(result.value!, 12);
  });
  it("fails just below 70% even when three dimensions remain", () => {
    const input = operationalScoreFixture();
    missing(input, 4, 5, 8, 9);
    config(input).dimensions[1]!.leaves[0]!.weight = 0.399999;
    config(input).dimensions[1]!.leaves[1]!.weight = 0.300001;
    const result = evaluateScore(input);
    expect(result.eligibleDimensions).toBe(3);
    expect(result.coverage).toBeLessThan(0.7);
    expect(result.value).toBeNull();
    expect(result.reasons).toContain("LEAF_WEIGHT_COVERAGE_BELOW_GATE");
    expect(result.dimensions.every((dim) => dim.contribution === null)).toBe(true);
  });
  it("fails the dimension gate independently of coverage", () => {
    const input = operationalScoreFixture();
    missing(input, 3, 4, 5, 8, 9);
    config(input).gate.minimumLeafWeightCoverage = 0.5;
    const result = evaluateScore(input);
    expect(result.coverage).toBeCloseTo(0.6);
    expect(result.value).toBeNull();
    expect(result.reasons).toEqual(["ELIGIBLE_DIMENSIONS_BELOW_GATE"]);
  });
  it.each([5, 4, null])(
    "checks minimum sample at and below the boundary: %s",
    (sample) => {
      const input = operationalScoreFixture();
      input.facts.active_user_target_attainment!.sampleSize = sample;
      const leaf = evaluateScore(input).dimensions[0]!.leaves[0]!;
      expect(leaf.eligible).toBe(sample === 5);
      expect(leaf.status).toBe(sample === 5 ? "available" : "insufficient_sample");
    },
  );
  it.each([
    "missing",
    "insufficient_sample",
    "missing_target",
    "partial",
    "not_collected",
    "delayed",
    "broken",
    "no_data",
    "metric_not_available",
  ] as ScoreInputStatus[])("preserves unavailable input status %s", (status) => {
    const input = operationalScoreFixture();
    input.facts.active_user_target_attainment!.status = status;
    const leaf = evaluateScore(input).dimensions[0]!.leaves[0]!;
    expect(leaf.status).toBe(status);
    expect(leaf.score).toBeNull();
  });
  it("distinguishes measured zero, null, nonfinite and an absent target", () => {
    const input = operationalScoreFixture();
    const fact = input.facts.active_user_target_attainment!;
    fact.value = 0;
    expect(evaluateScore(input).dimensions[0]!.leaves[0]!.score).toBe(0);
    fact.value = null;
    expect(evaluateScore(input).dimensions[0]!.leaves[0]!.status).toBe("missing");
    fact.value = Infinity;
    expect(evaluateScore(input).dimensions[0]!.leaves[0]!.score).toBeNull();
    fact.value = 0;
    allLeaves(input)[0]!.target = null;
    expect(evaluateScore(input).dimensions[0]!.leaves[0]!.status).toBe(
      "missing_target",
    );
  });
  it.each(["delayed", "broken", "no_data"] as const)(
    "prevents a trusted total on a %s pipeline",
    (pipelineStatus) => {
      const result = evaluateScore({ ...operationalScoreFixture(), pipelineStatus });
      expect(result.value).toBeNull();
      expect(result.reasons).toContain(`DATA_${pipelineStatus.toUpperCase()}`);
    },
  );
  it.each([
    "projectId",
    "env",
    "metricSetVersion",
    "definitionVersion",
    "scopeId",
    "from",
    "to",
    "timezone",
    "granularity",
  ] as const)("rejects an input from a different %s", (field) => {
    const input = operationalScoreFixture();
    const context = input.facts.active_user_target_attainment!.context;
    Object.assign(context, { [field]: field === "env" ? "staging" : "different" });
    const result = evaluateScore(input);
    expect(result.value).toBeNull();
    expect(result.reasons).toContain("SCORE_CONTEXT_MISMATCH");
    expect(result.dimensions[0]!.leaves[0]!.rawValue).toBeNull();
  });
  it("requires confirmed configuration and does not substitute an owner", () => {
    const input = operationalScoreFixture();
    input.configurationConfirmed = false;
    expect(evaluateScore(input).reasons).toContain("MISSING_CONFIGURATION");
    input.configurationConfirmed = true;
    config(input).owner = null;
    expect(evaluateScore(input).value).toBeNull();
    expect(
      validateScoreConfiguration(input.configuration, input.binding).readiness,
    ).toContainEqual({ key: "operational_score", reason: "SCORE_OWNER_MISSING" });
  });
  it("keeps effectiveAt boundaries separate from explicit history trial", () => {
    const input = operationalScoreFixture();
    input.effectiveAt = "2026-08-04T00:00:00.000Z";
    expect(evaluateScore(input).reasons).toContain("VERSION_RANGE_BOUNDARY");
    const trial = evaluateScore({ ...input, mode: "historical_trial" });
    expect(trial.value).toBeCloseTo(76.15);
    expect(trial.mode).toBe("historical_trial");
  });
  it("uses identical total/bucket evaluation, display values, radar and table", () => {
    const input = operationalScoreFixture();
    const result = evaluateScore(input);
    expect(evaluateScoreTrend([input, input])).toEqual([result, result]);
    config(input).displayUnit = "percent";
    const percent = evaluateScore(input);
    expect(percent.value).toBe(result.value);
    expect(percent.dimensions).toEqual(result.dimensions);
    expect(percent.radar.map((dim) => dim.value)).toEqual(
      percent.dimensions.map((dim) => dim.score),
    );
    expect(
      scoreQueryIdentity("operational_score", "operational", input.context),
    ).not.toBe(
      scoreQueryIdentity("operational_score", "operational", {
        ...input.context,
        env: "dev",
      }),
    );
  });
  it.each([
    [-1, 0],
    [0, 0],
    [1, 100],
    [2, 100],
  ])("clamps higher-better %s to %s", (value, expected) => {
    const input = operationalScoreFixture();
    input.facts.active_user_target_attainment!.value = value;
    expect(evaluateScore(input).dimensions[0]!.leaves[0]!.score).toBe(expected);
  });
  it.each([
    [0, 100],
    [60000, 100],
    [300000, 0],
    [500000, 0],
  ])("clamps lower-better %s to %s", (value, expected) => {
    const input = operationalScoreFixture();
    input.facts.key_task_duration_p50!.value = value;
    expect(evaluateScore(input).dimensions[3]!.leaves[0]!.score).toBe(expected);
  });
  it.each([
    [0, 0],
    [1, 100],
    [4, 100],
    [8, 0],
    [9, 0],
  ])("handles target-range boundary %s", (value, expected) => {
    const input = operationalScoreFixture();
    input.facts.session_distinct_pages_fit!.value = value;
    expect(evaluateScore(input).dimensions[1]!.leaves[1]!.score).toBe(expected);
  });
  it("rejects malformed targets, arbitrary fields, invalid weights and reserved keys", () => {
    const input = operationalScoreFixture();
    allLeaves(input)[0]!.target = { floor: 1, target: 0 };
    expect(() => parseScoreConfiguration(input.configuration)).toThrow(
      "FORMULA_TARGET_INVALID",
    );
    const valid = operationalScoreFixture();
    expect(() =>
      parseScoreConfiguration({ ...config(valid), sql: "SELECT secret" }),
    ).toThrow("SCORE_FIELD_NOT_ALLOWED");
    config(valid).dimensions[0]!.weight = 0.31;
    expect(() => parseScoreConfiguration(valid.configuration)).toThrow(
      "SCORE_WEIGHT_SUM_INVALID",
    );
    const removed = operationalScoreFixture();
    config(removed).scoreKey = FORBIDDEN_ALIASES.metricKeys[0]!;
    expect(() => parseScoreConfiguration(removed.configuration)).toThrow(
      "METRIC_KEY_REMOVED",
    );
    config(removed).scoreKey = "pv";
    expect(() => parseScoreConfiguration(removed.configuration)).toThrow(
      "SYSTEM_METRIC_KEY_RESERVED",
    );
  });
  it.each([
    "project",
    "version",
    "type",
    "scope",
    "granularity",
    "sample",
    "cycle",
    "missing",
    "unit",
  ])("validates transitive references: %s", (variant) => {
    const input = operationalScoreFixture();
    const ref = input.binding.metrics[0]!;
    if (variant === "project") Object.assign(ref, { projectId: "other" });
    if (variant === "version") ref.metricSetVersion = "other";
    if (variant === "type") ref.libraryType = "quality";
    if (variant === "scope") Object.assign(ref, { entityScopes: ["page"] });
    if (variant === "granularity") Object.assign(ref, { timeGranularities: ["month"] });
    if (variant === "sample") Object.assign(ref, { minimumSample: 6 });
    if (variant === "cycle")
      ref.formulaAst = { type: "metric", metricKey: ref.metricKey };
    if (variant === "missing")
      ref.formulaAst = { type: "metric", metricKey: "unknown" };
    if (variant === "unit")
      ref.formulaAst = {
        type: "binary",
        operator: "+",
        left: { type: "metric", metricKey: "core_page_coverage" },
        right: { type: "metric", metricKey: "key_task_duration_p50" },
      };
    expect(() =>
      validateScoreConfiguration(input.configuration, input.binding),
    ).toThrow();
  });
  it("never promotes partial or not-collected catalog metrics using supplied fixture numbers", () => {
    const input = operationalScoreFixture();
    input.binding.metrics[0]!.implementationStatus = "partial";
    input.binding.metrics[1]!.implementationStatus = "not_collected";
    const result = evaluateScore(input);
    expect(
      result.dimensions[0]!.leaves.slice(0, 2).map((leaf) => [leaf.status, leaf.score]),
    ).toEqual([
      ["partial", null],
      ["not_collected", null],
    ]);
  });
  it("evaluates a business DAG with the existing evaluator, ignoring caller-computed values", () => {
    const input = operationalScoreFixture();
    const ref = input.binding.metrics[0]!;
    ref.formulaAst = {
      type: "binary",
      operator: "/",
      left: { type: "metric", metricKey: "core_page_coverage" },
      right: { type: "metric", metricKey: "active_day_coverage" },
    };
    input.facts.active_user_target_attainment!.value = 10000;
    expect(evaluateScore(input).dimensions[0]!.leaves[0]!.rawValue).toBe(0.9);
    input.binding.metrics[1]!.implementationStatus = "partial";
    expect(evaluateScore(input).dimensions[0]!.leaves[0]!.score).toBeNull();
    input.binding.metrics[1]!.implementationStatus = "implemented";
    input.facts.active_day_coverage!.value = 0;
    expect(evaluateScore(input).dimensions[0]!.leaves[0]!.reason).toBe(
      "FORMULA_DIVISOR_ZERO",
    );
  });
  it("retains score-tree depth and node limits when composing allowed leaf formulas", () => {
    const input = operationalScoreFixture();
    let ast = (input.binding.metrics[0]!.formulaAst = {
      type: "metric",
      metricKey: "core_page_coverage",
    } as FormulaAst);
    for (let i = 0; i < 7; i++)
      ast = {
        type: "binary",
        operator: "*",
        left: ast,
        right: { type: "literal", value: 1 },
      };
    input.binding.metrics[0]!.formulaAst = ast;
    expect(() =>
      validateScoreConfiguration(input.configuration, input.binding),
    ).toThrow("FORMULA_DEPTH_LIMIT_EXCEEDED");
  });
  it("does not mutate input snapshots", () => {
    const input = operationalScoreFixture();
    const before = JSON.stringify(input);
    evaluateScore(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
