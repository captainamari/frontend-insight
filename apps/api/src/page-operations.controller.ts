import { Controller, Get, HttpException, Inject, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { resolveProjectCalendar } from "@frontend-insight/event-contract/project-range";
import {
  bindPageUsage,
  PAGE_USAGE_KEYS,
  readWorkflowFactDefinitions,
  type Principal,
  type UsagePage,
} from "@frontend-insight/server-core";
import type { RowDataPacket } from "@frontend-insight/server-core";
import { CoreService } from "./core.service.js";
import { CurrentPrincipal, parseInput } from "./http.js";
@Controller("api/projects/:projectId/page-operations")
export class PageOperationsController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}
  @Get()
  async read(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    const role = await this.core.mysql.getProjectRole(principal, projectId);
    if (!role) throw new HttpException("PROJECT_FORBIDDEN", 403);
    const q = parseInput(
      z
        .object({
          env: z.enum(["dev", "staging", "prod"]).default("prod"),
          range: z.enum(["7d", "30d", "90d", "180d", "365d", "custom"]).default("7d"),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
          pageRoute: z
            .string()
            .regex(/^\/[^?#]*$/)
            .max(512)
            .optional(),
          versionId: z.string().uuid().optional(),
        })
        .strict(),
      query,
    );
    const project = await this.core.mysql.getProject(projectId);
    if (!project) throw new HttpException("PROJECT_NOT_FOUND", 404);
    let range;
    try {
      range = resolveProjectCalendar(q, project.timezone);
    } catch {
      throw new HttpException("PAGE_RANGE_INVALID", 400);
    }
    if (Date.parse(range.to) > Date.now())
      throw new HttpException("PAGE_RANGE_IN_FUTURE", 400);
    const versions = await this.core.metricLibrary.listVersions(
      projectId,
      "operational",
    );
    const version = q.versionId
      ? versions.find((v) => v.id === q.versionId)
      : versions.find((v) => v.status === "active");
    if (q.versionId && !version) throw new HttpException("PAGE_VERSION_NOT_FOUND", 404);
    const snapshot = version
      ? await this.core.metricLibrary.displayBindings(projectId, version.id, "page")
      : null;
    const [pageRows] = await this.core.mysql.pool.query<RowDataPacket[]>(
      `SELECT p.id,p.page_route,r.id AS revision_id,r.name,r.module_id,r.template_key,r.is_core,r.status,r.expected_frequency,r.criticality_weight,r.effective_from,r.effective_to FROM page_definitions p JOIN page_definition_revisions r ON r.page_definition_id=p.id WHERE p.project_id=? AND r.effective_from<? AND (r.effective_to IS NULL OR r.effective_to>?) ORDER BY r.effective_from LIMIT 10001`,
      [projectId, new Date(range.to), new Date(range.from)],
    );
    if (pageRows.length > 10000)
      throw new HttpException("PAGE_REVISION_BUDGET_EXCEEDED", 422);
    const pages: UsagePage[] = pageRows
      .filter((r) => r.status === "active")
      .map((r) => ({
        pageRoute: String(r.page_route),
        moduleId: String(r.module_id),
        from: new Date(r.effective_from as string).toISOString(),
        to: r.effective_to ? new Date(r.effective_to as string).toISOString() : null,
      }));
    const definitions = await readWorkflowFactDefinitions(
      this.core.mysql.pool,
      projectId,
    );
    const selectedPageIds = new Set(
      pageRows
        .filter((r) => !q.pageRoute || r.page_route === q.pageRoute)
        .map((r) => String(r.id)),
    );
    const tasks = (await this.core.mysql.listFeatures(projectId)).filter(
      (f) => f.pageDefinitionId && selectedPageIds.has(f.pageDefinitionId),
    );
    const workflows = definitions.filter((d) =>
      d.steps.some((s) =>
        tasks.some((t) => s.triggerConfig.operationKey === t.featureKey),
      ),
    );

    // Existing workflow reducer owns terminal/cohort semantics; expose only safe aggregate rows.
    const workflowFacts = workflows.length
      ? await this.core.workflowFacts.read(
          projectId,
          q.env,
          range.from,
          range.to,
          workflows,
          range.buckets,
          [],
        )
      : null;
    const modules = await this.core.mysql.listModules(projectId, {
      includeArchived: true,
    });
    let facts;
    try {
      facts = await this.core.pageUsage.read(
        projectId,
        q.env,
        range.from,
        range.to,
        project.timezone,
        range.buckets,
        q.pageRoute,
        pages,
      );
    } catch (e) {
      if (e instanceof Error && /BUDGET|LIMIT/.test(e.message))
        throw new HttpException("PAGE_USAGE_BUDGET_EXCEEDED", 422);
      throw e;
    }
    const keys = snapshot?.metricKeys.length
      ? snapshot.metricKeys
      : [...PAGE_USAGE_KEYS];
    const boundary = (from: string, to: string) =>
      !!version &&
      version.status !== "draft" &&
      (!version.activatedAt ||
        from < version.activatedAt ||
        (!!version.supersededAt && to > version.supersededAt));
    const cards = (inputs: typeof facts.inputs, from: string, to: string) =>
      snapshot
        ? bindPageUsage(snapshot.definitions, keys, inputs, boundary(from, to))
        : keys.map((key) => ({
            key,
            name: key,
            unit: "",
            definitionVersion: null,
            value: null,
            status: "metric_not_available",
            sampleSize: null,
            reason: "NO_ACTIVE_METRIC_VERSION",
          }));
    return {
      ...facts,
      inputs: undefined,
      scope: { projectId, ...range, pageRoute: q.pageRoute ?? null },
      timezone: project.timezone,
      canConfigure: role === "admin",
      version: version ?? null,
      bindingKeys: keys,
      cards: cards(facts.inputs, range.from, range.to),
      trend: facts.trend.map((t) => ({
        ...t,
        inputs: undefined,
        cards: cards(t.inputs, t.from, t.to),
      })),
      pages: pageRows
        .filter((r) => !q.pageRoute || r.page_route === q.pageRoute)
        .map((r) => ({
          id: r.id,
          pageRoute: r.page_route,
          revisionId: r.revision_id,
          name: r.name,
          module: modules.find((m) => m.id === r.module_id)?.name ?? null,
          template: r.template_key,
          isCore: !!r.is_core,
          status: r.status,
          expectedFrequency: r.expected_frequency,
          criticalityWeight: r.criticality_weight,
          effectiveFrom: new Date(r.effective_from as string).toISOString(),
          effectiveTo: r.effective_to
            ? new Date(r.effective_to as string).toISOString()
            : null,
        })),
      tasks: tasks.map((t) => ({
        key: t.featureKey,
        name: t.name,
        isKeyTask: t.isKeyTask,
        status: t.status,
        lifecycle: t.operationLifecycleEnabled,
      })),
      workflows: workflowFacts?.definitions ?? [],
      statistics: {
        ...facts.statistics,
        usageClickHouseQueries: facts.statistics.clickHouseQueries,
        clickHouseQueries:
          facts.statistics.clickHouseQueries +
          (workflowFacts?.diagnostics.clickHouseQueries ?? 0),
        rowsRead:
          facts.statistics.rowsRead + (workflowFacts?.diagnostics.rowsRead ?? 0),
        bytesRead:
          facts.statistics.bytesRead + (workflowFacts?.diagnostics.bytesRead ?? 0),
        metadataQueryUpperBound: 12,
      },
      observationNotice:
        "仅表示窗口内收到的事实；无数据不代表零。会话深度/单页率按窗口内跨页面事实计算。",
    };
  }
}
