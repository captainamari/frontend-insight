import type { CalendarBucket } from "@frontend-insight/event-contract/project-range";
import type { BusinessPageWindow } from "./business-facts.js";
import { directoryAt, type DirectoryVersion } from "./organization-directory.js";

export const ORGANIZATION_POLICY_VERSION = "r4c-organization-k5-2026-09-29.1";
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
  payload: Record<string, unknown>;
}
export interface OrganizationContext {
  projectId: string;
  env: string;
  asOf: number;
  moduleId: string;
  buckets: CalendarBucket[];
  directories: DirectoryVersion[];
  pages: BusinessPageWindow[];
}
/** A fixed closed calendar bucket must fit one historical directory version. */
export function organizationWindowReason(c: OrganizationContext): string | null {
  if (!c.directories.some((v) => v.env === c.env && v.status === "published"))
    return "TRUSTED_DIRECTORY_MISSING";
  if (!c.buckets.length || c.buckets.some((b) => b.partial))
    return "ORGANIZATION_FIXED_BUCKET_REQUIRED";
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
    reason === "ORGANIZATION_SMALL_GROUP" ? "privacy_suppressed" : "not_collected",
  reason,
  values: null,
  definitionVersion: ORGANIZATION_POLICY_VERSION,
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
      const activity =
        e.event === "page_view" ||
        (e.event === "custom" &&
          e.payload.businessAdapter === true &&
          e.payload.name === "feature_started");
      if (!activity) continue;
      if (!e.user) {
        excluded.unidentified++;
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
        continue;
      }
      const page = matching[0]!;
      if (!member.roleId) excluded.missingRole++;
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
          (!r.durationMissing && r.pv > 0 && r.durationUsers.size < 5),
      ) ||
      Object.values(excluded).some((n) => n > 0 && n < 5);
    return { b, directory, excluded, rows, suppressed };
  });
  if (values.some((v) => v.suppressed)) return blocked("ORGANIZATION_SMALL_GROUP");
  return {
    status: "partial",
    reason: "ORGANIZATION_ACTIVITY_COVERAGE_NOT_VERIFIED",
    definitionVersion: ORGANIZATION_POLICY_VERSION,
    coverage: "observed_page_views_and_controlled_operation_starts",
    values: values.map((v) => ({
      from: v.b.from,
      to: v.b.to,
      directoryVersionId: v.directory.id,
      sourceKey: v.directory.sourceKey,
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
          value: null,
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
