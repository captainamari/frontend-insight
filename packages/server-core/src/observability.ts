import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { assertClickHouseReady } from "./clickhouse-health.js";
import { validateAnalyticsRange, type AnalyticsRange } from "./analytics.js";
import type { MySqlStore } from "./mysql-store.js";
import { evaluateDataStatus, type DataState } from "./status.js";

export const OBSERVABILITY_DEFINITION_VERSION = "observability_v1.0.0";
export const PAGE_PERFORMANCE_DEFINITION_VERSION = "page_performance_v1.7.0";

export type ErrorType = "js" | "resource" | "api";
export type AlertSeverity = "critical" | "high" | "warning";

export interface ErrorGroupSummary {
  groupId: string;
  errorType: ErrorType;
  errorName: string | null;
  message: string | null;
  stackTopFrame: string | null;
  requestMethod: string | null;
  requestPath: string | null;
  httpStatus: number | null;
  resourceType: string | null;
  occurrences: number;
  affectedAccounts: number;
  affectedBrowsers: number;
  affectedPages: number;
  pages: string[];
  releases: string[];
  browserFamilies: string[];
  osFamilies: string[];
  viewportBuckets: string[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  severity: AlertSeverity | "info";
}

export interface WebVitalSummary {
  route: string;
  vitalName: "LCP" | "CLS" | "INP" | "FCP" | "TTFB";
  releaseVersion: string;
  sampleSize: number;
  p75: number | null;
  poorSamples: number;
  poorRate: number | null;
  lastSeenAt: string | null;
}

export interface FixedAlert {
  id: string;
  ruleKey: "error_spike" | "web_vital_poor" | "telemetry_delayed";
  severity: AlertSeverity;
  title: string;
  evidence: string;
  entityType: "error_group" | "page_vital" | "pipeline";
  entityKey: string;
  triggeredAt: string | null;
  definitionVersion: typeof OBSERVABILITY_DEFINITION_VERSION;
}

export type CollectionStatus = "available" | "not_collected" | "insufficient_sample";

export function evidenceRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function durationEvidence(
  sampleSize: number,
  p50Ms: number | null,
  p90Ms: number | null,
): {
  p50Ms: number | null;
  p90Ms: number | null;
  status: CollectionStatus;
} {
  if (sampleSize <= 0) {
    return { p50Ms: null, p90Ms: null, status: "not_collected" };
  }
  return {
    p50Ms: sampleSize >= 5 ? p50Ms : null,
    p90Ms: sampleSize >= 20 ? p90Ms : null,
    status: sampleSize >= 20 ? "available" : "insufficient_sample",
  };
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).filter((item) => item && item !== "unknown")
    : [];
}

function observabilityEventsWhere(extra = ""): string {
  return `
    SELECT *
    FROM raw_events
    WHERE project_id = {projectId:UUID}
      AND event_time >= parseDateTime64BestEffort({from:String}, 3)
      AND event_time < parseDateTime64BestEffort({to:String}, 3)
      AND event_name IN ('error_js', 'error_resource', 'error_api', 'web_vital')
      ${extra}
    ORDER BY received_at DESC
    LIMIT 1 BY event_id
  `;
}

export function errorSeverity(input: {
  occurrences: number;
  affectedAccounts: number;
  affectedBrowsers: number;
  httpStatus: number | null;
}): ErrorGroupSummary["severity"] {
  if (
    input.occurrences >= 50 ||
    input.affectedAccounts >= 10 ||
    (input.httpStatus !== null && input.httpStatus >= 500 && input.occurrences >= 20)
  ) {
    return "critical";
  }
  if (input.occurrences >= 10 || input.affectedBrowsers >= 5) return "high";
  if (input.occurrences >= 5 && input.affectedBrowsers >= 3) return "warning";
  return "info";
}

export function buildFixedAlerts(input: {
  errors: ErrorGroupSummary[];
  vitals: WebVitalSummary[];
  dataState: DataState;
  updatedAt: string | null;
}): FixedAlert[] {
  const alerts: FixedAlert[] = [];
  for (const group of input.errors) {
    if (group.severity === "info") continue;
    alerts.push({
      id: `error_spike:${group.groupId}`,
      ruleKey: "error_spike",
      severity: group.severity,
      title: `${group.errorType.toUpperCase()} 错误组达到固定告警门槛`,
      evidence: `${group.occurrences} 次，影响 ${group.affectedBrowsers} 个浏览器实例 / ${group.affectedAccounts} 个账号`,
      entityType: "error_group",
      entityKey: group.groupId,
      triggeredAt: group.lastSeenAt,
      definitionVersion: OBSERVABILITY_DEFINITION_VERSION,
    });
  }
  for (const vital of input.vitals) {
    if (vital.sampleSize < 20 || vital.poorRate === null || vital.poorRate < 0.3) {
      continue;
    }
    const severity: AlertSeverity = vital.poorRate >= 0.5 ? "high" : "warning";
    alerts.push({
      id: `web_vital_poor:${vital.route}:${vital.vitalName}:${vital.releaseVersion}`,
      ruleKey: "web_vital_poor",
      severity,
      title: `${vital.route} 的 ${vital.vitalName} 较差样本偏高`,
      evidence: `${vital.poorSamples}/${vital.sampleSize} 个样本为 poor（${Math.round(vital.poorRate * 100)}%）`,
      entityType: "page_vital",
      entityKey: `${vital.route}:${vital.vitalName}:${vital.releaseVersion}`,
      triggeredAt: vital.lastSeenAt,
      definitionVersion: OBSERVABILITY_DEFINITION_VERSION,
    });
  }
  if (input.dataState === "delayed" || input.dataState === "broken") {
    alerts.push({
      id: "telemetry_delayed:pipeline",
      ruleKey: "telemetry_delayed",
      severity: input.dataState === "broken" ? "critical" : "warning",
      title: "采集链路未保持最新",
      evidence:
        input.dataState === "broken"
          ? "存在死信且没有可查询数据"
          : "最近接收时间领先于可查询时间超过 5 分钟",
      entityType: "pipeline",
      entityKey: "pipeline",
      triggeredAt: input.updatedAt,
      definitionVersion: OBSERVABILITY_DEFINITION_VERSION,
    });
  }
  const rank: Record<AlertSeverity, number> = {
    critical: 0,
    high: 1,
    warning: 2,
  };
  return alerts.sort(
    (left, right) =>
      rank[left.severity] - rank[right.severity] ||
      String(right.triggeredAt).localeCompare(String(left.triggeredAt)),
  );
}

export class ObservabilityStore {
  private readonly client: ClickHouseClient;
  private readonly durationSamples: number[] = [];
  private queryFailures = 0;

  constructor(
    clickhouse: {
      url: string;
      username: string;
      password: string;
      database: string;
    },
    private readonly mysql: MySqlStore,
  ) {
    this.client = createClient(clickhouse);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async ping(): Promise<void> {
    await assertClickHouseReady(this.client);
  }

  getMetrics(): { queries: number; failures: number; latencyP95Ms: number } {
    const sorted = [...this.durationSamples].sort((left, right) => left - right);
    return {
      queries: this.durationSamples.length,
      failures: this.queryFailures,
      latencyP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    };
  }

  async overview(projectId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const [errors, vitals, releases, trend, summary, availability, rawStatus] =
        await Promise.all([
          this.errorGroupsQuery(projectId, range, 500),
          this.webVitalsQuery(projectId, range, 20),
          this.releasesQuery(projectId, range),
          this.trendQuery(projectId, range),
          this.summaryQuery(projectId, range),
          this.availableFrom(projectId),
          this.mysql.getDataStatus(projectId),
        ]);
      const dataStatus = evaluateDataStatus(rawStatus);
      const alerts = buildFixedAlerts({
        errors,
        vitals,
        dataState: dataStatus.state,
        updatedAt: rawStatus.lastQueryableAt,
      });
      return {
        ...this.meta(range, dataStatus, availability),
        summary: { ...summary, activeAlerts: alerts.length },
        errors: errors.slice(0, 10),
        vitals,
        releases,
        alerts,
        trend,
        alertPolicy: {
          definitionVersion: OBSERVABILITY_DEFINITION_VERSION,
          errorSpike:
            "关注：次数 ≥5 且浏览器 ≥3；高：次数 ≥10 或浏览器 ≥5；严重：次数 ≥50、账号 ≥10，或 5xx 次数 ≥20。",
          webVitalPoor: "样本至少 20 且 poor 占比 ≥30% 时关注；poor 占比 ≥50% 时为高。",
          lifecycle: "固定只读告警；M8 不包含确认、关闭和通知路由。",
        },
        boundaries: {
          operationalIndexVersion: "operational_v1_unchanged",
          sourceMaps: "disabled_pending_real_location_evidence",
          causality: "错误、性能与使用变化可以并列比较，但相关不代表因果。",
        },
      };
    });
  }

  async errors(projectId: string, rangeInput: AnalyticsRange, limit = 100) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const [items, availability, rawStatus] = await Promise.all([
        this.errorGroupsQuery(projectId, range, limit),
        this.availableFrom(projectId),
        this.mysql.getDataStatus(projectId),
      ]);
      return {
        ...this.meta(range, evaluateDataStatus(rawStatus), availability),
        items,
      };
    });
  }

  async pagePerformance(projectId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const parameters = { projectId, from: range.from, to: range.to };
      const base = `
        SELECT *
        FROM raw_events
        WHERE project_id = {projectId:UUID}
          AND event_time >= parseDateTime64BestEffort({from:String}, 3)
          AND event_time < parseDateTime64BestEffort({to:String}, 3)
          AND event_name IN (
            'page_view', 'page_readiness', 'api_request_summary',
            'resource_summary', 'list_render', 'long_task_summary'
          )
        ORDER BY received_at DESC
        LIMIT 1 BY event_id
      `;
      const [
        coverageResponse,
        apiResponse,
        readinessResponse,
        listResponse,
        rawStatus,
      ] = await Promise.all([
        this.client.query({
          query: `
              SELECT
                uniqExactIf(page_view_id, event_name = 'page_view') AS page_views,
                uniqExactIf(page_view_id, event_name = 'page_readiness' AND first_screen_collected = true) AS readiness_page_views,
                uniqExactIf(page_view_id, event_name = 'page_readiness' AND blank_detection_collected = true) AS blank_observed_page_views,
                sumIf(ifNull(observed_page_views, 0), event_name = 'resource_summary') AS resource_observed_page_views,
                sumIf(ifNull(observed_page_views, 0), event_name = 'long_task_summary') AS long_task_observed_page_views,
                sumIf(ifNull(resource_total_count, 0), event_name = 'resource_summary') AS resource_requests,
                sumIf(ifNull(resource_failed_count, 0), event_name = 'resource_summary') AS resource_failures,
                sumIf(ifNull(long_task_count, 0), event_name = 'long_task_summary') AS long_task_count,
                sumIf(ifNull(long_task_duration_ms, 0), event_name = 'long_task_summary') AS long_task_duration_ms,
                countIf(event_name = 'long_task_summary' AND ifNull(long_task_count, 0) > 0) AS long_task_affected_page_views,
                countIf(event_name = 'page_readiness' AND readiness_state = 'blank_candidate' AND blank_detection_collected = true) AS blank_candidates,
                avgIf(collector_sample_rate, event_name = 'page_readiness') AS readiness_sample_rate,
                avgIf(collector_sample_rate, event_name = 'resource_summary') AS resource_sample_rate,
                avgIf(collector_sample_rate, event_name = 'long_task_summary') AS long_task_sample_rate,
                minOrNullIf(event_time, event_name != 'page_view') AS available_from
              FROM (${base})
            `,
          query_params: parameters,
          format: "JSONEachRow",
        }),
        this.client.query({
          query: `
              SELECT
                ifNull(request_method, 'OTHER') AS request_method,
                ifNull(request_path, '/unknown') AS request_path,
                sum(ifNull(request_count, 0)) AS requests,
                sum(ifNull(request_success_count, 0)) AS successes,
                sum(ifNull(request_error_count, 0)) AS errors,
                sum(ifNull(request_slow_count, 0)) AS slow_requests,
                quantileExactIf(0.5)(duration_ms, duration_ms IS NOT NULL) AS p50_ms,
                quantileExactIf(0.9)(duration_ms, duration_ms IS NOT NULL) AS p90_ms,
                avg(collector_sample_rate) AS sample_rate,
                max(event_time) AS last_seen_at
              FROM (${base})
              WHERE event_name = 'api_request_summary'
              GROUP BY request_method, request_path
              ORDER BY requests DESC, p90_ms DESC
              LIMIT 50
            `,
          query_params: parameters,
          format: "JSONEachRow",
        }),
        this.client.query({
          query: `
              SELECT
                ifNull(readiness_template, 'unknown') AS template_key,
                countIf(first_screen_collected = true) AS sample_size,
                quantileExactIf(0.5)(duration_ms, first_screen_collected = true AND duration_ms IS NOT NULL) AS p50_ms,
                quantileExactIf(0.9)(duration_ms, first_screen_collected = true AND duration_ms IS NOT NULL) AS p90_ms,
                countIf(blank_detection_collected = true) AS blank_observed,
                countIf(blank_detection_collected = true AND readiness_state = 'blank_candidate') AS blank_candidates
              FROM (${base})
              WHERE event_name = 'page_readiness'
              GROUP BY template_key
              ORDER BY sample_size DESC
            `,
          query_params: parameters,
          format: "JSONEachRow",
        }),
        this.client.query({
          query: `
              SELECT
                route,
                ifNull(row_count_bucket, 'unknown') AS row_count_bucket,
                count() AS sample_size,
                quantileExactIf(0.5)(duration_ms, duration_ms IS NOT NULL) AS p50_ms,
                quantileExactIf(0.9)(duration_ms, duration_ms IS NOT NULL) AS p90_ms
              FROM (${base})
              WHERE event_name = 'list_render'
              GROUP BY route, row_count_bucket
              ORDER BY sample_size DESC
              LIMIT 50
            `,
          query_params: parameters,
          format: "JSONEachRow",
        }),
        this.mysql.getDataStatus(projectId),
      ]);

      const coverageRows = await coverageResponse.json<Record<string, unknown>>();
      const coverage = coverageRows[0] ?? {};
      const pageViews = numberValue(coverage.page_views);
      const resourceRequests = numberValue(coverage.resource_requests);
      const resourceFailures = numberValue(coverage.resource_failures);
      const longTaskObserved = numberValue(coverage.long_task_observed_page_views);
      const blankObserved = numberValue(coverage.blank_observed_page_views);
      const availability = nullableString(coverage.available_from);

      const apis = (await apiResponse.json<Record<string, unknown>>()).map((row) => {
        const requests = numberValue(row.requests);
        const successes = numberValue(row.successes);
        const errors = numberValue(row.errors);
        const slowRequests = numberValue(row.slow_requests);
        return {
          requestMethod: String(row.request_method),
          requestPath: String(row.request_path),
          numerator: { successes, errors, slowRequests },
          denominator: requests,
          successRate: evidenceRate(successes, requests),
          errorRate: evidenceRate(errors, requests),
          slowRequestRate: evidenceRate(slowRequests, requests),
          ...durationEvidence(
            requests,
            nullableNumber(row.p50_ms),
            nullableNumber(row.p90_ms),
          ),
          sampleRate: nullableNumber(row.sample_rate),
          sampleSize: requests,
          lastSeenAt: nullableString(row.last_seen_at),
        };
      });
      const readiness = (await readinessResponse.json<Record<string, unknown>>()).map(
        (row) => {
          const sampleSize = numberValue(row.sample_size);
          const observed = numberValue(row.blank_observed);
          const candidates = numberValue(row.blank_candidates);
          return {
            templateKey: String(row.template_key),
            ...durationEvidence(
              sampleSize,
              nullableNumber(row.p50_ms),
              nullableNumber(row.p90_ms),
            ),
            sampleSize,
            blankCandidateRate: evidenceRate(candidates, observed),
            blankCandidates: candidates,
            blankObservedPageViews: observed,
          };
        },
      );
      const lists = (await listResponse.json<Record<string, unknown>>()).map((row) => {
        const sampleSize = numberValue(row.sample_size);
        return {
          route: String(row.route),
          rowCountBucket: String(row.row_count_bucket),
          ...durationEvidence(
            sampleSize,
            nullableNumber(row.p50_ms),
            nullableNumber(row.p90_ms),
          ),
          sampleSize,
        };
      });

      return {
        ...this.meta(range, evaluateDataStatus(rawStatus), availability),
        definitionVersion: PAGE_PERFORMANCE_DEFINITION_VERSION,
        coverage: {
          pageViews,
          readiness: {
            observedPageViews: numberValue(coverage.readiness_page_views),
            rate: evidenceRate(numberValue(coverage.readiness_page_views), pageViews),
            sampleRate: nullableNumber(coverage.readiness_sample_rate),
          },
          resources: {
            observedPageViews: numberValue(coverage.resource_observed_page_views),
            rate: evidenceRate(
              numberValue(coverage.resource_observed_page_views),
              pageViews,
            ),
            sampleRate: nullableNumber(coverage.resource_sample_rate),
          },
          longTasks: {
            observedPageViews: longTaskObserved,
            rate: evidenceRate(longTaskObserved, pageViews),
            sampleRate: nullableNumber(coverage.long_task_sample_rate),
          },
          blankScreen: {
            observedPageViews: blankObserved,
            rate: evidenceRate(blankObserved, pageViews),
            sampleRate: nullableNumber(coverage.readiness_sample_rate),
          },
        },
        api: {
          status: apis.length
            ? apis.some((item) => item.status === "available")
              ? "available"
              : "insufficient_sample"
            : "not_collected",
          items: apis,
        },
        resources: {
          status: numberValue(coverage.resource_observed_page_views)
            ? "available"
            : "not_collected",
          numerator: resourceFailures,
          denominator: resourceRequests,
          failureRate: evidenceRate(resourceFailures, resourceRequests),
          sampleRate: nullableNumber(coverage.resource_sample_rate),
        },
        readiness: {
          status: readiness.length
            ? readiness.some((item) => item.status === "available")
              ? "available"
              : "insufficient_sample"
            : "not_collected",
          items: readiness,
        },
        listRender: {
          status: lists.length
            ? lists.some((item) => item.status === "available")
              ? "available"
              : "insufficient_sample"
            : "not_collected",
          items: lists,
        },
        longTasks: {
          status: longTaskObserved ? "available" : "not_collected",
          count: numberValue(coverage.long_task_count),
          durationMs: numberValue(coverage.long_task_duration_ms),
          numerator: numberValue(coverage.long_task_affected_page_views),
          denominator: longTaskObserved,
          affectedPageViewRate: evidenceRate(
            numberValue(coverage.long_task_affected_page_views),
            longTaskObserved,
          ),
          sampleRate: nullableNumber(coverage.long_task_sample_rate),
        },
        blankScreen: {
          status: blankObserved ? "available" : "not_collected",
          numerator: numberValue(coverage.blank_candidates),
          denominator: blankObserved,
          candidateRate: evidenceRate(
            numberValue(coverage.blank_candidates),
            blankObserved,
          ),
          sampleRate: nullableNumber(coverage.readiness_sample_rate),
        },
      };
    });
  }

  async errorDetail(projectId: string, groupId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const parameters = { projectId, from: range.from, to: range.to, groupId };
      const [summaryResponse, trendResponse, impactResponse, rawStatus] =
        await Promise.all([
          this.client.query({
            query: this.errorGroupsSql("AND error_group_id = {groupId:String}", 1),
            query_params: parameters,
            format: "JSONEachRow",
          }),
          this.client.query({
            query: `
              SELECT
                ${range.granularity === "hour" ? "toStartOfHour" : "toStartOfDay"}(event_time, {timezone:String}) AS bucket,
                count() AS occurrences,
                uniqExact(visitor_id) AS affected_browsers,
                uniqExactIf(account_id, account_id IS NOT NULL) AS affected_accounts
              FROM (${observabilityEventsWhere("AND error_group_id = {groupId:String}")})
              GROUP BY bucket
              ORDER BY bucket
            `,
            query_params: { ...parameters, timezone: range.timezone },
            format: "JSONEachRow",
          }),
          this.client.query({
            query: `
              SELECT
                route,
                ifNull(release_version, 'unknown') AS release_version,
                count() AS occurrences,
                uniqExact(visitor_id) AS affected_browsers,
                max(event_time) AS last_seen_at
              FROM (${observabilityEventsWhere("AND error_group_id = {groupId:String}")})
              GROUP BY route, release_version
              ORDER BY occurrences DESC, route
              LIMIT 100
            `,
            query_params: parameters,
            format: "JSONEachRow",
          }),
          this.mysql.getDataStatus(projectId),
        ]);
      const summaryRows = await summaryResponse.json<Record<string, unknown>>();
      const item = summaryRows[0] ? this.mapErrorGroup(summaryRows[0]) : null;
      return {
        ...this.meta(
          range,
          evaluateDataStatus(rawStatus),
          await this.availableFrom(projectId),
        ),
        item,
        trend: (await trendResponse.json<Record<string, unknown>>()).map((row) => ({
          bucket: String(row.bucket),
          occurrences: numberValue(row.occurrences),
          affectedBrowsers: numberValue(row.affected_browsers),
          affectedAccounts: numberValue(row.affected_accounts),
        })),
        impact: (await impactResponse.json<Record<string, unknown>>()).map((row) => ({
          route: String(row.route),
          releaseVersion: String(row.release_version),
          occurrences: numberValue(row.occurrences),
          affectedBrowsers: numberValue(row.affected_browsers),
          lastSeenAt: nullableString(row.last_seen_at),
        })),
        privacy:
          "仅展示 SDK 截断并脱敏的消息/首帧；不含 query、header、正文或原始账号引用。",
      };
    });
  }

  async webVitals(projectId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const [items, availability, rawStatus] = await Promise.all([
        this.webVitalsQuery(projectId, range, 500),
        this.availableFrom(projectId),
        this.mysql.getDataStatus(projectId),
      ]);
      return {
        ...this.meta(range, evaluateDataStatus(rawStatus), availability),
        items,
        thresholds: {
          LCP: { goodMax: 2500, poorAbove: 4000, unit: "ms" },
          CLS: { goodMax: 0.1, poorAbove: 0.25, unit: "score" },
          INP: { goodMax: 200, poorAbove: 500, unit: "ms" },
          FCP: { goodMax: 1800, poorAbove: 3000, unit: "ms" },
          TTFB: { goodMax: 800, poorAbove: 1800, unit: "ms" },
        },
      };
    });
  }

  async releases(projectId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const [items, availability, rawStatus] = await Promise.all([
        this.releasesQuery(projectId, range),
        this.availableFrom(projectId),
        this.mysql.getDataStatus(projectId),
      ]);
      return {
        ...this.meta(range, evaluateDataStatus(rawStatus), availability),
        items,
      };
    });
  }

  async alerts(projectId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const [errors, vitals, rawStatus] = await Promise.all([
        this.errorGroupsQuery(projectId, range, 100),
        this.webVitalsQuery(projectId, range, 500),
        this.mysql.getDataStatus(projectId),
      ]);
      const dataStatus = evaluateDataStatus(rawStatus);
      return {
        ...this.meta(range, dataStatus, await this.availableFrom(projectId)),
        items: buildFixedAlerts({
          errors,
          vitals,
          dataState: dataStatus.state,
          updatedAt: rawStatus.lastQueryableAt,
        }),
      };
    });
  }

  private meta(
    range: AnalyticsRange,
    dataStatus: ReturnType<typeof evaluateDataStatus>,
    availableFrom: string | null,
  ) {
    return {
      range,
      dataStatus,
      updatedAt: dataStatus.lastQueryableAt,
      availableFrom,
      definitionVersion: OBSERVABILITY_DEFINITION_VERSION,
    };
  }

  private errorGroupsSql(extra: string, limit: number): string {
    return `
      SELECT
        error_group_id,
        any(error_type) AS error_type,
        argMax(error_name, event_time) AS error_name,
        argMax(error_message, event_time) AS error_message,
        argMax(error_stack_frame, event_time) AS error_stack_frame,
        argMax(request_method, event_time) AS request_method,
        argMax(request_path, event_time) AS request_path,
        argMax(http_status, event_time) AS http_status,
        argMax(resource_type, event_time) AS resource_type,
        count() AS occurrences,
        uniqExactIf(account_id, account_id IS NOT NULL) AS affected_accounts,
        uniqExact(visitor_id) AS affected_browsers,
        uniqExact(route) AS affected_pages,
        groupUniqArray(8)(route) AS pages,
        groupUniqArray(8)(ifNull(release_version, 'unknown')) AS releases,
        groupUniqArray(8)(ifNull(browser_family, 'unknown')) AS browser_families,
        groupUniqArray(8)(ifNull(os_family, 'unknown')) AS os_families,
        groupUniqArray(8)(ifNull(viewport_bucket, 'unknown')) AS viewport_buckets,
        min(event_time) AS first_seen_at,
        max(event_time) AS last_seen_at
      FROM (${observabilityEventsWhere(`AND error_group_id IS NOT NULL ${extra}`)})
      GROUP BY error_group_id
      ORDER BY occurrences DESC, last_seen_at DESC
      LIMIT ${Math.max(1, Math.min(500, limit))}
    `;
  }

  private async errorGroupsQuery(
    projectId: string,
    range: AnalyticsRange,
    limit: number,
  ): Promise<ErrorGroupSummary[]> {
    const response = await this.client.query({
      query: this.errorGroupsSql("", limit),
      query_params: { projectId, from: range.from, to: range.to },
      format: "JSONEachRow",
    });
    return (await response.json<Record<string, unknown>>()).map((row) =>
      this.mapErrorGroup(row),
    );
  }

  private mapErrorGroup(row: Record<string, unknown>): ErrorGroupSummary {
    const base = {
      groupId: String(row.error_group_id),
      errorType: String(row.error_type) as ErrorType,
      errorName: nullableString(row.error_name),
      message: nullableString(row.error_message),
      stackTopFrame: nullableString(row.error_stack_frame),
      requestMethod: nullableString(row.request_method),
      requestPath: nullableString(row.request_path),
      httpStatus: nullableNumber(row.http_status),
      resourceType: nullableString(row.resource_type),
      occurrences: numberValue(row.occurrences),
      affectedAccounts: numberValue(row.affected_accounts),
      affectedBrowsers: numberValue(row.affected_browsers),
      affectedPages: numberValue(row.affected_pages),
      pages: stringArray(row.pages),
      releases: stringArray(row.releases),
      browserFamilies: stringArray(row.browser_families),
      osFamilies: stringArray(row.os_families),
      viewportBuckets: stringArray(row.viewport_buckets),
      firstSeenAt: nullableString(row.first_seen_at),
      lastSeenAt: nullableString(row.last_seen_at),
    };
    return { ...base, severity: errorSeverity(base) };
  }

  private async webVitalsQuery(
    projectId: string,
    range: AnalyticsRange,
    limit: number,
  ): Promise<WebVitalSummary[]> {
    const response = await this.client.query({
      query: `
        SELECT
          route,
          vital_name,
          ifNull(release_version, 'unknown') AS release_version,
          count() AS sample_size,
          quantileExact(0.75)(vital_value) AS p75,
          countIf(vital_rating = 'poor') AS poor_samples,
          countIf(vital_rating = 'poor') / count() AS poor_rate,
          max(event_time) AS last_seen_at
        FROM (${observabilityEventsWhere("AND event_name = 'web_vital' AND vital_value IS NOT NULL")})
        GROUP BY route, vital_name, release_version
        ORDER BY poor_rate DESC, sample_size DESC, route
        LIMIT ${Math.max(1, Math.min(1000, limit))}
      `,
      query_params: { projectId, from: range.from, to: range.to },
      format: "JSONEachRow",
    });
    return (await response.json<Record<string, unknown>>()).map((row) => ({
      route: String(row.route),
      vitalName: String(row.vital_name) as WebVitalSummary["vitalName"],
      releaseVersion: String(row.release_version),
      sampleSize: numberValue(row.sample_size),
      p75: nullableNumber(row.p75),
      poorSamples: numberValue(row.poor_samples),
      poorRate: nullableNumber(row.poor_rate),
      lastSeenAt: nullableString(row.last_seen_at),
    }));
  }

  private async releasesQuery(projectId: string, range: AnalyticsRange) {
    const response = await this.client.query({
      query: `
        SELECT
          ifNull(release_version, 'unknown') AS release_version,
          any(deployment_environment) AS deployment_environment,
          count() AS observability_events,
          countIf(error_group_id IS NOT NULL) AS errors,
          uniqExactIf(error_group_id, error_group_id IS NOT NULL) AS error_groups,
          countIf(vital_rating = 'poor') AS poor_vital_samples,
          uniqExact(visitor_id) AS affected_browsers,
          min(event_time) AS first_seen_at,
          max(event_time) AS last_seen_at
        FROM (${observabilityEventsWhere("AND release_version IS NOT NULL")})
        GROUP BY release_version
        ORDER BY last_seen_at DESC, release_version
        LIMIT 100
      `,
      query_params: { projectId, from: range.from, to: range.to },
      format: "JSONEachRow",
    });
    return (await response.json<Record<string, unknown>>()).map((row) => ({
      releaseVersion: String(row.release_version),
      deploymentEnvironment: nullableString(row.deployment_environment),
      observabilityEvents: numberValue(row.observability_events),
      errors: numberValue(row.errors),
      errorGroups: numberValue(row.error_groups),
      poorVitalSamples: numberValue(row.poor_vital_samples),
      affectedBrowsers: numberValue(row.affected_browsers),
      firstSeenAt: nullableString(row.first_seen_at),
      lastSeenAt: nullableString(row.last_seen_at),
    }));
  }

  private async summaryQuery(projectId: string, range: AnalyticsRange) {
    const response = await this.client.query({
      query: `
        SELECT
          countIf(error_group_id IS NOT NULL) AS error_occurrences,
          uniqExactIf(error_group_id, error_group_id IS NOT NULL) AS error_groups,
          uniqExactIf(account_id, error_group_id IS NOT NULL AND account_id IS NOT NULL) AS affected_accounts,
          uniqExactIf(visitor_id, error_group_id IS NOT NULL) AS affected_browsers,
          countIf(event_name = 'web_vital') AS vital_samples,
          countIf(event_name = 'web_vital' AND vital_rating = 'poor') AS poor_vital_samples,
          uniqExactIf(release_version, release_version IS NOT NULL) AS releases
        FROM (${observabilityEventsWhere()})
      `,
      query_params: { projectId, from: range.from, to: range.to },
      format: "JSONEachRow",
    });
    const rows = await response.json<Record<string, unknown>>();
    const row = rows[0] ?? {};
    return {
      errorOccurrences: numberValue(row.error_occurrences),
      errorGroups: numberValue(row.error_groups),
      affectedAccounts: numberValue(row.affected_accounts),
      affectedBrowsers: numberValue(row.affected_browsers),
      vitalSamples: numberValue(row.vital_samples),
      poorVitalSamples: numberValue(row.poor_vital_samples),
      releases: numberValue(row.releases),
    };
  }

  private async trendQuery(projectId: string, range: AnalyticsRange) {
    const bucket = range.granularity === "hour" ? "toStartOfHour" : "toStartOfDay";
    const response = await this.client.query({
      query: `
        SELECT
          ${bucket}(event_time, {timezone:String}) AS bucket,
          countIf(error_group_id IS NOT NULL) AS errors,
          uniqExactIf(error_group_id, error_group_id IS NOT NULL) AS error_groups,
          countIf(event_name = 'web_vital') AS vital_samples,
          countIf(vital_rating = 'poor') AS poor_vital_samples
        FROM (${observabilityEventsWhere()})
        GROUP BY bucket
        ORDER BY bucket
      `,
      query_params: {
        projectId,
        from: range.from,
        to: range.to,
        timezone: range.timezone,
      },
      format: "JSONEachRow",
    });
    return (await response.json<Record<string, unknown>>()).map((row) => ({
      bucket: String(row.bucket),
      errors: numberValue(row.errors),
      errorGroups: numberValue(row.error_groups),
      vitalSamples: numberValue(row.vital_samples),
      poorVitalSamples: numberValue(row.poor_vital_samples),
    }));
  }

  private async availableFrom(projectId: string): Promise<string | null> {
    const response = await this.client.query({
      query: `
        SELECT minOrNull(event_time) AS available_from
        FROM raw_events
        WHERE project_id = {projectId:UUID}
          AND event_name IN ('error_js', 'error_resource', 'error_api', 'web_vital')
      `,
      query_params: { projectId },
      format: "JSONEachRow",
    });
    const rows = await response.json<{ available_from: string | null }>();
    return nullableString(rows[0]?.available_from);
  }

  private async measure<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } catch (cause) {
      this.queryFailures += 1;
      throw cause;
    } finally {
      this.durationSamples.push(performance.now() - startedAt);
      if (this.durationSamples.length > 1_000) this.durationSamples.shift();
    }
  }
}
