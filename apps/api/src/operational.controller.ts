import {
  DEFAULT_OPERATIONAL_PROFILE_ITEMS,
  METRIC_CATALOG,
  metricDefinition,
  metricLineage,
  normalizePageRouteDefinition,
  validateWorkflowDefinition,
  type AnalyticsRange,
  type MetricDimensionKey,
  type MetricProfileItem,
  type Principal,
  type ProjectRole,
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

const moduleKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const createModuleSchema = z
  .object({
    moduleKey,
    name: z.string().trim().min(1).max(120),
    displayOrder: z.number().int().min(-10_000).max(10_000).default(0),
    effectiveFrom: z.string().datetime().optional(),
  })
  .strict();
const updateModuleSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    displayOrder: z.number().int().min(-10_000).max(10_000).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    effectiveFrom: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.displayOrder !== undefined ||
      value.status !== undefined,
  );

const pageRoute = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^\/[^?#]*$/, "route must start with / and omit query/hash");
const pageFields = {
  moduleId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  templateKey: z.enum(["monitoring_dashboard", "analysis_view", "task_operation"]),
  isCore: z.boolean(),
  criticalityWeight: z.number().positive().max(100),
  expectedFrequency: z.enum(["daily", "weekly", "monthly", "ad_hoc"]),
  effectiveFrom: z.string().datetime().optional(),
};
const createPageSchema = z.object({
  pageRoute,
  ...pageFields,
});
const updatePageSchema = z
  .object({
    moduleId: pageFields.moduleId.optional(),
    name: pageFields.name.optional(),
    templateKey: pageFields.templateKey.optional(),
    isCore: pageFields.isCore.optional(),
    criticalityWeight: pageFields.criticalityWeight.optional(),
    expectedFrequency: pageFields.expectedFrequency.optional(),
    status: z.enum(["active", "disabled"]).optional(),
    effectiveFrom: pageFields.effectiveFrom,
  })
  .refine(
    (value) =>
      value.moduleId !== undefined ||
      value.name !== undefined ||
      value.templateKey !== undefined ||
      value.isCore !== undefined ||
      value.criticalityWeight !== undefined ||
      value.expectedFrequency !== undefined ||
      value.status !== undefined,
  );

const workflowKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const workflowStepKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const workflowTriggerKind = z.enum([
  "explicit_sdk",
  "selector",
  "network_request",
  "page_lifecycle",
  "operation_terminal",
]);
const workflowStepSchema = z
  .object({
    stepKey: workflowStepKey,
    name: z.string().trim().min(1).max(120),
    stepOrder: z.number().int().min(1).max(20),
    triggerKind: workflowTriggerKind,
    triggerConfig: z.record(z.string(), z.union([z.string().max(512), z.boolean()])),
  })
  .superRefine((step, context) => {
    const schemas = {
      explicit_sdk: z.object({}).strict(),
      selector: z
        .object({
          event: z.enum(["click", "change"]),
          selector: z.string().trim().min(1).max(256),
        })
        .strict(),
      network_request: z
        .object({
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
          pathPattern: z
            .string()
            .trim()
            .min(1)
            .max(256)
            .regex(/^\/[^?#]*$/, "pathPattern must omit query/hash"),
        })
        .strict(),
      page_lifecycle: z.object({ event: z.enum(["loaded", "refreshed"]) }).strict(),
      operation_terminal: z
        .object({
          operationKey: workflowStepKey,
          state: z.enum(["succeeded", "failed", "canceled"]),
        })
        .strict(),
    } as const;
    const result = schemas[step.triggerKind].safeParse(step.triggerConfig);
    if (!result.success) {
      context.addIssue({
        code: "custom",
        path: ["triggerConfig"],
        message: `invalid ${step.triggerKind} trigger config`,
      });
    }
  });
const workflowConfigurationSchema = z.object({
  startPolicy: z.enum(["explicit_sdk", "first_step"]),
  terminalPolicy: z.object({
    completedStepKey: workflowStepKey,
    failedStepKey: workflowStepKey.nullable(),
    canceledStepKey: workflowStepKey.nullable(),
    timeoutState: z.literal("approximate_abandoned"),
  }),
  timeoutSeconds: z.number().int().min(30).max(604_800),
  steps: z.array(workflowStepSchema).min(2).max(20),
});
const createWorkflowSchema = workflowConfigurationSchema.extend({
  moduleId: z.string().uuid(),
  workflowKey,
  name: z.string().trim().min(1).max(120),
});
const saveWorkflowDraftSchema = workflowConfigurationSchema.extend({
  moduleId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
});
const updateWorkflowSchema = z
  .object({
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
const activateWorkflowSchema = z.object({ versionId: z.string().uuid() });

const listAnalysisObjectsSchema = z.object({
  includeArchived: z.enum(["true", "false"]).default("false"),
  at: z.string().datetime().optional(),
  moduleId: z.string().uuid().optional(),
});

const settingsSchema = z.object({
  targetUsers: z.number().int().positive().max(100_000_000).nullable(),
  expectedActiveWeekdays: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((value) => new Set(value).size === value.length, "weekdays must be unique"),
  effectiveFrom: z.string().datetime().optional(),
});

const dimensionKey = z.enum([
  "usage_coverage",
  "continuity_depth",
  "task_completion",
  "usage_efficiency",
]);
const nullableFinite = z.number().finite().nullable();
const profileItemSchema = z.object({
  metricKey: z.string().min(1).max(96),
  dimensionKey,
  dimensionWeight: z.number().positive().max(1),
  metricWeight: z.number().positive().max(1),
  targetValue: nullableFinite,
  floorValue: nullableFinite,
  ceilingValue: nullableFinite,
  targetMin: nullableFinite,
  targetMax: nullableFinite,
  toleranceMin: nullableFinite,
  toleranceMax: nullableFinite,
  minimumSample: z.number().int().nonnegative().nullable(),
  enabled: z.boolean(),
  required: z.boolean(),
});
const profileItems = z
  .array(profileItemSchema)
  .min(1)
  .max(50)
  .superRefine((items, context) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.metricKey)) {
        context.addIssue({
          code: "custom",
          path: [index, "metricKey"],
          message: "metricKey must be unique",
        });
      }
      seen.add(item.metricKey);
      const definition = metricDefinition(item.metricKey);
      if (!definition || definition.scoreDirection === "none") {
        context.addIssue({
          code: "custom",
          path: [index, "metricKey"],
          message: "metric is not a scoreable catalog definition",
        });
      } else if (item.enabled) {
        if (
          definition.scoreDirection === "higher_better" &&
          (item.targetValue === null ||
            item.floorValue === null ||
            item.targetValue <= item.floorValue)
        ) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "higher_better requires targetValue > floorValue",
          });
        }
        if (
          definition.scoreDirection === "lower_better" &&
          (item.targetValue === null ||
            item.ceilingValue === null ||
            item.ceilingValue <= item.targetValue)
        ) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "lower_better requires ceilingValue > targetValue",
          });
        }
        if (
          definition.scoreDirection === "target_range" &&
          (item.targetMin === null ||
            item.targetMax === null ||
            item.toleranceMin === null ||
            item.toleranceMax === null ||
            item.toleranceMin >= item.targetMin ||
            item.targetMin > item.targetMax ||
            item.targetMax >= item.toleranceMax)
        ) {
          context.addIssue({
            code: "custom",
            path: [index],
            message:
              "target_range requires toleranceMin < targetMin <= targetMax < toleranceMax",
          });
        }
      }
    }
    for (const key of dimensionKey.options) {
      const enabled = items.filter((item) => item.enabled && item.dimensionKey === key);
      if (!enabled.length) continue;
      const metricWeight = enabled.reduce((sum, item) => sum + item.metricWeight, 0);
      if (Math.abs(metricWeight - 1) > 0.000001) {
        context.addIssue({
          code: "custom",
          message: `${key} enabled metric weights must sum to 1`,
        });
      }
      if (
        enabled.some(
          (item) =>
            Math.abs(item.dimensionWeight - enabled[0]!.dimensionWeight) > 0.000001,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: `${key} dimension weight must be consistent`,
        });
      }
    }
    const dimensionWeights = new Map<MetricDimensionKey, number>();
    for (const item of items.filter((candidate) => candidate.enabled)) {
      dimensionWeights.set(
        item.dimensionKey as MetricDimensionKey,
        item.dimensionWeight,
      );
    }
    const sum = [...dimensionWeights.values()].reduce(
      (total, weight) => total + weight,
      0,
    );
    if (Math.abs(sum - 1) > 0.000001) {
      context.addIssue({
        code: "custom",
        message: "enabled dimension weights must sum to 1",
      });
    }
  });
const createProfileSchema = z
  .object({
    profileKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    name: z.string().trim().min(1).max(120),
    templateKey: z.literal("operational_v1").optional(),
    sourceProfileId: z.string().uuid().optional(),
    items: profileItems.optional(),
  })
  .refine(
    (value) =>
      Number(Boolean(value.templateKey)) +
        Number(Boolean(value.sourceProfileId)) +
        Number(Boolean(value.items)) ===
      1,
    "choose exactly one of templateKey, sourceProfileId or items",
  );
const cloneProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  items: profileItems.optional(),
});
const activateProfileSchema = z.object({
  effectiveFrom: z.string().datetime().optional(),
});
const rangeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  timezone: z.string().min(1).max(64),
  granularity: z.enum(["hour", "day"]).default("day"),
});

@Controller("api/projects/:projectId")
export class OperationalController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @Get("modules")
  async listModules(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown = {},
  ) {
    await this.authorize(principal, projectId, false);
    const parsed = parseInput(listAnalysisObjectsSchema, query);
    return this.core.mysql.listModules(projectId, {
      includeArchived: parsed.includeArchived === "true",
      ...(parsed.at ? { at: new Date(parsed.at) } : {}),
    });
  }

  @Post("modules")
  async createModule(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.mysql.createModule({
      ...parseInput(createModuleSchema, body),
      projectId,
      actor: principal,
    });
  }

  @Patch("modules/:moduleId")
  async updateModule(
    @Param("projectId") projectId: string,
    @Param("moduleId") moduleId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.mysql.updateModule(projectId, moduleId, {
      ...parseInput(updateModuleSchema, body),
      actor: principal,
    });
  }

  @Post("modules/:moduleId/archive")
  @HttpCode(204)
  async archiveModule(
    @Param("projectId") projectId: string,
    @Param("moduleId") moduleId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.authorize(principal, projectId, true);
    await this.core.mysql.archiveModule({
      projectId,
      moduleId,
      actor: principal,
    });
  }

  @Post("modules/:moduleId/restore")
  async restoreModule(
    @Param("projectId") projectId: string,
    @Param("moduleId") moduleId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.mysql.restoreModule({ projectId, moduleId, actor: principal });
  }

  @Get("page-definitions")
  async listPages(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown = {},
  ) {
    await this.authorize(principal, projectId, false);
    const parsed = parseInput(listAnalysisObjectsSchema, query);
    return this.core.mysql.listPageDefinitions(projectId, {
      includeArchived: parsed.includeArchived === "true",
      ...(parsed.at ? { at: new Date(parsed.at) } : {}),
      ...(parsed.moduleId ? { moduleId: parsed.moduleId } : {}),
    });
  }

  @Post("page-definitions")
  async createPage(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    const parsed = parseInput(createPageSchema, body);
    return this.core.mysql.createPageDefinition({
      ...parsed,
      pageRoute: normalizePageRouteDefinition(parsed.pageRoute).pageRoute,
      projectId,
      actor: principal,
    });
  }

  @Patch("page-definitions/:pageId")
  async updatePage(
    @Param("projectId") projectId: string,
    @Param("pageId") pageId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.mysql.updatePageDefinition(projectId, pageId, {
      ...parseInput(updatePageSchema, body),
      actor: principal,
    });
  }

  @Post("page-definitions/:pageId/archive")
  @HttpCode(204)
  async archivePage(
    @Param("projectId") projectId: string,
    @Param("pageId") pageId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.authorize(principal, projectId, true);
    await this.core.mysql.archivePageDefinition({
      projectId,
      pageId,
      actor: principal,
    });
  }

  @Post("page-definitions/:pageId/restore")
  async restorePage(
    @Param("projectId") projectId: string,
    @Param("pageId") pageId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.mysql.restorePageDefinition({
      projectId,
      pageId,
      actor: principal,
    });
  }

  @Get("workflow-definitions")
  async listWorkflows(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown = {},
  ) {
    await this.authorize(principal, projectId, false);
    const parsed = parseInput(listAnalysisObjectsSchema, query);
    return this.core.mysql.listWorkflowDefinitions(projectId, {
      includeArchived: parsed.includeArchived === "true",
      ...(parsed.moduleId ? { moduleId: parsed.moduleId } : {}),
    });
  }

  @Post("workflow-definitions")
  async createWorkflow(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    const parsed = parseInput(createWorkflowSchema, body);
    validateWorkflowDefinition(parsed);
    return this.core.mysql.createWorkflowDefinition({
      ...parsed,
      projectId,
      actor: principal,
    });
  }

  @Patch("workflow-definitions/:workflowId")
  async updateWorkflow(
    @Param("projectId") projectId: string,
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.mysql.updateWorkflowDefinition(projectId, workflowId, {
      ...parseInput(updateWorkflowSchema, body),
      actor: principal,
    });
  }

  @Post("workflow-definitions/:workflowId/archive")
  @HttpCode(204)
  async archiveWorkflow(
    @Param("projectId") projectId: string,
    @Param("workflowId") workflowId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.authorize(principal, projectId, true);
    await this.core.mysql.archiveWorkflowDefinition({
      projectId,
      workflowId,
      actor: principal,
    });
  }

  @Post("workflow-definitions/:workflowId/restore")
  async restoreWorkflow(
    @Param("projectId") projectId: string,
    @Param("workflowId") workflowId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.mysql.restoreWorkflowDefinition({
      projectId,
      workflowId,
      actor: principal,
    });
  }

  @Get("operation-registry")
  async operationRegistry(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    return (await this.core.mysql.listFeatures(projectId))
      .filter(
        (feature) => feature.status === "active" && feature.operationLifecycleEnabled,
      )
      .map((feature) => ({
        operationKey: feature.featureKey,
        name: feature.name,
      }));
  }

  @Put("workflow-definitions/:workflowId/draft")
  async saveWorkflowDraft(
    @Param("projectId") projectId: string,
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    const parsed = parseInput(saveWorkflowDraftSchema, body);
    validateWorkflowDefinition(parsed);
    return this.core.mysql.saveWorkflowDraft({
      ...parsed,
      projectId,
      workflowId,
      actor: principal,
    });
  }

  @Post("workflow-definitions/:workflowId/activate")
  async activateWorkflow(
    @Param("projectId") projectId: string,
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    const parsed = parseInput(activateWorkflowSchema, body);
    return this.core.mysql.activateWorkflowDefinitionVersion({
      projectId,
      workflowId,
      versionId: parsed.versionId,
      actor: principal,
    });
  }

  @Get("operational-settings")
  async settings(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    return {
      active: await this.core.mysql.getOperationalSettings(projectId),
      versions: await this.core.mysql.listOperationalSettings(projectId),
    };
  }

  @Post("operational-settings/versions")
  async createSettings(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.mysql.createOperationalSettingsVersion({
      ...parseInput(settingsSchema, body),
      projectId,
      actor: principal,
    });
  }

  @Get("metric-profiles")
  async profiles(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    return this.core.mysql.listMetricProfiles(projectId);
  }

  @Post("metric-profiles")
  async createProfile(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    const parsed = parseInput(createProfileSchema, body);
    return this.core.mysql.createMetricProfileVersion({
      projectId,
      profileKey: parsed.profileKey,
      name: parsed.name,
      ...(parsed.sourceProfileId ? { sourceProfileId: parsed.sourceProfileId } : {}),
      items: parsed.templateKey
        ? DEFAULT_OPERATIONAL_PROFILE_ITEMS.map((item) => ({ ...item }))
        : (parsed.items as
            Array<Omit<MetricProfileItem, "id" | "profileId">> | undefined),
      actor: principal,
    });
  }

  @Post("metric-profiles/:profileId/versions")
  async cloneProfile(
    @Param("projectId") projectId: string,
    @Param("profileId") profileId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    const parsed = parseInput(cloneProfileSchema, body);
    const source = (await this.core.mysql.listMetricProfiles(projectId)).find(
      (item) => item.id === profileId,
    );
    if (!source) throw new HttpException("METRIC_PROFILE_NOT_FOUND", 404);
    return this.core.mysql.createMetricProfileVersion({
      projectId,
      profileKey: source.profileKey,
      name: parsed.name,
      sourceProfileId: profileId,
      ...(parsed.items
        ? {
            items: parsed.items as Array<Omit<MetricProfileItem, "id" | "profileId">>,
          }
        : {}),
      actor: principal,
    });
  }

  @Post("metric-profiles/:profileId/activate")
  async activateProfile(
    @Param("projectId") projectId: string,
    @Param("profileId") profileId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, true);
    return this.core.mysql.activateMetricProfile({
      ...parseInput(activateProfileSchema, body),
      projectId,
      profileId,
      actor: principal,
    });
  }

  @Delete("metric-profiles/:profileId")
  @HttpCode(204)
  async retireProfile(
    @Param("projectId") projectId: string,
    @Param("profileId") profileId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.authorize(principal, projectId, true);
    await this.core.mysql.retireMetricProfile({
      projectId,
      profileId,
      actor: principal,
    });
  }

  @Get("operational-index")
  async index(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    return this.core.analytics.operationalIndex(
      projectId,
      parseInput(rangeSchema, query) as AnalyticsRange,
    );
  }

  @Get("metrics/:metricKey/definition")
  async definition(
    @Param("projectId") projectId: string,
    @Param("metricKey") metricKey: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    const definition = metricDefinition(metricKey);
    if (!definition) throw new HttpException("METRIC_DEFINITION_NOT_FOUND", 404);
    return definition;
  }

  @Get("metrics")
  async catalog(
    @Param("projectId") projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    return METRIC_CATALOG;
  }

  @Get("metrics/:metricKey/lineage")
  async lineage(
    @Param("projectId") projectId: string,
    @Param("metricKey") metricKey: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.authorize(principal, projectId, false);
    const lineage = metricLineage(metricKey);
    if (!lineage) throw new HttpException("METRIC_DEFINITION_NOT_FOUND", 404);
    return lineage;
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
