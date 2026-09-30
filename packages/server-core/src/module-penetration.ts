import { directoryAt, type DirectoryVersion } from "./organization-directory.js";
import {
  localDateTime,
  projectLocalInstant,
} from "@frontend-insight/event-contract/project-range";

export interface PopulationScope {
  projectId: string;
  env: string;
  identityVersion: string;
  activityScope: string;
}
export interface PopulationEvidence extends PopulationScope {
  source: string;
  sourceVersion: string;
  window: { from: string; to: string };
  count: number;
  directoryVersion?: string;
  coverage: "complete" | "unknown" | "insufficient";
  // Coverage comes from a trusted collector/source contract, never first-event time.
  coverageWindows: { from: string; to: string }[];
}
export function penetrationObservationWindow(to: string, timezone: string) {
  const local = new Date(localDateTime(to, timezone) + "Z");
  local.setUTCDate(local.getUTCDate() - 90);
  return {
    from: projectLocalInstant(local.toISOString().slice(0, -1), timezone),
    to: new Date(to).toISOString(),
    timezone,
    boundary: "[from,to)" as const,
    calendarDays: 90,
    dstDisambiguation: "earlier_overlap_forward_gap" as const,
  };
}
function covers(e: PopulationEvidence) {
  let cursor = Date.parse(e.window.from);
  const end = Date.parse(e.window.to);
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || cursor >= end) return false;
  const spans = e.coverageWindows.map(
    (w) => [Date.parse(w.from), Date.parse(w.to)] as const,
  );
  if (spans.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b) || a >= b))
    return false;
  for (const [a, b] of spans.sort((a, b) => a[0] - b[0])) {
    if (a > cursor) break;
    cursor = Math.max(cursor, b);
    if (cursor >= end) return true;
  }
  return false;
}
/** Server-owned evidence only. No query parameter may assert source or coverage. */
export function evaluateModulePenetration(input: {
  scope: PopulationScope;
  from: string;
  to: string;
  timezone: string;
  observedNumerator: number | null;
  numeratorEvidence?: PopulationEvidence | undefined;
  denominatorEvidence?: PopulationEvidence | undefined;
}) {
  const observationWindow = penetrationObservationWindow(input.to, input.timezone);
  const n = input.numeratorEvidence,
    d = input.denominatorEvidence;
  const base = {
    metricKey: "module_penetration",
    value: null as number | null,
    numerator: n?.count ?? input.observedNumerator,
    numeratorStatus: n ? "source_evidence" : "observed_page_view_only",
    numeratorWindow: { from: input.from, to: input.to, boundary: "[from,to)" },
    denominator: d?.count ?? null,
    denominatorSource: d?.source ?? null,
    sourceVersion: d?.sourceVersion ?? null,
    directoryVersion: d?.directoryVersion ?? null,
    observationWindow,
    coverage: "unknown",
    estimated: false,
    availability: "unavailable",
    reason: "PENETRATION_SOURCE_MISSING",
    explanation:
      "已批准90个项目日历日活跃用户近似。当前缺少可信完整业务活动来源或覆盖证据；页面访问观察不是完整业务UV，分母不代表编制人数或真实系统总人数。",
  };
  const unavailable = (reason: string, coverage = "unknown") => ({
    ...base,
    reason,
    coverage,
  });
  const directory = !!d?.directoryVersion;
  if (!directory && Date.parse(input.from) < Date.parse(observationWindow.from))
    return unavailable("PENETRATION_RANGE_INCOMPATIBLE");
  if (!n || !d || !n.source || !d.source || !n.sourceVersion || !d.sourceVersion)
    return unavailable("PENETRATION_SOURCE_MISSING");
  if (
    [n, d].some(
      (e) => e.projectId !== input.scope.projectId || e.env !== input.scope.env,
    )
  )
    return unavailable("PENETRATION_SCOPE_INCOMPATIBLE");
  if (
    [n, d].some(
      (e) =>
        e.identityVersion !== input.scope.identityVersion ||
        e.activityScope !== input.scope.activityScope,
    )
  )
    return unavailable("PENETRATION_IDENTITY_SCOPE_INCOMPATIBLE");
  if (!directory && (n.source !== d.source || n.sourceVersion !== d.sourceVersion))
    return unavailable("PENETRATION_SOURCE_INCOMPATIBLE");
  if (
    Date.parse(n.window.from) !== Date.parse(input.from) ||
    Date.parse(n.window.to) !== Date.parse(input.to) ||
    Date.parse(d.window.from) !==
      Date.parse(directory ? input.from : observationWindow.from) ||
    Date.parse(d.window.to) !== Date.parse(input.to)
  )
    return unavailable("PENETRATION_RANGE_INCOMPATIBLE");
  if ([n, d].some((e) => e.coverage === "unknown"))
    return unavailable("PENETRATION_COVERAGE_UNKNOWN");
  if ([n, d].some((e) => e.coverage !== "complete" || !covers(e)))
    return unavailable("PENETRATION_COVERAGE_INSUFFICIENT", "insufficient");
  if (
    [n, d].some((e) => !Number.isSafeInteger(e.count) || e.count < 0) ||
    n.count > d.count
  )
    return unavailable("PENETRATION_SOURCE_INCONSISTENT", "complete");
  if (d.count === 0) return unavailable("PENETRATION_DENOMINATOR_ZERO", "complete");
  return {
    ...base,
    value: n.count / d.count,
    estimated: !directory,
    availability: directory ? "available" : "estimated",
    coverage: "complete",
    reason: directory
      ? "PENETRATION_TRUSTED_DIRECTORY"
      : "PENETRATION_ACTIVE_POPULATION_ESTIMATE",
    explanation: directory
      ? "模块规范业务UV / 同项目、环境、身份与窗口的可信完整eligible目录人数；目录版本固定，不重解释历史。"
      : "模块规范业务UV / 同项目、环境、身份及业务范围的90个项目日历日活跃用户。分母是活跃用户近似，不是编制人数或真实系统总人数。",
  };
}

/** No UI query can assert directory coverage. Caller must apply organization suppression first. */
export function directoryPopulationEvidence(
  versions: DirectoryVersion[],
  scope: PopulationScope,
  from: string,
  to: string,
  asOf: number,
): PopulationEvidence | undefined {
  const a = directoryAt(versions, scope.env, Date.parse(from), asOf);
  const b = directoryAt(versions, scope.env, Date.parse(to) - 1, asOf);
  if (
    !a ||
    !b ||
    a.id !== b.id ||
    a.projectId !== scope.projectId ||
    a.coverage !== "complete"
  )
    return;
  return {
    ...scope,
    source: "trusted_eligible_directory",
    sourceVersion: a.id,
    directoryVersion: a.id,
    window: { from, to },
    count: a.entries.filter((e) => e.eligible).length,
    coverage: "complete",
    coverageWindows: [{ from, to }],
  };
}
