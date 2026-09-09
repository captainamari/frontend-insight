import type { Principal } from "@frontend-insight/server-core";
import { defaultScoreTemplate } from "@frontend-insight/server-core";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { CoreService } from "./core.service.js";
import { CurrentPrincipal, parseInput } from "./http.js";
const querySchema = z
  .object({
    env: z.enum(["prod", "staging", "dev"]),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    granularity: z.enum(["5m", "hour", "day", "week", "month"]),
  })
  .strict();
const saveSchema = z
  .object({
    configuration: z.unknown(),
    business: z
      .object({
        confirmed: z.boolean(),
        scopeId: z.string().uuid(),
        optionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
        workflowWeights: z.record(z.string().uuid(), z.number().positive().max(1000)),
        durationMinimumSample: z.number().int().min(1).max(1000000),
      })
      .strict(),
  })
  .strict();
@Controller("api/projects/:projectId/score-management")
export class ScoreManagementController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}
  private async authorize(principal: Principal, projectId: string, write = false) {
    const role = await this.core.mysql.getProjectRole(principal, projectId);
    if (!role) throw new HttpException("PROJECT_FORBIDDEN", 403);
    if (
      write &&
      (principal.globalRole !== "admin" || !["owner", "admin"].includes(role))
    )
      throw new HttpException("WRITE_FORBIDDEN", 403);
  }
  @Get("templates") async templates(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() actor: Principal,
  ) {
    await this.authorize(actor, projectId);
    const { type } = parseInput(
      z.object({ type: z.enum(["operational", "quality"]) }).strict(),
      query,
    );
    return defaultScoreTemplate(type);
  }
  @Get("business-options") async options(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    await this.authorize(actor, projectId);
    return this.core.scores.businessOptions(projectId);
  }
  @Get("versions/:versionId") async get(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    await this.authorize(actor, projectId);
    return this.core.scores.get(projectId, versionId);
  }
  @Put("versions/:versionId") async save(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Body() body: unknown,
    @CurrentPrincipal() actor: Principal,
  ) {
    await this.authorize(actor, projectId, true);
    const input = parseInput(saveSchema, body);
    return this.core.scores.save(
      projectId,
      versionId,
      input.configuration,
      input.business,
      actor,
    );
  }
  @Post("versions/:versionId/preview") @HttpCode(200) async preview(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Body() body: unknown,
    @CurrentPrincipal() actor: Principal,
  ) {
    await this.authorize(actor, projectId);
    return this.core.scores.preview(projectId, versionId, body);
  }
  @Get("versions/:versionId/result") async result(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Query() query: unknown,
    @CurrentPrincipal() actor: Principal,
  ) {
    await this.authorize(actor, projectId);
    return this.core.scores.query(projectId, versionId, parseInput(querySchema, query));
  }
  @Get("versions/:versionId/trials") async history(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    await this.authorize(actor, projectId);
    return this.core.scores.history(projectId, versionId);
  }
  @Post("versions/:versionId/trials") async trial(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Body() body: unknown,
    @CurrentPrincipal() actor: Principal,
  ) {
    await this.authorize(actor, projectId, true);
    return this.core.scores.trial(
      projectId,
      versionId,
      parseInput(querySchema, body),
      actor,
    );
  }
  @Post("versions/:versionId/review") async review(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Body() body: unknown,
    @CurrentPrincipal() actor: Principal,
  ) {
    await this.authorize(actor, projectId, true);
    return this.core.scores.review(
      projectId,
      versionId,
      parseInput(querySchema, body),
      actor,
    );
  }
}

@Controller("api/projects/:projectId/scores")
export class ScoreReadController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}
  @Get(":scoreKey") async read(
    @Param("projectId") projectId: string,
    @Param("scoreKey") scoreKey: string,
    @Query() raw: unknown,
    @CurrentPrincipal() actor: Principal,
  ) {
    if (!(await this.core.mysql.getProjectRole(actor, projectId)))
      throw new HttpException("PROJECT_FORBIDDEN", 403);
    const { versionId, ...query } = parseInput(
      querySchema.extend({ versionId: z.string().uuid().optional() }).strict(),
      raw,
    );
    return this.core.scores.read(projectId, scoreKey, query, versionId);
  }
}
