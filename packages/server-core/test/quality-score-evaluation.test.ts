import { describe, expect, it } from "vitest";
import { evaluateScore } from "../src/score-evaluation.js";
import { qualityScoreFixture } from "./quality-score-fixture.js";

describe("quality evaluator with unapproved test-only parameter proposal", () => {
  it("uses three distinct denominators and independently hand-calculated contributions", () => {
    const result = evaluateScore(qualityScoreFixture());
    expect(result.dimensions.slice(0, 3).map((dim) => dim.leaves[0]!.rawValue)).toEqual(
      [0.005, 0.005, 0.005],
    );
    expect(result.dimensions[0]!.score).toBeCloseTo((100 * 0.005) / 0.009, 10);
    expect(result.dimensions[1]!.score).toBeCloseTo((100 * 0.015) / 0.019, 10);
    expect(result.dimensions[2]!.score).toBe(100);
    expect(result.dimensions[3]!.score).toBeCloseTo(58.33333333333333, 10);
    expect(result.value).toBeCloseTo(72.953216374269, 10);
  });
  it("separates healthy zero errors from no data", () => {
    const input = qualityScoreFixture();
    for (const name of ["js_occurrences", "api_failures", "resource_failures"])
      input.facts[name]!.value = 0;
    input.facts.lcp!.value = 2500;
    input.facts.inp!.value = 200;
    input.facts.cls!.value = 0.1;
    expect(evaluateScore(input).value).toBe(100);
    for (const fact of Object.values(input.facts)) {
      fact.value = null;
      fact.status = "no_data";
      fact.sampleSize = null;
    }
    const result = evaluateScore({ ...input, pipelineStatus: "no_data" });
    expect(result.value).toBeNull();
    expect(result.dimensions.every((dim) => dim.score === null)).toBe(true);
  });
  it.each(["pv", "api_requests", "resource_requests"])(
    "refuses a zero %s denominator instead of substituting PV",
    (denominator) => {
      const input = qualityScoreFixture();
      input.facts[denominator]!.value = 0;
      const result = evaluateScore(input);
      const index = denominator === "pv" ? 0 : denominator === "api_requests" ? 2 : 1;
      expect(result.dimensions[index]!.leaves[0]!.reason).toBe("FORMULA_DIVISOR_ZERO");
      expect(result.dimensions[index]!.score).toBeNull();
    },
  );
  it("propagates missing exposure and performance minimum sample", () => {
    const input = qualityScoreFixture();
    input.facts.api_requests!.status = "not_collected";
    input.facts.lcp!.sampleSize = 99;
    const result = evaluateScore(input);
    expect(result.dimensions[2]!.leaves[0]!.status).toBe("not_collected");
    expect(result.dimensions[3]!.leaves[0]!.status).toBe("insufficient_sample");
  });
});
