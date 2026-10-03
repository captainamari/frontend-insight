import { usageSourceAt, type UsageSourceVersion } from "./usage-source.js";
import { R4C_FACT_DEFINITION_VERSION } from "./system-metric-catalog.js";
import type { CalendarBucket } from "@frontend-insight/event-contract/project-range";
import type { BusinessPageWindow } from "./business-facts.js";
import { directoryAt, type DirectoryVersion } from "./organization-directory.js";

export const ORGANIZATION_POLICY_VERSION = "r4c-organization-k5-2026-10-03.1";
const DAY = 86400000;
export interface OrganizationEvent {
  id: string;
  at: number;
  received: number;
  event: string;
  user: string | null;
  session: string;
  page: string;
  pageView: string;
  directory: string | null;
  dept: string | null;
  role: string | null;
  sdkVersion?: string;
  usageCoverage?: {
    droppedEvents: number;
    failedBatches: number;
    businessSampleRate: number;
  } | null;
  release?: string;
  payload: Record<string, unknown>;
}
export interface OrganizationContext {
  projectId: string;
  env: string;
  asOf: number;
  moduleId: string;
  buckets: CalendarBucket[];
  directories: DirectoryVersion[];
  sources?: UsageSourceVersion[];
  formalDefinitionActive?: boolean;
  pages: BusinessPageWindow[];
}
/** A fixed closed calendar bucket must fit one historical directory version. */
export function organizationWindowReason(c: OrganizationContext): string | null {
  if (!c.directories.some((v) => v.env === c.env && v.status === "published"))
    return "TRUSTED_DIRECTORY_MISSING";
  if (!c.buckets.length || c.buckets.some((b) => b.partial))
    return "ORGANIZATION_FIXED_BUCKET_REQUIRED";
  if (c.buckets.some((b) => Date.parse(b.from) < c.asOf - 89 * DAY))
    return "FACT_RETENTION_RANGE_NOT_COVERED";
  if (c.buckets.some((b) => Date.parse(b.to) + DAY > c.asOf))
    return "ORGANIZATION_LATENESS_WINDOW_OPEN";
  for (const b of c.buckets) {
    const start = directoryAt(c.directories, c.env, Date.parse(b.from), c.asOf);
    const end = directoryAt(c.directories, c.env, Date.parse(b.to) - 1, c.asOf);
    if (!start || !end) return "DIRECTORY_RANGE_NOT_COVERED";
    if (start.id !== end.id) return "DIRECTORY_VERSION_BOUNDARY";
    if (start.projectId && start.projectId !== c.projectId)
      return "DIRECTORY_SCOPE_MISMATCH";
    if (start.coverage !== "complete") return "DIRECTORY_COVERAGE_UNKNOWN";
    if (!start.entries.some((e) => e.eligible)) return "ZERO_DENOMINATOR";
  }
  return null;
}
const blocked = (reason: string) => ({
  status:
    reason === "ORGANIZATION_SMALL_GROUP"
      ? "privacy_suppressed"
      : reason === "TRUSTED_DIRECTORY_MISSING"
        ? "not_collected"
        : "partial",
  reason,
  values: null,
  population: null,
  definitionVersion: R4C_FACT_DEFINITION_VERSION,
  policyVersion: ORGANIZATION_POLICY_VERSION,
  coverage: "unknown",
});
export function reduceOrganization(
  events: OrganizationEvent[],
  c: OrganizationContext,
) {
  const reason = organizationWindowReason(c);
  if (reason) return blocked(reason);
  if (events.length > 50000) throw new Error("ORGANIZATION_FACT_LIMIT");
  const unique = new Map<string, OrganizationEvent>();
  for (const e of events) {
    if (e.at > c.asOf || e.received > c.asOf) continue;
    const prior = unique.get(e.id);
    if (
      prior &&
      JSON.stringify({ ...prior, received: 0 }) !==
        JSON.stringify({ ...e, received: 0 })
    )
      return blocked("ORGANIZATION_CONFLICTING_FACTS");
    unique.set(e.id, e);
  }
  const knownLoss = [...unique.values()].some(
    (e) =>
      e.usageCoverage &&
      (e.usageCoverage.droppedEvents > 0 || e.usageCoverage.failedBatches > 0),
  );
  const operations = new Map<string, OrganizationEvent[]>();
  for (const e of unique.values())
    if (e.payload.businessAdapter === true) {
      const id = String(e.payload.operationInstanceId ?? "");
      const rows = operations.get(id) ?? [];
      rows.push(e);
      operations.set(id, rows);
    }
  const invalidOperations = new Set<string>();
  for (const [id, rows] of operations) {
    const starts = rows.filter((e) => e.payload.name === "feature_started");
    const ends = rows.filter((e) => e.payload.name !== "feature_started");
    const start = starts[0],
      end = ends[0];
    if (
      !id ||
      starts.length !== 1 ||
      ends.length !== 1 ||
      !start ||
      !end ||
      end.at < start.at ||
      start.user !== end.user ||
      start.session !== end.session ||
      start.payload.featureKey !== end.payload.featureKey ||
      !["success", "rejected", "technical_failure", "canceled"].includes(
        String(end.payload.businessResult),
      )
    )
      invalidOperations.add(id);
  }
  // The same policy family covers ALL modules, departments, roles and buckets.
  // Apply suppression before applying the UI's module filter or selecting Top N.
  const modules = [
    ...new Set(c.pages.filter((p) => p.included).map((p) => p.moduleId)),
  ].sort();
  if (modules.length > 100 || c.buckets.length > 400)
    throw new Error("ORGANIZATION_SERIES_LIMIT");
  const leaves = new Map<string, OrganizationEvent[]>();
  const pageKey = (e: OrganizationEvent) =>
    JSON.stringify([e.user, e.session, e.pageView]);
  for (const e of unique.values())
    if (e.event === "page_leave") {
      const key = pageKey(e),
        rows = leaves.get(key) ?? [];
      rows.push(e);
      leaves.set(key, rows);
    }
  const pagesByRoute = new Map<string, BusinessPageWindow[]>();
  for (const page of c.pages) {
    const windows = pagesByRoute.get(page.pageRoute) ?? [];
    windows.push(page);
    pagesByRoute.set(page.pageRoute, windows);
  }
  let series = 0;
  const values = c.buckets.map((b) => {
    const directory = directoryAt(c.directories, c.env, Date.parse(b.from), c.asOf)!;
    const source = usageSourceAt(
      c.sources ?? [],
      c.projectId,
      c.env,
      Date.parse(b.from),
      c.asOf,
    );
    const endSource = usageSourceAt(
      c.sources ?? [],
      c.projectId,
      c.env,
      Date.parse(b.to) - 1,
      c.asOf,
    );
    let coverageReason: string | null = !source
      ? "USAGE_SOURCE_MISSING"
      : source.id !== endSource?.id
        ? "USAGE_SOURCE_VERSION_BOUNDARY"
        : source.coverage !== "complete"
          ? "USAGE_SOURCE_INTERRUPTED"
          : null;
    const revisions = c.pages.filter(
      (p) =>
        p.included &&
        Date.parse(p.from) < Date.parse(b.to) &&
        Date.parse(p.to) > Date.parse(b.from),
    );
    const revisionKeys = (
      rows: { pageRevisionId: string; moduleRevisionId: string }[],
    ) =>
      [...new Set(rows.map((p) => p.pageRevisionId + ":" + p.moduleRevisionId))]
        .sort()
        .join(",");
    if (source && revisionKeys(revisions) !== revisionKeys(source.scope.pages))
      coverageReason = "USAGE_SOURCE_SCOPE_CHANGED";
    if (
      source?.scopeChangedAt &&
      Date.parse(source.scopeChangedAt) < Date.parse(b.to) &&
      Date.parse(source.scopeChangedAt) <= c.asOf
    )
      coverageReason = "USAGE_SOURCE_SCOPE_CHANGED";
    if (source && c.formalDefinitionActive === false)
      coverageReason = "USAGE_SOURCE_DEFINITION_NOT_ACTIVE";
    if (source && knownLoss) coverageReason = "USAGE_SOURCE_KNOWN_LOSS";
    const validUsers = new Set<string>();
    const successInstances = new Set<string>();
    const entries = new Map(
      directory.entries.filter((e) => e.eligible).map((e) => [e.userId, e]),
    );
    const groups = ["dept", "role"] as const;
    const cells = new Map<
      string,
      {
        dimension: "dept" | "role";
        key: string;
        moduleId: string;
        eligible: number;
        users: Set<string>;
        validUsers: Set<string>;
        pv: number;
        duration: number;
        durationMissing: boolean;
        durationUsers: Set<string>;
      }
    >();
    for (const dimension of groups) {
      const sizes = new Map<string, number>();
      for (const e of entries.values()) {
        const key = dimension === "dept" ? e.deptId : e.roleId;
        if (key) sizes.set(key, (sizes.get(key) ?? 0) + 1);
      }
      for (const [key, eligible] of sizes)
        for (const moduleId of modules) {
          cells.set(JSON.stringify([dimension, key, moduleId]), {
            dimension,
            key,
            moduleId,
            eligible,
            users: new Set(),
            validUsers: new Set(),
            pv: 0,
            duration: 0,
            durationMissing: false,
            durationUsers: new Set(),
          });
        }
    }
    series += cells.size;
    if (series > 10000) throw new Error("ORGANIZATION_SERIES_LIMIT");
    const excluded = {
      unidentified: 0,
      directoryUnmatched: 0,
      unclassified: 0,
      missingRole: 0,
      other: 0,
    };
    const pageViews = new Set<string>();
    for (const e of unique.values()) {
      if (e.at < Date.parse(b.from) || e.at >= Date.parse(b.to)) continue;
      if (
        source &&
        (e.sdkVersion !== source.sdkVersion ||
          !source.releases.includes(e.release ?? ""))
      )
        coverageReason = "USAGE_SOURCE_SDK_RELEASE_MISMATCH";
      if (
        e.event === "custom" &&
        source &&
        !source.scope.features.includes(String(e.payload.featureKey))
      )
        coverageReason = "USAGE_SOURCE_FEATURE_MISMATCH";
      if (
        e.payload.businessAdapter === true &&
        (e.payload.businessSampleRate !== 1 || e.payload.businessResult === "unknown")
      )
        coverageReason = "USAGE_SOURCE_SAMPLED_OR_UNKNOWN";
      if (
        e.payload.businessAdapter === true &&
        invalidOperations.has(String(e.payload.operationInstanceId ?? ""))
      )
        coverageReason = "USAGE_SOURCE_INCOMPLETE_OPERATION";
      if (source && !e.usageCoverage) coverageReason = "USAGE_SOURCE_COVERAGE_DISABLED";
      if (
        source &&
        e.usageCoverage &&
        (e.usageCoverage.droppedEvents !== 0 || e.usageCoverage.failedBatches !== 0)
      )
        coverageReason = "USAGE_SOURCE_KNOWN_LOSS";
      if (source && e.usageCoverage && e.usageCoverage.businessSampleRate !== 1)
        coverageReason = "USAGE_SOURCE_SAMPLED";
      const success =
        e.event === "custom" &&
        e.payload.name === "feature_succeeded" &&
        (e.payload.businessAdapter !== true || e.payload.businessResult === "success");
      const validActivity = e.event === "page_view" || success;
      const activity =
        e.event === "page_view" ||
        (e.event === "custom" &&
          e.payload.businessAdapter === true &&
          e.payload.name === "feature_started");
      if (!activity && !success) continue;
      if (!e.user) {
        excluded.unidentified++;
        coverageReason = "USAGE_SOURCE_UNIDENTIFIED_ACTIVITY";
        continue;
      }
      const member = entries.get(e.user);
      if (
        !member ||
        e.directory !== directory.id ||
        e.dept !== member.deptId ||
        e.role !== member.roleId
      ) {
        excluded.directoryUnmatched++;
        coverageReason = "USAGE_SOURCE_DIRECTORY_UNMATCHED";
        continue;
      }
      const matching = (pagesByRoute.get(e.page) ?? []).filter(
        (p) =>
          p.included &&
          p.pageRoute === e.page &&
          Date.parse(p.from) <= e.at &&
          e.at < Date.parse(p.to),
      );
      if (matching.length !== 1) {
        excluded.unclassified++;
        coverageReason = "USAGE_SOURCE_UNCLASSIFIED_ACTIVITY";
        continue;
      }
      const page = matching[0]!;
      if (success && e.payload.operationInstanceId) {
        const key = JSON.stringify([e.user, e.session, e.payload.operationInstanceId]);
        if (successInstances.has(key)) continue;
        successInstances.add(key);
      }
      if (validActivity && page.moduleId === c.moduleId) validUsers.add(e.user);
      if (!member.roleId) {
        excluded.missingRole++;
        coverageReason = "USAGE_SOURCE_ROLE_UNMATCHED";
      }
      let duration: number | null = null;
      if (e.event === "page_view") {
        if (pageViews.has(pageKey(e))) {
          excluded.other++;
          continue;
        }
        pageViews.add(pageKey(e));
        const segments = [...(leaves.get(pageKey(e)) ?? [])].sort(
          (a, b) => a.at - b.at,
        );
        let previousEnd = e.at,
          sum = 0;
        let valid = segments.length > 0;
        for (const leave of segments) {
          const ms = Number(leave.payload.visibleDurationMs);
          if (
            !Number.isFinite(ms) ||
            ms < 0 ||
            ms > DAY ||
            leave.page !== e.page ||
            leave.directory !== e.directory ||
            (source &&
              (leave.sdkVersion !== source.sdkVersion ||
                !source.releases.includes(leave.release ?? "") ||
                !leave.usageCoverage ||
                leave.usageCoverage.droppedEvents > 0 ||
                leave.usageCoverage.failedBatches > 0)) ||
            leave.at - ms < previousEnd ||
            leave.at - e.at > DAY
          )
            valid = false;
          previousEnd = leave.at;
          sum += ms;
        }
        if (valid && sum <= DAY) duration = sum;
      }
      for (const dimension of groups) {
        const key = dimension === "dept" ? member.deptId : member.roleId;
        if (!key) continue;
        const cell = cells.get(JSON.stringify([dimension, key, page.moduleId]))!;
        cell.users.add(e.user);
        if (validActivity) cell.validUsers.add(e.user);
        if (e.event === "page_view") {
          cell.pv++;
          if (duration === null) cell.durationMissing = true;
          else {
            cell.duration += duration;
            cell.durationUsers.add(e.user);
          }
        }
      }
    }
    const rows = [...cells.values()];
    const suppressed =
      !rows.length ||
      rows.some(
        (r) =>
          r.eligible < 5 ||
          r.users.size < 5 ||
          (!coverageReason && r.validUsers.size < 5) ||
          (!r.durationMissing && r.pv > 0 && r.durationUsers.size < 5),
      ) ||
      Object.values(excluded).some((n) => n > 0 && n < 5);
    return {
      b,
      directory,
      excluded,
      rows,
      suppressed,
      source,
      coverageReason,
      validUsers,
    };
  });
  if (values.some((v) => v.suppressed)) return blocked("ORGANIZATION_SMALL_GROUP");
  const formal = values.every((v) => !v.coverageReason);
  return {
    status:
      formal && values.every((v) => v.rows.every((r) => !r.durationMissing && r.pv > 0))
        ? "available"
        : "partial",
    reason: formal
      ? "USAGE_SOURCE_ADMIN_ATTESTED"
      : "ORGANIZATION_ACTIVITY_COVERAGE_NOT_VERIFIED",
    population:
      formal &&
      new Set(values.map((v) => v.source!.id)).size === 1 &&
      new Set(values.map((v) => v.directory.id)).size === 1
        ? {
            from: values[0]!.b.from,
            to: values.at(-1)!.b.to,
            count: new Set(values.flatMap((v) => [...v.validUsers])).size,
            sourceVersion: values[0]!.source!.id,
          }
        : null,
    definitionVersion: R4C_FACT_DEFINITION_VERSION,
    policyVersion: ORGANIZATION_POLICY_VERSION,
    coverage: formal
      ? "admin_attested_complete"
      : "observed_page_views_and_controlled_operation_starts",
    values: values.map((v) => ({
      from: v.b.from,
      to: v.b.to,
      directoryVersionId: v.directory.id,
      sourceKey: v.directory.sourceKey,
      usageSourceVersionId: v.source?.id ?? null,
      coverageReason: v.coverageReason,
      normativeUsers: formal ? v.validUsers.size : null,
      excluded: v.excluded,
      groups: v.rows
        .filter((r) => r.moduleId === c.moduleId)
        .map((r) => ({
          dimension: r.dimension,
          key: r.key,
          moduleId: r.moduleId,
          active: r.users.size,
          eligible: r.eligible,
          observedRatio: r.users.size / r.eligible,
          value: formal ? r.validUsers.size / r.eligible : null,
          formalActive: formal ? r.validUsers.size : null,
          pv: r.pv,
          visibleDurationMs: r.durationMissing || !r.pv ? null : r.duration,
          durationReason:
            r.durationMissing || !r.pv ? "VALID_PAGE_LEAVE_MISSING" : null,
        })),
      // Rank only after checking every cell. Ties are deterministic controlled IDs.
      roleDurationProfile: v.rows.some(
        (r) => r.dimension === "role" && (r.durationMissing || !r.pv),
      )
        ? null
        : v.rows
            .filter((r) => r.dimension === "role")
            .sort(
              (a, b) =>
                b.duration - a.duration ||
                a.key.localeCompare(b.key) ||
                a.moduleId.localeCompare(b.moduleId),
            )
            .slice(0, 20)
            .map((r) => ({
              roleId: r.key,
              moduleId: r.moduleId,
              visibleDurationMs: r.duration,
            })),
      roleFeatureProfile: v.rows
        .filter((r) => r.dimension === "role")
        .sort(
          (a, b) =>
            b.pv - a.pv ||
            a.key.localeCompare(b.key) ||
            a.moduleId.localeCompare(b.moduleId),
        )
        .slice(0, 20)
        .map((r) => ({
          roleId: r.key,
          moduleId: r.moduleId,
          pv: r.pv,
          visibleDurationMs: r.durationMissing || !r.pv ? null : r.duration,
        })),
      revisions: c.pages
        .filter(
          (p) =>
            p.included &&
            Date.parse(p.from) < Date.parse(v.b.to) &&
            Date.parse(p.to) > Date.parse(v.b.from),
        )
        .map((p) => ({
          pageRevisionId: p.pageRevisionId,
          moduleRevisionId: p.moduleRevisionId,
        })),
    })),
  };
}
