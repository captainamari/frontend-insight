import { SafeClickHouseLogger } from "./clickhouse-logger.js";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { assertClickHouseReady } from "./clickhouse-health.js";
import { validateAnalyticsRange, type AnalyticsRange } from "./analytics.js";
import type { MySqlStore } from "./mysql-store.js";
import { evaluateDataStatus, type DataState } from "./status.js";

export const OBSERVABILITY_DEFINITION_VERSION = "observability_v1.0.0";

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
  affectedUsers: number;
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
  pageRoute: string;
  vitalName: "lcp" | "cls" | "inp" | "fcp" | "ttfb";
  release: string;
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
    SELECT *, page_route AS pageRoute
    FROM raw_events
    WHERE project_id = {projectId:UUID}
      AND timestamp >= parseDateTime64BestEffort({from:String}, 3)
      AND timestamp < parseDateTime64BestEffort({to:String}, 3)
      AND (
        event IN ('error', 'performance')
        OR (event = 'api' AND error_group_id IS NOT NULL)
      )
      ${extra}
    ORDER BY received_at DESC
    LIMIT 1 BY event_id
  `;
}

export function errorSeverity(input: {
  occurrences: number;
  affectedUsers: number;
  affectedBrowsers: number;
  httpStatus: number | null;
}): ErrorGroupSummary["severity"] {
  if (
    input.occurrences >= 50 ||
    input.affectedUsers >= 10 ||
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
      evidence: `${group.occurrences} 次，影响 ${group.affectedBrowsers} 个浏览器实例 / ${group.affectedUsers} 个账号`,
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
      id: `web_vital_poor:${vital.pageRoute}:${vital.vitalName}:${vital.release}`,
      ruleKey: "web_vital_poor",
      severity,
      title: `${vital.pageRoute} 的 ${vital.vitalName} 较差样本偏高`,
      evidence: `${vital.poorSamples}/${vital.sampleSize} 个样本为 poor（${Math.round(vital.poorRate * 100)}%）`,
      entityType: "page_vital",
      entityKey: `${vital.pageRoute}:${vital.vitalName}:${vital.release}`,
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
    this.client = createClient({
      ...clickhouse,
      log: { LoggerClass: SafeClickHouseLogger },
    });
  }

  async overviewEvidence(
    projectId: string,
    input: { from: string; to: string; timezone: string; env: string },
    onQuery?: () => void,
  ) {
    const range = { ...input, granularity: "day" as const };
    const [errors, vitals] = await Promise.all([
      this.errorGroupsQuery(projectId, range, 500, input.env, onQuery),
      this.webVitalsQuery(projectId, range, 1000, input.env, onQuery),
    ]);
    const items = buildFixedAlerts({
      errors,
      vitals,
      dataState: "no_data",
      updatedAt: null,
    });
    return {
      status: items.length
        ? "alerts_observed"
        : errors.length || vitals.some((v) => v.sampleSize >= 20)
          ? "no_alerts_observed"
          : vitals.length
            ? "insufficient_sample"
            : "unavailable",
      reason:
        !errors.length && vitals.length && vitals.every((v) => v.sampleSize < 20)
          ? "ALERT_INSUFFICIENT_SAMPLE"
          : "ENV_EXPOSURE_NOT_VERIFIED",
      completeness: "limited",
      truncated: errors.length === 500 || vitals.length === 1000,
      scope: { projectId, ...input },
      rules: {
        error_spike:
          "既有诊断规则：critical≥50次或≥10账号或HTTP≥500且≥20次；high≥10次或≥5浏览器；warning≥5次且≥3浏览器。不是规范质量rate。",
        web_vital_poor:
          "既有诊断规则：≥20个样本且poor占比≥30%；≥50%为high。使用已上报rating，不作为新的质量评分阈值。",
      },
      items: items.map((alert) => ({
        ...alert,
        scope: { projectId, ...input },
        sample:
          alert.entityType === "error_group"
            ? (errors.find((e) => e.groupId === alert.entityKey)?.occurrences ?? null)
            : (vitals.find(
                (v) => `${v.pageRoute}:${v.vitalName}:${v.release}` === alert.entityKey,
              )?.sampleSize ?? null),
        detail:
          alert.entityType === "error_group"
            ? errors
                .filter((e) => e.groupId === alert.entityKey)
                .map((e) => ({
                  occurrences: e.occurrences,
                  affectedUsers: e.affectedUsers,
                  affectedBrowsers: e.affectedBrowsers,
                  affectedPages: e.affectedPages,
                  httpStatus: e.httpStatus,
                  firstSeenAt: e.firstSeenAt,
                  lastSeenAt: e.lastSeenAt,
                }))
            : vitals.filter(
                (v) => `${v.pageRoute}:${v.vitalName}:${v.release}` === alert.entityKey,
              ),
      })),
    };
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
                ${range.granularity === "hour" ? "toStartOfHour" : "toStartOfDay"}(timestamp, {timezone:String}) AS bucket,
                count() AS occurrences,
                uniqExact(device_id) AS affected_browsers,
                uniqExactIf(user_id, user_id IS NOT NULL) AS affected_users
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
                pageRoute,
                ifNull(release, 'unknown') AS release,
                count() AS occurrences,
                uniqExact(device_id) AS affected_browsers,
                max(timestamp) AS last_seen_at
              FROM (${observabilityEventsWhere("AND error_group_id = {groupId:String}")})
              GROUP BY pageRoute, release
              ORDER BY occurrences DESC, pageRoute
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
          affectedUsers: numberValue(row.affected_users),
        })),
        impact: (await impactResponse.json<Record<string, unknown>>()).map((row) => ({
          pageRoute: String(row.pageRoute),
          release: String(row.release),
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
        argMax(error_name, timestamp) AS error_name,
        argMax(error_message, timestamp) AS error_message,
        argMax(error_stack_frame, timestamp) AS error_stack_frame,
        argMax(request_method, timestamp) AS request_method,
        argMax(request_path, timestamp) AS request_path,
        argMax(http_status, timestamp) AS http_status,
        argMax(resource_type, timestamp) AS resource_type,
        count() AS occurrences,
        uniqExactIf(user_id, user_id IS NOT NULL) AS affected_users,
        uniqExact(device_id) AS affected_browsers,
        uniqExact(pageRoute) AS affected_pages,
        groupUniqArray(8)(pageRoute) AS pages,
        groupUniqArray(8)(ifNull(release, 'unknown')) AS releases,
        groupUniqArray(8)(ifNull(browser, 'unknown')) AS browser_families,
        groupUniqArray(8)(ifNull(os, 'unknown')) AS os_families,
        groupUniqArray(8)(ifNull(viewport_bucket, 'unknown')) AS viewport_buckets,
        min(timestamp) AS first_seen_at,
        max(timestamp) AS last_seen_at
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
    env?: string,
    onQuery?: () => void,
  ): Promise<ErrorGroupSummary[]> {
    onQuery?.();
    const response = await this.client.query({
      query: this.errorGroupsSql(env ? "AND env = {env:String}" : "", limit),
      query_params: {
        projectId,
        from: range.from,
        to: range.to,
        ...(env ? { env } : {}),
      },
      format: "JSONEachRow",
      clickhouse_settings: {
        max_execution_time: 5,
        max_rows_to_read: "400000000",
        read_overflow_mode: "throw",
      },
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
      affectedUsers: numberValue(row.affected_users),
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
    env?: string,
    onQuery?: () => void,
  ): Promise<WebVitalSummary[]> {
    onQuery?.();
    const response = await this.client.query({
      query: `
        SELECT
          pageRoute,
          vital_name,
          ifNull(release, 'unknown') AS release,
          count() AS sample_size,
          quantileExact(0.75)(vital_value) AS p75,
          countIf(vital_rating = 'poor') AS poor_samples,
          countIf(vital_rating = 'poor') / count() AS poor_rate,
          max(timestamp) AS last_seen_at
        FROM (${observabilityEventsWhere("AND event = 'performance' AND vital_value IS NOT NULL" + (env ? " AND env={env:String}" : ""))})
        GROUP BY pageRoute, vital_name, release
        ORDER BY poor_rate DESC, sample_size DESC, pageRoute
        LIMIT ${Math.max(1, Math.min(1000, limit))}
      `,
      query_params: {
        projectId,
        from: range.from,
        to: range.to,
        ...(env ? { env } : {}),
      },
      clickhouse_settings: {
        max_execution_time: 5,
        max_rows_to_read: "400000000",
        read_overflow_mode: "throw",
      },
      format: "JSONEachRow",
    });
    return (await response.json<Record<string, unknown>>()).map((row) => ({
      pageRoute: String(row.pageRoute),
      vitalName: String(row.vital_name) as WebVitalSummary["vitalName"],
      release: String(row.release),
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
          ifNull(release, 'unknown') AS release,
          any(env) AS env,
          count() AS observability_events,
          countIf(error_group_id IS NOT NULL) AS errors,
          uniqExactIf(error_group_id, error_group_id IS NOT NULL) AS error_groups,
          countIf(vital_rating = 'poor') AS poor_vital_samples,
          uniqExact(device_id) AS affected_browsers,
          min(timestamp) AS first_seen_at,
          max(timestamp) AS last_seen_at
        FROM (${observabilityEventsWhere("AND release IS NOT NULL")})
        GROUP BY release
        ORDER BY last_seen_at DESC, release
        LIMIT 100
      `,
      query_params: { projectId, from: range.from, to: range.to },
      format: "JSONEachRow",
    });
    return (await response.json<Record<string, unknown>>()).map((row) => ({
      release: String(row.release),
      env: nullableString(row.env),
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
          uniqExactIf(user_id, error_group_id IS NOT NULL AND user_id IS NOT NULL) AS affected_users,
          uniqExactIf(device_id, error_group_id IS NOT NULL) AS affected_browsers,
          countIf(event = 'performance') AS vital_samples,
          countIf(event = 'performance' AND vital_rating = 'poor') AS poor_vital_samples,
          uniqExactIf(release, release IS NOT NULL) AS releases
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
      affectedUsers: numberValue(row.affected_users),
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
          ${bucket}(timestamp, {timezone:String}) AS bucket,
          countIf(error_group_id IS NOT NULL) AS errors,
          uniqExactIf(error_group_id, error_group_id IS NOT NULL) AS error_groups,
          countIf(event = 'performance') AS vital_samples,
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
        SELECT minOrNull(timestamp) AS available_from
        FROM raw_events
        WHERE project_id = {projectId:UUID}
          AND (
            event IN ('error', 'performance')
            OR (event = 'api' AND error_group_id IS NOT NULL)
          )
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
