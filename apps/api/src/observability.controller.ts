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

  @Get("page-performance")
  async pagePerformance(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId);
    return this.core.observability.pagePerformance(projectId, this.range(query));
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
