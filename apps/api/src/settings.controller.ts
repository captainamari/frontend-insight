import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveProjectCalendar } from "@frontend-insight/event-contract/project-range";
import {
  evaluateDataStatus,
  evaluateAbnormal,
  probeDistribution,
  R7_SDK_VERSION,
  EXPORT_KINDS,
  type Principal,
} from "@frontend-insight/server-core";
import { CoreService } from "./core.service.js";
import { CurrentPrincipal, parseInput } from "./http.js";
import { PublicRoute } from "./auth.guard.js";

const uuid = z.string().uuid();
const env = z.enum(["dev", "staging", "prod"]);
const instant = z.string().datetime({ offset: true });
const safeText = z.string().trim().min(1).max(1000);
export const settingsRange = z
  .object({
    env: env.default("prod"),
    range: z.enum(["7d", "30d", "90d", "180d", "365d", "custom"]).default("7d"),
    from: instant.optional(),
    to: instant.optional(),
  })
  .strict();
export const probeSchema = z
  .object({
    version: z
      .string()
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/)
      .max(32),
    status: z.enum(["recommended", "supported", "deprecated", "blocked"]),
    contractVersion: z.literal(3),
    releaseNotes: safeText,
    upgradeAdvice: safeText,
    confirmBlocked: z.boolean().optional(),
  })
  .strict();
export const exportSchema = z
  .object({
    kind: z.enum(EXPORT_KINDS),
    scope: z
      .object({
        env,
        from: instant,
        to: instant,
        maxRangeDays: z.number().int().min(1).max(90),
        expiresAt: instant,
        rateLimit: z.number().int().min(1).max(600),
      })
      .strict(),
  })
  .strict();
export const exportQuery = z
  .object({ env, from: instant, to: instant, cursor: z.string().max(2048).optional() })
  .strict()
  .refine(
    (v) => Date.parse(v.from) < Date.parse(v.to) && Date.parse(v.to) <= Date.now(),
    "invalid range",
  );
const subject = z.string().regex(/^[a-f0-9]{24}$/);
export const ruleSchema = z
  .object({
    ruleKey: z.enum([
      "outside_hours",
      "historical_volume",
      "multi_device",
      "multi_ip",
      "permission_denied",
    ]),
    config: z
      .object({
        env,
        threshold: z.number().positive().max(1000000),
        minimumSample: z.number().int().min(1).max(100000),
        baselineDays: z.number().int().min(1).max(60),
        minimumBaselineDays: z.number().int().min(1).max(60),
        multiplier: z.number().min(1).max(100),
        workStart: z.number().int().min(0).max(23),
        workEnd: z.number().int().min(1).max(24),
        workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        visibleRoles: z
          .array(z.enum(["owner", "admin", "viewer"]))
          .min(1)
          .max(3),
        sharedSubjects: z.array(subject).max(100),
        exceptions: z
          .array(
            z
              .object({
                subject,
                from: instant,
                to: instant,
                reason: z.enum(["travel", "on_call", "shared_account"]),
              })
              .strict()
              .refine((v) => Date.parse(v.from) < Date.parse(v.to)),
          )
          .max(100),
      })
      .strict(),
  })
  .strict();
const approvalSchema = z
  .object({
    managementApprover: safeText,
    securityApprover: safeText,
    approvedAt: instant,
    source: safeText,
    attested: z.literal(true),
  })
  .strict()
  .refine(
    (v) => Date.parse(v.approvedAt) <= Date.now(),
    "approval cannot be in future",
  );

@Controller("api/projects/:projectId/settings")
export class SettingsController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}
  private async access(p: Principal, id: string, write = false) {
    parseInput(uuid, id);
    const role = await this.core.mysql.getProjectRole(p, id);
    if (!role) throw new HttpException("PROJECT_FORBIDDEN", 403);
    if (write && (p.globalRole !== "admin" || !["owner", "admin"].includes(role)))
      throw new HttpException("WRITE_FORBIDDEN", 403);
    return role;
  }
  private async range(projectId: string, raw: unknown) {
    const input = parseInput(settingsRange, raw);
    const project = await this.core.mysql.getProject(projectId);
    if (!project) throw new HttpException("PROJECT_NOT_FOUND", 404);
    try {
      const q = resolveProjectCalendar(input, project.timezone);
      if (Date.parse(q.to) > Date.now()) throw new Error();
      return { project, q };
    } catch {
      throw new HttpException("SETTINGS_RANGE_INVALID", 400);
    }
  }
  @Get("integration")
  @Header("Cache-Control", "no-store")
  async integration(@Param("projectId") id: string, @CurrentPrincipal() p: Principal) {
    await this.access(p, id);
    const project = await this.core.mysql.getProject(id),
      policies = await this.core.settings.probes(id);
    const configured = policies.find((v) => v.status === "recommended"),
      current = policies.find((v) => v.version === R7_SDK_VERSION);
    const recommended =
      configured?.version ??
      (!current || current.status === "supported" ? R7_SDK_VERSION : null);
    return {
      project,
      endpoint: "/v1/events",
      sdk: {
        package: "@frontend-insight/web-tracker",
        version: recommended,
        contractVersion: 3,
        moduleUrl: recommended ? `/api/sdk/${recommended}/index.js` : null,
        source: configured ? "project_policy" : "bundled_default",
      },
      status: evaluateDataStatus(await this.core.mysql.getDataStatus(id)),
      privacy:
        "不读取 Authorization、Cookie、Local/Session Storage token、表单、DOM 文本或 URL query；仅使用 SDK 自有随机设备标识。",
    };
  }
  @Post("test-event")
  @Header("Cache-Control", "no-store")
  async testEvent(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
  ) {
    await this.access(p, id, true);
    const input = parseInput(z.object({ env }).strict(), raw);
    const project = await this.core.mysql.getProject(id);
    if (!project) throw new HttpException("PROJECT_NOT_FOUND", 404);
    const origin = request.headers.origin;
    if (!origin || !project.origins.includes(origin))
      throw new HttpException("PROJECT_ORIGIN_FORBIDDEN", 403);
    const now = Date.now(),
      eventId = "evt_" + randomUUID().replaceAll("-", "");
    const accepted = await this.core.ingestion.accept(
      {
        schemaVersion: 3,
        sentAt: now,
        sdk: { name: "settings-test", version: R7_SDK_VERSION },
        events: [
          {
            eventId,
            event: "page_view",
            appId: project.appId,
            env: input.env,
            release: "settings-test",
            timestamp: now,
            pageUrl: origin + "/settings-test",
            pageRoute: "/settings-test",
            userId: null,
            deptId: null,
            roleId: null,
            deviceId: "dev_" + randomUUID().replaceAll("-", ""),
            sessionId: "ses_" + randomUUID().replaceAll("-", ""),
            pageViewId: "pv_" + randomUUID().replaceAll("-", ""),
            ua: "Other",
            os: "Other",
            browser: "Other",
            payload: {},
          },
        ],
      },
      { origin, ip: request.ip },
    );
    await this.core.settings.audit(
      this.core.mysql.pool,
      id,
      p.userId,
      "integration.test_sent",
      eventId,
      request.id,
      { env: input.env, collectorRequestId: accepted.requestId },
    );
    return { ...accepted, eventId };
  }
  @Get("test-receipt")
  async receipt(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
    @Query() raw: unknown,
  ) {
    await this.access(p, id);
    const q = parseInput(
      z
        .object({
          env,
          eventId: z.string().regex(/^evt_[a-zA-Z0-9_-]{8,100}$/),
          requestId: uuid,
        })
        .strict(),
      raw,
    );
    const queryable = await this.core.settingsFacts.receipt(
      id,
      q.env,
      q.eventId,
      q.requestId,
    );
    return {
      eventId: q.eventId,
      requestId: q.requestId,
      ingested: queryable,
      queryable,
      state: queryable ? "queryable" : "awaiting_storage",
      reason: queryable
        ? null
        : "已接收不等于入库；等待 consumer，超时请按请求 ID 检查 Kafka/consumer/ClickHouse。",
      pipeline: evaluateDataStatus(await this.core.mysql.getDataStatus(id)),
    };
  }
  @Get("probe-versions")
  async probes(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
    @Query() raw: unknown,
  ) {
    await this.access(p, id);
    const { q } = await this.range(id, raw),
      facts = await this.core.settingsFacts.read(id, q.env, q.from, q.to);
    return {
      projectId: id,
      query: q,
      policies: await this.core.settings.probes(id),
      ...probeDistribution(facts.rows, q.from, q.to),
      statistics: facts.statistics,
    };
  }
  @Put("probe-versions")
  async saveProbe(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
  ) {
    await this.access(p, id, true);
    return this.core.settings.saveProbe(
      id,
      p.userId,
      parseInput(probeSchema, raw),
      request.id,
    );
  }
  @Delete("probe-versions/:version")
  async deleteProbe(
    @Param("projectId") id: string,
    @Param("version") version: string,
    @CurrentPrincipal() p: Principal,
    @Req() request: FastifyRequest,
  ) {
    await this.access(p, id, true);
    return this.core.settings.deleteProbe(
      id,
      p.userId,
      parseInput(probeSchema.shape.version, version),
      request.id,
    );
  }
  @Get("export-interfaces")
  async interfaces(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
    @Query() raw: unknown,
  ) {
    await this.access(p, id);
    const q = parseInput(
      z.object({ page: z.coerce.number().int().min(1).max(100).default(1) }).strict(),
      raw,
    );
    return this.core.settings.interfaces(id, q.page);
  }
  @Post("export-interfaces")
  async createInterface(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
  ) {
    await this.access(p, id, true);
    const v = parseInput(exportSchema, raw);
    return this.core.settings.createInterface(
      id,
      p.userId,
      v.kind,
      v.scope,
      request.id,
    );
  }
  @Put("export-interfaces/:interfaceId")
  async updateInterface(
    @Param("projectId") id: string,
    @Param("interfaceId") interfaceId: string,
    @CurrentPrincipal() p: Principal,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
  ) {
    await this.access(p, id, true);
    const v = parseInput(exportSchema.pick({ scope: true }).strict(), raw);
    return this.core.settings.updateInterface(
      id,
      p.userId,
      parseInput(uuid, interfaceId),
      v.scope,
      request.id,
    );
  }
  @Post("export-interfaces/:interfaceId/:action")
  @Header("Cache-Control", "no-store")
  async interfaceAction(
    @Param("projectId") id: string,
    @Param("interfaceId") interfaceId: string,
    @Param("action") action: string,
    @CurrentPrincipal() p: Principal,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
  ) {
    await this.access(p, id, true);
    parseInput(z.object({}).strict(), raw);
    return this.core.settings.changeInterface(
      id,
      p.userId,
      parseInput(uuid, interfaceId),
      parseInput(z.enum(["enable", "disable", "rotate", "revoke"]), action),
      request.id,
    );
  }
  @Get("abnormal-rules")
  async rules(@Param("projectId") id: string, @CurrentPrincipal() p: Principal) {
    await this.access(p, id, true);
    return this.core.settings.rules(id);
  }
  @Post("abnormal-rules")
  async createRule(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
  ) {
    await this.access(p, id, true);
    const v = parseInput(ruleSchema, raw);
    return this.core.settings.createRule(id, p.userId, v.ruleKey, v.config, request.id);
  }
  @Post("abnormal-rules/:versionId/:action")
  async ruleAction(
    @Param("projectId") id: string,
    @Param("versionId") versionId: string,
    @Param("action") action: string,
    @CurrentPrincipal() p: Principal,
    @Body() raw: unknown,
    @Req() request: FastifyRequest,
  ) {
    const role = await this.access(p, id, true);
    const a = parseInput(z.enum(["approve", "enable", "disable"]), action);
    if (a === "approve" && role !== "owner")
      throw new HttpException("OWNER_ATTESTATION_REQUIRED", 403);
    const approval = a === "approve" ? parseInput(approvalSchema, raw) : null;
    if (a !== "approve") parseInput(z.object({}).strict(), raw);
    return this.core.settings.ruleAction(
      id,
      p.userId,
      parseInput(uuid, versionId),
      a,
      approval,
      request.id,
    );
  }
  @Get("abnormal-evidence")
  @Header("Cache-Control", "no-store")
  async evidence(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
    @Query() raw: unknown,
    @Req() request: FastifyRequest,
  ) {
    const role = await this.access(p, id);
    const input = parseInput(
        settingsRange.extend({ export: z.enum(["json"]).optional() }).strict(),
        raw,
      ),
      { export: exportFormat, ...range } = input;
    const { project, q } = await this.range(id, range),
      rules = (await this.core.settings.rules(id)).filter(
        (r) =>
          r.status === "enabled" &&
          r.config.env === q.env &&
          r.config.visibleRoles.includes(role),
      );
    if (!rules.length) {
      await this.core.settings.audit(
        this.core.mysql.pool,
        id,
        p.userId,
        "abnormal.view",
        id,
        request.id,
        { state: "NO_VISIBLE_APPROVED_RULE" },
      );
      return {
        query: q,
        items: [],
        status: "unavailable",
        reason: "NO_VISIBLE_APPROVED_RULE",
      };
    }
    const baseline = Math.max(...rules.map((r) => r.config.baselineDays));
    const facts = await this.core.settingsFacts.read(
      id,
      q.env,
      new Date(Date.parse(q.from) - baseline * 86400000).toISOString(),
      q.to,
    );
    const items = rules.map((r) => ({
      versionId: r.id,
      ruleKey: r.ruleKey,
      approval: r.approval,
      ...evaluateAbnormal(
        facts.rows.filter(
          (e) => e.at >= Date.parse(q.from) - r.config.baselineDays * 86400000,
        ),
        r.ruleKey,
        r.config,
        q.from,
        q.to,
        project.timezone,
      ),
    }));
    for (const r of items)
      if (r.items.some((e) => e.status === "hit"))
        await this.core.settings.audit(
          this.core.mysql.pool,
          id,
          p.userId,
          "abnormal.hit",
          r.versionId,
          request.id,
          {
            query: { env: q.env, from: q.from, to: q.to },
            count: r.items.filter((e) => e.status === "hit").length,
          },
        );
    await this.core.settings.audit(
      this.core.mysql.pool,
      id,
      p.userId,
      exportFormat ? "abnormal.export" : "abnormal.view",
      id,
      request.id,
      { versions: items.map((i) => i.versionId) },
    );
    return {
      query: q,
      items,
      statistics: facts.statistics,
      status: "observed",
      notice:
        "仅调查证据，不生成个人评分或绩效排名。设备数不代表 IP 数；历史基线仅含已观测操作日。",
    };
  }
  @Get("audit")
  async audit(
    @Param("projectId") id: string,
    @CurrentPrincipal() p: Principal,
    @Query() raw: unknown,
  ) {
    await this.access(p, id, true);
    const q = parseInput(
      z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).strict(),
      raw,
    );
    return this.core.settings.auditPage(id, q.page);
  }
}

@Controller("api/sdk")
export class SdkDistributionController {
  @PublicRoute()
  @Get(":version/index.js")
  @Header("Content-Type", "text/javascript; charset=utf-8")
  @Header("Access-Control-Allow-Origin", "*")
  @Header("Cache-Control", "no-cache")
  async bundle(@Param("version") version: string) {
    if (version !== R7_SDK_VERSION)
      throw new HttpException("SDK_BUNDLE_NOT_FOUND", 404);
    for (const base of [process.cwd(), resolve(process.cwd(), "../..")]) {
      try {
        return await readFile(
          resolve(base, "packages/web-tracker/dist/index.js"),
          "utf8",
        );
      } catch {
        /* Try repository root for source and packaged launches. */
      }
    }
    throw new HttpException("SDK_BUNDLE_UNAVAILABLE", 503);
  }
}

@Controller("api/external/projects/:projectId")
export class ExternalSettingsController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}
  @PublicRoute()
  @Get(":kind")
  @Header("Cache-Control", "no-store")
  async read(
    @Param("projectId") id: string,
    @Param("kind") rawKind: string,
    @Query() raw: unknown,
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    // Server-generated IDs; never echo credentials or user-controlled query values in errors/audit.
    const requestId = randomUUID();
    response.header("x-request-id", requestId);
    try {
      parseInput(uuid, id);
      const kind = parseInput(z.enum(EXPORT_KINDS), rawKind),
        q = parseInput(exportQuery, raw);
      if (q.cursor && kind !== "quality_summary")
        throw new HttpException("CURSOR_NOT_SUPPORTED", 400);
      if (!authorization || !/^Bearer fi_[A-Za-z0-9_-]{43}$/.test(authorization))
        throw new HttpException("EXPORT_CREDENTIAL_INVALID", 401);
      await this.core.settings.authorizeExport(
        id,
        kind,
        authorization.slice(7),
        q,
        requestId,
      );
      const overview = await this.core.projectOverview.overview(id, {
        env: q.env,
        range: "custom",
        from: q.from,
        to: q.to,
      });
      const common = {
        requestId,
        projectId: id,
        query: overview.query,
        pipeline: overview.pipeline,
        data: overview.data,
        identity: overview.identity,
        version: overview.metrics.version,
      };
      if (kind === "metric_snapshot")
        return {
          ...common,
          metrics: overview.metrics.cards,
          operational: overview.operational,
          quality: overview.quality,
        };
      if (kind === "metric_trend")
        return {
          ...common,
          trends: overview.metrics.trends,
          boundaries: overview.metrics.boundaries,
        };
      if (kind === "quality_summary") {
        const quality = await this.core.pageQuality.read(id, {
          env: q.env,
          from: q.from,
          to: q.to,
          category: "all",
          mode: "latest",
          limit: 20,
          ...(q.cursor ? { cursor: q.cursor } : {}),
        });
        return {
          ...common,
          quality: overview.quality,
          groups: {
            ...quality,
            routes: undefined,
            items: quality.items.map((v) => ({
              groupId: v.groupId,
              category: v.category,
              occurrences: v.occurrences,
              lastObservedAt: v.timestamp,
            })),
            definitionVersion: quality.definitionVersion,
          },
        };
      }
      response.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
      // Label names AND values are finite; no route, message, account, version or arbitrary metric key.
      const state =
        overview.data.state === "no_data"
          ? "no_data"
          : overview.data.state === "broken"
            ? "broken"
            : "observed";
      const lines = [
        `# HELP frontend_insight_data_state Observed scoped data state`,
        `# TYPE frontend_insight_data_state gauge`,
        `frontend_insight_data_state{service="frontend_insight",env="${q.env}",state="${state}"} 1`,
        `# HELP frontend_insight_score Versioned score; missing values are omitted`,
        `# TYPE frontend_insight_score gauge`,
        `# HELP frontend_insight_score_available Whether the versioned score is available`,
        `# TYPE frontend_insight_score_available gauge`,
      ];
      for (const [type, entry] of [
        ["operational", overview.operational],
        ["quality", overview.quality],
      ] as const) {
        const value = entry.result?.value;
        const available =
          entry.result?.status === "available" &&
          typeof value === "number" &&
          Number.isFinite(value);
        const labels = `service="frontend_insight",env="${q.env}",type="${type}"`;
        lines.push(`frontend_insight_score_available{${labels}} ${available ? 1 : 0}`);
        if (available) lines.push(`frontend_insight_score{${labels}} ${value}`);
      }
      return lines.join("\n") + "\n";
    } catch (error) {
      const e = error as { statusCode?: number; code?: string };
      const status =
        error instanceof HttpException ? error.getStatus() : (e.statusCode ?? 503);
      const code =
        error instanceof HttpException
          ? typeof error.getResponse() === "string"
            ? String(error.getResponse())
            : "EXPORT_REQUEST_INVALID"
          : typeof e.code === "string" && /^EXPORT_[A-Z_]+$/.test(e.code)
            ? e.code
            : "EXPORT_UNAVAILABLE";
      response.status(status);
      return { code, requestId };
    }
  }
}
