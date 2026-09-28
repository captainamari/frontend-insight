import type { WorkflowFactDefinition } from "./workflow-definitions.js";
import { sessionPercentile } from "./score-observation.js";
export interface WorkflowFactEvent {
  eventId: string;
  timestamp: number;
  receivedAt: number;
  sessionId: string;
  identified: boolean;
  identityScope?: string;
  name: string;
  workflowInstanceId: string;
  workflowKey: string;
  version: number;
  stepKey?: string;
  stepOrder?: number;
  operationInstanceId?: string;
  operationKey?: string;
}
export interface WorkflowInstanceFact {
  workflowInstanceId: string;
  workflowKey: string;
  version: number;
  versionId: string;
  sessionId: string;
  identified: boolean;
  startedAt: number;
  terminalAt: number | null;
  state:
    | "started"
    | "completed"
    | "failed"
    | "canceled"
    | "approximate_abandoned"
    | "unresolved";
  durationMs: number | null;
  steps: { key: string; order: number; at: number }[];
  reasons: string[];
}
/** Replayed immutable observations at an explicit event-time AND receipt-time asOf.
 * No mutable last-write state, session-nearest join or physical timeout event. */
export function reduceWorkflowInstances(
  events: readonly WorkflowFactEvent[],
  definitions: readonly WorkflowFactDefinition[],
  asOf: number,
) {
  const dedup = new Map<string, WorkflowFactEvent>();
  const conflicted = new Set<string>();
  const groups = new Map<string, WorkflowFactEvent[]>();
  const rejected: Record<string, number> = {};
  const reject = (reason: string) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };
  for (const e of events) {
    if (
      !Number.isFinite(e.timestamp) ||
      !Number.isFinite(e.receivedAt) ||
      e.timestamp > asOf ||
      e.receivedAt > asOf
    )
      continue;
    if (conflicted.has(e.eventId)) continue;
    const prior = dedup.get(e.eventId);
    if (
      prior &&
      JSON.stringify({ ...prior, receivedAt: 0 }) !==
        JSON.stringify({ ...e, receivedAt: 0 })
    ) {
      reject("EVENT_ID_CONFLICT");
      dedup.delete(e.eventId);
      conflicted.add(e.eventId);
      continue;
    }
    if (!prior || e.receivedAt < prior.receivedAt) dedup.set(e.eventId, e);
  }
  for (const e of dedup.values()) {
    const group = groups.get(e.workflowInstanceId) ?? [];
    group.push(e);
    groups.set(e.workflowInstanceId, group);
  }
  const instances: WorkflowInstanceFact[] = [];
  for (const es of groups.values()) {
    const starts = es.filter((e) => e.name === "workflow_started");
    if (!starts.length) {
      reject("WORKFLOW_START_MISSING");
      continue;
    }
    const start = starts.reduce((a, b) => (a.timestamp < b.timestamp ? a : b));
    const d = definitions.find(
      (d) => d.workflowKey === start.workflowKey && d.version === start.version,
    );
    if (!d) {
      reject("WORKFLOW_DEFINITION_MISSING");
      continue;
    }
    const reasons: string[] = [];
    if (
      d.admissionPeriods &&
      !d.admissionPeriods.some(
        (p) =>
          start.timestamp >= Date.parse(p.from) &&
          (!p.to || start.timestamp < Date.parse(p.to)),
      )
    )
      reasons.push("WORKFLOW_START_OUTSIDE_ADMISSION");
    if (
      es.some(
        (e) =>
          e.sessionId !== start.sessionId ||
          e.workflowKey !== start.workflowKey ||
          e.version !== start.version ||
          e.identified !== start.identified ||
          e.identityScope !== start.identityScope,
      )
    )
      reasons.push("WORKFLOW_CONTEXT_CONFLICT");
    if (starts.some((s) => s.timestamp !== start.timestamp))
      reasons.push("WORKFLOW_MULTIPLE_STARTS");
    if (es.some((e) => e.name.startsWith("workflow_") && e.timestamp < start.timestamp))
      reasons.push("WORKFLOW_EVENT_BEFORE_START");
    const stepMap = new Map<string, { key: string; order: number; at: number }>();
    for (const e of es.filter((e) => e.name === "workflow_step_reached")) {
      const step = d.steps.find(
        (s) => s.stepKey === e.stepKey && s.stepOrder === e.stepOrder,
      );
      if (!step) {
        reasons.push("WORKFLOW_STEP_INVALID");
        continue;
      }
      if (step.triggerKind === "operation_terminal") {
        const op = es.filter(
          (o) =>
            Boolean(e.operationInstanceId) &&
            o.operationInstanceId === e.operationInstanceId &&
            o.operationKey === step.triggerConfig.operationKey,
        );
        const opStart = op.find(
          (o) =>
            o.name === "feature_started" &&
            (d.startPolicy === "first_step" || o.timestamp >= start.timestamp) &&
            o.timestamp <= e.timestamp,
        );
        const terminals = op
          .filter((o) =>
            ["feature_succeeded", "feature_failed", "feature_canceled"].includes(
              o.name,
            ),
          )
          .sort((a, b) => a.timestamp - b.timestamp);
        if (
          !opStart ||
          !terminals[0] ||
          terminals[0].name !== `feature_${step.triggerConfig.state}` ||
          terminals[0].timestamp > e.timestamp ||
          terminals.some((o) => o.name !== terminals[0]!.name)
        ) {
          reasons.push("WORKFLOW_OPERATION_EVIDENCE_INVALID");
          continue;
        }
      }
      const prior = stepMap.get(step.stepKey);
      if (!prior || e.timestamp < prior.at)
        stepMap.set(step.stepKey, {
          key: step.stepKey,
          order: step.stepOrder,
          at: e.timestamp,
        });
    }
    const steps = [...stepMap.values()].sort((a, b) => a.order - b.order);
    if (steps.some((s, i) => i > 0 && s.at < steps[i - 1]!.at))
      reasons.push("WORKFLOW_STEP_ORDER_CONFLICT");
    const terminals = es
      .filter((e) =>
        ["workflow_completed", "workflow_failed", "workflow_canceled"].includes(e.name),
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    const first = terminals[0];
    if (
      first?.name === "workflow_completed" &&
      steps.some((s) => s.order > 1 && !steps.some((p) => p.order === s.order - 1))
    )
      reasons.push("WORKFLOW_STEP_SEQUENCE_UNVERIFIED");
    if (first && terminals.some((e) => e.name !== first.name))
      reasons.push("WORKFLOW_TERMINAL_CONFLICT");
    // Equal-time contradictory terminal events have no evidenced first terminal.
    const tied =
      first &&
      terminals.some((e) => e.timestamp === first.timestamp && e.name !== first.name);
    if (tied) reasons.push("WORKFLOW_TERMINAL_ORDER_UNRESOLVED");
    if (
      first?.name === "workflow_completed" &&
      !steps.some(
        (s) => s.key === d.terminalPolicy.completedStepKey && s.at <= first.timestamp,
      )
    )
      reasons.push("WORKFLOW_SUCCESS_STEP_MISSING");
    const fatal = reasons.some((r) => r !== "WORKFLOW_TERMINAL_CONFLICT");
    const state: WorkflowInstanceFact["state"] = fatal
      ? "unresolved"
      : first
        ? (first.name.slice("workflow_".length) as "completed" | "failed" | "canceled")
        : asOf >= start.timestamp + d.timeoutSeconds * 1000
          ? "approximate_abandoned"
          : "started";
    instances.push({
      workflowInstanceId: start.workflowInstanceId,
      workflowKey: start.workflowKey,
      version: start.version,
      versionId: d.versionId,
      sessionId: start.sessionId,
      identified: start.identified,
      startedAt: start.timestamp,
      terminalAt: first?.timestamp ?? null,
      state,
      durationMs:
        state === "completed" && first ? first.timestamp - start.timestamp : null,
      steps: steps.filter((s) => !first || s.at <= first.timestamp),
      reasons: [...new Set(reasons)],
    });
  }
  return { instances, rejected };
}
export function summarizeWorkflowCohort(
  instances: readonly WorkflowInstanceFact[],
  definition: WorkflowFactDefinition,
  from: number,
  to: number,
) {
  const cohort = instances.filter(
    (i) =>
      i.versionId === definition.versionId && i.startedAt >= from && i.startedAt < to,
  );
  const durations = cohort.flatMap((i) =>
    i.durationMs === null ? [] : [i.durationMs],
  );
  const count = (state: WorkflowInstanceFact["state"]) =>
    cohort.filter((i) => i.state === state).length;
  const quantiles = (values: number[]) => ({
    p50: sessionPercentile(values, 0.5),
    p90: sessionPercentile(values, 0.9),
    p75: sessionPercentile(values, 0.75),
    p99: sessionPercentile(values, 0.99),
    sample: values.length,
    algorithm: "linear_interpolation",
  });
  const stages = definition.steps.map((s, index) => {
    const reached = cohort.filter((i) => i.steps.some((x) => x.key === s.stepKey));
    const previous = definition.steps[index - 1];
    const paired = previous
      ? cohort.flatMap((i) => {
          const a = i.steps.find((x) => x.key === previous.stepKey),
            b = i.steps.find((x) => x.key === s.stepKey);
          return a && b && b.at >= a.at ? [b.at - a.at] : [];
        })
      : [];
    const previousCount = previous
      ? cohort.filter((i) => i.steps.some((x) => x.key === previous.stepKey)).length
      : cohort.length;
    const progressed = previous
      ? cohort.filter(
          (i) =>
            i.steps.some((x) => x.key === previous.stepKey) &&
            i.steps.some((x) => x.key === s.stepKey),
        ).length
      : reached.length;
    return {
      stepKey: s.stepKey,
      name: s.name,
      stepOrder: s.stepOrder,
      reached: reached.length,
      rate: cohort.length ? reached.length / cohort.length : null,
      adjacentDropoff: previousCount
        ? (previousCount - progressed) / previousCount
        : null,
      adjacentDuration: quantiles(paired),
    };
  });
  return {
    started: cohort.length,
    completed: count("completed"),
    failed: count("failed"),
    canceled: count("canceled"),
    approximate_abandoned: count("approximate_abandoned"),
    inProgress: count("started"),
    unresolved: count("unresolved"),
    successRate:
      cohort.length && !count("unresolved") ? count("completed") / cohort.length : null,
    task_duration: quantiles(durations),
    stages,
    unidentified: cohort.filter((i) => !i.identified).length,
  };
}
