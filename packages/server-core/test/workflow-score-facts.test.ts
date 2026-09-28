import { describe, expect, it } from "vitest";
import { workflowScoreFacts } from "../src/workflow-score-facts.js";
import type { WorkflowInstanceFact } from "../src/workflow-reducer.js";
import type { ScoreQueryContext } from "../src/score-evaluation.js";
const context: ScoreQueryContext = {
  projectId: "p",
  env: "dev",
  metricSetVersion: "metric-v1",
  definitionVersion: "score-v1",
  scopeId: "p",
  from: "2026-09-28T00:00:00Z",
  to: "2026-09-29T00:00:00Z",
  timezone: "UTC",
  granularity: "day",
};
const dependencies = {
  workflows: [
    { id: "a", workflowKey: "a", versionId: "av1", moduleId: "m" },
    { id: "b", workflowKey: "b", versionId: "bv1", moduleId: "m" },
  ],
  workflowWeights: { a: 1, b: 3 },
  durationMinimumSample: 1,
};
function instance(
  id: string,
  versionId: string,
  state: WorkflowInstanceFact["state"],
  durationMs: number | null,
): WorkflowInstanceFact {
  return {
    workflowInstanceId: id,
    workflowKey: versionId[0]!,
    version: 1,
    versionId,
    sessionId: "s",
    identified: true,
    startedAt: Date.parse(context.from) + 1,
    terminalAt: durationMs === null ? null : Date.parse(context.from) + 1 + durationMs,
    state,
    durationMs,
    steps: [],
    reasons: [],
  };
}
describe("R4-B existing score evaluator fact adapter", () => {
  const instances = [
    instance("a1", "av1", "completed", 10),
    instance("a2", "av1", "completed", 100),
    instance("b1", "bv1", "completed", 30),
    instance("b2", "bv1", "failed", null),
  ];
  it("uses approved type weights, compatible start cohort and pooled nearest rank, never mean of type medians", () => {
    const result = workflowScoreFacts(
      { instances, rejected: {}, asOf: context.to, coverage: "proven" },
      dependencies,
      context,
    );
    expect(result.values.completionRate).toBe(5 / 8);
    expect(result.values.adverseRate).toBe(3 / 8);
    expect(result.values.p50).toBe(30);
    expect(result.facts.key_task_duration_p50).toMatchObject({
      value: 30,
      sampleSize: 3,
      status: "available",
    });
  });
  it("excludes new workflow versions from the frozen score and discloses unidentified/conflicting samples", () => {
    const other = instance("new", "av2", "completed", 1);
    const unidentified = {
      ...instance("anon", "av1", "completed", 1),
      identified: false,
    };
    const r = workflowScoreFacts(
      {
        instances: [...instances, other, unidentified],
        rejected: {},
        asOf: context.to,
        coverage: "proven",
      },
      dependencies,
      context,
    );
    expect(r.samples).toMatchObject({
      total: 5,
      valid: 4,
      unidentified: 1,
      excluded: 1,
    });
    expect(r.facts.key_task_completion_rate?.status).toBe("partial");
    expect(r.values.p50).toBe(30);
  });
  it("keeps observed values separate from permission to unlock scoring; unknown coverage is partial", () => {
    const r = workflowScoreFacts(
      { instances, rejected: {}, asOf: context.to, coverage: "unknown" },
      dependencies,
      context,
    );
    expect(r.facts.key_task_completion_rate).toMatchObject({
      value: 5 / 8,
      status: "partial",
      reason: "WORKFLOW_COVERAGE_UNKNOWN",
    });
    const empty = workflowScoreFacts(
      { instances: [], rejected: {}, asOf: context.to, coverage: "unknown" },
      dependencies,
      context,
    );
    expect(empty.facts.key_task_completion_rate).toMatchObject({
      value: null,
      status: "no_data",
    });
  });
});
