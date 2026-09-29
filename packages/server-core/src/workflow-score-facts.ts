import { resolveProjectCalendar } from "@frontend-insight/event-contract/project-range";
import type { FactWindow } from "./overview-facts.js";
import type { ScoreFact, ScoreQueryContext } from "./score-evaluation.js";
import type { WorkflowInstanceFact } from "./workflow-reducer.js";
import { workflowScoreSamples } from "./score-observation.js";

export interface WorkflowScoreObservation {
  instances: WorkflowInstanceFact[];
  rejected: Record<string, number>;
  asOf: string;
  coverage: "proven" | "unknown" | "insufficient";
}
/** Use the requested R3 calendar granularity, including explicit long day/week ranges. */
export function workflowScoreBuckets(context: ScoreQueryContext) {
  const range =
    context.granularity === "day"
      ? "7d"
      : context.granularity === "week"
        ? "90d"
        : context.granularity === "month"
          ? "365d"
          : null;
  if (!range) return [];
  return resolveProjectCalendar(
    { range, env: context.env, from: context.from, to: context.to },
    context.timezone,
  ).buckets;
}
/** Frozen dependency versions and weights, never the currently active definition. */
export function workflowScoreFacts(
  observation: WorkflowScoreObservation,
  dependencies: {
    workflows: readonly {
      id: string;
      workflowKey: string;
      versionId: string;
      moduleId: string;
    }[];
    workflowWeights: Record<string, number>;
    durationMinimumSample: number;
  },
  context: ScoreQueryContext,
) {
  const versions = new Map(
    dependencies.workflows
      .filter((w) => Object.hasOwn(dependencies.workflowWeights, w.id))
      .map((w) => [w.versionId, w]),
  );
  const cohort = observation.instances.filter(
    (i) =>
      versions.has(i.versionId) &&
      i.startedAt >= Date.parse(context.from) &&
      i.startedAt < Date.parse(context.to),
  );
  const eligible = cohort.filter((i) => i.identified && i.state !== "unresolved");
  const values = workflowScoreSamples(
    eligible.map((i) => ({
      workflowInstanceId: i.workflowInstanceId,
      workflowType: i.versionId,
      state: i.state as
        "started" | "completed" | "failed" | "canceled" | "approximate_abandoned",
      weight: dependencies.workflowWeights[versions.get(i.versionId)!.id]!,
      durationMs: i.durationMs,
    })),
  );
  const reason = !versions.size
    ? "SCORE_WORKFLOW_SNAPSHOT_EMPTY"
    : !cohort.length
      ? "NO_WORKFLOW_EVENTS_IN_COHORT"
      : observation.coverage !== "proven"
        ? "WORKFLOW_COVERAGE_" + observation.coverage.toUpperCase()
        : cohort.length !== eligible.length || Object.keys(observation.rejected).length
          ? "WORKFLOW_EXCLUDED_OR_CONFLICTING_SAMPLES"
          : null;
  const make = (
    value: number | null,
    sampleSize: number,
    duration = false,
  ): ScoreFact => ({
    context,
    value,
    sampleSize,
    totalSampleSize: cohort.length,
    excludedSampleSize: cohort.length - eligible.length,
    status: reason
      ? cohort.length
        ? "partial"
        : "no_data"
      : duration && sampleSize < dependencies.durationMinimumSample
        ? "insufficient_sample"
        : value === null
          ? "no_data"
          : "available",
    reason:
      reason ??
      (duration && sampleSize < dependencies.durationMinimumSample
        ? "WORKFLOW_DURATION_SAMPLE_INSUFFICIENT"
        : null),
    // An observation is not a continuous coverage guarantee.
    availableFrom: cohort.length
      ? new Date(Math.min(...cohort.map((i) => i.startedAt))).toISOString()
      : null,
  });
  const facts: Record<string, ScoreFact> = {
    key_task_completion_rate: make(values.completionRate, eligible.length),
    task_adverse_outcome_rate: make(values.adverseRate, eligible.length),
    key_task_duration_p50: make(values.p50, values.valid, true),
  };
  return {
    facts,
    values,
    asOf: observation.asOf,
    coverage: observation.coverage,
    samples: {
      total: cohort.length,
      valid: eligible.length,
      excluded: cohort.length - eligible.length,
      unidentified: cohort.filter((i) => !i.identified).length,
      reason,
    },
    workflowVersions: [...versions.keys()],
    algorithm: "approved_type_weights; pooled_weighted_nearest_rank_p50; start_cohort",
  };
}

/** Shared AST/card input adapter. Observation values do not grant scoring eligibility. */
export function mergeWorkflowFacts(
  window: FactWindow,
  facts: Readonly<Record<string, ScoreFact>>,
) {
  for (const [key, fact] of Object.entries(facts)) {
    window.raw[key] = {
      value: fact.value,
      sampleSize: fact.sampleSize,
      status: fact.value === null ? "missing" : "available",
      reason: fact.reason,
    };
    window.inputs[key] = {
      value: fact.status === "available" ? fact.value : null,
      sampleSize: fact.sampleSize,
      status: fact.status === "available" ? "available" : "metric_not_available",
      reason: fact.reason,
    };
  }
}
