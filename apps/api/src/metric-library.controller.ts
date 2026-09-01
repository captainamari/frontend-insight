import type {
  BusinessMetricInput,
  Principal,
  ProjectRole,
} from "@frontend-insight/server-core";
import {
  Body,
  Controller,
  Delete,
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

const libraryTypeSchema = z.enum(["operational", "quality"]);
const versionQuerySchema = z.object({ type: libraryTypeSchema }).strict();
const createVersionSchema = z
  .object({
    type: libraryTypeSchema,
    sourceVersionId: z.string().uuid().nullable().optional(),
  })
  .strict();
const metricKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const businessMetricSchema = z
  .object({
    metricKey: metricKeySchema,
    displayName: z.string().trim().min(1).max(120),
    businessDescription: z.string().trim().min(1).max(1000),
    category: z.enum([
      "usage",
      "operation",
      "performance",
      "stability",
      "organization",
    ]),
    numeratorDescription: z.string().trim().max(1000).nullable(),
    denominatorDescription: z.string().trim().max(1000).nullable(),
    deduplicationKey: z.string().trim().min(1).max(512),
    unit: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    entityScope: z.enum(["project", "module", "page", "workflow"]),
    timeGranularity: z.enum(["5m", "hour", "day", "week", "month"]),
    minimumSample: z.number().int().min(0).max(1_000_000),
    missingPolicy: z.string().trim().min(1).max(1000),
    owner: z.string().trim().min(1).max(120),
    enabled: z.boolean(),
    formulaAst: z.unknown(),
  })
  .strict();
const definitionQuerySchema = z
  .object({ versionId: z.string().uuid().optional() })
  .strict();
const impactQuerySchema = z.object({ metricKey: metricKeySchema.optional() }).strict();

@Controller("projects/:projectId/metrics")
export class MetricLibraryController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @Get("catalog")
  async catalog(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    const { type } = parseInput(versionQuerySchema, query);
    return this.core.metricLibrary.catalog(projectId, type);
  }

  @Get("versions")
  async versions(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    const { type } = parseInput(versionQuerySchema, query);
    return this.core.metricLibrary.listVersions(projectId, type);
  }

  @Post("versions")
  async createVersion(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    const input = parseInput(createVersionSchema, body);
    return this.core.metricLibrary.createDraft({
      projectId,
      libraryType: input.type,
      ...(input.sourceVersionId === undefined
        ? {}
        : { sourceVersionId: input.sourceVersionId }),
      actor: principal,
    });
  }

  @Get("versions/:versionId")
  async version(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    return this.core.metricLibrary.getVersion(projectId, versionId);
  }

  @Post("versions/:versionId/validate")
  async validate(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.metricLibrary.validateVersion(projectId, versionId);
  }

  @Post("versions/:versionId/activate")
  async activate(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.metricLibrary.activateVersion({
      projectId,
      versionId,
      actor: principal,
    });
  }

  @Delete("versions/:versionId")
  @HttpCode(204)
  async abandon(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.authorize(principal, projectId, true);
    await this.core.metricLibrary.abandonDraft({
      projectId,
      versionId,
      actor: principal,
    });
  }

  @Put("versions/:versionId/definitions/:metricKey")
  async saveDefinition(
    @Param("projectId") projectId: string,
    @Param("versionId") requestedVersionId: string,
    @Param("metricKey") metricKey: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    const definition = parseInput(businessMetricSchema, body) as BusinessMetricInput;
    if (definition.metricKey !== metricKey)
      throw new HttpException("METRIC_KEY_PATH_MISMATCH", 400);
    let versionId = requestedVersionId;
    const requested = await this.core.metricLibrary.getVersion(
      projectId,
      requestedVersionId,
    );
    if (requested.version.status !== "draft") {
      const draft = await this.core.metricLibrary.createDraft({
        projectId,
        libraryType: requested.version.libraryType,
        sourceVersionId: requested.version.id,
        actor: principal,
      });
      versionId = draft.id;
    }
    return this.core.metricLibrary.saveBusinessMetric({
      projectId,
      versionId,
      definition,
      actor: principal,
    });
  }

  @Delete("versions/:versionId/definitions/:metricKey")
  async deleteDefinition(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Param("metricKey") metricKey: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ versionId: string }> {
    await this.authorize(principal, projectId, true);
    let mutableVersionId = versionId;
    const requested = await this.core.metricLibrary.getVersion(projectId, versionId);
    if (requested.version.status !== "draft") {
      const draft = await this.core.metricLibrary.createDraft({
        projectId,
        libraryType: requested.version.libraryType,
        sourceVersionId: requested.version.id,
        actor: principal,
      });
      mutableVersionId = draft.id;
    }
    await this.core.metricLibrary.deleteBusinessMetric({
      projectId,
      versionId: mutableVersionId,
      metricKey,
      actor: principal,
    });
    return { versionId: mutableVersionId };
  }

  @Get("versions/:versionId/diff")
  async diff(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    return this.core.metricLibrary.diff(projectId, versionId);
  }

  @Get("versions/:versionId/impact")
  async impact(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    const { metricKey } = parseInput(impactQuerySchema, query);
    return this.core.metricLibrary.impact(projectId, versionId, metricKey);
  }

  @Get("versions/:versionId/lineage/:metricKey")
  async lineage(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Param("metricKey") metricKey: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    return this.core.metricLibrary.lineage(projectId, versionId, metricKey);
  }

  @Get(":metricKey/definition")
  async definition(
    @Param("projectId") projectId: string,
    @Param("metricKey") metricKey: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    const { versionId } = parseInput(definitionQuerySchema, query);
    return this.core.metricLibrary.definition(projectId, metricKey, versionId);
  }

  private async authorize(
    principal: Principal,
    projectId: string,
    write: boolean,
  ): Promise<ProjectRole> {
    const role = await this.core.mysql.getProjectRole(principal, projectId);
    if (!role) throw new HttpException("PROJECT_FORBIDDEN", 403);
    if (
      write &&
      (principal.globalRole !== "admin" || !["owner", "admin"].includes(role))
    ) {
      throw new HttpException("WRITE_FORBIDDEN", 403);
    }
    return role;
  }
}
