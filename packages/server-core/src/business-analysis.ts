import { readDirectories, directorySegments } from "./organization-directory.js";
import type { EfficiencyFactStore } from "./efficiency-facts.js";
import { storageFailureCode } from "./clickhouse-logger.js";
import { mergeWorkflowFacts } from "./workflow-score-facts.js";
import { readWorkflowFactDefinitions } from "./workflow-definitions.js";
import type { WorkflowFactStore } from "./workflow-facts.js";
import type { RowDataPacket } from "mysql2/promise";
import {
  resolveProjectCalendar,
  ProjectRangeError,
} from "@frontend-insight/event-contract/project-range";
import type { MySqlStore } from "./mysql-store.js";
import type { ScoreManagementService } from "./score-management.js";
import { MetricLibraryError } from "./metric-library.js";
import { scoreDigest } from "./score-storage.js";
import {
  evaluateOverviewMetrics,
  segmentOverviewBuckets,
  type OverviewQuery,
} from "./project-overview.js";
import {
  type BusinessFactStore,
  emptyBusinessObservation,
  businessFactWindow,
  type BusinessPageWindow,
} from "./business-facts.js";
import {
  IDENTITY_DEFINITION_VERSION,
  WORKFLOW_FACT_DEFINITION_VERSION,
} from "./system-metric-catalog.js";
import { evaluateModulePenetration } from "./module-penetration.js";
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
export interface BusinessQuery extends OverviewQuery {
  moduleId?: string | undefined;
  versionId?: string | undefined;
  workflowPage?: number | undefined;
  workflowEvidencePage?: number | undefined;
  workflowVersion?: string | undefined;
}
export class BusinessAnalysisService {
  constructor(
    private readonly mysql: MySqlStore,
    private readonly scores: ScoreManagementService,
    private readonly facts: BusinessFactStore,
    private readonly workflowFacts?: WorkflowFactStore,
    private readonly efficiencyFacts?: EfficiencyFactStore,
  ) {}
  async analysis(projectId: string, input: BusinessQuery) {
    const asOf = new Date();
    const started = performance.now(),
      raw = await this.mysql.pool.getConnection();
    let metadataQueries = 0;
    const c = new Proxy(raw, {
      get(target, key) {
        if (key === "query")
          return (...args: unknown[]) => {
            if (/^\s*SELECT/i.test(String(args[0]))) metadataQueries++;
            return Reflect.apply(target.query, target, args);
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const snapshot = await (async () => {
      try {
        await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await c.beginTransaction();
        const [projects] = await c.query<RowDataPacket[]>(
          "SELECT id,name,timezone,retention_days FROM projects WHERE id=?",
          [projectId],
        );
        const p = projects[0];
        if (!p) throw new MetricLibraryError("PROJECT_NOT_FOUND", 404);
        let query: ReturnType<typeof resolveProjectCalendar>;
        try {
          query = resolveProjectCalendar(input, String(p.timezone));
        } catch (e) {
          if (e instanceof ProjectRangeError) throw new MetricLibraryError(e.code, 400);
          throw e;
        }
        const [modules] = await c.query<RowDataPacket[]>(
          `SELECT m.id,m.module_key,m.archived_at,r.id AS revision_id,r.name,r.status,r.revision,r.effective_from,r.effective_to FROM modules m JOIN module_revisions r ON r.module_id=m.id WHERE m.project_id=? AND r.effective_from<? AND (r.effective_to IS NULL OR r.effective_to>?) ORDER BY r.effective_from,r.display_order,m.id LIMIT 10001`,
          [projectId, new Date(query.to), new Date(query.from)],
        );
        // Explicit selection must belong to this project even when there is no revision in the window.
        if (input.moduleId) {
          const [owned] = await c.query<RowDataPacket[]>(
            "SELECT id FROM modules WHERE project_id=? AND id=?",
            [projectId, input.moduleId],
          );
          if (!owned.length) throw new MetricLibraryError("MODULE_NOT_FOUND", 404);
        }
        const selected =
          input.moduleId ??
          modules.find((m) => m.status === "active")?.id ??
          modules[0]?.id ??
          null;
        const active = (
          await this.scores.readActiveBatch(c, [projectId], {
            ...query,
            asOf: asOf.toISOString(),
          })
        ).find((a) => a.libraryType === "operational");
        if (input.versionId && input.versionId !== active?.version.id)
          throw new MetricLibraryError("BUSINESS_ACTIVE_VERSION_CHANGED", 409);
        const [bindings] = await c.query<RowDataPacket[]>(
          `SELECT d.metric_key FROM metric_display_bindings b JOIN metric_definitions d ON d.id=b.metric_definition_id WHERE d.library_version_id=? AND b.route_name='project-business' AND b.surface_key='business' ORDER BY b.display_order,d.metric_key`,
          [active?.version.id ?? ""],
        );
        const [pageRows] = await c.query<RowDataPacket[]>(
          `SELECT p.id AS page_id,p.page_route,r.id AS page_revision_id,r.name,r.module_id,r.status AS page_status,mr.id AS module_revision_id,mr.status AS module_status,GREATEST(r.effective_from,mr.effective_from) AS effective_from,LEAST(COALESCE(r.effective_to,?),COALESCE(mr.effective_to,?)) AS effective_to FROM page_definitions p JOIN page_definition_revisions r ON r.page_definition_id=p.id JOIN module_revisions mr ON mr.module_id=r.module_id AND mr.effective_from<COALESCE(r.effective_to,?) AND (mr.effective_to IS NULL OR mr.effective_to>r.effective_from) WHERE p.project_id=? AND r.effective_from<? AND (r.effective_to IS NULL OR r.effective_to>?) AND mr.effective_from<? AND (mr.effective_to IS NULL OR mr.effective_to>?) ORDER BY p.id,r.effective_from,mr.effective_from LIMIT 10001`,
          [
            new Date(Math.max(Date.parse(query.to), asOf.valueOf())),
            new Date(Math.max(Date.parse(query.to), asOf.valueOf())),
            new Date(Math.max(Date.parse(query.to), asOf.valueOf())),
            projectId,
            new Date(Math.max(Date.parse(query.to), asOf.valueOf())),
            new Date(Date.parse(query.from) - 1800000),
            new Date(Math.max(Date.parse(query.to), asOf.valueOf())),
            new Date(Date.parse(query.from) - 1800000),
          ],
        );
        if (pageRows.length > 10000 || modules.length > 10000)
          throw new MetricLibraryError("BUSINESS_REVISION_LIMIT", 400);
        const pathPages: BusinessPageWindow[] = pageRows.map((r) => ({
          pageId: String(r.page_id),
          pageRoute: String(r.page_route),
          name: String(r.name),
          moduleId: String(r.module_id),
          pageRevisionId: String(r.page_revision_id),
          moduleRevisionId: String(r.module_revision_id),
          from: iso(r.effective_from)!,
          to: iso(r.effective_to)!,
          included: r.page_status === "active" && r.module_status === "active",
          reason:
            r.page_status !== "active"
              ? "PAGE_DISABLED"
              : r.module_status !== "active"
                ? "MODULE_DISABLED"
                : "INCLUDED",
        }));
        const pages = pathPages.filter(
          (p) =>
            Date.parse(p.from) < Date.parse(query.to) &&
            Date.parse(p.to) > Date.parse(query.from),
        );
        const [workflows] = await c.query<RowDataPacket[]>(
          `SELECT w.id,w.workflow_key,w.status AS object_status,v.id AS version_id,v.version,v.name,v.status,v.activated_at,v.effective_to,v.timeout_seconds,s.step_key,s.name AS step_name,s.step_order FROM workflow_definitions w JOIN workflow_definition_versions v ON v.workflow_definition_id=w.id LEFT JOIN workflow_steps s ON s.workflow_definition_version_id=v.id WHERE w.project_id=? AND v.module_id=? AND v.status='active' ORDER BY w.id,s.step_order LIMIT 4001`,
          [projectId, selected ?? ""],
        );
        if (workflows.length > 4000)
          throw new MetricLibraryError("BUSINESS_WORKFLOW_LIMIT", 400);
        const workflowDefinitions = this.workflowFacts
          ? await readWorkflowFactDefinitions(c, projectId)
          : [];
        const directories = this.efficiencyFacts
          ? await readDirectories(c, projectId)
          : [];
        await c.commit();
        return {
          directories,
          workflowDefinitions,
          pathPages,
          p,
          query,
          modules,
          selected: selected ? String(selected) : null,
          active,
          bindings,
          pages,
          workflows,
        };
      } catch (e) {
        await c.rollback();
        throw e;
      } finally {
        c.release();
      }
    })();
    const { p, query, active, pages, selected: moduleId } = snapshot;
    const keys = snapshot.bindings.map((r) => String(r.metric_key));
    if (keys.length > 24) throw new MetricLibraryError("BUSINESS_BINDING_LIMIT", 400);
    const definitions = active?.snapshot.definitions ?? [];
    const units = new Map<string, number>();
    const selected =
      input.metrics ??
      keys
        .filter((k) => {
          const u = definitions.find((d) => d.metricKey === k)?.unit ?? "";
          const n = units.get(u) ?? 0;
          units.set(u, n + 1);
          return n < 4;
        })
        .slice(0, 16);
    units.clear();
    if (
      selected.length > 16 ||
      new Set(selected).size !== selected.length ||
      selected.some((k) => !keys.includes(k))
    )
      throw new MetricLibraryError("BUSINESS_METRIC_SELECTION_INVALID", 400);
    for (const k of selected) {
      const u = definitions.find((d) => d.metricKey === k)?.unit ?? "";
      units.set(u, (units.get(u) ?? 0) + 1);
    }
    if ([...units.values()].some((n) => n > 4))
      throw new MetricLibraryError("BUSINESS_UNIT_SERIES_LIMIT", 400);
    const segments = segmentOverviewBuckets(
      query.buckets,
      active?.activationPeriods ?? [],
    );
    if (segments.length > 800)
      throw new MetricLibraryError("BUSINESS_SEGMENT_LIMIT", 400);
    let clickHouseQueries = active?.result?.workflowObservation ? 1 : 0;
    const observation = moduleId
      ? await this.facts
          .read(
            projectId,
            moduleId,
            query.env,
            segments,
            pages,
            () => clickHouseQueries++,
          )
          .catch((cause: unknown) => {
            console.warn(
              JSON.stringify({
                source: "business-facts",
                code: storageFailureCode(cause),
              }),
            );
            throw new MetricLibraryError("FACT_STORE_UNAVAILABLE", 503);
          })
      : null;
    if (
      input.workflowVersion &&
      !snapshot.workflowDefinitions.some(
        (d) => d.versionId === input.workflowVersion && d.moduleId === moduleId,
      )
    )
      throw new MetricLibraryError("WORKFLOW_VERSION_NOT_FOUND", 404);
    const workflowAnalysis =
      this.workflowFacts && moduleId
        ? await this.workflowFacts
            .read(
              projectId,
              query.env,
              query.from,
              query.to,
              snapshot.workflowDefinitions.filter((d) => d.moduleId === moduleId),
              query.buckets,
              snapshot.pathPages,
              asOf,
              input.workflowPage ?? 1,
              input.workflowVersion,
              input.workflowEvidencePage ?? 1,
            )
            .catch((cause: unknown) => {
              if (
                cause instanceof Error &&
                [
                  "WORKFLOW_FACT_LIMIT",
                  "WORKFLOW_SESSION_LIMIT",
                  "WORKFLOW_PATH_LIMIT",
                ].includes(cause.message)
              )
                throw new MetricLibraryError(cause.message, 400);
              throw new MetricLibraryError("WORKFLOW_FACT_STORE_UNAVAILABLE", 503);
            })
        : null;
    const efficiency =
      this.efficiencyFacts && moduleId
        ? await this.efficiencyFacts
            .read(
              projectId,
              moduleId,
              query.env,
              query.from,
              query.to,
              asOf,
              snapshot.pathPages,
            )
            .catch((cause: unknown) => {
              if (
                cause instanceof Error &&
                ["EFFICIENCY_FACT_LIMIT", "EFFICIENCY_SERIES_LIMIT"].includes(
                  cause.message,
                )
              ) {
                throw new MetricLibraryError(cause.message, 400);
              }
              throw new MetricLibraryError("EFFICIENCY_FACT_STORE_UNAVAILABLE", 503);
            })
        : null;
    const fact = observation
      ? businessFactWindow(observation.window)
      : { inputs: {}, raw: {}, events: 0, lastDataAt: null };
    const workflowScore = active?.result;
    if (
      workflowScore?.workflowObservation &&
      workflowScore.configurationSnapshot.scope === "module" &&
      workflowScore.dependencySnapshot.scopeId === moduleId
    )
      mergeWorkflowFacts(fact, workflowScore.workflowObservation.facts);
    const activeFrom = active?.version.activatedAt;
    const boundary =
      !activeFrom || query.from < activeFrom ? "VERSION_RANGE_BOUNDARY" : null;
    const evaluate = (f: typeof fact, metricKeys: string[], reason: string | null) =>
      evaluateOverviewMetrics(
        definitions,
        metricKeys,
        f,
        query.granularity,
        reason,
        "module",
      ).map((m) => ({
        ...m,
        workflowBreakdown:
          m.definition.metricKey === "task_duration" &&
          m.definition.definitionVersion === WORKFLOW_FACT_DEFINITION_VERSION
            ? (workflowAnalysis?.definitions ?? []).map((w) => ({
                workflowKey: w.workflowKey,
                versionId: w.versionId,
                version: w.version,
                ...w.task_duration,
              }))
            : undefined,
        rawScope:
          m.definition.metricKey === "task_duration"
            ? "按工作流定义版本分别输出普通P50/P90/P75/P99，不把不同任务类型的分位数合并成标量；当前页与工作流列表一致，覆盖未知。"
            : "同窗口、按事件时间匹配启用模块/页面 revision 的已识别 page_view 观察；UV 只覆盖已观测页面访问，不代表已验证完整业务活动。",
      }));
    const moduleRows = [
      ...new Map(
        snapshot.modules.map((m) => [
          String(m.id),
          {
            id: String(m.id),
            moduleKey: String(m.module_key),
            name: String(m.name),
            status: String(m.status),
            revision: Number(m.revision),
            archived: Boolean(m.archived_at),
          },
        ]),
      ).values(),
    ];
    const hasActiveRevision = snapshot.modules.some(
      (m) => m.id === moduleId && m.status === "active",
    );
    const identity = scoreDigest({
      projectId,
      moduleId,
      query,
      version: active?.version,
      keys,
      selected,
      pages,
      modules: snapshot.modules,
      workflows: snapshot.workflows,
    });
    const directoryVersions = directorySegments(
      snapshot.directories,
      query.env,
      Date.parse(query.from),
      Date.parse(query.to),
      asOf.valueOf(),
    );
    return {
      project: {
        id: projectId,
        name: String(p.name),
        timezone: String(p.timezone),
        retentionDays: Number(p.retention_days),
      },
      query,
      identity,
      modules: moduleRows,
      moduleId,
      moduleRevisions: snapshot.modules
        .filter((m) => m.id === moduleId)
        .map((m) => ({
          id: String(m.revision_id),
          revision: Number(m.revision),
          name: String(m.name),
          status: String(m.status),
          from: iso(m.effective_from),
          to: iso(m.effective_to),
        })),
      metrics: {
        version: active?.version ?? null,
        status: !moduleId
          ? "no_modules"
          : !active
            ? "missing_active"
            : !keys.length
              ? "missing_bindings"
              : "configured",
        cards: evaluate(fact, keys, boundary),
        selected,
        boundaries:
          active?.activationPeriods.map((p) => ({
            at: p.effectiveFrom,
            versionId: p.versionId,
          })) ?? [],
        trends: segments.map((b, i) => {
          const bucketFact = observation
            ? businessFactWindow(observation.buckets[i]!)
            : { inputs: {}, raw: {}, events: 0, lastDataAt: null };
          if (
            workflowScore?.workflowObservation &&
            workflowScore.configurationSnapshot.scope === "module" &&
            workflowScore.dependencySnapshot.scopeId === moduleId
          ) {
            const trend = workflowScore.workflowObservation.trends.find(
              (t) => t.from === b.from && t.to === b.to,
            );
            if (trend) mergeWorkflowFacts(bucketFact, trend.facts);
          }
          const reason =
            b.versionId !== active?.version.id || b.segment !== activeFrom
              ? "HISTORICAL_VERSION_NOT_RECALCULATED"
              : null;
          return {
            ...b,
            penetration: evaluateModulePenetration({
              scope: {
                projectId,
                env: query.env,
                identityVersion: IDENTITY_DEFINITION_VERSION,
                activityScope: "identified_valid_classified_business_activity",
              },
              from: b.from,
              to: b.to,
              timezone: query.timezone,
              observedNumerator: observation?.buckets[i]?.uv ?? null,
            }),
            reason,
            metrics: evaluate(bucketFact, selected, reason).map((m) => ({
              metricKey: m.definition.metricKey,
              value: m.value,
              rawValue: m.rawValue,
              status: m.status,
              sampleSize: m.sampleSize,
              reason: m.reason,
            })),
          };
        }),
      },
      observation: observation?.window ?? null,
      pages: (
        observation?.pages ??
        pages.map((p) => ({ ...p, observation: emptyBusinessObservation() }))
      ).filter((p) => p.moduleId === moduleId),
      data: {
        state: !moduleId
          ? "no_modules"
          : !hasActiveRevision
            ? "no_active_module"
            : !observation?.window.events
              ? "no_data"
              : "partial",
        reason: !moduleId
          ? "NO_MODULE_IN_RANGE"
          : !hasActiveRevision
            ? "NO_ACTIVE_MODULE_REVISION_IN_RANGE"
            : !observation?.window.events
              ? "NO_EVENTS_IN_RANGE"
              : "IDENTITY_AND_ENV_COVERAGE_NOT_VERIFIED",
      },
      availableFrom: observation?.window.firstDataAt ?? null,
      availabilityScope:
        "first observed event within requested project/env window; not a completeness or retained-history guarantee",
      lastDataAt: observation?.window.lastDataAt ?? null,
      identityPolicy: {
        version: IDENTITY_DEFINITION_VERSION,
        rule: "project-HMAC(userId); identified valid classified activity; no anonymous fallback",
        observationScope: "page_view only",
        complete: false,
      },
      penetration: evaluateModulePenetration({
        scope: {
          projectId,
          env: query.env,
          identityVersion: IDENTITY_DEFINITION_VERSION,
          activityScope: "identified_valid_classified_business_activity",
        },
        from: query.from,
        to: query.to,
        timezone: query.timezone,
        observedNumerator: observation?.window.uv ?? null,
      }),
      workflows: snapshot.workflows.map((w) => ({
        id: String(w.id),
        workflowKey: String(w.workflow_key),
        name: String(w.name),
        versionId: String(w.version_id),
        version: Number(w.version),
        status: String(w.object_status),
        stepKey: w.step_key ? String(w.step_key) : null,
        stepName: w.step_name ? String(w.step_name) : null,
        stepOrder: Number(w.step_order ?? 0),
        activatedAt: iso(w.activated_at),
      })),
      efficiency,
      organization: {
        status: directoryVersions.length ? "privacy_suppressed" : "not_collected",
        reason: directoryVersions.length
          ? "ORGANIZATION_PRIVACY_POLICY_REVIEW_REQUIRED"
          : "TRUSTED_DIRECTORY_MISSING",
        values: null,
        directoryVersions,
      },
      workflowAnalysis,
      workflowFacts: workflowAnalysis
        ? { status: workflowAnalysis.status, reason: workflowAnalysis.reason }
        : { status: "not_collected", reason: "未安装工作流事实查询服务" },
      diagnostics: {
        metadataQueries,
        clickHouseQueries:
          clickHouseQueries +
          (efficiency ? 1 : 0) +
          (workflowAnalysis?.diagnostics.clickHouseQueries ?? 0),
        elapsedMs: performance.now() - started,
        scans: observation?.statistics ?? null,
        physicalRetentionDays: 90,
        coverage: "保留原始事实的观察；长范围缺失不补值，非生产容量证明。",
      },
    };
  }
}
