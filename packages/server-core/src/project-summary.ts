import {
  CANONICAL_RANGES,
  type CanonicalEnvironment,
} from "@frontend-insight/event-contract";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { validateAnalyticsRange } from "./analytics.js";
import type { MySqlStore } from "./mysql-store.js";
import type { Principal } from "./model.js";
import { scoreColor } from "./score-evaluation.js";
import { MetricLibraryError } from "./metric-library.js";
import type { ScoreManagementService, ScoreQuery } from "./score-management.js";
import { evaluateDataStatus } from "./status.js";

export type ProjectRange = (typeof CANONICAL_RANGES)[number]["key"];
export interface ProjectSummaryQuery {
  search: string;
  page: number;
  pageSize: 12 | 24 | 48;
  env: CanonicalEnvironment;
  range: ProjectRange;
  from?: string;
  to?: string;
  locate?: string;
}
/** Ranges are explicit instants [from,to), never interpreted in a selected project's zone.
 * Every card also exposes its own local boundaries. Presets use canonical rolling days. */
export function resolveProjectRange(
  query: Pick<ProjectSummaryQuery, "range" | "from" | "to" | "env">,
  now = new Date(),
): ScoreQuery {
  const preset = CANONICAL_RANGES.find((r) => r.key === query.range);
  if (
    !preset ||
    Boolean(query.from) !== Boolean(query.to) ||
    (query.range === "custom" && !query.from)
  )
    throw new MetricLibraryError("PROJECT_RANGE_INVALID", 400);
  const to = query.to ?? now.toISOString();
  const from =
    query.from ??
    new Date(
      Date.parse(to) - ("days" in preset ? preset.days : 7) * 86400000,
    ).toISOString();
  const validated = validateAnalyticsRange({
    from,
    to,
    timezone: "UTC",
    granularity: "day",
  });
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if ("days" in preset && Math.abs(days - preset.days) > 0.000001)
    throw new MetricLibraryError("PROJECT_PRESET_RANGE_MISMATCH", 400);
  return {
    from: validated.from,
    to: validated.to,
    env: query.env,
    granularity:
      preset.granularity === "adaptive"
        ? days <= 31
          ? "day"
          : days <= 120
            ? "week"
            : "month"
        : preset.granularity,
  };
}
export interface ProjectObservation {
  projectId: string;
  retainedEvents: number;
  windowEvents: number;
  windowPageViews: number;
  lastDataAt: string | null;
}
export interface ProjectObservationBatch {
  items: ProjectObservation[];
  statistics: { rowsRead: number; bytesRead: number; elapsedSeconds: number };
}
export interface ProjectObservationReader {
  projectObservations(
    projects: { id: string; appId: string }[],
    query: ScoreQuery,
  ): Promise<ProjectObservationBatch>;
}
export type ProjectCardState =
  "normal" | "alert" | "missing_configuration" | "insufficient_data";
export interface ProjectCardScore {
  scoreKey: string;
  value: number | null;
  status: string;
  color: "green" | "yellow" | "red" | "gray";
  versionId: string | null;
  version: number | null;
  reasons: string[];
  context: Record<string, unknown>;
  availableFrom: string | null;
}
export function projectCardState(
  pipeline: string,
  scores: readonly ProjectCardScore[],
): { state: ProjectCardState; alert: boolean; reasons: string[] } {
  const reasons = scores.flatMap((s) =>
    s.reasons.map((reason) => `${s.scoreKey}:${reason}`),
  );
  const alert =
    pipeline === "broken" ||
    pipeline === "delayed" ||
    scores.some((s) => s.status === "available" && s.value !== null && s.value <= 80);
  if (pipeline === "broken" || pipeline === "delayed")
    reasons.push(`PIPELINE_${pipeline.toUpperCase()}`);
  for (const s of scores)
    if (s.status === "available" && s.value !== null && s.value <= 80)
      reasons.push(`${s.scoreKey}:SCORE_AT_OR_BELOW_80`);
  const missing = scores.some(
    (s) =>
      !s.versionId ||
      s.reasons.some((r) =>
        ["MISSING_CONFIGURATION", "SCORE_CONFIGURATION_NOT_SAVED"].includes(r),
      ),
  );
  const state = alert
    ? "alert"
    : missing
      ? "missing_configuration"
      : pipeline === "healthy" &&
          scores.every(
            (s) => s.status === "available" && s.value !== null && s.value > 80,
          )
        ? "normal"
        : "insufficient_data";
  return { state, alert, reasons: [...new Set(reasons)] };
}
export function compareProjectCards(
  a: { id: string; alert: boolean; lastDataAt: string | null },
  b: { id: string; alert: boolean; lastDataAt: string | null },
) {
  return (
    Number(b.alert) - Number(a.alert) ||
    (b.lastDataAt ? Date.parse(b.lastDataAt) : 0) -
      (a.lastDataAt ? Date.parse(a.lastDataAt) : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
const iso = (value: unknown): string | null =>
  value ? new Date(value as string).toISOString() : null;
export class ProjectSummaryService {
  constructor(
    private readonly mysql: MySqlStore,
    private readonly scores: ScoreManagementService,
    private readonly observations: ProjectObservationReader,
  ) {}
  async summary(principal: Principal, input: ProjectSummaryQuery) {
    const started = performance.now(),
      query = resolveProjectRange(input);
    const rawConnection = await this.mysql.pool.getConnection();
    let metadataQueries = 0,
      transactionStatements = 0;
    const connection = new Proxy(rawConnection, {
      get(target, key) {
        if (key === "query")
          return (...args: unknown[]) => {
            if (typeof args[0] === "string" && /^SELECT/i.test(args[0].trim()))
              metadataQueries++;
            else transactionStatements++;
            return Reflect.apply(target.query, target, args);
          };
        if (key === "beginTransaction" || key === "commit")
          return () => {
            transactionStatements++;
            return target[key]();
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PoolConnection;
    let rows: RowDataPacket[],
      active: Awaited<ReturnType<ScoreManagementService["readActiveBatch"]>>;
    try {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.beginTransaction();
      // Authorization and literal substring matching happen BEFORE any metadata/fact aggregation.
      const admin = principal.globalRole === "admin";
      const [candidates] = await connection.query<RowDataPacket[]>(
        `SELECT p.id,p.app_id,p.name,p.timezone,p.status,${admin ? "'admin'" : "pm.role"} AS role,d.last_received_at,d.last_ingested_at,d.last_queryable_at,d.dead_letter_events FROM projects p ${admin ? "" : "JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?"} LEFT JOIN project_data_status d ON d.project_id=p.id WHERE ${admin ? "1=1" : "p.status='active'"} AND LOCATE(?,p.name)>0 ORDER BY p.id`,
        admin ? [input.search] : [principal.userId, input.search],
      );
      rows = candidates;
      active = await this.scores.readActiveBatch(
        connection,
        rows.map((r) => String(r.id)),
        query,
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    let facts: ProjectObservationBatch = {
        items: [],
        statistics: { rowsRead: 0, bytesRead: 0, elapsedSeconds: 0 },
      },
      factFailure = false;
    if (rows.length)
      try {
        facts = await this.observations.projectObservations(
          rows.map((r) => ({ id: String(r.id), appId: String(r.app_id) })),
          query,
        );
      } catch {
        factFailure = true;
      }
    const byProject = new Map(facts.items.map((f) => [f.projectId, f]));
    const items = rows
      .map((row) => {
        const id = String(row.id),
          timezone = String(row.timezone),
          observed = byProject.get(id);
        const projectPipeline = evaluateDataStatus({
          projectId: id,
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
        // Current MySQL health is PROJECT scoped. Never relabel it as verified env health.
        const state = factFailure
          ? "broken"
          : ["broken", "delayed"].includes(projectPipeline.state)
            ? projectPipeline.state
            : !observed?.retainedEvents
              ? "no_data"
              : "unknown";
        const dataState = factFailure
          ? "broken"
          : !observed?.retainedEvents
            ? "no_data"
            : observed.windowEvents === 0
              ? "no_data"
              : "partial";
        const dataReason = factFailure
          ? "FACT_STORE_UNAVAILABLE"
          : !observed?.retainedEvents
            ? row.last_received_at
              ? "NO_RETAINED_EVENTS_IN_ENV"
              : "FIRST_NOT_CONNECTED"
            : observed.windowEvents === 0
              ? "NO_EVENTS_IN_RANGE"
              : observed.windowPageViews === 0
                ? "NO_PAGE_VIEWS_IN_RANGE"
                : "ENV_EXPOSURE_NOT_VERIFIED";
        const pipelineReasons = [
          ...(factFailure ? ["FACT_STORE_UNAVAILABLE"] : []),
          ...(["broken", "delayed"].includes(projectPipeline.state)
            ? [projectPipeline.reason]
            : []),
          "ENV_HEALTH_NOT_VERIFIED",
        ];
        const score = (type: "operational" | "quality"): ProjectCardScore => {
          const entry = active.find(
              (a) => a.projectId === id && a.libraryType === type,
            ),
            result = entry?.result;
          const value =
            result?.status === "available" &&
            result.context.scopeId === id &&
            result.configurationSnapshot.scope === "project"
              ? result.value
              : null;
          const reasons = result
            ? [
                ...result.reasons,
                ...result.dimensions.flatMap((d) =>
                  d.leaves
                    .filter((l) => !l.eligible)
                    .map((l) => `${l.metricKey}:${l.reason}`),
                ),
              ]
            : [
                "MISSING_CONFIGURATION",
                ...(entry ? ["SCORE_CONFIGURATION_NOT_SAVED"] : []),
              ];
          if (
            result &&
            (result.context.scopeId !== id ||
              result.configurationSnapshot.scope !== "project")
          )
            reasons.push("PROJECT_SCORE_SCOPE_REQUIRED");
          return {
            scoreKey: type + "_score",
            value,
            status: value === null ? "unavailable" : "available",
            color: scoreColor(value),
            versionId: entry?.version.id ?? null,
            version: entry?.version.version ?? null,
            reasons: [...new Set(reasons)],
            context: result
              ? { ...result.context }
              : { ...query, projectId: id, timezone },
            availableFrom: result?.effectiveAt ?? null,
          };
        };
        const operational = score("operational"),
          quality = score("quality"),
          status = projectCardState(state, [operational, quality]);
        const format = (instant: string) =>
          new Intl.DateTimeFormat("sv-SE", {
            timeZone: timezone,
            dateStyle: "short",
            timeStyle: "long",
          }).format(new Date(instant));
        return {
          id,
          name: String(row.name),
          role: String(row.role),
          projectStatus: String(row.status),
          timezone,
          operational,
          quality,
          ...status,
          reasons: [...new Set([...status.reasons, ...pipelineReasons, dataReason])],
          pipeline: {
            state,
            scope: ["broken", "delayed"].includes(projectPipeline.state)
              ? "project"
              : "env",
            projectState: projectPipeline.state,
            reasons: pipelineReasons,
            envVerified: false,
          },
          data: {
            state: dataState,
            reason: dataReason,
            windowEvents: observed?.windowEvents ?? (factFailure ? null : 0),
            windowPageViews: observed?.windowPageViews ?? (factFailure ? null : 0),
          },
          lastDataAt: observed?.lastDataAt ?? null,
          lastDataSource:
            "ClickHouse raw_events received_at; selected env, retained data",
          range: {
            ...query,
            timezone,
            localFrom: format(query.from),
            localTo: format(query.to),
            boundary: "[from,to)",
          },
          entry: { module: "metrics", path: `/projects/${id}/metrics` },
        };
      })
      .sort(compareProjectCards);
    const total = items.length,
      maxPage = Math.max(1, Math.ceil(total / input.pageSize));
    let page = Math.min(input.page, maxPage);
    if (input.locate) {
      const index = items.findIndex((p) => p.id === input.locate);
      if (index >= 0) page = Math.floor(index / input.pageSize) + 1;
    }
    return {
      items: items.slice((page - 1) * input.pageSize, page * input.pageSize),
      total,
      page,
      pageSize: input.pageSize,
      search: input.search,
      query: { ...query, range: input.range },
      located:
        input.locate && items.some((p) => p.id === input.locate) ? input.locate : null,
      diagnostics: {
        candidateProjects: total,
        metadataQueries,
        transactionStatements,
        clickHouseQueries: rows.length ? 1 : 0,
        clickHouse: factFailure ? null : facts.statistics,
        elapsedMs: performance.now() - started,
      },
    };
  }
}
