import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { MySqlStore } from "./mysql-store.js";

export type Granularity = "hour" | "day";

export interface AnalyticsRange {
  from: string;
  to: string;
  timezone: string;
  granularity: Granularity;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function zonedParts(instant: Date, timezone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
    millisecond: values.fractionalSecond!,
  };
}

function partsAsUtc(parts: ZonedDateParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
}

function localPartsToInstant(parts: ZonedDateParts, timezone: string): Date {
  const target = partsAsUtc(parts);
  let candidate = target;
  for (let index = 0; index < 4; index += 1) {
    const observed = partsAsUtc(zonedParts(new Date(candidate), timezone));
    const adjustment = target - observed;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(candidate);
}

export function previousLocalCalendarDay(iso: string, timezone: string): string {
  const current = zonedParts(new Date(iso), timezone);
  const previousDate = new Date(
    Date.UTC(current.year, current.month - 1, current.day - 1),
  );
  return localPartsToInstant(
    {
      ...current,
      year: previousDate.getUTCFullYear(),
      month: previousDate.getUTCMonth() + 1,
      day: previousDate.getUTCDate(),
    },
    timezone,
  ).toISOString();
}

export function validateAnalyticsRange(input: AnalyticsRange): AnalyticsRange {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (
    !Number.isFinite(from.valueOf()) ||
    !Number.isFinite(to.valueOf()) ||
    from >= to
  ) {
    throw new Error("ANALYTICS_RANGE_INVALID");
  }
  const maximum = new Date(from);
  maximum.setUTCMonth(maximum.getUTCMonth() + 13);
  if (to > maximum) throw new Error("ANALYTICS_RANGE_TOO_LARGE");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(from);
  } catch {
    throw new Error("TIMEZONE_INVALID");
  }
  const durationDays = (to.valueOf() - from.valueOf()) / 86_400_000;
  if (input.granularity === "hour" && durationDays > 31) {
    throw new Error("GRANULARITY_TOO_FINE");
  }
  return {
    ...input,
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

function deduplicatedEventsWhere(extra = ""): string {
  return `
    SELECT *
    FROM raw_events
    WHERE project_id = {projectId:UUID}
      AND event_time >= parseDateTime64BestEffort({from:String}, 3)
      AND event_time < parseDateTime64BestEffort({to:String}, 3)
      ${extra}
    ORDER BY received_at DESC
    LIMIT 1 BY event_id
  `;
}

function numberRow(
  row: Record<string, unknown>,
): Record<string, number | string | null> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (value === null) return [key, null];
      if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
        return [key, Number(value)];
      }
      return [key, value as string];
    }),
  );
}

export class AnalyticsStore {
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
    await this.client.ping();
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
      const current = await this.metricOverview(projectId, range);
      const previous = await this.metricOverview(projectId, {
        ...range,
        from: previousLocalCalendarDay(range.from, range.timezone),
        to: previousLocalCalendarDay(range.to, range.timezone),
      });
      return {
        range,
        current,
        comparison: {
          label: "previous_day_same_duration",
          metrics: previous,
        },
        semantics: {
          visitors: "anonymous browser storage instances, not people",
          accounts: "project-HMACed business account references",
          sessions: "tab-scoped sessions with 30-minute inactivity timeout",
        },
      };
    });
  }

  private async metricOverview(projectId: string, range: AnalyticsRange) {
    const response = await this.client.query({
      query: `
        SELECT
          countIf(event_name = 'page_view') AS pv,
          uniqExact(visitor_id) AS visitors,
          uniqExactIf(account_id, account_id IS NOT NULL) AS accounts,
          uniqExact(session_id) AS sessions,
          max(received_at) AS last_received_at
        FROM (${deduplicatedEventsWhere()})
      `,
      query_params: { projectId, from: range.from, to: range.to },
      format: "JSONEachRow",
    });
    const rows = await response.json<Record<string, unknown>>();
    return numberRow(rows[0] ?? {});
  }

  async trend(projectId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const bucket = range.granularity === "hour" ? "toStartOfHour" : "toStartOfDay";
      const response = await this.client.query({
        query: `
        SELECT
          ${bucket}(event_time, {timezone:String}) AS bucket,
          countIf(event_name = 'page_view') AS pv,
          uniqExact(visitor_id) AS visitors
        FROM (${deduplicatedEventsWhere()})
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
      const rows = await response.json<Record<string, unknown>>();
      return {
        range,
        points: rows.map(numberRow),
        gapPolicy: "missing buckets are omitted and must not be connected as zero",
      };
    });
  }

  async pages(
    projectId: string,
    rangeInput: AnalyticsRange,
    options: {
      search?: string;
      page?: number;
      pageSize?: number;
      sort?: "pv" | "visitors" | "sessions" | "lastVisitAt";
      direction?: "asc" | "desc";
    } = {},
  ) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const page = Math.max(1, options.page ?? 1);
      const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
      const sortColumns = {
        pv: "pv",
        visitors: "visitors",
        sessions: "sessions",
        lastVisitAt: "last_visit_at",
      } as const;
      const sort = sortColumns[options.sort ?? "pv"];
      const direction = options.direction === "asc" ? "ASC" : "DESC";
      const search = options.search?.trim() ?? "";
      const extra = search
        ? "AND positionCaseInsensitive(route, {search:String}) > 0"
        : "";
      const queryParams = {
        projectId,
        from: range.from,
        to: range.to,
        search,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      };
      const response = await this.client.query({
        query: `
        SELECT
          route,
          count() AS pv,
          uniqExact(visitor_id) AS visitors,
          uniqExact(session_id) AS sessions,
          max(event_time) AS last_visit_at,
          max(received_at) AS last_received_at
        FROM (${deduplicatedEventsWhere(`AND event_name = 'page_view' ${extra}`)})
        GROUP BY route
        ORDER BY ${sort} ${direction}, route ASC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      `,
        query_params: queryParams,
        format: "JSONEachRow",
      });
      const totalResponse = await this.client.query({
        query: `
        SELECT uniqExact(route) AS total
        FROM (${deduplicatedEventsWhere(`AND event_name = 'page_view' ${extra}`)})
      `,
        query_params: queryParams,
        format: "JSONEachRow",
      });
      const rows = await response.json<Record<string, unknown>>();
      const totalRows = await totalResponse.json<{ total: string }>();
      return {
        range,
        page,
        pageSize,
        total: Number(totalRows[0]?.total ?? 0),
        items: rows.map(numberRow),
      };
    });
  }

  async features(projectId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const response = await this.client.query({
        query: `
        SELECT
          feature_key,
          uniqExactIf(account_id, event_name = 'feature_exposed' AND account_id IS NOT NULL) AS exposed_accounts,
          uniqExactIf(visitor_id, event_name = 'feature_exposed') AS exposed_visitors,
          uniqExactIf(account_id, event_name = 'feature_succeeded' AND account_id IS NOT NULL) AS succeeded_accounts,
          uniqExactIf(visitor_id, event_name = 'feature_succeeded') AS succeeded_visitors,
          countIf(event_name = 'feature_succeeded') AS success_count,
          maxIf(event_time, event_name = 'feature_succeeded') AS last_succeeded_at,
          uniqExactIf(account_id, event_name = 'feature_succeeded' AND account_id IS NOT NULL AND
            (ifNull(account_id, ''), ifNull(feature_key, '')) IN (
            SELECT ifNull(account_id, ''), ifNull(feature_key, '')
            FROM (${deduplicatedEventsWhere("AND event_name = 'feature_succeeded' AND account_id IS NOT NULL AND feature_key IS NOT NULL")})
            GROUP BY account_id, feature_key HAVING uniqExact(session_id) >= 2
          )) AS repeat_accounts,
          uniqExactIf(visitor_id, event_name = 'feature_succeeded' AND
            (visitor_id, ifNull(feature_key, '')) IN (
            SELECT visitor_id, ifNull(feature_key, '')
            FROM (${deduplicatedEventsWhere("AND event_name = 'feature_succeeded' AND feature_key IS NOT NULL")})
            GROUP BY visitor_id, feature_key HAVING uniqExact(session_id) >= 2
          )) AS repeat_visitors
        FROM (${deduplicatedEventsWhere("AND feature_key IS NOT NULL")})
        GROUP BY feature_key
        ORDER BY success_count DESC, feature_key
      `,
        query_params: { projectId, from: range.from, to: range.to },
        format: "JSONEachRow",
      });
      const rows = (await response.json<Record<string, unknown>>()).map(numberRow);
      const metrics = new Map(rows.map((row) => [String(row.feature_key), row]));
      const definitions = await this.mysql.listFeatures(projectId);
      return {
        range,
        items: definitions.map((feature) => {
          const metric = metrics.get(feature.featureKey) ?? {};
          const exposedAccounts = Number(metric.exposed_accounts ?? 0);
          const succeededAccounts = Number(metric.succeeded_accounts ?? 0);
          const exposedVisitors = Number(metric.exposed_visitors ?? 0);
          const succeededVisitors = Number(metric.succeeded_visitors ?? 0);
          return {
            ...feature,
            ...metric,
            accountConversionRate:
              exposedAccounts > 0 ? succeededAccounts / exposedAccounts : null,
            visitorConversionRate:
              exposedVisitors > 0 ? succeededVisitors / exposedVisitors : null,
          };
        }),
      };
    });
  }

  async featureDetail(
    projectId: string,
    featureId: string,
    rangeInput: AnalyticsRange,
  ) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const feature = (await this.mysql.listFeatures(projectId)).find(
        (candidate) => candidate.id === featureId,
      );
      if (!feature) throw new Error("FEATURE_NOT_FOUND");
      const queryParams = {
        projectId,
        featureKey: feature.featureKey,
        from: range.from,
        to: range.to,
        timezone: range.timezone,
      };
      const response = await this.client.query({
        query: `
        SELECT
          countIf(event_name = 'feature_exposed') AS exposed,
          countIf(event_name = 'feature_started') AS started,
          countIf(event_name = 'feature_succeeded') AS succeeded,
          countIf(event_name = 'feature_failed') AS failed,
          uniqExactIf(account_id, event_name = 'feature_succeeded' AND account_id IS NOT NULL) AS succeeded_accounts,
          uniqExactIf(visitor_id, event_name = 'feature_succeeded') AS succeeded_visitors,
          uniqExactIf(account_id, event_name = 'feature_succeeded' AND account_id IS NOT NULL AND account_id IN (
            SELECT account_id
            FROM (${deduplicatedEventsWhere("AND feature_key = {featureKey:String} AND event_name = 'feature_succeeded' AND account_id IS NOT NULL")})
            GROUP BY account_id HAVING uniqExact(session_id) >= 2
          )) AS repeat_accounts,
          uniqExactIf(visitor_id, event_name = 'feature_succeeded' AND visitor_id IN (
            SELECT visitor_id
            FROM (${deduplicatedEventsWhere("AND feature_key = {featureKey:String} AND event_name = 'feature_succeeded'")})
            GROUP BY visitor_id HAVING uniqExact(session_id) >= 2
          )) AS repeat_visitors
        FROM (${deduplicatedEventsWhere("AND feature_key = {featureKey:String}")})
      `,
        query_params: queryParams,
        format: "JSONEachRow",
      });
      const bucket = range.granularity === "hour" ? "toStartOfHour" : "toStartOfDay";
      const trendResponse = await this.client.query({
        query: `
        SELECT
          ${bucket}(event_time, {timezone:String}) AS bucket,
          countIf(event_name = 'feature_exposed') AS exposed,
          countIf(event_name = 'feature_succeeded') AS succeeded,
          uniqExactIf(account_id, event_name = 'feature_succeeded' AND account_id IS NOT NULL) AS succeeded_accounts,
          uniqExactIf(visitor_id, event_name = 'feature_succeeded') AS succeeded_visitors
        FROM (${deduplicatedEventsWhere("AND feature_key = {featureKey:String}")})
        GROUP BY bucket
        ORDER BY bucket
      `,
        query_params: queryParams,
        format: "JSONEachRow",
      });
      const durationResponse = await this.client.query({
        query: `
        SELECT sum(instance_duration_ms) AS visible_duration_ms
        FROM (
          SELECT
            visitor_id,
            session_id,
            page_view_id,
            max(ifNull(visible_duration_ms, 0)) AS instance_duration_ms
          FROM (${deduplicatedEventsWhere("AND feature_key = {featureKey:String} AND event_name IN ('feature_long_view_heartbeat', 'feature_long_view_ended')")})
          GROUP BY visitor_id, session_id, page_view_id
        )
      `,
        query_params: queryParams,
        format: "JSONEachRow",
      });
      const rows = await response.json<Record<string, unknown>>();
      const durationRows = await durationResponse.json<Record<string, unknown>>();
      const trendRows = await trendResponse.json<Record<string, unknown>>();
      return {
        range,
        feature,
        metrics: {
          ...numberRow(rows[0] ?? {}),
          ...numberRow(durationRows[0] ?? {}),
        },
        trend: trendRows.map(numberRow),
        gapPolicy: "missing buckets are omitted and must not be connected as zero",
      };
    });
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
