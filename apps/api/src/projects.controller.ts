import {
  CANONICAL_ENVIRONMENTS,
  CANONICAL_RANGES,
} from "@frontend-insight/event-contract";
import type {
  FeatureType,
  Principal,
  ProjectRole,
} from "@frontend-insight/server-core";
import {
  evaluateDataStatus,
  defaultScoreTemplate,
  type ProjectSummaryQuery,
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
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { CoreService } from "./core.service.js";
import { CurrentPrincipal, parseInput } from "./http.js";

const timezone = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      if (/^[+-]/.test(value)) return false;
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "invalid IANA timezone");

const origin = z
  .string()
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        parsed.origin === value &&
        !value.includes("*")
      );
    } catch {
      return false;
    }
  }, "origin must contain scheme and host only");

const createProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    timezone: timezone.default("UTC"),
    retentionDays: z.number().int().min(1).max(365).default(90),
    origins: z.array(origin).min(1).max(20),
    creationId: z.string().uuid().optional(),
    templates: z
      .object({
        operational: z.string().min(1).max(120),
        quality: z.string().min(1).max(120),
      })
      .strict()
      .optional(),
  })
  .strict();
export const projectSummarySchema = z
  .object({
    search: z.string().trim().max(120).default(""),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce
      .number()
      .refine((n) => [12, 24, 48].includes(n))
      .default(12),
    env: z.enum(CANONICAL_ENVIRONMENTS).default("prod"),
    range: z.enum(CANONICAL_RANGES.map((r) => r.key)).default("7d"),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    locate: z.string().uuid().optional(),
  })
  .strict();

export const projectOverviewSchema = z
  .object({
    env: z.enum(CANONICAL_ENVIRONMENTS).default("prod"),
    range: z.enum(CANONICAL_RANGES.map((r) => r.key)).default("7d"),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    metrics: z
      .string()
      .max(1100)
      .transform((s) => (s ? s.split(",") : []))
      .pipe(z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(16))
      .optional(),
  })
  .strict();

const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    timezone: timezone.optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
    origins: z.array(origin).min(1).max(20).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");

const featureType = z.enum(["data_view", "action", "long_view"]);
const createFeatureSchema = z.object({
  featureKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  featureType,
  longViewSuccessAfterMs: z.number().int().min(1_000).max(3_600_000).default(30_000),
  heartbeatIntervalMs: z.number().int().min(5_000).max(3_600_000).default(60_000),
  launchedAt: z.string().datetime().optional(),
  pageDefinitionId: z.string().uuid().nullable().optional(),
  isKeyTask: z.boolean().default(false),
  taskWeight: z.number().positive().max(100).default(1),
  taskTimeoutSeconds: z.number().int().min(30).max(86_400).default(900),
  operationLifecycleEnabled: z.boolean().default(false),
  configurationEffectiveFrom: z.string().datetime().optional(),
});

const updateFeatureSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).nullable().optional(),
    status: z.enum(["active", "disabled"]).optional(),
    longViewSuccessAfterMs: z.number().int().min(1_000).max(3_600_000).optional(),
    heartbeatIntervalMs: z.number().int().min(5_000).max(3_600_000).optional(),
    launchedAt: z.string().datetime().nullable().optional(),
    pageDefinitionId: z.string().uuid().nullable().optional(),
    isKeyTask: z.boolean().optional(),
    taskWeight: z.number().positive().max(100).optional(),
    taskTimeoutSeconds: z.number().int().min(30).max(86_400).optional(),
    operationLifecycleEnabled: z.boolean().optional(),
    configurationEffectiveFrom: z.string().datetime().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");

const membershipSchema = z.object({
  role: z.enum(["owner", "admin", "viewer"]),
});

@Controller("api/projects")
export class ProjectsController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal) {
    return this.core.mysql.listProjects(principal);
  }

  @Get("summary")
  summary(@Query() raw: unknown, @CurrentPrincipal() principal: Principal) {
    return this.core.projectSummary.summary(
      principal,
      parseInput(projectSummarySchema, raw) as ProjectSummaryQuery,
    );
  }
  @Get("templates")
  templates(@CurrentPrincipal() principal: Principal) {
    if (principal.globalRole !== "admin")
      throw new HttpException("WRITE_FORBIDDEN", 403);
    return {
      operational: defaultScoreTemplate("operational"),
      quality: defaultScoreTemplate("quality"),
    };
  }
  @Get(":projectId/access")
  async access(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    const role = await this.requireProject(principal, projectId, false);
    const project = await this.core.mysql.getProject(projectId);
    return { ...project, role };
  }

  @Get(":projectId/overview")
  async overview(
    @Param("projectId") projectId: string,
    @Query() raw: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.requireProject(principal, projectId, false);
    return this.core.projectOverview.overview(
      projectId,
      parseInput(projectOverviewSchema, raw),
    );
  }

  @Post()
  async create(@Body() rawBody: unknown, @CurrentPrincipal() principal: Principal) {
    if (principal.globalRole !== "admin")
      throw new HttpException("WRITE_FORBIDDEN", 403);
    const body = parseInput(createProjectSchema, rawBody);
    const templates = body.templates ?? {
      operational: defaultScoreTemplate("operational").version,
      quality: defaultScoreTemplate("quality").version,
    };
    return this.core.mysql.createProject({
      ...body,
      templateVersions: templates,
      actor: principal,
      initialize: (connection, projectId) =>
        this.core.scores.initializeProject(connection, {
          projectId,
          timezone: body.timezone,
          actor: principal,
          templates,
        }),
    });
  }

  @Patch(":projectId")
  async update(
    @Param("projectId") projectId: string,
    @Body() rawBody: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.requireProject(principal, projectId, true);
    const current = await this.core.mysql.getProject(projectId);
    if (!current) throw new HttpException("PROJECT_NOT_FOUND", 404);
    const body = parseInput(updateProjectSchema, rawBody);
    const updated = await this.core.mysql.updateProject(projectId, {
      ...body,
      actor: principal,
    });
    this.core.ingestion.invalidateProject(current.appId);
    return updated;
  }

  @Get(":projectId/features")
  async listFeatures(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.requireProject(principal, projectId, false);
    return this.core.mysql.listFeatures(projectId);
  }

  @Post(":projectId/features")
  async createFeature(
    @Param("projectId") projectId: string,
    @Body() rawBody: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.requireProject(principal, projectId, true);
    const body = parseInput(createFeatureSchema, rawBody);
    const feature = await this.core.mysql.createFeature({
      ...body,
      featureType: body.featureType as FeatureType,
      projectId,
      actor: principal,
    });
    const project = await this.core.mysql.getProject(projectId);
    if (project) this.core.ingestion.invalidateProject(project.appId);
    return feature;
  }

  @Patch(":projectId/features/:featureId")
  async updateFeature(
    @Param("projectId") projectId: string,
    @Param("featureId") featureId: string,
    @Body() rawBody: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.requireProject(principal, projectId, true);
    const body = parseInput(updateFeatureSchema, rawBody);
    const feature = await this.core.mysql.updateFeature(projectId, featureId, {
      ...body,
      actor: principal,
    });
    const project = await this.core.mysql.getProject(projectId);
    if (project) this.core.ingestion.invalidateProject(project.appId);
    return feature;
  }

  @Get(":projectId/onboarding/status")
  async onboarding(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.requireProject(principal, projectId, false);
    const project = await this.core.mysql.getProject(projectId);
    if (!project) throw new HttpException("PROJECT_NOT_FOUND", 404);
    return {
      project,
      status: await this.core.mysql.onboardingStatus(projectId),
      integration: {
        package: "@frontend-insight/web-tracker",
        endpoint: "/v1/events",
        appId: project.appId,
        csp: "connect-src 'self' <frontend-insight-api-origin>",
      },
    };
  }

  @Get(":projectId/members")
  async listMembers(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.requireProject(principal, projectId, true);
    return this.core.mysql.listProjectMembers(projectId);
  }

  @Put(":projectId/members/:userId")
  async setMember(
    @Param("projectId") projectId: string,
    @Param("userId") userId: string,
    @Body() rawBody: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.requireProject(principal, projectId, true);
    const body = parseInput(membershipSchema, rawBody);
    await this.core.mysql.setProjectMember({
      projectId,
      userId,
      role: body.role,
      actor: principal,
    });
    return { projectId, userId, role: body.role };
  }

  @Delete(":projectId/members/:userId")
  @HttpCode(204)
  async removeMember(
    @Param("projectId") projectId: string,
    @Param("userId") userId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.requireProject(principal, projectId, true);
    await this.core.mysql.removeProjectMember({ projectId, userId, actor: principal });
  }

  @Get(":projectId/data-status")
  async dataStatus(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.requireProject(principal, projectId, false);
    return evaluateDataStatus(await this.core.mysql.getDataStatus(projectId));
  }

  private async requireProject(
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
