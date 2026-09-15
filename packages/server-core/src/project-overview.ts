import {
  resolveProjectCalendar,
  ProjectRangeError,
  type ProjectRangeQuery,
  type CalendarBucket,
} from "@frontend-insight/event-contract/project-range";
import type { RowDataPacket } from "mysql2/promise";
import type { MySqlStore } from "./mysql-store.js";
import type { ScoreManagementService } from "./score-management.js";
import type { AnalyticsStore } from "./analytics.js";
import { buildFixedAlerts } from "./observability.js";
import type { ObservabilityStore } from "./observability.js";
import type {
  OverviewFactStore,
  OverviewFacts,
  FactWindow,
  PageRevisionWindow,
} from "./overview-facts.js";
import { OBSERVED_PV_DEFINITION } from "./overview-facts.js";
import {
  evaluateFormula,
  collectFormulaDependencies,
  type FormulaInputValue,
} from "./formula.js";
import { MetricLibraryError, type MetricLibraryDefinition } from "./metric-library.js";
import { evaluateDataStatus } from "./status.js";
import { projectCardState, type ProjectCardScore } from "./project-summary.js";
import { scoreColor } from "./score-evaluation.js";
import { scoreDigest } from "./score-storage.js";

const iso = (v: unknown): string | null =>
  v ? new Date(v as string).toISOString() : null;
export interface OverviewQuery extends ProjectRangeQuery {
  metrics?: string[] | undefined;
}
export interface OverviewPeriod {
  versionId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}
/** Split calendar buckets at actual activation boundaries. Historical segments are
 * identified by their actual version and never evaluated with the active snapshot. */
export function segmentOverviewBuckets(
  buckets: CalendarBucket[],
  periods: OverviewPeriod[],
) {
  return buckets.flatMap((bucket) => {
    const cuts = [
      ...new Set([
        bucket.from,
        bucket.to,
        ...periods.flatMap((p) =>
          [p.effectiveFrom, p.effectiveTo].filter(
            (v): v is string => !!v && v > bucket.from && v < bucket.to,
          ),
        ),
      ]),
    ].sort();
    return cuts.slice(0, -1).map((from, i) => {
      const period = periods.find(
        (p) => p.effectiveFrom <= from && (!p.effectiveTo || p.effectiveTo > from),
      );
      return {
        ...bucket,
        from,
        to: cuts[i + 1]!,
        partial: bucket.partial || cuts.length > 2,
        versionId: period?.versionId ?? null,
        segment: period?.effectiveFrom ?? null,
      };
    });
  });
}
export function evaluateOverviewMetrics(
  definitions: readonly MetricLibraryDefinition[],
  keys: readonly string[],
  fact: FactWindow,
  granularity: string,
  boundaryReason: string | null,
) {
  const values: Record<string, FormulaInputValue> = {},
    rawValues: Record<string, FormulaInputValue> = {},
    visiting = new Set<string>();
  const read = (key: string): FormulaInputValue => {
    if (values[key]) return values[key];
    const d = definitions.find((d) => d.metricKey === key);
    if (!d || visiting.has(key))
      throw new MetricLibraryError("OVERVIEW_DEFINITION_INVALID", 409);
    visiting.add(key);
    if (d.formulaAst) collectFormulaDependencies(d.formulaAst).forEach(read);
    const missing = (reason: string): FormulaInputValue => ({
      value: null,
      status: "metric_not_available",
      sampleSize: null,
      reason,
    });
    let value: FormulaInputValue;
    if (!d.enabled) value = missing("METRIC_DISABLED");
    else if (!d.timeGranularities.includes(granularity as never))
      value = missing("METRIC_GRANULARITY_UNSUPPORTED");
    else if (!d.entityScopes.includes("project"))
      value = missing("PROJECT_METRIC_SCOPE_REQUIRED");
    else if (d.implementationStatus === "not_collected")
      value = missing("METRIC_NOT_COLLECTED");
    else if (d.formulaAst) value = evaluateFormula(d.formulaAst, values);
    else value = fact.inputs[key] ?? missing(d.unavailableReason ?? "METRIC_PARTIAL");
    let observed = d.formulaAst
      ? evaluateFormula(d.formulaAst, rawValues)
      : fact.raw[key];
    if (
      d.origin === "system" &&
      key === "pv" &&
      d.definitionVersion !== OBSERVED_PV_DEFINITION
    )
      observed = undefined;
    if (
      !d.enabled ||
      d.implementationStatus === "not_collected" ||
      !d.entityScopes.includes("project") ||
      !d.timeGranularities.includes(granularity as never)
    )
      observed = undefined;
    rawValues[key] = observed ?? missing("NO_QUERYABLE_ATOMIC_FACT");
    if (
      value.value !== null &&
      value.sampleSize !== null &&
      value.sampleSize < d.minimumSample
    )
      value = {
        ...value,
        value: null,
        status: "insufficient_sample",
        reason: "METRIC_MINIMUM_SAMPLE_NOT_MET",
      };
    if (boundaryReason) {
      value = {
        ...value,
        value: null,
        status: "metric_not_available",
        reason: boundaryReason,
      };
      rawValues[key] = missing(boundaryReason);
    }
    values[key] = value;
    visiting.delete(key);
    return value;
  };
  return keys.map((key) => {
    const result = read(key),
      d = definitions.find((d) => d.metricKey === key)!;
    return {
      definition: d,
      ...result,
      rawValue: rawValues[key]?.value ?? null,
      rawScope:
        "同窗口已观测、按事件时间匹配有效页面 revision 的已识别 PV；曝光完整性未验证。业务指标观察值使用同一 AST，非可信正式值。",
      dataAt: fact.lastDataAt,
      upstream: d.formulaAst ? collectFormulaDependencies(d.formulaAst) : [],
    };
  });
}
export class ProjectOverviewService {
  constructor(
    private readonly mysql: MySqlStore,
    private readonly scores: ScoreManagementService,
    private readonly analytics: AnalyticsStore,
    private readonly facts: OverviewFactStore,
    private readonly observability: ObservabilityStore,
  ) {}
  async overview(projectId: string, input: OverviewQuery) {
    const started = performance.now(),
      rawConnection = await this.mysql.pool.getConnection();
    let metadataQueries = 0;
    const connection = new Proxy(rawConnection, {
      get(target, key) {
        if (key === "query")
          return (...args: unknown[]) => {
            if (/^\s*SELECT/i.test(String(args[0]))) metadataQueries++;
            return Reflect.apply(target.query, target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let row: RowDataPacket,
      query: ReturnType<typeof resolveProjectCalendar>,
      active: Awaited<ReturnType<ScoreManagementService["readActiveBatch"]>>,
      bindingRows: RowDataPacket[],
      pages: PageRevisionWindow[];
    try {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT p.*,d.last_received_at,d.last_ingested_at,d.last_queryable_at,d.dead_letter_events FROM projects p LEFT JOIN project_data_status d ON d.project_id=p.id WHERE p.id=?",
        [projectId],
      );
      if (!rows[0]) throw new MetricLibraryError("PROJECT_NOT_FOUND", 404);
      row = rows[0];
      try {
        query = resolveProjectCalendar(input, String(row.timezone));
      } catch (e) {
        if (e instanceof ProjectRangeError) throw new MetricLibraryError(e.code, 400);
        throw e;
      }
      active = await this.scores.readActiveBatch(connection, [projectId], query);
      const [bindings] = await connection.query<RowDataPacket[]>(
        `SELECT d.library_version_id,d.metric_key,b.display_order FROM metric_display_bindings b JOIN metric_definitions d ON d.id=b.metric_definition_id JOIN metric_library_versions v ON v.id=d.library_version_id WHERE v.project_id=? AND v.status='active' AND v.library_type='operational' AND b.route_name='project-overview' AND b.surface_key='overview' ORDER BY b.display_order,d.metric_key`,
        [projectId],
      );
      bindingRows = bindings;
      const [revisions] = await connection.query<RowDataPacket[]>(
        `SELECT p.page_route,r.effective_from,r.effective_to FROM page_definitions p JOIN page_definition_revisions r ON r.page_definition_id=p.id WHERE p.project_id=? AND r.status='active' AND r.effective_from<? AND (r.effective_to IS NULL OR r.effective_to>?)`,
        [projectId, new Date(query.to), new Date(query.from)],
      );
      pages = revisions.map((r) => ({
        pageRoute: String(r.page_route),
        from: iso(r.effective_from)!,
        to: iso(r.effective_to) ?? query.to,
      }));
      if (pages.length > 10000)
        throw new MetricLibraryError("OVERVIEW_REVISION_LIMIT", 400);
      await connection.commit();
    } catch (e) {
      await connection.rollback();
      throw e;
    } finally {
      connection.release();
    }
    const operational = active.find((a) => a.libraryType === "operational"),
      quality = active.find((a) => a.libraryType === "quality");
    const keys = bindingRows
      .filter((r) => r.library_version_id === operational?.version.id)
      .map((r) => String(r.metric_key));
    if (keys.length > 24) throw new MetricLibraryError("OVERVIEW_BINDING_LIMIT", 400);
    const selected = input.metrics ?? keys.slice(0, 4);
    if (
      selected.length > 16 ||
      new Set(selected).size !== selected.length ||
      selected.some((k) => !keys.includes(k))
    )
      throw new MetricLibraryError("OVERVIEW_METRIC_SELECTION_INVALID", 400);
    const units = new Map<string, number>();
    for (const key of selected) {
      const unit =
        operational?.snapshot.definitions.find((d) => d.metricKey === key)?.unit ?? "";
      units.set(unit, (units.get(unit) ?? 0) + 1);
    }
    if ([...units.values()].some((n) => n > 4))
      throw new MetricLibraryError("OVERVIEW_UNIT_SERIES_LIMIT", 400);
    const segments = segmentOverviewBuckets(
      query.buckets,
      operational?.activationPeriods ?? [],
    );
    if (segments.length > 800)
      throw new MetricLibraryError("OVERVIEW_SEGMENT_LIMIT", 400);
    const settled = await Promise.allSettled([
      this.analytics.projectObservations(
        [{ id: projectId, appId: String(row.app_id) }],
        query,
      ),
      this.facts.read(projectId, query.env, segments, pages),
      this.observability.overviewEvidence(projectId, query),
    ]);
    const observation =
      settled[0].status === "fulfilled" ? settled[0].value.items[0] : undefined;
    const empty: FactWindow = { inputs: {}, raw: {}, events: 0, lastDataAt: null };
    const facts: OverviewFacts =
      settled[1].status === "fulfilled"
        ? settled[1].value
        : {
            window: empty,
            buckets: segments.map(() => empty),
            availableFrom: null,
            statistics: { rowsRead: 0, bytesRead: 0, elapsedSeconds: 0 },
          };
    const projectPipeline = evaluateDataStatus({
      projectId,
      lastReceivedAt: iso(row.last_received_at),
      lastIngestedAt: iso(row.last_ingested_at),
      lastQueryableAt: iso(row.last_queryable_at),
      deadLetterEvents: Number(row.dead_letter_events ?? 0),
      lastRequestId: null,
      lastSdkVersion: null,
      lastRejectionCode: null,
      acceptedEvents: 0,
      rejectedEvents: 0,
    });
    const failure =
      settled[0].status === "rejected" || settled[1].status === "rejected";
    const pipeline = {
      state: failure
        ? "broken"
        : ["broken", "delayed"].includes(projectPipeline.state)
          ? projectPipeline.state
          : observation?.retainedEvents
            ? "unknown"
            : "no_data",
      scope: ["broken", "delayed"].includes(projectPipeline.state) ? "project" : "env",
      projectState: projectPipeline.state,
      envVerified: false,
      reasons: [
        ...(failure ? ["FACT_STORE_UNAVAILABLE"] : []),
        ...(["broken", "delayed"].includes(projectPipeline.state)
          ? [projectPipeline.reason]
          : []),
        "ENV_HEALTH_NOT_VERIFIED",
      ],
    };
    for (const entry of active) {
      if (
        entry.result &&
        (entry.result.configurationSnapshot.scope !== "project" ||
          entry.result.context.scopeId !== projectId)
      ) {
        entry.result = {
          ...entry.result,
          value: null,
          status: "unavailable",
          color: "gray",
          reasons: [...entry.result.reasons, "PROJECT_SCORE_SCOPE_REQUIRED"],
          dimensions: entry.result.dimensions.map((d) => ({
            ...d,
            score: null,
            contribution: null,
          })),
          radar: [],
        };
      }
    }
    const scoreCard = (entry: typeof operational, key: string): ProjectCardScore => ({
      scoreKey: key,
      value: entry?.result?.value ?? null,
      status: entry?.result?.status ?? "unavailable",
      color: scoreColor(entry?.result?.value ?? null),
      versionId: entry?.version.id ?? null,
      version: entry?.version.version ?? null,
      reasons: entry?.result?.reasons ?? ["MISSING_CONFIGURATION"],
      context: entry?.result ? { ...entry.result.context } : { ...query, projectId },
      availableFrom: entry?.version.activatedAt ?? null,
    });
    const state = projectCardState(pipeline.state, [
      scoreCard(operational, "operational_score"),
      scoreCard(quality, "quality_score"),
    ]);
    const activeFrom = operational?.version.activatedAt ?? null;
    const boundary = (from: string) =>
      !activeFrom || Date.parse(from) < Date.parse(activeFrom)
        ? "VERSION_RANGE_BOUNDARY"
        : failure
          ? "FACT_STORE_UNAVAILABLE"
          : null;
    const definitions = operational?.snapshot.definitions ?? [];
    const cards = evaluateOverviewMetrics(
      definitions,
      keys,
      facts.window,
      query.granularity,
      boundary(query.from),
    );
    const trends = segments.map((bucket, i) => ({
      ...bucket,
      reason:
        bucket.versionId !== operational?.version.id || bucket.segment !== activeFrom
          ? "HISTORICAL_VERSION_NOT_RECALCULATED"
          : boundary(bucket.from),
      metrics: evaluateOverviewMetrics(
        definitions,
        selected,
        facts.buckets[i]!,
        query.granularity,
        bucket.versionId !== operational?.version.id || bucket.segment !== activeFrom
          ? "HISTORICAL_VERSION_NOT_RECALCULATED"
          : boundary(bucket.from),
      ).map((m) => ({
        metricKey: m.definition.metricKey,
        value: m.value,
        status: m.status,
        sampleSize: m.sampleSize,
        reason: m.reason,
        rawValue: m.rawValue,
      })),
    }));
    const unavailableReason = failure
      ? "FACT_STORE_UNAVAILABLE"
      : !observation?.retainedEvents
        ? row.last_received_at
          ? "NO_RETAINED_EVENTS_IN_ENV"
          : "FIRST_NOT_CONNECTED"
        : observation.windowEvents === 0
          ? "NO_EVENTS_IN_RANGE"
          : observation.windowPageViews === 0
            ? "NO_PAGE_VIEWS_IN_RANGE"
            : "ENV_EXPOSURE_NOT_VERIFIED";
    const result = (entry: typeof operational) => ({
      version: entry?.version ?? null,
      result: entry?.result ?? null,
      reason: entry?.result
        ? null
        : entry
          ? "SCORE_CONFIGURATION_NOT_SAVED"
          : "MISSING_CONFIGURATION",
      lowest:
        entry?.result &&
        entry.result.dimensions.filter((d) => d.score !== null).length >= 2
          ? entry.result.dimensions
              .filter((d) => d.score !== null)
              .sort((a, b) => a.score! - b.score!)[0]
          : null,
    });
    const pipelineAlerts = buildFixedAlerts({
      errors: [],
      vitals: [],
      dataState: projectPipeline.state,
      updatedAt: iso(row.last_queryable_at),
    }).map((a) => ({
      ...a,
      sample: null,
      scope: { projectId, env: null, scope: "project", from: query.from, to: query.to },
      detail: {
        lastReceivedAt: iso(row.last_received_at),
        lastIngestedAt: iso(row.last_ingested_at),
        lastQueryableAt: iso(row.last_queryable_at),
        deadLetterEvents: Number(row.dead_letter_events ?? 0),
        reason: projectPipeline.reason,
      },
    }));
    const alertEvidence =
      settled[2].status === "fulfilled"
        ? settled[2].value
        : {
            status: "unavailable",
            reason: "ALERT_FACT_STORE_UNAVAILABLE",
            items: [],
            scope: { projectId, ...query },
          };
    return {
      project: {
        id: projectId,
        name: String(row.name),
        timezone: String(row.timezone),
        retentionDays: Number(row.retention_days),
      },
      query,
      identity: scoreDigest({
        projectId,
        query,
        versions: active.map((a) => [a.version.id, a.version.activatedAt]),
        bindings: keys,
        selected,
      }),
      pipeline,
      ...state,
      data: {
        state: failure ? "broken" : observation?.windowEvents ? "partial" : "no_data",
        reason: unavailableReason,
      },
      lastDataAt: observation?.lastDataAt ?? null,
      lastDataSource:
        "ClickHouse raw_events.received_at / selected env / retained data",
      availableFrom: facts.availableFrom,
      operational: result(operational),
      quality: result(quality),
      metrics: {
        version: operational?.version ?? null,
        status: !operational
          ? "missing_active"
          : !keys.length
            ? "missing_bindings"
            : "configured",
        cards,
        selected,
        trends,
        boundaries:
          operational?.activationPeriods.map((p) => ({
            at: p.effectiveFrom,
            versionId: p.versionId,
          })) ?? [],
      },
      alerts: {
        ...alertEvidence,
        status: pipelineAlerts.length ? "alerts_observed" : alertEvidence.status,
        items: [...pipelineAlerts, ...alertEvidence.items],
        envEvaluation: alertEvidence.status,
        rules: {
          ...("rules" in alertEvidence ? alertEvidence.rules : {}),
          telemetry_delayed:
            "既有项目级规则：死信且无可查询数据为broken；接收领先可查询超过5分钟为delayed。不证明所选env健康。",
        },
      },
      diagnostics: {
        metadataQueries,
        clickHouseQueries: 4,
        elapsedMs: performance.now() - started,
        scans: facts.statistics,
        physicalRetentionDays: 90,
        coverage:
          "Long windows may predate the physical 90-day TTL; query timing is not a production capacity claim.",
      },
    };
  }
}
