import { R4C_FACT_DEFINITION_VERSION } from "./system-metric-catalog.js";
import type { RepeatedProof } from "./repeated-projection.js";
import type { BusinessPageWindow } from "./business-facts.js";
interface Event {
  at: number;
  received: number;
  user: string | null;
  session: string;
  page: string;
  payload: Record<string, unknown>;
}
export function readRepeatedRate(
  events: Event[],
  proofs: RepeatedProof[],
  context: {
    from: number;
    to: number;
    asOf: number;
    moduleId: string;
    pages: BusinessPageWindow[];
  },
) {
  const day = 86400000,
    starts = new Map<string, Event>(),
    required = new Map<string, Event>(),
    conflicts = new Set<string>();
  for (const e of events) {
    if (
      e.at < context.from - day ||
      e.at >= context.to + day ||
      e.received > context.asOf ||
      !e.user ||
      e.payload.name !== "feature_started" ||
      e.payload.repeatedEligible !== true
    )
      continue;
    const id = String(e.payload.operationInstanceId),
      previous = required.get(id);
    if (
      previous &&
      JSON.stringify({ ...previous, received: 0 }) !==
        JSON.stringify({ ...e, received: 0 })
    )
      conflicts.add(id);
    required.set(id, e);
    if (e.at < context.from || e.at >= context.to) continue;
    const pages = context.pages.filter(
      (p) =>
        p.included &&
        p.pageRoute === e.page &&
        p.moduleId === context.moduleId &&
        Date.parse(p.from) <= e.at &&
        e.at < Date.parse(p.to),
    );
    if (pages.length !== 1) continue;
    const key = String(e.payload.operationInstanceId),
      prior = starts.get(key);
    if (
      prior &&
      JSON.stringify({ ...prior, received: 0 }) !==
        JSON.stringify({ ...e, received: 0 })
    )
      conflicts.add(key);
    else starts.set(key, e);
  }
  const relatedSessionKeys = new Set<string>(),
    receipts = new Set<string>(),
    hits = new Set<string>();
  for (const e of starts.values())
    relatedSessionKeys.add(JSON.stringify([e.user, e.session]));
  for (const p of proofs) {
    if (
      p.processed > context.asOf ||
      p.received > context.asOf ||
      p.proof_received > context.asOf ||
      p.proof_to > context.asOf
    )
      continue;
    const start = required.get(p.instance);
    if (
      start &&
      start.user === p.user &&
      start.session === p.session &&
      start.at === p.at &&
      start.payload.featureKey === p.operation
    )
      receipts.add(p.instance);
    const key = JSON.stringify([p.user, p.session]);
    if (
      p.hit &&
      relatedSessionKeys.has(key) &&
      p.proof_from >= context.from - day &&
      p.proof_to < context.to + day
    )
      hits.add(key);
  }
  const reason = !starts.size
    ? "OBJECT_REFERENCE_NOT_OBSERVED"
    : conflicts.size
      ? "CONFLICTING_OPERATION_INSTANCES"
      : receipts.size !== required.size
        ? "REPEATED_PROJECTION_INCOMPLETE"
        : context.from < context.asOf - 89 * day
          ? "FACT_RETENTION_RANGE_NOT_COVERED"
          : context.asOf < context.to + 2 * day
            ? "REPEATED_LATENESS_WINDOW_OPEN"
            : relatedSessionKeys.size < 5
              ? "INSUFFICIENT_SAMPLE"
              : null;
  return {
    value: reason ? null : hits.size / relatedSessionKeys.size,
    observedValue:
      receipts.size === required.size && relatedSessionKeys.size && !conflicts.size
        ? hits.size / relatedSessionKeys.size
        : null,
    numerator: hits.size,
    denominator: relatedSessionKeys.size,
    status: reason ? (starts.size ? "partial" : "not_collected") : "available",
    reason,
    definitionVersion: R4C_FACT_DEFINITION_VERSION,
    sampleSize: relatedSessionKeys.size,
    unit: "ratio",
    coverage: reason ? "incomplete_or_open" : "controlled_unsampled_object_operations",
    source: "controlled_unsampled_object_operations",
    minimumSample: 5,
    boundary:
      "rolling inclusive 24h; session cohort [from,to); lookaround +/-24h; lateness 24h",
    asOf: new Date(context.asOf).toISOString(),
  };
}
