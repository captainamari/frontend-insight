import { evaluateFormula } from "./formula.js";
import { PAGE_TEMPLATE_DURATION_TARGETS } from "./metrics.js";
import type { PageTemplate } from "./model.js";
/** Shared query-window semantics inherited from the accepted analytics service. */
export function expectedScoreDates(
  from: string,
  to: string,
  timezone: string,
  weekdays: readonly number[],
) {
  const dates = new Set<string>();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const start = Date.parse(from),
    end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 400 * 86400000)
    return [];
  for (let t = start; t < end; t += 12 * 3600000) dates.add(formatter.format(t));
  if (end > start) dates.add(formatter.format(end - 1));
  return [...dates]
    .filter((d) => weekdays.includes(new Date(d + "T12:00:00Z").getUTCDay()))
    .sort();
}
export const CANONICAL_SCORE_IDENTITY = "identified-user-v1.8";
export interface ScoreActivity {
  eventId: string;
  userId: string | null;
  sessionId: string;
  timestamp: string;
  pageRoute: string;
  moduleId: string | null;
  valid: boolean;
  visibleDurationMs?: number;
}
export function canonicalBusinessActivity(event: ScoreActivity) {
  return Boolean(event.userId && event.userId.trim() && event.valid && event.moduleId);
}
export function sessionPercentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  if (p < 0 || p > 1 || values.some((v) => !Number.isFinite(v) || v < 0))
    throw new Error("SCORE_SAMPLE_INVALID");
  const sorted = [...values].sort((a, b) => a - b),
    position = (sorted.length - 1) * p,
    index = Math.floor(position);
  return (
    sorted[index]! +
    (sorted[Math.ceil(position)]! - sorted[index]!) * (position - index)
  );
}
export function pooledWorkflowPercentile(
  samples: readonly { durationMs: number; weight: number }[],
  p: number,
) {
  if (!samples.length) return null;
  if (
    p <= 0 ||
    p > 1 ||
    samples.some(
      (s) =>
        !Number.isFinite(s.durationMs) ||
        s.durationMs < 0 ||
        !Number.isFinite(s.weight) ||
        s.weight <= 0,
    )
  )
    throw new Error("SCORE_SAMPLE_INVALID");
  const sorted = [...samples].sort((a, b) => a.durationMs - b.durationMs),
    total = sorted.reduce((n, s) => n + s.weight, 0);
  let cumulative = 0;
  for (const s of sorted) {
    cumulative += s.weight;
    if (cumulative >= total * p) return s.durationMs;
  }
  return sorted.at(-1)!.durationMs;
}
/** Pure facts adapter contract. Callers must first prove project/env/version/scope and exposure completeness; no collector or database fallback. */
export function operationalUsageSamples(input: {
  from: string;
  to: string;
  timezone: string;
  targetUsers: number | null;
  weekdays: readonly number[];
  identityComplete: boolean;
  exposureComplete: boolean;
  events: readonly ScoreActivity[];
  pages: readonly {
    pageRoute: string;
    moduleId: string;
    isCore: boolean;
    criticalityWeight: number;
    templateKey: PageTemplate;
  }[];
  durationMinimumSample: number;
}) {
  const start = Date.parse(input.from),
    end = Date.parse(input.to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    throw new Error("SCORE_RANGE_INVALID");
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const events = [
    ...new Map(
      input.events
        .filter(
          (e) => Date.parse(e.timestamp) >= start && Date.parse(e.timestamp) < end,
        )
        .map((e) => [e.eventId, e]),
    ).values(),
  ];
  const valid = events.filter(
    (e) =>
      canonicalBusinessActivity(e) &&
      input.pages.some((p) => p.pageRoute === e.pageRoute && p.moduleId === e.moduleId),
  );
  const users = new Map<string, Set<string>>(),
    vvSamples = new Map<string, ScoreActivity[]>();
  for (const event of valid) {
    const days = users.get(event.userId!) ?? new Set<string>();
    days.add(date.format(new Date(event.timestamp)));
    users.set(event.userId!, days);
    const group = vvSamples.get(event.sessionId) ?? [];
    group.push(event);
    vvSamples.set(event.sessionId, group);
  }
  const allSessions = new Set(
    events.filter((e) => e.valid && e.userId).map((e) => e.sessionId),
  );
  const expectedDates = expectedScoreDates(
    input.from,
    input.to,
    input.timezone,
    input.weekdays,
  );
  const activeDates = [...new Set(valid.map((e) => date.format(new Date(e.timestamp))))]
    .filter((d) => expectedDates.includes(d))
    .sort();
  const uv = users.size,
    crossDay = [...users.values()].filter((d) => d.size >= 2).length;
  const core = input.pages.filter((p) => p.isCore);
  const covered = core.filter((p) => valid.some((e) => e.pageRoute === p.pageRoute));
  const coreWeight = core.reduce((s, p) => s + p.criticalityWeight, 0);
  const coveredWeight = covered.reduce((s, p) => s + p.criticalityWeight, 0);
  const durations = core.map((page) => {
    const values = valid
      .filter(
        (e) =>
          e.pageRoute === page.pageRoute &&
          e.visibleDurationMs !== undefined &&
          Number.isFinite(e.visibleDurationMs) &&
          e.visibleDurationMs! >= 0,
      )
      .map((e) => e.visibleDurationMs!);
    const raw = sessionPercentile(values, 0.5),
      t = PAGE_TEMPLATE_DURATION_TARGETS[page.templateKey];
    const fit =
      raw === null || values.length < input.durationMinimumSample
        ? null
        : evaluateFormula(
            {
              type: "normalize",
              direction: "target_range",
              input: { type: "literal", value: raw },
              target: {
                toleranceMin: t.toleranceMin!,
                targetMin: t.targetMin!,
                targetMax: t.targetMax!,
                toleranceMax: t.toleranceMax!,
              },
            },
            {},
          ).value;
    return {
      pageRoute: page.pageRoute,
      weight: page.criticalityWeight,
      rawDurationP50Ms: raw,
      target: t,
      sampleSize: values.length,
      score: fit,
    };
  });
  const validDuration = durations.filter((d) => d.score !== null);
  const durationFit = validDuration.length
    ? evaluateFormula(
        {
          type: "weighted_mean",
          items: validDuration.map((d) => ({
            value: { type: "literal", value: d.score! },
            weight: d.weight,
          })),
        },
        {},
      ).value
    : null;
  const complete = input.identityComplete && input.exposureComplete;
  const singleDate = date.format(start) === date.format(end - 1);
  const values = {
    active_user_target_attainment:
      input.targetUsers && input.targetUsers > 0 ? uv / input.targetUsers : null,
    core_page_coverage: coreWeight ? coveredWeight / coreWeight : null,
    active_day_coverage: expectedDates.length
      ? activeDates.length / expectedDates.length
      : null,
    cross_day_continuity: singleDate || !uv ? null : crossDay / uv,
    session_distinct_pages_fit: sessionPercentile(
      [...vvSamples.values()].map((es) => new Set(es.map((e) => e.pageRoute)).size),
      0.5,
    ),
    session_module_breadth_fit: sessionPercentile(
      [...vvSamples.values()].map((es) => new Set(es.map((e) => e.moduleId)).size),
      0.5,
    ),
    page_visible_duration_fit: durationFit === null ? null : durationFit / 100,
  };
  return {
    values: complete
      ? values
      : (Object.fromEntries(
          Object.keys(values).map((k) => [k, null]),
        ) as typeof values),
    reason: !complete ? "IDENTITY_OR_EXPOSURE_INCOMPLETE" : null,
    crossDayReason: singleDate
      ? "SINGLE_LOCAL_DATE_CANNOT_OBSERVE_CROSS_DAY_CONTINUITY"
      : null,
    samples: {
      total: events.length,
      valid: valid.length,
      excluded: events.length - valid.length,
      unidentified: events.filter((e) => !e.userId).length,
      reason: "未识别、无效或未归类业务活动排除；混合会话保留已归类部分。",
    },
    vvSamples: {
      total: allSessions.size,
      valid: vvSamples.size,
      excluded: allSessions.size - vvSamples.size,
      sampleUnit: "session",
      algorithm: "linear_interpolation",
      boundary:
        "existing_session_id; event-window [from,to); 30-minute inactivity; no midnight reset",
    },
    expectedDates,
    activeDates,
    uv,
    crossDayNumerator: crossDay,
    coreNumerator: coveredWeight,
    coreDenominator: coreWeight,
    durations,
  };
}
export interface ScopedWorkflowInstance {
  workflowInstanceId: string;
  workflowType: string;
  state: "started" | "completed" | "failed" | "canceled" | "approximate_abandoned";
  weight: number;
  durationMs: number | null;
}
/** Instances already assigned to one approved query scope by the future R4-B fact service. */
export function workflowScoreSamples(instances: readonly ScopedWorkflowInstance[]) {
  const unique = [...new Map(instances.map((i) => [i.workflowInstanceId, i])).values()];
  if (unique.some((i) => !Number.isFinite(i.weight) || i.weight <= 0))
    throw new Error("SCORE_WORKFLOW_WEIGHT_INVALID");
  const typeWeights = new Map<string, number>();
  for (const item of unique) {
    const existing = typeWeights.get(item.workflowType);
    if (existing !== undefined && existing !== item.weight)
      throw new Error("SCORE_WORKFLOW_TYPE_WEIGHT_INCONSISTENT");
    typeWeights.set(item.workflowType, item.weight);
  }
  const totalWeight = unique.reduce((s, i) => s + i.weight, 0),
    completed = unique.filter((i) => i.state === "completed"),
    adverse = unique.filter((i) =>
      ["failed", "canceled", "approximate_abandoned"].includes(i.state),
    );
  const samples = completed
    .filter(
      (i) =>
        i.durationMs !== null && Number.isFinite(i.durationMs) && i.durationMs >= 0,
    )
    .map((i) => ({ durationMs: i.durationMs!, weight: i.weight }));
  const groups = [...new Set(unique.map((i) => i.workflowType))].map((workflowType) => {
    const group = unique.filter((i) => i.workflowType === workflowType),
      success = group
        .filter(
          (i) => i.state === "completed" && i.durationMs !== null && i.durationMs >= 0,
        )
        .map((i) => ({ durationMs: i.durationMs!, weight: i.weight }));
    return {
      workflowType,
      started: group.length,
      completed: group.filter((i) => i.state === "completed").length,
      effectiveDurationSamples: success.length,
      p50: pooledWorkflowPercentile(success, 0.5),
      p90: pooledWorkflowPercentile(success, 0.9),
    };
  });
  return {
    completionRate: totalWeight
      ? completed.reduce((s, i) => s + i.weight, 0) / totalWeight
      : null,
    adverseRate: totalWeight
      ? adverse.reduce((s, i) => s + i.weight, 0) / totalWeight
      : null,
    p50: pooledWorkflowPercentile(samples, 0.5),
    p90: pooledWorkflowPercentile(samples, 0.9),
    total: unique.length,
    valid: samples.length,
    excluded: unique.length - samples.length,
    groups,
  };
}
