import {
  ERROR_CATEGORIES,
  PageQualityError,
  evaluateDataStatus,
} from "@frontend-insight/server-core";
import { resolveProjectCalendar } from "@frontend-insight/event-contract/project-range";
import { bindQualityFacts, readQualityPages } from "@frontend-insight/server-core";
import type { AnalyticsRange, Principal } from "@frontend-insight/server-core";
import { Controller, Get, HttpException, Inject, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { CoreService } from "./core.service.js";
import { CurrentPrincipal, parseInput } from "./http.js";

const rangeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  timezone: z.string().min(1).max(64),
  granularity: z.enum(["hour", "day"]).default("day"),
});
const errorsSchema = rangeSchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const groupIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

@Controller("api/projects/:projectId/observability")
export class ObservabilityController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @Get("occurrences")
  async occurrences(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
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
          category: z.enum(["all", ...ERROR_CATEGORIES]).default("all"),
          mode: z.enum(["latest", "all"]).default("latest"),
          groupId: groupIdSchema.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().max(1024).optional(),
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
      throw new HttpException("QUALITY_RANGE_INVALID", 400);
    }
    try {
      const data = await this.core.pageQuality.read(projectId, {
        ...q,
        from: range.from,
        to: range.to,
      });
      const pipeline = evaluateDataStatus(
        await this.core.mysql.getDataStatus(projectId),
      );
      return {
        ...data,
        scope: {
          projectId,
          ...range,
          pageRoute: q.pageRoute ?? null,
          category: q.category,
        },
        timezone: project.timezone,
        pipeline: { state: pipeline.state, reason: pipeline.reason },
      };
    } catch (e) {
      if (e instanceof PageQualityError)
        throw new HttpException(e.message, e.message.includes("BUDGET") ? 422 : 400);
      throw e;
    }
  }

  @Get("quality")
  async quality(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    const q = parseInput(
      z
        .object({
          versionId: z.string().uuid().optional(),
          env: z.enum(["dev", "staging", "prod"]),
          from: z.string().datetime(),
          to: z.string().datetime(),
          pageRoute: z
            .string()
            .regex(/^\/[^?#]*$/)
            .max(512)
            .optional(),
        })
        .strict(),
      query,
    );
    if (
      Date.parse(q.to) <= Date.parse(q.from) ||
      Date.parse(q.to) > Date.now() ||
      Date.parse(q.to) - Date.parse(q.from) > 89 * 86400000
    )
      throw new HttpException("QUALITY_RANGE_INVALID", 400);
    const pages = await readQualityPages(this.core.mysql, projectId, q.from, q.to);
    const result = await this.core.qualityFacts.read(
      projectId,
      q.env,
      q.from,
      q.to,
      undefined,
      q.pageRoute,
      pages,
    );
    const snapshot = q.versionId
      ? await this.core.metricLibrary.getVersion(projectId, q.versionId)
      : null;
    if (snapshot && snapshot.version.libraryType !== "quality")
      throw new HttpException("QUALITY_LIBRARY_REQUIRED", 400);
    const binding = snapshot ? bindQualityFacts(result, snapshot) : null;
    return {
      ...result,
      metrics: Object.fromEntries(
        Object.entries(result.metrics).map(([key, metric]) => [
          key,
          binding ? { ...metric, ...binding.inputs[key] } : metric,
        ]),
      ),
      binding,
      mode: snapshot ? "versioned" : "observation",
    };
  }

  @Get("overview")
  async overview(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.observability.overview(projectId, this.range(query));
  }

  @Get("errors")
  async errors(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    const parsed = parseInput(errorsSchema, query);
    return this.core.observability.errors(projectId, parsed, parsed.limit);
  }

  @Get("errors/:groupId")
  async errorDetail(
    @Param("projectId") projectId: string,
    @Param("groupId") rawGroupId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    const groupId = parseInput(groupIdSchema, rawGroupId);
    const result = await this.core.observability.errorDetail(
      projectId,
      groupId,
      this.range(query),
    );
    if (!result.item) throw new HttpException("ERROR_GROUP_NOT_FOUND", 404);
    return result;
  }

  @Get("web-vitals")
  async webVitals(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.observability.webVitals(projectId, this.range(query));
  }

  @Get("releases")
  async releases(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.observability.releases(projectId, this.range(query));
  }

  @Get("alerts")
  async alerts(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.observability.alerts(projectId, this.range(query));
  }

  private range(query: unknown): AnalyticsRange {
    return parseInput(rangeSchema, query) as AnalyticsRange;
  }

  private async authorize(principal: Principal, projectId: string): Promise<void> {
    const role = await this.core.mysql.getProjectRole(principal, projectId);
    if (!role) throw new HttpException("PROJECT_FORBIDDEN", 403);
  }
}
