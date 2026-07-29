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

const pagesSchema = rangeSchema.extend({
  search: z.string().max(512).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["pv", "visitors", "sessions", "lastVisitAt"]).default("pv"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});

const pageDetailSchema = rangeSchema.extend({
  route: z.string().min(1).max(512),
});

@Controller("api/projects/:projectId/analytics")
export class AnalyticsController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @Get("overview")
  async overview(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.analytics.overview(projectId, this.range(query));
  }

  @Get("trend")
  async trend(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.analytics.trend(projectId, this.range(query));
  }

  @Get("pages")
  async pages(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    const parsed = parseInput(pagesSchema, query);
    const options = {
      page: parsed.page,
      pageSize: parsed.pageSize,
      sort: parsed.sort,
      direction: parsed.direction,
      ...(parsed.search === undefined ? {} : { search: parsed.search }),
    };
    return this.core.analytics.pages(projectId, parsed, options);
  }

  @Get("features")
  async features(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.analytics.features(projectId, this.range(query));
  }

  @Get("features/:featureId")
  async featureDetail(
    @Param("projectId") projectId: string,
    @Param("featureId") featureId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.analytics.featureDetail(projectId, featureId, this.range(query));
  }

  @Get("operational-overview")
  async operationalOverview(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.analytics.operationalOverview(projectId, this.range(query));
  }

  @Get("modules")
  async modules(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.analytics.modules(projectId, this.range(query));
  }

  @Get("page-detail")
  async pageDetail(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    const parsed = parseInput(pageDetailSchema, query);
    return this.core.analytics.pageDetail(projectId, parsed.route, parsed);
  }

  @Get("tasks/:featureId")
  async taskDetail(
    @Param("projectId") projectId: string,
    @Param("featureId") featureId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.analytics.taskDetail(projectId, featureId, this.range(query));
  }

  private range(query: unknown): AnalyticsRange {
    return parseInput(rangeSchema, query) as AnalyticsRange;
  }

  private async authorize(principal: Principal, projectId: string): Promise<void> {
    if (!(await this.core.mysql.getProjectRole(principal, projectId))) {
      throw new HttpException("PROJECT_FORBIDDEN", 403);
    }
  }
}
