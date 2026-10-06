import type { RowDataPacket } from "mysql2/promise";
import type { MySqlStore } from "./mysql-store.js";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { SafeClickHouseLogger } from "./clickhouse-logger.js";
import { sessionPercentile } from "./score-observation.js";
import { systemMetricDefinition } from "./system-metric-catalog.js";
import type { FormulaInputValue } from "./formula.js";

import { QUALITY_DEFINITION_VERSION, QUALITY_KEYS } from "./quality-definition.js";
export { QUALITY_DEFINITION_VERSION, QUALITY_KEYS } from "./quality-definition.js";
export interface QualityEvent {
  errorGroup?: string | null;
  classified?: boolean;
  transportIncomplete?: boolean;
  id: string;
  event: string;
  at: number;
  received: number;
  pageView: string;
  page: string;
  user: string | null;
  payload: Record<string, unknown>;
}
export interface QualityMetric extends FormulaInputValue {
  formula: string;
  unit: string;
  percentileAlgorithm: string;
  numerator: number | null;
  denominator: number | null;
  coverage: { observedViews: number; enabledViews: number; settledViews: number };
  definitionVersion: string;
  thresholdVersion: string;
  percentiles: Record<string, number | null>;
  observedValue: number | null;
}
/** Page-start cohorts; terminal facts through asOf (at most 24h after cohort end).
 * Counts never infer failed/successful requests from one-sided error events. */
export function reduceQuality(
  events: QualityEvent[],
  from: number,
  to: number,
  asOf: number,
  pageRoute?: string,
) {
  if (![from, to, asOf].every(Number.isFinite) || from >= to || to > asOf)
    throw new Error("QUALITY_RANGE_INVALID");
  if (events.length > 50000) throw new Error("QUALITY_FACT_LIMIT");
  const ids = new Map<string, QualityEvent>();
  let conflict = false;
  for (const e of events) {
    if (e.at > asOf || e.received > asOf) continue;
    const previous = ids.get(e.id);
    if (
      previous &&
      JSON.stringify({ ...previous, received: 0 }) !==
        JSON.stringify({ ...e, received: 0 })
    )
      conflict = true;
    else ids.set(e.id, e);
  }
  const all = [...ids.values()];
  const views = all.filter(
    (e) =>
      e.event === "page_view" &&
      e.at >= from &&
      e.at < to &&
      (!pageRoute || e.page === pageRoute),
  );
  const groups = new Map<string, QualityEvent[]>();
  for (const v of views) {
    if (groups.has(v.pageView)) conflict = true;
    else groups.set(v.pageView, []);
  }
  for (const e of all) groups.get(e.pageView)?.push(e);
  const leaves = new Map<string, QualityEvent>();
  for (const v of views) {
    const group = groups.get(v.pageView)!;
    if (group.some((e) => e.page !== v.page || e.user !== v.user || e.at < v.at))
      conflict = true;
    const terminals = group
      .filter((e) => e.event === "page_leave" && e.payload.qualityVersion === "r5a-1")
      .sort(
        (a, b) => Number(b.payload.qualitySequence) - Number(a.payload.qualitySequence),
      );
    const counters = [
      "apiStarted",
      "apiCompleted",
      "resourceStarted",
      "resourceCompleted",
      "resourceFailed",
      "longtaskCount",
      "longtaskTotal",
      "qualityDropped",
      "qualityFailed",
      "qualitySuppressed",
    ];
    for (let i = 1; i < terminals.length; i++) {
      const newer = terminals[i - 1]!,
        older = terminals[i]!;
      if (
        newer.payload.qualitySequence === older.payload.qualitySequence ||
        counters.some((key) => Number(newer.payload[key]) < Number(older.payload[key]))
      )
        conflict = true;
    }
    if (terminals[0]) leaves.set(v.pageView, terminals[0]);
  }
  const baseReason = views.some((v) => v.classified === false)
    ? "PAGE_SCOPE_NOT_VERIFIED"
    : all.some((e) => e.transportIncomplete)
      ? "TRANSPORT_INCOMPLETE"
      : views.some((v) => !v.user)
        ? "IDENTITY_NOT_VERIFIED"
        : conflict
          ? "FACT_CONFLICT"
          : from < asOf - 89 * 86400000
            ? "FACT_RETENTION_RANGE_NOT_COVERED"
            : to > asOf - 86400000
              ? "LATENESS_WINDOW_OPEN"
              : views.length === 0
                ? "NO_PAGE_VIEWS"
                : null;
  const relevant = all.filter((e) => groups.has(e.pageView));
  const maskFor = (key: string) =>
    ["lcp", "inp", "cls", "fcp", "ttfb"].includes(key)
      ? 1
      : key === "first_screen_time"
        ? 2
        : key === "list_render_duration"
          ? 4
          : key.startsWith("api_")
            ? 8
            : key === "resource_error_rate"
              ? 16
              : key.startsWith("longtask_")
                ? 32
                : key === "blank_screen_rate"
                  ? 128
                  : 64;
  const metrics: Record<string, QualityMetric> = {};
  const inputs: Record<string, FormulaInputValue> = {};
  const apiRows = relevant.filter(
    (e) =>
      e.event === "api" &&
      e.payload.qualityVersion === "r5a-1" &&
      typeof e.payload.apiRequestId === "string",
  );
  const requests = new Set<string>();
  for (const e of apiRows) {
    const id = String(e.payload.apiRequestId);
    if (requests.has(id)) conflict = true;
    requests.add(id);
  }
  const sum = (key: string) =>
    [...leaves.values()].reduce((n, e) => n + Number(e.payload[key] ?? 0), 0);
  const badTerminal = (v: QualityEvent) => {
    const p = leaves.get(v.pageView)?.payload;
    return (
      !p ||
      p.qualityClosed !== true ||
      p.qualitySampleRate !== 1 ||
      p.qualityMask !== v.payload.qualityMask ||
      Number(p.qualityDropped) > 0 ||
      Number(p.qualityFailed) > 0 ||
      Number(p.qualitySuppressed) > 0
    );
  };
  const perf = relevant.filter(
    (e) => e.event === "performance" && e.payload.qualityVersion === "r5a-1",
  );
  const samplesFor = (key: string) => {
    const bySample = new Map<string, QualityEvent>();
    for (const e of perf.filter((e) => e.payload.metric === key)) {
      const id =
        e.pageView + (key === "list_render_duration" ? String(e.payload.sampleId) : "");
      const previous = bySample.get(id);
      if (
        !previous ||
        Number(previous.payload.qualitySequence ?? previous.at) <=
          Number(e.payload.qualitySequence ?? e.at)
      )
        bySample.set(id, e);
    }
    return [...bySample.values()].map((e) => Number(e.payload.value));
  };
  const js = relevant.filter(
    (e) =>
      e.event === "error" &&
      e.payload.errorType === "js" &&
      e.payload.qualityVersion === "r5a-1",
  );
  for (const key of QUALITY_KEYS) {
    const bit = maskFor(key),
      enabled = views.filter(
        (v) =>
          v.payload.qualityVersion === "r5a-1" &&
          (Number(v.payload.qualityMask) & bit) !== 0 &&
          (bit !== 1 ||
            (Number(v.payload.qualityVitals) &
              (1 << ["lcp", "inp", "cls", "fcp", "ttfb"].indexOf(key))) !==
              0),
      );
    let reason = conflict ? "FACT_CONFLICT" : baseReason;
    if (!reason && enabled.length === 0) reason = "COLLECTOR_DISABLED_OR_UNSUPPORTED";
    if (!reason && key !== "blank_screen_rate" && enabled.length !== views.length)
      reason = "PARTIAL_COLLECTOR_COVERAGE";
    if (
      !reason &&
      enabled.some((v) => v.payload.qualitySampleRate !== 1 || badTerminal(v))
    )
      reason = "INCOMPLETE_OR_SAMPLED_PAGE";
    let values: number[] = [],
      numerator: number | null = null,
      denominator: number | null = null,
      observed: number | null = null;
    if (
      [
        "lcp",
        "inp",
        "cls",
        "fcp",
        "ttfb",
        "first_screen_time",
        "list_render_duration",
      ].includes(key)
    )
      values = samplesFor(key);
    if (key === "api_duration" || key === "api_slow_top")
      values = apiRows.map((e) => Number(e.payload.durationMs));
    if (key.startsWith("api_")) {
      if (
        !reason &&
        (sum("apiStarted") !== sum("apiCompleted") ||
          sum("apiCompleted") !== apiRows.length)
      )
        reason = "API_TERMINALS_MISSING";
      if (key === "api_error_rate") {
        numerator = apiRows.filter((e) =>
          ["http", "network", "timeout"].includes(String(e.payload.failureType)),
        ).length;
        denominator = sum("apiStarted");
      }
    }
    if (key === "js_error_rate") {
      numerator = js.length;
      denominator = views.length;
    }
    if (key === "resource_error_rate") {
      numerator = sum("resourceFailed");
      denominator = sum("resourceStarted");
      if (!reason && sum("resourceCompleted") !== denominator)
        reason = "RESOURCE_TERMINALS_MISSING";
    }
    if (key === "blank_screen_rate") {
      denominator = enabled.length;
      numerator = enabled.filter(
        (v) => leaves.get(v.pageView)?.payload.blankScreen === true,
      ).length;
      if (
        !reason &&
        enabled.some(
          (v) =>
            typeof leaves.get(v.pageView)?.payload.blankScreen !== "boolean" ||
            leaves.get(v.pageView)?.payload.blankRule !== "root-empty-3s-v1",
        )
      )
        reason = "BLANK_RULE_NOT_SETTLED";
    }
    if (key.startsWith("longtask_")) {
      numerator = sum(key === "longtask_count" ? "longtaskCount" : "longtaskTotal");
      denominator = enabled.length;
      observed = numerator;
    }
    if (key === "breadcrumb") {
      reason = reason ?? "STRUCTURED_CONTEXT_NOT_SCALAR";
      denominator = js.length;
      numerator = js.filter((e) => e.payload.breadcrumb).length;
    }
    if (
      numerator !== null &&
      denominator !== null &&
      observed === null &&
      key !== "breadcrumb"
    )
      observed = denominator > 0 ? numerator / denominator : null;
    if (!reason && denominator === 0) reason = "ZERO_DENOMINATOR";
    const percentiles = Object.fromEntries(
      [50, 75, 90, 99].map((p) => [`p${p}`, sessionPercentile(values, p / 100)]),
    );
    if (values.length)
      observed =
        percentiles[
          ["lcp", "inp", "cls"].includes(key)
            ? "p75"
            : key === "api_duration"
              ? "p50"
              : "p90"
        ]!;
    if (values.length && denominator === null) denominator = values.length;
    const sample = denominator ?? values.length;
    if (
      !reason &&
      values.length === 0 &&
      [
        "lcp",
        "inp",
        "cls",
        "fcp",
        "ttfb",
        "first_screen_time",
        "list_render_duration",
      ].includes(key)
    )
      reason =
        key === "inp" ? "NO_INTERACTION_SAMPLES" : "NO_VALID_PERFORMANCE_SAMPLES";
    if (!reason && sample < (systemMetricDefinition(key)?.minimumSample ?? 5))
      reason = "INSUFFICIENT_SAMPLE";
    if (key === "api_slow_top") reason = reason ?? "STRUCTURED_RESULT_NOT_SCALAR";
    const result: QualityMetric = {
      formula: systemMetricDefinition(key)?.formulaDescription ?? key,
      unit: systemMetricDefinition(key)?.unit ?? "unknown",
      percentileAlgorithm:
        "linear-interpolation; window samples recomputed, never average bucket percentiles",
      value: reason ? null : observed,
      observedValue: observed,
      numerator,
      denominator,
      sampleSize: sample,
      status:
        reason === "INSUFFICIENT_SAMPLE"
          ? "insufficient_sample"
          : reason
            ? "metric_not_available"
            : "available",
      reason,
      coverage: {
        observedViews: views.length,
        enabledViews: enabled.length,
        settledViews: enabled.filter((v) => !badTerminal(v)).length,
      },
      definitionVersion: QUALITY_DEFINITION_VERSION,
      thresholdVersion:
        bit === 1
          ? "web-vitals-5.3.0"
          : key.startsWith("api_")
            ? "api-slow-1000ms-v1"
            : key === "blank_screen_rate"
              ? "root-empty-3s-v1"
              : "r5a-observed-facts-v1",
      percentiles,
    };
    metrics[key] = result;
    inputs[key] = {
      value: result.value,
      status: result.status,
      sampleSize: result.sampleSize,
      reason,
    };
  }
  const routes = new Map<string, QualityEvent[]>();
  for (const e of apiRows) {
    const key = String(e.payload.requestMethod) + " " + String(e.payload.requestPath);
    if (!routes.has(key) && routes.size >= 100)
      throw new Error("QUALITY_API_SERIES_LIMIT");
    routes.set(key, [...(routes.get(key) ?? []), e]);
  }
  const apiSlowTop = [...routes]
    .map(([route, rows]) => ({
      route,
      sample: rows.length,
      p50: sessionPercentile(
        rows.map((e) => Number(e.payload.durationMs)),
        0.5,
      ),
      p90: sessionPercentile(
        rows.map((e) => Number(e.payload.durationMs)),
        0.9,
      ),
      successRate: rows.filter((e) => e.payload.success === true).length / rows.length,
      slowRate:
        rows.filter((e) => Number(e.payload.durationMs) > 1000).length / rows.length,
      thresholdVersion: "api-slow-1000ms-v1",
    }))
    .sort((a, b) => b.p90! - a.p90! || a.route.localeCompare(b.route))
    .slice(0, 20);
  const listBuckets = ["lt100", "100to1000", "gt1000"].map((bucket) => {
    const values = perf
      .filter(
        (e) =>
          e.payload.metric === "list_render_duration" && e.payload.rowBucket === bucket,
      )
      .map((e) => Number(e.payload.value));
    return {
      bucket,
      sample: values.length,
      p50: sessionPercentile(values, 0.5),
      p75: sessionPercentile(values, 0.75),
      p90: sessionPercentile(values, 0.9),
      p99: sessionPercentile(values, 0.99),
    };
  });
  return {
    metrics,
    inputs,
    apiSlowTop,
    errorContexts: relevant
      .filter((e) => e.event === "error" && e.payload.qualityVersion === "r5a-1")
      .sort((a, b) => b.at - a.at)
      .slice(0, 20)
      .map((e) => ({
        eventId: e.id,
        errorGroupId: e.errorGroup ?? null,
        pageRoute: e.page,
        at: new Date(e.at).toISOString(),
        category: e.payload.errorType,
        breadcrumbs: Object.entries(
          (e.payload.breadcrumb ?? {}) as Record<string, unknown>,
        )
          .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
          .map(([, value]) => value)
          .filter((value) =>
            [
              "navigation",
              "action",
              "api_success",
              "api_failure",
              "visible",
              "hidden",
            ].includes(String(value)),
          )
          .slice(-50),
      })),
    affectedUsers: new Set(js.map((e) => e.user).filter(Boolean)).size,
    listBuckets,
    definitionVersion: QUALITY_DEFINITION_VERSION,
    formulaScope:
      "observed page-start cohort; explicit controlled API/resource adapters",
    blankRule: "root-empty-3s-v1",
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    asOf: new Date(asOf).toISOString(),
  };
}
export class QualityFactStore {
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
  async close() {
    await this.client.close();
  }
  async read(
    projectId: string,
    env: string,
    from: string,
    to: string,
    asOf = new Date().toISOString(),
    pageRoute?: string,
    pages: QualityPageWindow[] = [],
  ) {
    const start = Date.parse(from),
      end = Date.parse(to),
      at = Date.parse(asOf);
    if (
      ![start, end, at].every(Number.isFinite) ||
      end <= start ||
      end > at ||
      end - start > 89 * 86400000
    )
      throw new Error("QUALITY_RANGE_INVALID");
    const r = await this.client.query({
      query: `SELECT event_id AS id,event,toUnixTimestamp64Milli(timestamp) AS at,toUnixTimestamp64Milli(received_at) AS received,page_view_id AS pageView,page_route AS page,user_id AS user,error_group_id AS errorGroup,sdk_usage,payload_json FROM raw_events WHERE project_id={project:UUID} AND env={env:String} AND timestamp>=fromUnixTimestamp64Milli({from:Int64}) AND timestamp<fromUnixTimestamp64Milli({until:Int64}) AND received_at<=fromUnixTimestamp64Milli({asOf:Int64}) AND event IN ('page_view','page_leave','performance','api','error') LIMIT 50001`,
      query_params: {
        project: projectId,
        env,
        from: start,
        until: Math.min(at + 1, end + 86400000),
        asOf: at,
      },
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 2,
        max_rows_to_read: "1000000",
        read_overflow_mode: "throw",
      },
    });
    const body = await r.json<
      Omit<QualityEvent, "payload"> & { payload_json: string; sdk_usage: string | null }
    >();
    const events = body.data.map((e) => ({
      ...e,
      at: Number(e.at),
      received: Number(e.received),
      classified:
        pages.filter(
          (p) =>
            p.page === e.page &&
            p.from <= Number(e.at) &&
            Number(e.at) < p.to &&
            p.active,
        ).length === 1,
      transportIncomplete: Boolean(
        e.sdk_usage &&
        (JSON.parse(e.sdk_usage).droppedEvents ||
          JSON.parse(e.sdk_usage).failedBatches),
      ),
      payload: JSON.parse(e.payload_json) as Record<string, unknown>,
    }));
    return {
      ...reduceQuality(events, start, end, at, pageRoute),
      statistics: {
        clickHouseQueries: 1,
        rowsRead: body.statistics?.rows_read ?? 0,
        bytesRead: body.statistics?.bytes_read ?? 0,
        elapsedSeconds: body.statistics?.elapsed ?? 0,
      },
    };
  }
}

export interface QualityPageWindow {
  page: string;
  from: number;
  to: number;
  active: boolean;
}
export async function readQualityPages(
  mysql: MySqlStore,
  projectId: string,
  from: string,
  to: string,
): Promise<QualityPageWindow[]> {
  const [rows] = await mysql.pool.query<RowDataPacket[]>(
    `SELECT p.page_route,r.status AS page_status,m.status AS module_status,GREATEST(r.effective_from,m.effective_from) AS starts,LEAST(COALESCE(r.effective_to,?),COALESCE(m.effective_to,?)) AS ends FROM page_definitions p JOIN page_definition_revisions r ON r.page_definition_id=p.id JOIN module_revisions m ON m.module_id=r.module_id AND m.effective_from<COALESCE(r.effective_to,?) AND (m.effective_to IS NULL OR m.effective_to>r.effective_from) WHERE p.project_id=? AND r.effective_from<? AND (r.effective_to IS NULL OR r.effective_to>?) AND m.effective_from<? AND (m.effective_to IS NULL OR m.effective_to>?) LIMIT 10001`,
    [
      new Date(to),
      new Date(to),
      new Date(to),
      projectId,
      new Date(to),
      new Date(from),
      new Date(to),
      new Date(from),
    ],
  );
  if (rows.length > 10000) throw new Error("QUALITY_PAGE_REVISION_LIMIT");
  return rows.map((r) => ({
    page: String(r.page_route),
    from: new Date(r.starts).valueOf(),
    to: new Date(r.ends).valueOf(),
    active: r.page_status === "active" && r.module_status === "active",
  }));
}
