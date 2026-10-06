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
        AND (event = 'error' OR (event = 'api' AND error_type = 'api'))
        ORDER BY received_at DESC, event_id DESC LIMIT 1 BY event_id LIMIT 50001`,
      query_params: {
        projectId,
        env: q.env,
        from: q.from,
        to: q.to,
        asOf: cursor.asOf,
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
  async close() {
    await this.client.close();
  }
}
