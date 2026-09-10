import { expectedScoreDates, CANONICAL_SCORE_IDENTITY } from "./score-observation.js";
import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import type { Principal } from "./model.js";
import type { MySqlStore } from "./mysql-store.js";
import { type MetricLibraryService, MetricLibraryError } from "./metric-library.js";
import {
  evaluateScore,
  parseScoreConfiguration,
  validateScoreConfiguration,
  type ScoreConfiguration,
  type ScoreQueryContext,
} from "./score-evaluation.js";
import { scoreBinding } from "./score-preflight.js";
import { scoreExamples } from "./score-examples.js";
import { defaultScoreTemplate, selectedScoreTemplate } from "./score-templates.js";
import { PAGE_TEMPLATE_DURATION_TARGETS } from "./metrics.js";
import {
  jsonValue,
  scoreDigest,
  snapshotDigest,
  writeScoreItems,
} from "./score-storage.js";
export interface ScoreBusinessInput {
  templateVersion?: string | undefined;
  confirmed: boolean;
  scopeId: string;
  optionsDigest: string;
  workflowWeights: Record<string, number>;
  durationMinimumSample: number;
}
export interface ScoreQuery {
  env: ScoreQueryContext["env"];
  from: string;
  to: string;
  granularity: ScoreQueryContext["granularity"];
}
export class ScoreManagementService {
  constructor(
    private readonly mysql: MySqlStore,
    private readonly library: MetricLibraryService,
  ) {}
  async businessOptions(projectId: string) {
    const [project, settings, modules, pages, workflows] = await Promise.all([
      this.mysql.getProject(projectId),
      this.mysql.getOperationalSettings(projectId),
      this.mysql.listModules(projectId),
      this.mysql.listPageDefinitions(projectId),
      this.mysql.pool.query<RowDataPacket[]>(
        `SELECT d.id,d.workflow_key AS workflowKey,v.id AS versionId,v.version,v.module_id AS moduleId,v.name,v.timeout_seconds AS timeoutSeconds,v.activated_at AS effectiveFrom,v.terminal_policy AS terminalPolicy FROM workflow_definitions d JOIN workflow_definition_versions v ON v.workflow_definition_id=d.id WHERE d.project_id=? AND d.status='active' AND d.archived_at IS NULL AND v.status='active' ORDER BY d.id`,
        [projectId],
      ),
    ]);
    if (!project) throw new MetricLibraryError("PROJECT_NOT_FOUND", 404);
    const options = {
      projectId,
      timezone: project.timezone,
      settings,
      modules,
      pages,
      workflows: workflows[0].map((w) => ({
        id: String(w.id),
        workflowKey: String(w.workflowKey),
        versionId: String(w.versionId),
        version: Number(w.version),
        moduleId: String(w.moduleId),
        name: String(w.name),
        timeoutSeconds: Number(w.timeoutSeconds),
        effectiveFrom: w.effectiveFrom,
        terminalPolicy: jsonValue(w.terminalPolicy),
      })),
      pageTemplateVersion: "page-duration-v1.8",
      evaluatorVersion: "score-evaluator-v1.8-r1c-2026-09-09",
      pageTargets: PAGE_TEMPLATE_DURATION_TARGETS,
      identityPolicy: CANONICAL_SCORE_IDENTITY,
      businessScope:
        "已识别、有效且已归类的业务活动；统一规范 UV；缺少 userId 视为接入完整性待核实。",
      sessionPolicy:
        "30 分钟无操作切分；查询 [from,to) 内事实按既有 sessionId 归组，跨午夜不重置；纯未归类排除，混合会话只计已归类模块。",
      percentilePolicy:
        "会话样本线性插值 P50，窗口重算不平均每日 P50；成功工作流池化加权 nearest-rank P50。",
    };
    return { ...options, optionsDigest: scoreDigest(options) };
  }
  async get(projectId: string, versionId: string) {
    const snapshot = await this.library.getVersion(projectId, versionId);
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT * FROM score_definitions WHERE library_version_id=? AND configuration IS NOT NULL`,
      [versionId],
    );
    const row = rows[0];
    return {
      ...snapshot,
      score: row
        ? {
            id: String(row.id),
            configuration: jsonValue<ScoreConfiguration>(row.configuration),
            dependencies: jsonValue<
              Awaited<ReturnType<ScoreManagementService["businessOptions"]>> &
                ScoreBusinessInput & {
                  template: ReturnType<typeof defaultScoreTemplate>;
                }
            >(row.dependency_snapshot),
          }
        : null,
    };
  }
  async preview(projectId: string, versionId: string, raw: unknown) {
    const snapshot = await this.get(projectId, versionId);
    const validation = validateScoreConfiguration(raw, scoreBinding(snapshot));
    const source = snapshot.version.sourceVersionId
      ? await this.get(projectId, snapshot.version.sourceVersionId)
      : null;
    const previous = source?.score?.configuration ?? null;
    const diff = Object.keys(validation.configuration)
      .filter(
        (key) =>
          JSON.stringify(previous?.[key as keyof ScoreConfiguration]) !==
          JSON.stringify(validation.configuration[key as keyof ScoreConfiguration]),
      )
      .map((field) => ({
        field,
        before: previous?.[field as keyof ScoreConfiguration] ?? null,
        after: validation.configuration[field as keyof ScoreConfiguration],
      }));
    return {
      ...validation,
      configurationReady: validation.readiness.every((r) =>
        ["partial", "not_collected"].includes(r.reason),
      ),
      factStatus: "unavailable",
      diff,
      impact: await this.library.impact(projectId, versionId),
      metricDiff: await this.library.diff(projectId, versionId),
      definitionLineage: snapshot.definitions.filter((m) =>
        validation.dependencies.includes(m.metricKey),
      ),
      fixtures: scoreExamples(validation.configuration),
      template: defaultScoreTemplate(snapshot.version.libraryType),
      templateChanged:
        snapshot.score?.dependencies.template.version !==
        defaultScoreTemplate(snapshot.version.libraryType).version,
    };
  }
  async save(
    projectId: string,
    versionId: string,
    raw: unknown,
    business: ScoreBusinessInput,
    actor: Principal,
  ) {
    const configuration = parseScoreConfiguration(raw),
      requested = await this.get(projectId, versionId);
    if (configuration.libraryType !== requested.version.libraryType)
      throw new MetricLibraryError("SCORE_TYPE_MISMATCH", 400);
    const options = await this.businessOptions(projectId);
    if (business.optionsDigest !== options.optionsDigest)
      throw new MetricLibraryError("SCORE_BUSINESS_REVISION_CHANGED", 409);
    if (
      configuration.scope === "project"
        ? business.scopeId !== projectId
        : !options.modules.some(
            (m) => m.id === business.scopeId && m.status === "active",
          )
    )
      throw new MetricLibraryError("SCORE_SCOPE_INVALID", 400);
    const workflows = options.workflows.filter(
      (w) => configuration.scope === "project" || w.moduleId === business.scopeId,
    );
    if (
      Object.keys(business.workflowWeights).some(
        (key) => !workflows.some((w) => w.id === key),
      ) ||
      Object.values(business.workflowWeights).some(
        (w) => !Number.isFinite(w) || w <= 0 || w > 1000,
      )
    )
      throw new MetricLibraryError("SCORE_WORKFLOW_WEIGHT_INVALID", 400);
    if (
      business.confirmed &&
      configuration.libraryType === "operational" &&
      (!(options.settings?.targetUsers && options.settings.targetUsers > 0) ||
        !options.settings.expectedActiveWeekdays.length ||
        !options.pages.some(
          (p) =>
            p.isCore &&
            p.status === "active" &&
            (configuration.scope === "project" || p.moduleId === business.scopeId),
        ) ||
        !workflows.length ||
        workflows.some((w) => !business.workflowWeights[String(w.id)]))
    )
      throw new MetricLibraryError("SCORE_BUSINESS_CONFIGURATION_INCOMPLETE", 400);
    const selectedTemplate = selectedScoreTemplate(
      configuration.libraryType,
      requested.score?.dependencies.template ?? null,
      business.templateVersion,
    );
    if (!selectedTemplate)
      throw new MetricLibraryError("SCORE_TEMPLATE_VERSION_INVALID", 400);
    const version =
      requested.version.status === "draft"
        ? requested.version
        : await this.library.createDraft({
            projectId,
            libraryType: configuration.libraryType,
            sourceVersionId: versionId,
            actor,
          });
    const snapshot = await this.library.getVersion(projectId, version.id);
    validateScoreConfiguration(configuration, scoreBinding(snapshot));
    const dependencies = {
      ...options,
      ...business,
      template: selectedTemplate,
    };
    const connection = await this.mysql.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(`SELECT id FROM projects WHERE id=? FOR UPDATE`, [
        projectId,
      ]);
      const [versions] = await connection.query<RowDataPacket[]>(
        `SELECT status FROM metric_library_versions WHERE id=? AND project_id=? FOR UPDATE`,
        [version.id, projectId],
      );
      if (versions[0]?.status !== "draft")
        throw new MetricLibraryError("METRIC_LIBRARY_VERSION_IMMUTABLE", 409);
      const [existing] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM score_definitions WHERE library_version_id=?`,
        [version.id],
      );
      const id = existing[0]?.id ?? randomUUID();
      await connection.execute(
        `INSERT INTO score_definitions (id,library_version_id,score_key,display_name,version,gate_ast,color_bands,status,configuration,dependency_snapshot) VALUES (?,?,?,?,?,?,?,'draft',?,?) ON DUPLICATE KEY UPDATE score_key=VALUES(score_key),display_name=VALUES(display_name),gate_ast=VALUES(gate_ast),color_bands=VALUES(color_bands),configuration=VALUES(configuration),dependency_snapshot=VALUES(dependency_snapshot),reviewed_digest=NULL`,
        [
          id,
          version.id,
          configuration.scoreKey,
          configuration.displayName,
          version.version,
          JSON.stringify(configuration.gate),
          JSON.stringify(configuration.colorBands),
          JSON.stringify(configuration),
          JSON.stringify(dependencies),
        ],
      );
      await writeScoreItems(connection, String(id), version.id, configuration);
      await connection.execute(
        `INSERT INTO audit_logs (project_id,actor_user_id,action,entity_type,entity_id,metadata,request_id) VALUES (?,?,'score.saved','score_definition',?,?,?)`,
        [
          projectId,
          actor.userId,
          id,
          JSON.stringify({
            versionId: version.id,
            scoreKey: configuration.scoreKey,
            libraryType: configuration.libraryType,
          }),
          randomUUID(),
        ],
      );
      await connection.commit();
    } catch (e) {
      await connection.rollback();
      throw e;
    } finally {
      connection.release();
    }
    return this.get(projectId, version.id);
  }
  async read(
    projectId: string,
    scoreKey: string,
    query: ScoreQuery,
    versionId?: string,
  ) {
    if (!versionId) {
      const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
        `SELECT v.id FROM metric_library_versions v JOIN score_definitions s ON s.library_version_id=v.id WHERE v.project_id=? AND v.status='active' AND s.score_key=? AND s.configuration IS NOT NULL`,
        [projectId, scoreKey],
      );
      if (rows.length !== 1)
        throw new MetricLibraryError(
          rows.length ? "SCORE_KEY_AMBIGUOUS" : "SCORE_CONFIGURATION_NOT_SAVED",
          rows.length ? 409 : 404,
        );
      versionId = String(rows[0]!.id);
    }
    const snapshot = await this.get(projectId, versionId);
    if (snapshot.score?.configuration.scoreKey !== scoreKey)
      throw new MetricLibraryError("SCORE_KEY_VERSION_MISMATCH", 404);
    return this.query(projectId, versionId, query);
  }
  async query(
    projectId: string,
    versionId: string,
    query: ScoreQuery,
    mode: "current" | "historical_trial" = "current",
  ) {
    const snapshot = await this.get(projectId, versionId);
    if (!snapshot.score)
      throw new MetricLibraryError("SCORE_CONFIGURATION_NOT_SAVED", 404);
    const { configuration, dependencies } = snapshot.score;
    const definitionVersion = snapshotDigest(
      versionId,
      configuration,
      dependencies,
      snapshot.definitions,
    );
    const context: ScoreQueryContext = {
      ...query,
      projectId,
      metricSetVersion: versionId,
      definitionVersion,
      scopeId: dependencies.scopeId,
      timezone: dependencies.timezone,
    };
    // D4-A: canonical workflow/quality/usage facts are deferred. No fixture fallback.
    const result = evaluateScore({
      configuration,
      binding: scoreBinding(snapshot, definitionVersion),
      context,
      facts: {},
      pipelineStatus: "no_data",
      configurationConfirmed: dependencies.confirmed,
      effectiveAt: snapshot.version.activatedAt,
      mode,
    });
    result.reasons.push("ENV_EXPOSURE_NOT_VERIFIED");
    const [periods] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT library_version_id AS versionId,effective_from AS effectiveFrom,effective_to AS effectiveTo FROM metric_activation_periods WHERE project_id=? AND library_type=? AND effective_from<? AND (effective_to IS NULL OR effective_to>?) ORDER BY effective_from`,
      [projectId, configuration.libraryType, new Date(query.to), new Date(query.from)],
    );
    if (
      mode === "current" &&
      (snapshot.version.status !== "active" ||
        periods.some((p) => p.versionId !== versionId)) &&
      !result.reasons.includes("VERSION_RANGE_BOUNDARY")
    )
      result.reasons.push("VERSION_RANGE_BOUNDARY");
    const validation = validateScoreConfiguration(
      configuration,
      scoreBinding(snapshot, definitionVersion),
    );
    return {
      ...result,
      configurationStatus: snapshot.version.status,
      configurationSnapshot: configuration,
      definitionLineage: snapshot.definitions.filter((m) =>
        validation.dependencies.includes(m.metricKey),
      ),
      dependencySnapshot: dependencies,
      activationPeriods: periods,
      source: "project_query",
      calculatedAt: new Date().toISOString(),
      trend: null,
      samples: {
        total: null,
        valid: null,
        excluded: null,
        unidentified: null,
        reason: "规范事实、身份及来源曝光尚不能证明完整性；未把未知样本写成 0。",
      },
      observation: {
        expectedDates: expectedScoreDates(
          query.from,
          query.to,
          dependencies.timezone,
          dependencies.settings?.expectedActiveWeekdays ?? [],
        ),
        activeDates: null,
        numerator: null,
        denominator: null,
        reason: "R4-B/R5-A/R6 事实查询待交付。",
      },
    };
  }
  async trial(
    projectId: string,
    versionId: string,
    query: ScoreQuery,
    actor: Principal,
  ) {
    const result = await this.query(projectId, versionId, query, "historical_trial");
    const id = randomUUID();
    const connection = await this.mysql.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO score_historical_trials (id,project_id,library_version_id,definition_version,requested_by_user_id,query_context,result_snapshot) VALUES (?,?,?,?,?,?,?)`,
        [
          id,
          projectId,
          versionId,
          result.context.definitionVersion,
          actor.userId,
          JSON.stringify(result.context),
          JSON.stringify(result),
        ],
      );
      await connection.execute(
        `INSERT INTO audit_logs (project_id,actor_user_id,action,entity_type,entity_id,metadata,request_id) VALUES (?,?,'score.historical_trial','score_historical_trial',?,?,?)`,
        [
          projectId,
          actor.userId,
          id,
          JSON.stringify({
            versionId,
            env: query.env,
            definitionVersion: result.context.definitionVersion,
          }),
          randomUUID(),
        ],
      );
      await connection.commit();
    } catch (e) {
      await connection.rollback();
      throw e;
    } finally {
      connection.release();
    }
    return { id, result };
  }
  async history(projectId: string, versionId: string) {
    await this.library.getVersion(projectId, versionId);
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT id,created_at AS createdAt,result_snapshot AS result FROM score_historical_trials WHERE project_id=? AND library_version_id=? ORDER BY created_at DESC,id DESC LIMIT 50`,
      [projectId, versionId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      createdAt: r.createdAt,
      result: jsonValue<Awaited<ReturnType<ScoreManagementService["query"]>>>(r.result),
    }));
  }
  async review(
    projectId: string,
    versionId: string,
    query: ScoreQuery,
    actor: Principal,
  ) {
    const snapshot = await this.get(projectId, versionId);
    if (!snapshot.score)
      throw new MetricLibraryError("SCORE_CONFIGURATION_NOT_SAVED", 404);
    const preview = await this.preview(
      projectId,
      versionId,
      snapshot.score.configuration,
    );
    const trial = await this.trial(projectId, versionId, query, actor);
    const digest = snapshotDigest(
      versionId,
      snapshot.score.configuration,
      snapshot.score.dependencies,
      snapshot.definitions,
    );
    // A changed draft cannot use an old review: activation recomputes this digest under lock.
    await this.mysql.pool.execute(
      `UPDATE score_definitions SET reviewed_digest=? WHERE library_version_id=?`,
      [digest, versionId],
    );
    return {
      ...preview,
      trial,
      digest,
      businessConfirmed: snapshot.score.dependencies.confirmed,
    };
  }
}
