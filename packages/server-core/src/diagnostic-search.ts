import type { ClickHouseClient } from "@clickhouse/client";
import { projectOccurrence, ERROR_CATEGORIES } from "./page-quality.js";

export class DiagnosticQueryError extends Error {}
export const DIAGNOSTIC_QUERY_LIMITS = {
  days: 7,
  candidates: 500,
  bytes: 32 * 1024 * 1024,
  limit: 50,
  termMin: 2,
  termMax: 128,
  seconds: 5,
  exportBytes: 512 * 1024,
} as const;
export interface DiagnosticSearchQuery {
  env: string;
  from: string;
  to: string;
  term: string;
  field: "message" | "raw";
  category: string;
  release?: string | undefined;
  groupId?: string | undefined;
  pageRoute?: string | undefined;
  offset: number;
  limit: number;
  asOf?: number | undefined;
}
const settings = {
  max_execution_time: 5,
  max_rows_to_read: "1000000",
  max_bytes_to_read: "67108864",
  max_result_bytes: "34603008",
  read_overflow_mode: "throw" as const,
  result_overflow_mode: "throw" as const,
  log_queries: 0 as const,
  log_query_threads: 0 as const,
};
/** Search string values, never JSON escapes or object keys. No regex evaluation. */
export function diagnosticMatches(
  raw: unknown,
  term: string,
  field: "message" | "raw",
) {
  const needle = term.toLowerCase();
  const contains = (value: unknown): boolean => {
    if (typeof value === "string") return value.toLowerCase().includes(needle);
    if (Array.isArray(value)) return value.some(contains);
    return !!value && typeof value === "object" && Object.values(value).some(contains);
  };
  if (field === "raw") return contains(raw);
  const r = raw as { error?: { message?: unknown }; message?: unknown } | undefined;
  return contains(r?.error?.message ?? r?.message);
}
export async function searchDiagnostics(
  ch: ClickHouseClient,
  project: string,
  q: DiagnosticSearchQuery,
  eligible: (ids: string[]) => Promise<string[]> = async (ids) => ids,
) {
  const asOf = q.asOf ?? Date.now();
  if (
    !Number.isFinite(Date.parse(q.from)) ||
    !Number.isFinite(Date.parse(q.to)) ||
    Date.parse(q.to) <= Date.parse(q.from) ||
    Date.parse(q.to) - Date.parse(q.from) > 7 * 86400000 ||
    q.term.length < 2 ||
    q.term.length > 128 ||
    !q.term.trim() ||
    q.limit < 1 ||
    q.limit > 50 ||
    q.offset < 0 ||
    q.offset > 500 ||
    !Number.isSafeInteger(asOf) ||
    asOf > Date.now() ||
    Date.now() - asOf > 3600000
  )
    throw new DiagnosticQueryError("DIAGNOSTICS_SEARCH_BUDGET_INVALID");
  try {
    // No term reaches SQL/query logs. Filter base facts before touching raw details.
    const response = await ch.query({
      query: `SELECT event_id, error_group_id, error_type, error_category,
        toUnixTimestamp64Milli(timestamp) AS at, page_route, release, env,
        payload_json, error_stack_frame FROM raw_events
        WHERE project_id={project:UUID} AND env={env:String}
        AND timestamp>=parseDateTime64BestEffort({from:String},3)
        AND timestamp<parseDateTime64BestEffort({to:String},3)
        AND received_at<=fromUnixTimestamp64Milli({asOf:Int64})
        AND (event='error' OR (event='api' AND error_type='api'))
        AND error_group_id IS NOT NULL
        AND ({release:String}='' OR ifNull(release,'__unknown__')={release:String})
        AND ({groupId:String}='' OR error_group_id={groupId:String})
        AND ({pageRoute:String}='' OR page_route={pageRoute:String})
        AND ({category:String}='all' OR if(error_type IN ('api','resource'),error_type,if(error_category IN {categories:Array(String)},error_category,'other'))={category:String})
        ORDER BY received_at DESC, event_id DESC LIMIT 1 BY event_id LIMIT 501`,
      query_params: {
        project,
        env: q.env,
        from: q.from,
        to: q.to,
        category: q.category,
        asOf,
        release: q.release ?? "",
        groupId: q.groupId ?? "",
        pageRoute: q.pageRoute ?? "",
        categories: [...ERROR_CATEGORIES],
      },
      clickhouse_settings: settings,
      format: "JSON",
    });
    const base = await response.json<Record<string, unknown>>();
    if (base.data.length > 500)
      throw new DiagnosticQueryError("DIAGNOSTICS_SEARCH_CANDIDATE_BUDGET");
    const ids = await eligible(base.data.map((r) => String(r.event_id)));
    const details = ids.length
      ? await ch
          .query({
            query: `SELECT event_id,envelope_json FROM diagnostic_details FINAL
        WHERE project_id={project:UUID} AND event_id IN {ids:Array(String)}
        AND expires_at>now() LIMIT 501`,
            query_params: { project, ids },
            clickhouse_settings: settings,
            format: "JSON",
          })
          .then((r) => r.json<{ event_id: string; envelope_json: string }>())
      : null;
    if (
      (details?.data.reduce((n, r) => n + Buffer.byteLength(r.envelope_json), 0) ?? 0) >
      DIAGNOSTIC_QUERY_LIMITS.bytes
    )
      throw new DiagnosticQueryError("DIAGNOSTICS_SEARCH_BYTE_BUDGET");
    const current = new Set(await eligible(ids));
    const found = new Set(
      (details?.data ?? [])
        .filter((r) => current.has(r.event_id))
        .filter((r) =>
          diagnosticMatches(JSON.parse(r.envelope_json).raw, q.term, q.field),
        )
        .map((r) => r.event_id),
    );
    const hits = base.data
      .filter((r) => found.has(String(r.event_id)))
      .map(projectOccurrence)
      .sort(
        (a, b) =>
          b.timestamp.localeCompare(a.timestamp) ||
          b.eventId!.localeCompare(a.eventId!),
      );
    return {
      items: hits.slice(q.offset, q.offset + q.limit),
      total: hits.length,
      nextOffset: q.offset + q.limit < hits.length ? q.offset + q.limit : null,
      asOf,
      candidates: base.data.length,
      searchable: (details?.data ?? []).filter((r) => current.has(r.event_id)).length,
      boundary: "retained_diagnostic_raw_only",
      truncated: false,
      statistics: {
        rowsRead:
          (base.statistics?.rows_read ?? 0) + (details?.statistics?.rows_read ?? 0),
        bytesRead:
          (base.statistics?.bytes_read ?? 0) + (details?.statistics?.bytes_read ?? 0),
        elapsedSeconds:
          (base.statistics?.elapsed ?? 0) + (details?.statistics?.elapsed ?? 0),
      },
    };
  } catch (e) {
    if (e instanceof DiagnosticQueryError) throw e;
    // Driver errors can include SQL/values. Stable code only.
    const type = e && typeof e === "object" && "type" in e ? e.type : undefined;
    if (type === "TIMEOUT_EXCEEDED" || type === "SOCKET_TIMEOUT" || type === "TOO_SLOW")
      throw new DiagnosticQueryError("DIAGNOSTICS_SEARCH_TIMEOUT");
    if (
      [
        "TOO_MANY_ROWS",
        "TOO_MANY_BYTES",
        "TOO_MANY_ROWS_OR_BYTES",
        "MEMORY_LIMIT_EXCEEDED",
      ].includes(String(type))
    )
      throw new DiagnosticQueryError("DIAGNOSTICS_SEARCH_SCAN_BUDGET");
    throw new DiagnosticQueryError("DIAGNOSTICS_SEARCH_UNAVAILABLE");
  }
}
