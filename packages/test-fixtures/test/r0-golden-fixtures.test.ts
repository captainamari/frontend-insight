import { describe, expect, it } from "vitest";
import formulaCases from "../fixtures/r0/formula-cases.json" with { type: "json" };
import operationalFixture from "../fixtures/r0/operational-score.json" with { type: "json" };
import privacyFixture from "../fixtures/r0/privacy-negative.json" with { type: "json" };
import qualityFixture from "../fixtures/r0/quality-score.json" with { type: "json" };
import workflowFixture from "../fixtures/r0/workflow-cases.json" with { type: "json" };

function weightedScore(
  items: ReadonlyArray<{ weight: number; score: number | null }>,
): number | null {
  const eligible = items.filter(
    (item): item is { weight: number; score: number } => item.score !== null,
  );
  const weight = eligible.reduce((sum, item) => sum + item.weight, 0);
  if (weight === 0) return null;
  return eligible.reduce((sum, item) => sum + item.score * item.weight, 0) / weight;
}

describe("R0 hand-calculable golden fixtures", () => {
  it("keeps operational eligibility and leaf coverage independent", () => {
    const dimensions = operationalFixture.dimensions.map((dimension) => ({
      key: dimension.key,
      weight: dimension.weight,
      score: weightedScore(dimension.leaves),
      coveredWeight: dimension.leaves
        .filter((leaf) => leaf.score !== null)
        .reduce((sum, leaf) => sum + leaf.weight * dimension.weight, 0),
    }));
    const eligible = dimensions.filter(
      (item): item is typeof item & { score: number } => item.score !== null,
    );
    const coverage = dimensions.reduce(
      (sum, dimension) => sum + dimension.coveredWeight,
      0,
    );
    expect(eligible).toHaveLength(operationalFixture.expected.eligibleDimensions);
    expect(coverage).toBeCloseTo(operationalFixture.expected.leafWeightCoverage, 10);
    for (const dimension of dimensions) {
      const expected =
        operationalFixture.expected.dimensionScores[
          dimension.key as keyof typeof operationalFixture.expected.dimensionScores
        ];
      if (expected === null) expect(dimension.score).toBeNull();
      else expect(dimension.score).toBeCloseTo(expected, 10);
    }
    expect(weightedScore(eligible)).toBeCloseTo(
      operationalFixture.expected.operationalScore,
      10,
    );
  });

  it("calculates the quality score only from sufficient healthy dimensions", () => {
    expect(qualityFixture.pipelineStatus).toBe("healthy");
    expect(
      qualityFixture.dimensions.every(
        (item) => item.sample >= qualityFixture.minimumSample,
      ),
    ).toBe(true);
    expect(weightedScore(qualityFixture.dimensions)).toBe(
      qualityFixture.expected.qualityScore,
    );
  });

  it("keeps formula results and invalid reasons explicit", () => {
    const ratio = formulaCases.valid[0]!;
    expect(ratio.inputs.completed_workflows / ratio.inputs.started_workflows).toBe(
      ratio.expected,
    );
    const mean = formulaCases.valid[1]!;
    expect(mean.inputs.coverage_score * 0.6 + mean.inputs.completion_score * 0.4).toBe(
      mean.expected,
    );
    expect(formulaCases.invalid.map((item) => item.reason)).toEqual([
      "operator_not_allowed",
      "metric_not_available",
      "cycle",
    ]);
  });

  it("documents out-of-order, conflicting and timeout workflow outcomes", () => {
    const byInstance = Object.groupBy(
      workflowFixture.events,
      (event) => event.instance,
    );
    const terminalNames = new Set([
      "workflow_completed",
      "workflow_failed",
      "workflow_canceled",
    ]);
    for (const [instance, expected] of Object.entries(workflowFixture.expected)) {
      const events = (byInstance[instance] ?? []).toSorted(
        (left, right) => left.timestamp - right.timestamp,
      );
      const terminals = events.filter((event) => terminalNames.has(event.name));
      const firstTerminal = terminals[0];
      const started = events.find((event) => event.name === "workflow_started");
      const timeout =
        started &&
        workflowFixture.evaluatedAt - started.timestamp >= workflowFixture.timeoutMs;
      const terminal =
        firstTerminal?.name.replace("workflow_", "") ??
        (timeout ? "approximate_abandoned" : null);
      expect(terminal).toBe(expected.terminal);
      expect(terminals.slice(1)).toHaveLength(expected.conflictingTerminalCount);
      expect(
        firstTerminal && started ? firstTerminal.timestamp - started.timestamp : null,
      ).toBe(expected.durationMs);
    }
  });

  it("keeps the privacy fixture as a zero-leak expectation", () => {
    expect(privacyFixture.forbidden).toHaveLength(
      privacyFixture.expected.forbiddenCount,
    );
    expect(privacyFixture.expected.leakedCount).toBe(0);
    expect(privacyFixture.allowed).not.toContain("query");
    expect(privacyFixture.allowed).not.toContain("domText");
  });
});
