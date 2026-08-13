import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { assertClickHouseReady } from "./clickhouse-health.js";
import {
  calculateOperationalIndex,
  metricDefinition,
  metricResult,
  normalizeMetricScore,
  PAGE_TEMPLATE_DURATION_TARGETS,
  type MetricResult,
} from "./metrics.js";
import type { MySqlStore } from "./mysql-store.js";
import { evaluateDataStatus } from "./status.js";
import type { FeatureRecord, PageDefinitionRecord } from "./model.js";

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

function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  return 0;
}

function nullableNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index]!;
}

function weightedPercentile(
  values: Array<{ value: number; weight: number }>,
  quantile: number,
): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left.value - right.value);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  const threshold = totalWeight * quantile;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= threshold) return item.value;
  }
  return sorted.at(-1)!.value;
}

export interface PageOperationalRow {
  route: string;
  pageViews: number;
  accounts: number;
  browsers: number;
  sessions: number;
  lastVisitAt: string | null;
  durationSamples: number;
  durationAverageMs: number | null;
  durationP50Ms: number | null;
  durationP75Ms: number | null;
  durationCoverage: number | null;
}

interface ModuleOperationalRow {
  moduleId: string;
  pageViews: number;
  accounts: number;
  browsers: number;
  sessions: number;
  lastVisitAt: string | null;
}

interface OperationInstanceRow {
  operationInstanceId: string;
  featureKey: string;
  startedAtMs: number;
  terminalAtMs: number | null;
  terminalName: "feature_succeeded" | "feature_failed" | "feature_canceled" | null;
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
      const [current, previous, sdkVersions] = await Promise.all([
        this.metricOverview(projectId, range),
        this.metricOverview(projectId, {
          ...range,
          from: previousLocalCalendarDay(range.from, range.timezone),
          to: previousLocalCalendarDay(range.to, range.timezone),
        }),
        this.sdkVersionDistribution(projectId, range),
      ]);
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
        sdkVersions,
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
      const bucket = range.granularity === "hour" ? "toStartOfHour" : "toStartOfDay";
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
      const trendResponse = await this.client.query({
        query: `
        SELECT
          ${bucket}(event_time, {timezone:String}) AS bucket,
          countIf(event_name = 'feature_exposed') AS exposed,
          countIf(event_name = 'feature_succeeded') AS succeeded,
          uniqExactIf(account_id, event_name = 'feature_succeeded' AND account_id IS NOT NULL) AS succeeded_accounts,
          uniqExactIf(visitor_id, event_name = 'feature_succeeded') AS succeeded_visitors
        FROM (${deduplicatedEventsWhere("AND feature_key IS NOT NULL")})
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
      const rows = (await response.json<Record<string, unknown>>()).map(numberRow);
      const trend = (await trendResponse.json<Record<string, unknown>>()).map(
        numberRow,
      );
      const sdkVersions = await this.sdkVersionDistribution(projectId, range);
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
        trend,
        gapPolicy: "missing buckets are omitted and must not be connected as zero",
        sdkVersions,
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
      const sdkVersions = await this.sdkVersionDistribution(projectId, range);
      return {
        range,
        feature,
        metrics: {
          ...numberRow(rows[0] ?? {}),
          ...numberRow(durationRows[0] ?? {}),
        },
        trend: trendRows.map(numberRow),
        gapPolicy: "missing buckets are omitted and must not be connected as zero",
        sdkVersions,
      };
    });
  }

  async modules(projectId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const [modules, pages, rows, status] = await Promise.all([
        this.mysql.listModules(projectId),
        this.mysql.listPageDefinitions(projectId),
        this.pageOperationalRows(projectId, range),
        this.projectDataStatus(projectId),
      ]);
      const activePages = pages.filter(
        (page) =>
          page.status === "active" &&
          Date.parse(page.effectiveFrom) < Date.parse(range.to),
      );
      const activeModules = modules.filter(
        (module) =>
          module.status === "active" &&
          Date.parse(module.effectiveFrom) < Date.parse(range.to),
      );
      const moduleRows = await this.moduleOperationalRows(
        projectId,
        range,
        activePages,
      );
      const moduleRowById = new Map(
        moduleRows.map((row) => [row.moduleId, row] as const),
      );
      const pageByRoute = new Map(
        activePages.map((page) => [page.normalizedRoute, page] as const),
      );
      const rowByRoute = new Map(rows.map((row) => [row.route, row] as const));
      return {
        ...this.readModelMeta(range, status),
        items: activeModules.map((module) => {
          const modulePages = activePages.filter((page) => page.moduleId === module.id);
          const configuredWeight = modulePages.reduce(
            (sum, page) => sum + page.criticalityWeight,
            0,
          );
          const usedWeight = modulePages.reduce(
            (sum, page) =>
              sum +
              ((rowByRoute.get(page.normalizedRoute)?.pageViews ?? 0) > 0
                ? page.criticalityWeight
                : 0),
            0,
          );
          return {
            ...module,
            ...(moduleRowById.get(module.id) ?? {
              pageViews: 0,
              accounts: 0,
              browsers: 0,
              sessions: 0,
              lastVisitAt: null,
            }),
            configuredPages: modulePages.length,
            usedPages: modulePages.filter(
              (page) => (rowByRoute.get(page.normalizedRoute)?.pageViews ?? 0) > 0,
            ).length,
            pageCoverage: configuredWeight > 0 ? usedWeight / configuredWeight : null,
          };
        }),
        unclassified: rows
          .filter((row) => !pageByRoute.has(row.route))
          .map((row) => ({
            route: row.route,
            pageViews: row.pageViews,
            accounts: row.accounts,
            browsers: row.browsers,
            sessions: row.sessions,
            lastVisitAt: row.lastVisitAt,
          })),
      };
    });
  }

  async operationalOverview(projectId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const [modules, pages, features, rows, sessions, operations, status, settings] =
        await Promise.all([
          this.mysql.listModules(projectId),
          this.mysql.listPageDefinitions(projectId),
          this.mysql.listFeatures(projectId),
          this.pageOperationalRows(projectId, range),
          this.sessionOperationalRows(projectId, range),
          this.operationInstances(projectId, range),
          this.projectDataStatus(projectId),
          this.mysql.getOperationalSettings(projectId, new Date(range.to)),
        ]);
      const activePages = pages.filter(
        (page) =>
          page.status === "active" &&
          Date.parse(page.effectiveFrom) < Date.parse(range.to),
      );
      const pageByRoute = new Map(
        activePages.map((page) => [page.normalizedRoute, page] as const),
      );
      const rowByRoute = new Map(rows.map((row) => [row.route, row] as const));
      const activeModules = modules.filter(
        (module) =>
          module.status === "active" &&
          Date.parse(module.effectiveFrom) < Date.parse(range.to),
      );
      const activeFeatures = features.filter(
        (feature) =>
          feature.status === "active" &&
          Date.parse(feature.configurationEffectiveFrom) < Date.parse(range.to),
      );
      const [validUsage, moduleRows] = await Promise.all([
        this.validUsageFacts(projectId, range, activePages, activeFeatures),
        this.moduleOperationalRows(projectId, range, activePages),
      ]);
      const moduleRowById = new Map(
        moduleRows.map((row) => [row.moduleId, row] as const),
      );
      const taskSummary = this.taskSummary(activeFeatures, operations, range);
      const sessionSummary = this.sessionSummary(sessions, pageByRoute);
      const corePages = activePages.filter((page) => page.isCore);
      const keyTasks = activeFeatures.filter((feature) => feature.isKeyTask);
      const usedCorePages = corePages.filter(
        (page) => (rowByRoute.get(page.normalizedRoute)?.pageViews ?? 0) > 0,
      );
      const usedKeyTasks = new Set(
        operations
          .filter((operation) => operation.terminalName === "feature_succeeded")
          .map((operation) => operation.featureKey),
      );
      const expectedDates = this.expectedLocalDates(
        range,
        settings?.expectedActiveWeekdays ?? [],
      );
      const observedDates = new Set(validUsage.activeDates);
      const activeExpectedDays = expectedDates.filter((date) =>
        observedDates.has(date),
      ).length;
      return {
        ...this.readModelMeta(range, status),
        settingsVersion: settings?.version ?? null,
        summary: {
          pageViews: rows.reduce((sum, row) => sum + row.pageViews, 0),
          activeAccounts: validUsage.activeAccounts,
          crossDayAccounts: validUsage.crossDayAccounts,
          activeDates: validUsage.activeDates.length,
          expectedActiveDays: expectedDates.length,
          activeExpectedDays,
          activeDayCoverage:
            expectedDates.length > 0 ? activeExpectedDays / expectedDates.length : null,
          configuredModules: activeModules.length,
          configuredPages: activePages.length,
          corePages: corePages.length,
          usedCorePages: usedCorePages.length,
          keyTasks: keyTasks.length,
          usedKeyTasks: keyTasks.filter((task) => usedKeyTasks.has(task.featureKey))
            .length,
          unclassifiedRoutes: rows.filter((row) => !pageByRoute.has(row.route)).length,
        },
        modules: activeModules.map((module) => {
          const modulePages = activePages.filter((page) => page.moduleId === module.id);
          return {
            id: module.id,
            moduleKey: module.moduleKey,
            name: module.name,
            ...(moduleRowById.get(module.id) ?? {
              pageViews: 0,
              accounts: 0,
              browsers: 0,
              sessions: 0,
              lastVisitAt: null,
            }),
            usedPages: modulePages.filter(
              (page) => (rowByRoute.get(page.normalizedRoute)?.pageViews ?? 0) > 0,
            ).length,
            configuredPages: modulePages.length,
          };
        }),
        corePages: corePages.map((page) => ({
          ...page,
          metrics: rowByRoute.get(page.normalizedRoute) ?? null,
        })),
        keyTasks: keyTasks.map((feature) => ({
          ...feature,
          ...taskSummary.byFeature.get(feature.featureKey),
        })),
        depth: sessionSummary,
        taskSummary: taskSummary.overall,
        unclassified: rows
          .filter((row) => !pageByRoute.has(row.route))
          .map((row) => ({
            route: row.route,
            pageViews: row.pageViews,
            accounts: row.accounts,
            browsers: row.browsers,
            sessions: row.sessions,
            lastVisitAt: row.lastVisitAt,
          })),
      };
    });
  }

  async pageDetail(projectId: string, route: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const [modules, pages, features, rows, sessions, trend, status] =
        await Promise.all([
          this.mysql.listModules(projectId),
          this.mysql.listPageDefinitions(projectId),
          this.mysql.listFeatures(projectId),
          this.pageOperationalRows(projectId, range),
          this.sessionOperationalRows(projectId, range),
          this.pageOperationalTrend(projectId, route, range),
          this.projectDataStatus(projectId),
        ]);
      const page =
        pages.find(
          (item) =>
            item.normalizedRoute === route &&
            item.status === "active" &&
            Date.parse(item.effectiveFrom) < Date.parse(range.to),
        ) ?? null;
      const activePageByRoute = new Map(
        pages
          .filter((definition) => definition.status === "active")
          .map((definition) => [definition.normalizedRoute, definition] as const),
      );
      const module = page
        ? (modules.find(
            (item) => item.id === page.moduleId && item.status === "active",
          ) ?? null)
        : null;
      const metrics =
        rows.find((item) => item.route === route) ??
        ({
          route,
          pageViews: 0,
          accounts: 0,
          browsers: 0,
          sessions: 0,
          lastVisitAt: null,
          durationSamples: 0,
          durationAverageMs: null,
          durationP50Ms: null,
          durationP75Ms: null,
          durationCoverage: null,
        } satisfies PageOperationalRow);
      const sessionDepths = sessions
        .filter((session) => session.routes.includes(route))
        .map((session) => session.routes.length);
      const sessionModuleBreadths = sessions
        .filter((session) => session.routes.includes(route))
        .map((session) => {
          const moduleIds = new Set(
            session.routes
              .map((sessionRoute) => activePageByRoute.get(sessionRoute)?.moduleId)
              .filter((id): id is string => Boolean(id)),
          );
          return moduleIds.size;
        })
        .filter((value) => value > 0);
      const durationTarget =
        PAGE_TEMPLATE_DURATION_TARGETS[page?.templateKey ?? "analysis_view"];
      const templateTarget = {
        direction: "target_range" as const,
        minMs: durationTarget.targetMin!,
        maxMs: durationTarget.targetMax!,
        toleranceMinMs: durationTarget.toleranceMin!,
        toleranceMaxMs: durationTarget.toleranceMax!,
      };
      return {
        ...this.readModelMeta(range, status),
        classification: page
          ? { status: "classified", page, module }
          : { status: "unclassified", page: null, module: null },
        metrics: {
          ...metrics,
          sessionDistinctPagesP50: percentile(sessionDepths, 0.5),
          sessionDistinctPagesP75: percentile(sessionDepths, 0.75),
          sessionModuleBreadthP50: percentile(sessionModuleBreadths, 0.5),
          sessionModuleBreadthP75: percentile(sessionModuleBreadths, 0.75),
        },
        templateTarget,
        depthGuidance:
          page?.templateKey === "monitoring_dashboard"
            ? "持续监测页面单页会话可能完全健康，页面深度只作描述，不因低深度扣分。"
            : page?.templateKey === "task_operation"
              ? "任务操作页面应结合任务前路径判断是否跳转过多，深度不是越高越好。"
              : "信息分析页面用目标区间观察探索范围，不能仅凭深度推断设计质量。",
        availableFrom: page?.effectiveFrom ?? null,
        trend,
        gapPolicy: "missing buckets are omitted and must not be connected as zero",
        keyTasks: page
          ? features.filter(
              (feature) =>
                feature.status === "active" &&
                feature.pageDefinitionId === page.id &&
                feature.isKeyTask,
            )
          : [],
        definitions: [
          metricDefinition("page_views"),
          metricDefinition("page_visible_duration_p50"),
          metricDefinition("page_duration_coverage"),
        ].filter((item): item is NonNullable<typeof item> => item !== null),
      };
    });
  }

  async taskDetail(projectId: string, featureId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const [features, operations, status] = await Promise.all([
        this.mysql.listFeatures(projectId),
        this.operationInstances(projectId, range),
        this.projectDataStatus(projectId),
      ]);
      const feature = features.find((item) => item.id === featureId);
      if (!feature) throw new Error("FEATURE_NOT_FOUND");
      const instances = operations.filter(
        (item) => item.featureKey === feature.featureKey,
      );
      const availableFrom = await this.operationAvailableFrom(projectId, [
        feature.featureKey,
      ]);
      const summary = this.taskSummary([feature], instances, range).overall;
      return {
        ...this.readModelMeta(range, status),
        availableFrom,
        availabilityStatus:
          availableFrom === null
            ? "none"
            : Date.parse(range.from) < Date.parse(availableFrom)
              ? "partial"
              : "full",
        feature,
        metrics: summary,
        semantics: {
          abandonment:
            "Approximation: a started instance without a terminal after the configured timeout.",
          pairing:
            "Each terminal is paired only with its SDK-generated operationInstanceId.",
        },
      };
    });
  }

  async operationalIndex(projectId: string, rangeInput: AnalyticsRange) {
    return this.measure(async () => {
      const range = validateAnalyticsRange(rangeInput);
      const [pages, features, settings, profile, status] = await Promise.all([
        this.mysql.listPageDefinitions(projectId),
        this.mysql.listFeatures(projectId),
        this.mysql.getOperationalSettings(projectId, new Date(range.to)),
        this.mysql.getActiveMetricProfile(projectId, new Date(range.to)),
        this.projectDataStatus(projectId),
      ]);
      const activePages = pages.filter(
        (page) =>
          page.status === "active" &&
          Date.parse(page.effectiveFrom) < Date.parse(range.to),
      );
      const activeFeatures = features.filter(
        (feature) =>
          feature.status === "active" &&
          Date.parse(feature.configurationEffectiveFrom) < Date.parse(range.to),
      );
      const configurationBoundaries = [
        profile?.effectiveFrom,
        settings?.effectiveFrom,
        ...activePages.map((page) => page.effectiveFrom),
        ...activeFeatures.map((feature) => feature.configurationEffectiveFrom),
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => Date.parse(value))
        .filter((value) => Number.isFinite(value));
      const evaluationRange = {
        ...range,
        from: new Date(
          Math.max(Date.parse(range.from), ...configurationBoundaries),
        ).toISOString(),
      };
      const [pageRows, sessions, operations, validUsage, availableFrom] =
        await Promise.all([
          this.pageOperationalRows(projectId, evaluationRange),
          this.sessionOperationalRows(projectId, evaluationRange),
          this.operationInstances(projectId, evaluationRange),
          this.validUsageFacts(projectId, evaluationRange, activePages, activeFeatures),
          this.operationAvailableFrom(
            projectId,
            activeFeatures
              .filter(
                (feature) => feature.isKeyTask && feature.operationLifecycleEnabled,
              )
              .map((feature) => feature.featureKey),
          ),
        ]);
      const pageByRoute = new Map(
        activePages.map((page) => [page.normalizedRoute, page] as const),
      );
      const rowByRoute = new Map(pageRows.map((row) => [row.route, row] as const));
      const sessionSummary = this.sessionSummary(sessions, pageByRoute);
      const taskSummary = this.taskSummary(
        activeFeatures,
        operations,
        evaluationRange,
      ).overall;
      const corePages = activePages.filter((page) => page.isCore);
      const totalCoreWeight = corePages.reduce(
        (sum, page) => sum + page.criticalityWeight,
        0,
      );
      const usedCoreWeight = corePages.reduce(
        (sum, page) =>
          sum +
          ((rowByRoute.get(page.normalizedRoute)?.pageViews ?? 0) > 0
            ? page.criticalityWeight
            : 0),
        0,
      );
      const expectedDates = this.expectedLocalDates(
        evaluationRange,
        settings?.expectedActiveWeekdays ?? [],
      );
      const observedDates = new Set(validUsage.activeDates);
      const activeExpectedDates = expectedDates.filter((date) =>
        observedDates.has(date),
      ).length;
      const durationPages = corePages
        .map((page) => ({
          page,
          row: rowByRoute.get(page.normalizedRoute),
          fit:
            rowByRoute.get(page.normalizedRoute)?.durationP50Ms === null ||
            rowByRoute.get(page.normalizedRoute)?.durationP50Ms === undefined
              ? null
              : normalizeMetricScore(
                  rowByRoute.get(page.normalizedRoute)!.durationP50Ms!,
                  "target_range",
                  PAGE_TEMPLATE_DURATION_TARGETS[page.templateKey],
                ),
        }))
        .filter(
          (
            item,
          ): item is {
            page: PageDefinitionRecord;
            row: PageOperationalRow;
            fit: number;
          } =>
            Boolean(
              item.row &&
              item.row.durationP50Ms !== null &&
              item.fit !== null &&
              item.row.durationSamples >= 5 &&
              (item.row.durationCoverage ?? 0) >= 0.5,
            ),
        );
      const weightedDurationFit =
        durationPages.length > 0
          ? durationPages.reduce(
              (sum, item) => sum + (item.fit! / 100) * item.page.criticalityWeight,
              0,
            ) /
            durationPages.reduce((sum, item) => sum + item.page.criticalityWeight, 0)
          : null;
      const results: MetricResult[] = [
        metricResult({
          metricKey: "active_account_target_attainment",
          value:
            settings?.targetAccounts && settings.targetAccounts > 0
              ? validUsage.activeAccounts / settings.targetAccounts
              : null,
          sampleSize: validUsage.activeAccounts,
          status:
            settings?.targetAccounts && settings.targetAccounts > 0
              ? "available"
              : "missing_target",
          reason:
            settings?.targetAccounts && settings.targetAccounts > 0
              ? null
              : "TARGET_ACCOUNTS_NOT_CONFIGURED",
          inputs: [{ metricKey: "active_accounts", value: validUsage.activeAccounts }],
        }),
        metricResult({
          metricKey: "core_page_coverage",
          value: totalCoreWeight > 0 ? usedCoreWeight / totalCoreWeight : null,
          sampleSize: corePages.length,
          reason: totalCoreWeight > 0 ? null : "CORE_PAGES_NOT_CONFIGURED",
        }),
        metricResult({
          metricKey: "active_day_coverage",
          value:
            expectedDates.length > 0
              ? activeExpectedDates / expectedDates.length
              : null,
          sampleSize: expectedDates.length,
          status:
            settings &&
            settings.expectedActiveWeekdays.length &&
            expectedDates.length > 0
              ? "available"
              : settings && settings.expectedActiveWeekdays.length
                ? "metric_not_available"
                : "missing_target",
          reason:
            !settings || !settings.expectedActiveWeekdays.length
              ? "EXPECTED_ACTIVE_WEEKDAYS_NOT_CONFIGURED"
              : expectedDates.length === 0
                ? "NO_EXPECTED_DATES_IN_RANGE"
                : null,
        }),
        metricResult({
          metricKey: "cross_day_continuity",
          value:
            validUsage.activeAccounts > 0
              ? validUsage.crossDayAccounts / validUsage.activeAccounts
              : null,
          sampleSize: validUsage.activeAccounts,
          reason:
            validUsage.activeAccounts > 0 ? null : "NO_IDENTIFIED_ACTIVE_ACCOUNTS",
        }),
        metricResult({
          metricKey: "session_distinct_pages_fit",
          value: sessionSummary.distinctPagesP50,
          sampleSize: sessionSummary.sampleSize,
          reason: sessionSummary.distinctPagesP50 === null ? "NO_PAGE_SESSIONS" : null,
        }),
        metricResult({
          metricKey: "session_module_breadth_fit",
          value: sessionSummary.moduleBreadthP50,
          sampleSize: sessionSummary.classifiedSampleSize,
          reason:
            sessionSummary.moduleBreadthP50 === null
              ? "NO_CLASSIFIED_PAGE_SESSIONS"
              : null,
        }),
        metricResult({
          metricKey: "key_task_completion_rate",
          value: taskSummary.completionRate,
          sampleSize: taskSummary.started,
          availableFrom,
          reason:
            taskSummary.completionRate === null ? "NO_V2_KEY_TASK_INSTANCES" : null,
        }),
        metricResult({
          metricKey: "task_adverse_outcome_rate",
          value: taskSummary.adverseOutcomeRate,
          sampleSize: taskSummary.started,
          availableFrom,
          reason:
            taskSummary.adverseOutcomeRate === null ? "NO_V2_KEY_TASK_INSTANCES" : null,
        }),
        metricResult({
          metricKey: "key_task_duration_p50",
          value: taskSummary.successDurationP50Ms,
          sampleSize: taskSummary.succeeded,
          availableFrom,
          reason:
            taskSummary.successDurationP50Ms === null
              ? "NO_SUCCESSFUL_V2_KEY_TASK_INSTANCES"
              : null,
        }),
        metricResult({
          metricKey: "page_visible_duration_fit",
          value: weightedDurationFit,
          sampleSize: durationPages.reduce(
            (sum, item) => sum + item.row.durationSamples,
            0,
          ),
          reason:
            weightedDurationFit === null
              ? "NO_REPRESENTATIVE_CORE_PAGE_DURATION"
              : null,
        }),
      ];
      const evaluatedStatus = evaluateDataStatus(status);
      const index = profile
        ? calculateOperationalIndex({
            results,
            profileItems: profile.items,
            dataState: evaluatedStatus.state,
          })
        : {
            value: null,
            status: "unavailable" as const,
            reasons: [
              "METRIC_PROFILE_NOT_CONFIGURED",
              ...(evaluatedStatus.state === "healthy"
                ? []
                : [`DATA_${evaluatedStatus.state.toUpperCase()}`]),
            ],
            eligibleDimensions: 0,
            weightCoverage: 0,
            dimensions: [],
            definitionVersion: metricDefinition("project_operational_index")!
              .definitionVersion,
          };
      return {
        ...this.readModelMeta(range, status),
        evaluationRange,
        configurationAvailabilityStatus:
          evaluationRange.from === range.from ? "full" : "partial",
        profile: profile
          ? {
              id: profile.id,
              profileKey: profile.profileKey,
              name: profile.name,
              version: profile.version,
              effectiveFrom: profile.effectiveFrom,
            }
          : null,
        settings,
        availableFrom,
        availabilityStatus:
          availableFrom === null
            ? "none"
            : Date.parse(range.from) < Date.parse(availableFrom)
              ? "partial"
              : "full",
        rawMetrics: results,
        index,
        configurationGaps: [
          ...(settings ? [] : ["OPERATIONAL_SETTINGS_NOT_CONFIGURED"]),
          ...(profile ? [] : ["METRIC_PROFILE_NOT_CONFIGURED"]),
          ...(corePages.length ? [] : ["CORE_PAGES_NOT_CONFIGURED"]),
          ...(activeFeatures.some((feature) => feature.isKeyTask)
            ? []
            : ["KEY_TASKS_NOT_CONFIGURED"]),
        ],
      };
    });
  }

  private async projectDataStatus(projectId: string) {
    return this.mysql.getDataStatus(projectId);
  }

  private readModelMeta(
    range: AnalyticsRange,
    status: Awaited<ReturnType<MySqlStore["getDataStatus"]>>,
  ) {
    const evaluated = evaluateDataStatus(status);
    return {
      range,
      dataStatus: evaluated,
      updatedAt: status.lastQueryableAt,
      definitionVersion: metricDefinition("project_operational_index")!
        .definitionVersion,
    };
  }

  private async pageOperationalRows(
    projectId: string,
    range: AnalyticsRange,
  ): Promise<PageOperationalRow[]> {
    const parameters = { projectId, from: range.from, to: range.to };
    const [basicResponse, durationResponse] = await Promise.all([
      this.client.query({
        query: `
          SELECT
            route,
            count() AS page_views,
            uniqExactIf(account_id, account_id IS NOT NULL) AS accounts,
            uniqExact(visitor_id) AS browsers,
            uniqExact(session_id) AS sessions,
            max(event_time) AS last_visit_at
          FROM (${deduplicatedEventsWhere("AND event_name = 'page_view'")})
          GROUP BY route
          ORDER BY page_views DESC, route
        `,
        query_params: parameters,
        format: "JSONEachRow",
      }),
      this.client.query({
        query: `
          SELECT
            route,
            count() AS duration_samples,
            avg(page_duration_ms) AS duration_average_ms,
            quantileExact(0.5)(page_duration_ms) AS duration_p50_ms,
            quantileExact(0.75)(page_duration_ms) AS duration_p75_ms
          FROM (
            SELECT
              route,
              page_view_id,
              sum(visible_duration_ms) AS page_duration_ms
            FROM (${deduplicatedEventsWhere(
              "AND event_name = 'page_leave' AND visible_duration_ms IS NOT NULL",
            )})
            GROUP BY route, page_view_id
          )
          GROUP BY route
        `,
        query_params: parameters,
        format: "JSONEachRow",
      }),
    ]);
    const basicRows = await basicResponse.json<Record<string, unknown>>();
    const durations = new Map(
      (await durationResponse.json<Record<string, unknown>>()).map(
        (row) => [String(row.route), row] as const,
      ),
    );
    return basicRows.map((row) => {
      const duration = durations.get(String(row.route));
      const pageViews = numeric(row.page_views);
      const durationSamples = numeric(duration?.duration_samples);
      return {
        route: String(row.route),
        pageViews,
        accounts: numeric(row.accounts),
        browsers: numeric(row.browsers),
        sessions: numeric(row.sessions),
        lastVisitAt: row.last_visit_at ? String(row.last_visit_at) : null,
        durationSamples,
        durationAverageMs: nullableNumeric(duration?.duration_average_ms),
        durationP50Ms: nullableNumeric(duration?.duration_p50_ms),
        durationP75Ms: nullableNumeric(duration?.duration_p75_ms),
        durationCoverage:
          pageViews > 0 ? Math.min(1, durationSamples / pageViews) : null,
      };
    });
  }

  private async moduleOperationalRows(
    projectId: string,
    range: AnalyticsRange,
    pages: PageDefinitionRecord[],
  ): Promise<ModuleOperationalRow[]> {
    if (!pages.length) return [];
    const routes = pages.map((page) => page.normalizedRoute);
    const moduleIds = pages.map((page) => page.moduleId);
    const response = await this.client.query({
      query: `
        SELECT
          arrayElement(
            {moduleIds:Array(String)},
            indexOf({routes:Array(String)}, route)
          ) AS module_id,
          count() AS page_views,
          uniqExactIf(account_id, account_id IS NOT NULL) AS accounts,
          uniqExact(visitor_id) AS browsers,
          uniqExact(session_id) AS sessions,
          max(event_time) AS last_visit_at
        FROM (${deduplicatedEventsWhere(
          "AND event_name = 'page_view' AND has({routes:Array(String)}, route)",
        )})
        GROUP BY module_id
        ORDER BY module_id
      `,
      query_params: {
        projectId,
        from: range.from,
        to: range.to,
        routes,
        moduleIds,
      },
      format: "JSONEachRow",
    });
    const rows = await response.json<Record<string, unknown>>();
    return rows.map((row) => ({
      moduleId: String(row.module_id),
      pageViews: numeric(row.page_views),
      accounts: numeric(row.accounts),
      browsers: numeric(row.browsers),
      sessions: numeric(row.sessions),
      lastVisitAt: row.last_visit_at ? String(row.last_visit_at) : null,
    }));
  }

  private async pageOperationalTrend(
    projectId: string,
    route: string,
    range: AnalyticsRange,
  ): Promise<Array<Record<string, number | string | null>>> {
    const bucket = range.granularity === "hour" ? "toStartOfHour" : "toStartOfDay";
    const response = await this.client.query({
      query: `
        SELECT
          ${bucket}(event_time, {timezone:String}) AS bucket,
          count() AS pv,
          uniqExact(visitor_id) AS visitors
        FROM (${deduplicatedEventsWhere(
          "AND event_name = 'page_view' AND route = {route:String}",
        )})
        GROUP BY bucket
        ORDER BY bucket
      `,
      query_params: {
        projectId,
        from: range.from,
        to: range.to,
        timezone: range.timezone,
        route,
      },
      format: "JSONEachRow",
    });
    const rows = await response.json<Record<string, unknown>>();
    return rows.map(numberRow);
  }

  private async sessionOperationalRows(
    projectId: string,
    range: AnalyticsRange,
  ): Promise<Array<{ sessionId: string; pageViews: number; routes: string[] }>> {
    const response = await this.client.query({
      query: `
        SELECT
          session_id,
          count() AS page_views,
          groupUniqArray(route) AS routes
        FROM (${deduplicatedEventsWhere("AND event_name = 'page_view'")})
        GROUP BY session_id
      `,
      query_params: { projectId, from: range.from, to: range.to },
      format: "JSONEachRow",
    });
    const rows = await response.json<Record<string, unknown>>();
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      pageViews: numeric(row.page_views),
      routes: Array.isArray(row.routes) ? row.routes.map(String) : [],
    }));
  }

  private sessionSummary(
    sessions: Array<{ sessionId: string; pageViews: number; routes: string[] }>,
    pageByRoute: ReadonlyMap<string, PageDefinitionRecord>,
  ) {
    const visits = sessions.map((session) => session.pageViews);
    const distinctPages = sessions.map((session) => session.routes.length);
    const moduleBreadths = sessions
      .map((session) => {
        const modules = new Set(
          session.routes
            .map((route) => pageByRoute.get(route)?.moduleId)
            .filter((id): id is string => Boolean(id)),
        );
        return modules.size;
      })
      .filter((value) => value > 0);
    return {
      sampleSize: sessions.length,
      classifiedSampleSize: moduleBreadths.length,
      pageViewsP50: percentile(visits, 0.5),
      pageViewsP75: percentile(visits, 0.75),
      distinctPagesP50: percentile(distinctPages, 0.5),
      distinctPagesP75: percentile(distinctPages, 0.75),
      moduleBreadthP50: percentile(moduleBreadths, 0.5),
      moduleBreadthP75: percentile(moduleBreadths, 0.75),
    };
  }

  private async operationInstances(
    projectId: string,
    range: AnalyticsRange,
  ): Promise<OperationInstanceRow[]> {
    const response = await this.client.query({
      query: `
        SELECT
          operation_instance_id,
          any(feature_key) AS feature_key,
          minIf(
            toUnixTimestamp64Milli(event_time),
            event_name = 'feature_started'
          ) AS started_at_ms,
          minIf(
            toUnixTimestamp64Milli(event_time),
            event_name IN ('feature_succeeded', 'feature_failed', 'feature_canceled')
          ) AS terminal_at_ms,
          argMinIf(
            event_name,
            event_time,
            event_name IN ('feature_succeeded', 'feature_failed', 'feature_canceled')
          ) AS terminal_name
        FROM (${deduplicatedEventsWhere(
          "AND schema_version = 3 AND operation_instance_id IS NOT NULL AND feature_key IS NOT NULL",
        )})
        GROUP BY operation_instance_id
        HAVING started_at_ms > 0
      `,
      query_params: { projectId, from: range.from, to: range.to },
      format: "JSONEachRow",
    });
    const rows = await response.json<Record<string, unknown>>();
    return rows.map((row) => {
      const terminalAtMs = numeric(row.terminal_at_ms);
      const terminalName = String(row.terminal_name ?? "");
      return {
        operationInstanceId: String(row.operation_instance_id),
        featureKey: String(row.feature_key),
        startedAtMs: numeric(row.started_at_ms),
        terminalAtMs: terminalAtMs > 0 ? terminalAtMs : null,
        terminalName: [
          "feature_succeeded",
          "feature_failed",
          "feature_canceled",
        ].includes(terminalName)
          ? (terminalName as OperationInstanceRow["terminalName"])
          : null,
      };
    });
  }

  private async operationAvailableFrom(
    projectId: string,
    featureKeys: string[],
  ): Promise<string | null> {
    if (!featureKeys.length) return null;
    const response = await this.client.query({
      query: `
        SELECT
          toUnixTimestamp64Milli(minOrNull(event_time)) AS available_from_ms
        FROM raw_events
        WHERE project_id = {projectId:UUID}
          AND schema_version = 3
          AND event_name = 'feature_started'
          AND operation_instance_id IS NOT NULL
          AND feature_key IN {featureKeys:Array(String)}
      `,
      query_params: { projectId, featureKeys },
      format: "JSONEachRow",
    });
    const rows = await response.json<Record<string, unknown>>();
    const availableFromMs = nullableNumeric(rows[0]?.available_from_ms);
    return availableFromMs === null ? null : new Date(availableFromMs).toISOString();
  }

  private taskSummary(
    features: FeatureRecord[],
    operations: OperationInstanceRow[],
    range: AnalyticsRange,
  ) {
    const featureByKey = new Map(
      features
        .filter(
          (feature) =>
            feature.status === "active" &&
            feature.isKeyTask &&
            feature.operationLifecycleEnabled,
        )
        .map((feature) => [feature.featureKey, feature] as const),
    );
    const cutoffMs = Math.min(Date.now(), Date.parse(range.to));
    const states = operations
      .map((operation) => {
        const feature = featureByKey.get(operation.featureKey);
        if (
          !feature ||
          operation.startedAtMs < Date.parse(feature.configurationEffectiveFrom)
        ) {
          return null;
        }
        const abandoned =
          operation.terminalName === null &&
          cutoffMs - operation.startedAtMs >= feature.taskTimeoutSeconds * 1_000;
        return {
          ...operation,
          feature,
          abandoned,
          durationMs:
            operation.terminalName === "feature_succeeded" &&
            operation.terminalAtMs !== null
              ? Math.max(0, operation.terminalAtMs - operation.startedAtMs)
              : null,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const byFeature = new Map<string, Record<string, number | null>>();
    for (const feature of featureByKey.values()) {
      const items = states.filter(
        (item) => item.feature.featureKey === feature.featureKey,
      );
      const succeeded = items.filter(
        (item) => item.terminalName === "feature_succeeded",
      );
      const adverse = items.filter(
        (item) =>
          item.terminalName === "feature_failed" ||
          item.terminalName === "feature_canceled" ||
          item.abandoned,
      );
      byFeature.set(feature.featureKey, {
        started: items.length,
        succeeded: succeeded.length,
        failed: items.filter((item) => item.terminalName === "feature_failed").length,
        canceled: items.filter((item) => item.terminalName === "feature_canceled")
          .length,
        abandoned: items.filter((item) => item.abandoned).length,
        completionRate: items.length > 0 ? succeeded.length / items.length : null,
        adverseOutcomeRate: items.length > 0 ? adverse.length / items.length : null,
        successDurationP50Ms: percentile(
          succeeded
            .map((item) => item.durationMs)
            .filter((value): value is number => value !== null),
          0.5,
        ),
        successDurationP75Ms: percentile(
          succeeded
            .map((item) => item.durationMs)
            .filter((value): value is number => value !== null),
          0.75,
        ),
      });
    }
    const startedWeight = states.reduce(
      (sum, item) => sum + item.feature.taskWeight,
      0,
    );
    const succeededStates = states.filter(
      (item) => item.terminalName === "feature_succeeded",
    );
    const adverseStates = states.filter(
      (item) =>
        item.terminalName === "feature_failed" ||
        item.terminalName === "feature_canceled" ||
        item.abandoned,
    );
    const durationSamples = succeededStates
      .filter((item) => item.durationMs !== null)
      .map((item) => ({
        value: item.durationMs!,
        weight: item.feature.taskWeight,
      }));
    return {
      byFeature,
      overall: {
        started: states.length,
        succeeded: succeededStates.length,
        failed: states.filter((item) => item.terminalName === "feature_failed").length,
        canceled: states.filter((item) => item.terminalName === "feature_canceled")
          .length,
        abandoned: states.filter((item) => item.abandoned).length,
        completionRate:
          startedWeight > 0
            ? succeededStates.reduce((sum, item) => sum + item.feature.taskWeight, 0) /
              startedWeight
            : null,
        adverseOutcomeRate:
          startedWeight > 0
            ? adverseStates.reduce((sum, item) => sum + item.feature.taskWeight, 0) /
              startedWeight
            : null,
        successDurationP50Ms: weightedPercentile(durationSamples, 0.5),
        successDurationP75Ms: weightedPercentile(durationSamples, 0.75),
      },
    };
  }

  private async validUsageFacts(
    projectId: string,
    range: AnalyticsRange,
    pages: PageDefinitionRecord[],
    features: FeatureRecord[],
  ) {
    const routes = pages.map((page) => page.normalizedRoute);
    const featureKeys = features.map((feature) => feature.featureKey);
    if (!routes.length && !featureKeys.length) {
      return { activeAccounts: 0, crossDayAccounts: 0, activeDates: [] as string[] };
    }
    const validCondition = `
      (
        (event_name = 'page_view' AND route IN {routes:Array(String)})
        OR
        (event_name = 'feature_succeeded' AND feature_key IN {featureKeys:Array(String)})
      )
      AND position(properties_json, '"source":"onboarding"') = 0
      AND position(properties_json, '"demo":true') = 0
    `;
    const queryParams = {
      projectId,
      from: range.from,
      to: range.to,
      timezone: range.timezone,
      routes,
      featureKeys,
    };
    const [summaryResponse, repeatResponse, datesResponse] = await Promise.all([
      this.client.query({
        query: `
          SELECT uniqExactIf(account_id, account_id IS NOT NULL) AS active_accounts
          FROM (${deduplicatedEventsWhere(`AND ${validCondition}`)})
        `,
        query_params: queryParams,
        format: "JSONEachRow",
      }),
      this.client.query({
        query: `
          SELECT countIf(active_days >= 2) AS cross_day_accounts
          FROM (
            SELECT
              account_id,
              uniqExact(toDate(event_time, {timezone:String})) AS active_days
            FROM (${deduplicatedEventsWhere(
              `AND account_id IS NOT NULL AND ${validCondition}`,
            )})
            GROUP BY account_id
          )
        `,
        query_params: queryParams,
        format: "JSONEachRow",
      }),
      this.client.query({
        query: `
          SELECT toString(toDate(event_time, {timezone:String})) AS active_date
          FROM (${deduplicatedEventsWhere(`AND ${validCondition}`)})
          GROUP BY active_date
          ORDER BY active_date
        `,
        query_params: queryParams,
        format: "JSONEachRow",
      }),
    ]);
    const summary = await summaryResponse.json<Record<string, unknown>>();
    const repeat = await repeatResponse.json<Record<string, unknown>>();
    const dates = await datesResponse.json<Record<string, unknown>>();
    return {
      activeAccounts: numeric(summary[0]?.active_accounts),
      crossDayAccounts: numeric(repeat[0]?.cross_day_accounts),
      activeDates: dates.map((row) => String(row.active_date)),
    };
  }

  private expectedLocalDates(
    range: AnalyticsRange,
    weekdays: readonly number[],
  ): string[] {
    if (!weekdays.length) return [];
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: range.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const dates = new Set<string>();
    const start = Date.parse(range.from);
    const end = Date.parse(range.to);
    for (let timestamp = start; timestamp < end; timestamp += 12 * 60 * 60 * 1_000) {
      dates.add(formatter.format(new Date(timestamp)));
    }
    if (end > start) dates.add(formatter.format(new Date(end - 1)));
    return [...dates]
      .filter((date) => {
        const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay() || 7;
        return weekdays.includes(weekday);
      })
      .sort();
  }

  private async sdkVersionDistribution(
    projectId: string,
    range: AnalyticsRange,
  ): Promise<Array<Record<string, number | string | null>>> {
    const response = await this.client.query({
      query: `
        SELECT
          sdk_name,
          sdk_version,
          count() AS events,
          max(received_at) AS last_received_at
        FROM (${deduplicatedEventsWhere()})
        GROUP BY sdk_name, sdk_version
        ORDER BY events DESC, sdk_name, sdk_version
      `,
      query_params: { projectId, from: range.from, to: range.to },
      format: "JSONEachRow",
    });
    return (await response.json<Record<string, unknown>>()).map(numberRow);
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
