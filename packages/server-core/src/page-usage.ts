import { createClient, type ClickHouseClient } from "@clickhouse/client";
import {
  localDateTime,
  type CalendarBucket,
} from "@frontend-insight/event-contract/project-range";
import { SafeClickHouseLogger } from "./clickhouse-logger.js";
import type { FormulaInputValue } from "./formula.js";
export const PAGE_USAGE_DEFINITION = "page-usage-2026-10-06.1";
export const PAGE_USAGE_KEYS = [
  "pv",
  "uv",
  "dau",
  "wau",
  "mau",
  "vv",
  "avg_usage_duration",
  "hourly_distribution",
  "bounce_rate",
] as const;
export interface UsageEvent {
  id: string;
  at: number;
  event: string;
  route: string;
  user: string | null;
  device: string;
  session: string;
  pageView: string;
  duration: number | null;
}
export interface UsagePage {
  pageRoute: string;
  moduleId: string;
  from: string;
  to: string | null;
}
const input = (
  value: number | null,
  sampleSize: number,
  reason: string | null = null,
): FormulaInputValue => ({
  value: reason ? null : value,
  sampleSize,
  status: reason ? "missing" : "available",
  reason,
});
const percentile = (values: number[], p: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!
    : null;
const identity = (e: UsageEvent) =>
  e.user ? "u:" + e.user : e.device ? "d:" + e.device : null;
function period(at: number, zone: string, kind: string) {
  const local = localDateTime(new Date(at).toISOString(), zone);
  if (kind === "month") return local.slice(0, 7);
  if (kind === "day") return local.slice(0, 10);
  const d = new Date(local.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
/** ADR-019: select [from,to) first, then pool original session IDs; midnight never splits a session.
 * The caller supplies all routes in scope, so filtering a page cannot manufacture a bounce. */
export function pageUsageWindow(
  source: UsageEvent[],
  from: string,
  to: string,
  zone: string,
  route?: string,
  pages: UsagePage[] = [],
) {
  const seen = new Set<string>();
  const events = source.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return e.at >= Date.parse(from) && e.at < Date.parse(to);
  });
  const views = events.filter((e) => e.event === "page_view");
  const selected = views.filter((e) => !route || e.route === route);
  const users = new Set(selected.map(identity).filter(Boolean));
  const vvSet = new Set(selected.map((e) => e.session).filter(Boolean));
  const identified = new Set(selected.filter((e) => e.user).map((e) => e.user)).size;
  const anonymous = new Set(
    selected.filter((e) => !e.user && e.device).map((e) => e.device),
  ).size;
  const leaves = events.filter(
    (e) => e.event === "page_leave" && e.duration !== null && e.duration >= 0,
  );
  const leaveIndex = new Map<string, UsageEvent[]>();
  for (const e of leaves) {
    const list = leaveIndex.get(e.pageView) ?? [];
    list.push(e);
    leaveIndex.set(e.pageView, list);
  }
  const sessionIndex = new Map<string, UsageEvent[]>();
  for (const e of views) {
    const list = sessionIndex.get(e.session) ?? [];
    list.push(e);
    sessionIndex.set(e.session, list);
  }
  const pageIndex = new Map<string, UsagePage[]>();
  for (const p of pages) {
    const list = pageIndex.get(p.pageRoute) ?? [];
    list.push(p);
    pageIndex.set(p.pageRoute, list);
  }
  const durations: number[] = [];
  for (const v of selected) {
    const segments = (leaveIndex.get(v.pageView) ?? []).filter(
      (e) =>
        e.pageView === v.pageView &&
        e.session === v.session &&
        e.route === v.route &&
        e.at >= v.at &&
        identity(e) === identity(v),
    );
    if (segments.length) durations.push(segments.reduce((n, e) => n + e.duration!, 0));
  }
  const depths: number[] = [],
    breadths: number[] = [];
  for (const s of vvSet) {
    const cohort = sessionIndex.get(s) ?? [];
    depths.push(new Set(cohort.map((e) => e.route)).size);
    const modules = new Set(
      cohort.flatMap((e) =>
        (pageIndex.get(e.route) ?? [])
          .filter(
            (p) =>
              p.pageRoute === e.route &&
              e.at >= Date.parse(p.from) &&
              (!p.to || e.at < Date.parse(p.to)),
          )
          .map((p) => p.moduleId),
      ),
    );
    if (modules.size) breadths.push(modules.size);
  }
  const reason = selected.length ? null : "NO_PAGE_VIEWS";
  const completeDuration =
    selected.length > 0 && durations.length === selected.length && users.size > 0;
  const inputs: Record<string, FormulaInputValue> = {
    pv: input(selected.length || null, selected.length, reason),
    uv: input(
      users.size || null,
      selected.length,
      reason ?? (selected.some((e) => !identity(e)) ? "IDENTITY_MISSING" : null),
    ),
    vv: input(
      vvSet.size || null,
      selected.length,
      reason ?? (selected.some((e) => !e.session) ? "SESSION_MISSING" : null),
    ),
    avg_usage_duration: input(
      completeDuration ? durations.reduce((n, v) => n + v, 0) / users.size : null,
      durations.length,
      completeDuration ? null : "PAGE_LEAVE_OR_IDENTITY_MISSING",
    ),
    bounce_rate: input(
      vvSet.size ? depths.filter((n) => n === 1).length / vvSet.size : null,
      vvSet.size,
      vvSet.size ? null : "EMPTY_DENOMINATOR",
    ),
  };
  const calendar: Record<
    string,
    { period: string; value: number; partial: boolean }[]
  > = {};
  for (const [key, kind] of [
    ["dau", "day"],
    ["wau", "week"],
    ["mau", "month"],
  ]) {
    const groups = new Map<string, Set<string>>();
    for (const e of selected) {
      const who = identity(e);
      if (!who) continue;
      const k = period(e.at, zone, kind!);
      const set = groups.get(k) ?? new Set<string>();
      set.add(who);
      groups.set(k, set);
    }
    calendar[key!] = [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, set]) => ({ period: p, value: set.size, partial: true }));
    // A scalar spans exactly one natural period. Multi-period data is a series, never summed or silently averaged.
    const singlePeriod =
      period(Date.parse(from), zone, kind!) === period(Date.parse(to) - 1, zone, kind!);
    inputs[key!] = input(
      singlePeriod && groups.size === 1 ? [...groups.values()][0]!.size : null,
      selected.length,
      singlePeriod && groups.size === 1
        ? null
        : groups.size
          ? "MULTIPLE_CALENDAR_PERIODS_SEE_SERIES"
          : "NO_PAGE_VIEWS",
    );
  }
  const localHours = new Map(
    selected.map((e) => [
      e.id,
      Number(localDateTime(new Date(e.at).toISOString(), zone).slice(11, 13)),
    ]),
  );
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const rows = selected.filter((e) => localHours.get(e.id) === hour);
    return {
      hour,
      pv: rows.length || null,
      uv: rows.length ? new Set(rows.map(identity).filter(Boolean)).size : null,
      status: rows.length ? "observed" : "no_data",
    };
  });
  inputs.hourly_distribution = input(null, selected.length, "DISTRIBUTION_SEE_HOURLY");
  return {
    inputs,
    calendar,
    hourly,
    identity: {
      identified,
      anonymous,
      missing: selected.filter((e) => !identity(e)).length,
      rule: "userId, otherwise deviceId; no cross-identity stitching",
    },
    diagnostics: {
      totalPageViews: selected.length,
      validDurationSamples: durations.length,
      missingPageLeave: selected.length - durations.length,
      coverage: selected.length ? durations.length / selected.length : null,
      visibleDuration: Object.fromEntries(
        [50, 75, 90, 99].map((p) => ["p" + p, percentile(durations, p / 100)]),
      ),
      pageDepthP50: percentile(depths, 0.5),
      moduleBreadthP50: percentile(breadths, 0.5),
      moduleSamples: breadths.length,
      excludedUnclassifiedSessions: vvSet.size - breadths.length,
    },
    availableFrom: selected.length
      ? new Date(Math.min(...selected.map((e) => e.at))).toISOString()
      : null,
    dataState: selected.length ? "observed" : "no_data",
  };
}
export class PageUsageStore {
  private readonly client: ClickHouseClient;
  constructor(config: {
    url: string;
    username: string;
    password: string;
    database: string;
  }) {
    this.client = createClient({
      ...config,
      log: { LoggerClass: SafeClickHouseLogger },
    });
  }
  close() {
    return this.client.close();
  }
  async read(
    projectId: string,
    env: string,
    from: string,
    to: string,
    zone: string,
    buckets: CalendarBucket[],
    route?: string,
    pages: UsagePage[] = [],
  ) {
    const response = await this.client.query({
      query: `SELECT event_id AS id,toUnixTimestamp64Milli(timestamp) AS at,event,page_route AS route,user_id AS user,device_id AS device,session_id AS session,page_view_id AS pageView,visible_duration_ms AS duration FROM raw_events WHERE project_id={projectId:UUID} AND env={env:String} AND event IN ('page_view','page_leave') AND timestamp>=parseDateTime64BestEffort({from:String},3) AND timestamp<parseDateTime64BestEffort({to:String},3) ORDER BY received_at DESC LIMIT 1 BY event_id LIMIT 50001`,
      query_params: { projectId, env, from, to },
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 5,
        max_rows_to_read: "1000000",
        read_overflow_mode: "throw",
      },
    });
    const body = await response.json<UsageEvent>();
    if (body.data.length > 50000) throw new Error("PAGE_USAGE_BUDGET_EXCEEDED");
    const events = body.data.map((e) => ({
      ...e,
      at: Number(e.at),
      duration: e.duration === null ? null : Number(e.duration),
    }));
    return {
      ...pageUsageWindow(events, from, to, zone, route, pages),
      routes: [
        ...new Set(events.filter((e) => e.event === "page_view").map((e) => e.route)),
      ].sort(),
      trend: buckets.map((b) => ({
        ...b,
        ...pageUsageWindow(events, b.from, b.to, zone, route, pages),
      })),
      statistics: {
        clickHouseQueries: 1,
        rowsRead: body.statistics?.rows_read ?? 0,
        bytesRead: body.statistics?.bytes_read ?? 0,
        elapsedSeconds: body.statistics?.elapsed ?? 0,
        returnedEvents: events.length,
      },
    };
  }
}
