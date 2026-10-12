import { parseErrorStack } from "./error-stack.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { findCredentialLeak } from "@frontend-insight/event-contract/security";
import { SafeClickHouseLogger } from "./clickhouse-logger.js";

export const ERROR_CATEGORIES = [
  "api",
  "resource",
  "vue",
  "react",
  "promise",
  "js",
  "other",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];
export interface PageQualityQuery {
  env: string;
  from: string;
  to: string;
  pageRoute?: string | undefined;
  category: string;
  mode: "latest" | "all";
  groupId?: string | undefined;
  limit: number;
  cursor?: string | undefined;
  release?: string | undefined;
}
export class PageQualityError extends Error {}
const choose = (v: unknown, allowed: readonly string[], fallback = "unknown") =>
  typeof v === "string" && allowed.includes(v) ? v : fallback;
/** No free text, raw UA, identities or arbitrary payload is returned. */
export function safeQualityPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//"))
    return null;
  const path = value.split(/[?#]/)[0]!;
  if (findCredentialLeak(path) || !/^\/[a-zA-Z0-9_/:.-]*$/.test(path)) return null;
  return path
    .split("/")
    .map((s) => (/\d{3,}|[a-f0-9]{8,}|[A-Za-z0-9_-]{20,}/i.test(s) ? ":id" : s))
    .join("/")
    .slice(0, 256);
}
function label(v: unknown) {
  return typeof v === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(v) &&
    !findCredentialLeak(v)
    ? v
    : null;
}
export function projectOccurrence(row: Record<string, unknown>) {
  let payload: Record<string, unknown> = {};
  try {
    const p: unknown = JSON.parse(String(row.payload_json ?? "{}"));
    if (p && typeof p === "object" && !Array.isArray(p))
      payload = p as Record<string, unknown>;
  } catch {
    /* Old/malformed context stays unavailable. */
  }
  const category: ErrorCategory =
    row.error_type === "api"
      ? "api"
      : row.error_type === "resource"
        ? "resource"
        : (choose(row.error_category, ERROR_CATEGORIES, "other") as ErrorCategory);
  const path = safeQualityPath(row.page_route);
  const rawFrame = String(row.error_stack_frame ?? "");
  const frame =
    safeQualityPath(rawFrame) ??
    safeQualityPath(parseErrorStack(rawFrame).frames[0]?.file) ??
    (() => {
      const match = rawFrame.match(/https?:\/\/[^\s)]+/);
      try {
        return match ? safeQualityPath(new URL(match[0]).pathname) : null;
      } catch {
        return null;
      }
    })();
  const crumbs =
    payload.breadcrumb && typeof payload.breadcrumb === "object"
      ? Object.entries(payload.breadcrumb)
          .filter(([k]) => /^b[0-9]{1,2}$/.test(k))
          .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
          .slice(0, 50)
          .map(([, v]) =>
            choose(
              v,
              [
                "navigation",
                "action",
                "api_success",
                "api_failure",
                "visible",
                "hidden",
              ],
              "",
            ),
          )
          .filter(Boolean)
      : [];
  return {
    eventId: /^evt_[A-Za-z0-9_-]{8,64}$/.test(String(row.event_id))
      ? String(row.event_id)
      : null,
    occurrenceId: createHash("sha256").update(String(row.event_id)).digest("hex"),
    groupId: /^[a-f0-9]{64}$/.test(String(row.error_group_id))
      ? String(row.error_group_id)
      : "",
    timestamp: new Date(Number(row.at)).toISOString(),
    category,
    pageRoute: path ?? "/[unavailable]",
    stackFrames: frame ? [frame] : [],
    context: {
      pageRoute: path,
      release: label(row.release),
      env: choose(row.env, ["dev", "staging", "prod"]),
      browser: choose(row.browser, ["Chrome", "Firefox", "Safari", "Edge", "Other"]),
      os: choose(row.os, ["Windows", "macOS", "Linux", "Android", "iOS", "Other"]),
      viewport: choose(row.viewport_bucket ?? payload.viewportBucket, [
        "small",
        "medium",
        "large",
      ]),
      navigation: choose(payload.navigationType, [
        "navigate",
        "reload",
        "back_forward",
        "prerender",
      ]),
      requestMethod: choose(row.request_method, [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
        "OTHER",
      ]),
      requestPath: safeQualityPath(row.request_path),
      statusCode:
        row.http_status !== null &&
        row.http_status !== undefined &&
        Number.isInteger(Number(row.http_status)) &&
        Number(row.http_status) >= 0 &&
        Number(row.http_status) <= 599
          ? Number(row.http_status)
          : null,
      sdkVersion: label(row.sdk_version),
      schemaVersion: label(String(row.schema_version ?? "")),
      workflowStep: null,
      breadcrumbs: crumbs,
    },
  };
}
export type QualityOccurrence = ReturnType<typeof projectOccurrence>;
function scope(projectId: string, q: PageQualityQuery) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        projectId,
        q.env,
        q.from,
        q.to,
        q.pageRoute ?? "",
        q.category,
        q.mode,
        q.groupId ?? "",
        q.limit,
        q.release ?? "",
      ]),
    )
    .digest("hex");
}
export function readQualityCursor(
  projectId: string,
  q: PageQualityQuery,
  secret: string,
  now = Date.now(),
) {
  if (!q.cursor) return { asOf: now, after: null as string | null };
  try {
    if (q.cursor.length > 1024) throw 0;
    const [body, mac] = q.cursor.split(".");
    const expected = createHmac("sha256", secret).update(body!).digest("hex");
    if (
      !mac ||
      mac.length !== expected.length ||
      !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
    )
      throw 0;
    const p = JSON.parse(Buffer.from(body!, "base64url").toString()) as {
      scope: string;
      asOf: number;
      after: string;
    };
    if (
      p.scope !== scope(projectId, q) ||
      !Number.isSafeInteger(p.asOf) ||
      p.asOf > now ||
      now - p.asOf > 3600000 ||
      !/^\d{13}:[a-f0-9]{64}$/.test(p.after)
    )
      throw 0;
    return { asOf: p.asOf, after: p.after };
  } catch {
    throw new PageQualityError("QUALITY_CURSOR_INVALID_OR_EXPIRED");
  }
}
const key = (e: QualityOccurrence) => `${Date.parse(e.timestamp)}:${e.occurrenceId}`;
export function qualityOccurrencePage(
  rows: Record<string, unknown>[],
  projectId: string,
  q: PageQualityQuery,
  secret: string,
  cursor: { asOf: number; after: string | null },
) {
  if (rows.length > 50000)
    throw new PageQualityError("QUALITY_OCCURRENCE_BUDGET_EXCEEDED");
  const seen = new Set<string>();
  const all = rows
    .filter((r) => {
      const id = String(r.event_id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(projectOccurrence)
    .filter((e) => e.groupId);
  const routes = [...new Set(all.map((e) => e.pageRoute))].sort();
  const filtered = all
    .filter(
      (e) =>
        (!q.pageRoute || e.pageRoute === q.pageRoute) &&
        (!q.release ||
          (q.release === "__unknown__"
            ? e.context.release === null
            : e.context.release === q.release)) &&
        (q.category === "all" || q.category === e.category) &&
        (!q.groupId || e.groupId === q.groupId),
    )
    .sort((a, b) => key(b).localeCompare(key(a)));
  const counts = new Map<string, number>();
  for (const e of filtered) counts.set(e.groupId, (counts.get(e.groupId) ?? 0) + 1);
  const groups = new Set<string>();
  const selected = filtered
    .filter((e) => {
      if (q.mode === "all") return true;
      if (groups.has(e.groupId)) return false;
      groups.add(e.groupId);
      return true;
    })
    .filter((e) => !cursor.after || key(e) < cursor.after);
  const items = selected
    .slice(0, q.limit)
    .map((e) => ({ ...e, occurrences: counts.get(e.groupId)! }));
  let nextCursor: string | null = null;
  if (selected.length > q.limit && items.length) {
    const body = Buffer.from(
      JSON.stringify({
        scope: scope(projectId, q),
        asOf: cursor.asOf,
        after: key(items.at(-1)!),
      }),
    ).toString("base64url");
    nextCursor = body + "." + createHmac("sha256", secret).update(body).digest("hex");
  }
  return {
    items,
    nextCursor,
    routes,
    availableFrom: filtered.at(-1)?.timestamp ?? null,
    availableFromScope: "selected_window",
    asOf: new Date(cursor.asOf).toISOString(),
    totalOccurrences: filtered.length,
    totalGroups: counts.size,
    mode: q.mode,
    dataState: filtered.length ? "observed" : "no_data",
    coverage: "Observed errors only; absence does not prove no errors",
    definitionVersion: "r5b-occurrences-1",
  };
}
export class PageQualityStore {
  private readonly client: ClickHouseClient;
  constructor(
    config: { url: string; username: string; password: string; database: string },
    private readonly secret: string,
  ) {
    this.client = createClient({
      ...config,
      log: { LoggerClass: SafeClickHouseLogger },
    });
  }
  async read(projectId: string, q: PageQualityQuery) {
    const cursor = readQualityCursor(projectId, q, this.secret);
    const response = await this.client.query({
      query: `SELECT event_id, error_group_id, error_type, error_category, toUnixTimestamp64Milli(timestamp) AS at,
        page_route, error_stack_frame, payload_json, release, env, browser, os, viewport_bucket,
        request_method, request_path, http_status, sdk_version, schema_version
        FROM raw_events WHERE project_id = {projectId:UUID} AND env = {env:String}
        AND timestamp >= parseDateTime64BestEffort({from:String}, 3) AND timestamp < parseDateTime64BestEffort({to:String}, 3)
        AND received_at <= fromUnixTimestamp64Milli({asOf:Int64}) AND error_group_id IS NOT NULL
        AND ({release:String}='' OR ifNull(release,'__unknown__')={release:String})
        AND (event = 'error' OR (event = 'api' AND error_type = 'api'))
        ORDER BY received_at DESC, event_id DESC LIMIT 1 BY event_id LIMIT 50001`,
      query_params: {
        projectId,
        env: q.env,
        from: q.from,
        to: q.to,
        asOf: cursor.asOf,
        release: q.release ?? "",
      },
      clickhouse_settings: {
        max_execution_time: 5,
        max_rows_to_read: "1000000",
        max_bytes_to_read: "268435456",
        read_overflow_mode: "throw",
      },
      format: "JSON",
    });
    const body = await response.json<Record<string, unknown>>();
    return {
      ...qualityOccurrencePage(body.data, projectId, q, this.secret, cursor),
      statistics: {
        clickHouseQueries: 1,
        rowsRead: body.statistics?.rows_read ?? 0,
        bytesRead: body.statistics?.bytes_read ?? 0,
        elapsedSeconds: body.statistics?.elapsed ?? 0,
      },
    };
  }
  async groupStats(projectId: string, q: PageQualityQuery, snapshot?: string) {
    const asOf = snapshot ? Date.parse(snapshot) : Date.now();
    if (!Number.isSafeInteger(asOf) || asOf > Date.now() || Date.now() - asOf > 3600000)
      throw new PageQualityError("QUALITY_CURSOR_INVALID_OR_EXPIRED");
    const read = async (from: string, to: string) => {
      const response = await this.client.query({
        query: `SELECT release, grouping(release) AS is_total, count() AS occurrences,
          uniqExactIf(user_id,user_id IS NOT NULL) AS affectedUsers,
          uniqExact(device_id) AS affectedBrowsers, uniqExact(page_route) AS affectedPages,
          toUnixTimestamp64Milli(min(timestamp)) AS firstAt,toUnixTimestamp64Milli(max(timestamp)) AS lastAt
          FROM (SELECT event_id,timestamp,release,user_id,device_id,page_route FROM raw_events
            WHERE project_id={projectId:UUID} AND env={env:String}
            AND timestamp>=parseDateTime64BestEffort({from:String},3) AND timestamp<parseDateTime64BestEffort({to:String},3)
            AND received_at<=fromUnixTimestamp64Milli({asOf:Int64}) AND error_group_id={groupId:String}
            AND (event='error' OR (event='api' AND error_type='api'))
            AND ({pageRoute:String}='' OR page_route={pageRoute:String})
            AND ({category:String}='all' OR if(error_type IN ('api','resource'),error_type,if(error_category IN {categories:Array(String)},error_category,'other'))={category:String})
            ORDER BY received_at DESC,event_id DESC LIMIT 1 BY event_id)
          GROUP BY GROUPING SETS ((release),()) ORDER BY is_total DESC,release LIMIT 102`,
        query_params: {
          projectId,
          env: q.env,
          from,
          to,
          asOf,
          groupId: q.groupId!,
          pageRoute: q.pageRoute ?? "",
          category: q.category,
          categories: [...ERROR_CATEGORIES],
        },
        clickhouse_settings: {
          max_execution_time: 5,
          max_rows_to_read: "1000000",
          max_bytes_to_read: "67108864",
          max_memory_usage: "134217728",
          read_overflow_mode: "throw",
        },
        format: "JSONEachRow",
      });
      const rows = await response.json<Record<string, unknown>>();
      if (rows.length > 101)
        throw new PageQualityError("QUALITY_RELEASE_BUDGET_EXCEEDED");
      return rows.map((r) => ({
        release: r.release === null ? null : String(r.release),
        total: Number(r.is_total) === 1,
        occurrences: Number(r.occurrences),
        affectedUsers: Number(r.affectedUsers),
        affectedBrowsers: Number(r.affectedBrowsers),
        affectedPages: Number(r.affectedPages),
        firstSeen: Number(r.occurrences)
          ? new Date(Number(r.firstAt)).toISOString()
          : null,
        lastSeen: Number(r.occurrences)
          ? new Date(Number(r.lastAt)).toISOString()
          : null,
      }));
    };
    try {
      const window = await read(q.from, q.to);
      const historyFrom = new Date(asOf - 90 * 86400000).toISOString();
      const history = await read(historyFrom, new Date(asOf).toISOString());
      const select = (rows: typeof window) =>
        rows.find((r) =>
          q.release
            ? !r.total &&
              (q.release === "__unknown__"
                ? r.release === null
                : r.release === q.release)
            : r.total,
        ) ?? null;
      return {
        groupId: q.groupId,
        scope: {
          env: q.env,
          from: q.from,
          to: q.to,
          pageRoute: q.pageRoute ?? null,
          category: q.category,
          release: q.release ?? null,
        },
        selected: select(window),
        history: select(history),
        releases: window.filter((r) => !r.total),
        historyReleases: history.filter((r) => !r.total),
        historyFrom,
        asOf: new Date(asOf).toISOString(),
        definition:
          "deduplicated_event_id; account=user_id; browser=device_id; page=page_route",
        historyScope: "retained_90_days",
        searchApplied: false,
      };
    } catch (e) {
      if (e instanceof PageQualityError) throw e;
      throw new PageQualityError("QUALITY_STATISTICS_BUDGET_OR_UNAVAILABLE");
    }
  }
  async close() {
    await this.client.close();
  }
}
