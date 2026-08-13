import {
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Options,
  Param,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { PublicRoute } from "./auth.guard.js";
import { CoreService } from "./core.service.js";

const projectKeyPattern = /^fi_public_[A-Za-z0-9_-]{8,64}$/;

function disabledCollectors() {
  const disabled = { enabled: false, sampleRate: 1 };
  return {
    api: { ...disabled, slowThresholdMs: 2_000, globalFetch: false },
    resources: { ...disabled },
    firstScreen: { ...disabled },
    listRender: { ...disabled },
    longTasks: { ...disabled },
    blankScreen: { ...disabled },
    breadcrumbs: { ...disabled, allowedActionKeys: [] as string[] },
  };
}

@Controller("v1/collector-config/:projectKey")
export class CollectorConfigController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @PublicRoute()
  @Options()
  options(
    @Headers("origin") origin: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply,
  ): void {
    this.cors(response, origin);
  }

  @PublicRoute()
  @Get()
  async config(
    @Param("projectKey") projectKey: string,
    @Headers("origin") origin: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    if (!projectKeyPattern.test(projectKey)) {
      throw new HttpException("PROJECT_NOT_FOUND", 404);
    }
    const project = await this.core.mysql.getIngestionProject(projectKey);
    if (!project) throw new HttpException("PROJECT_NOT_FOUND", 404);
    if (!origin || !project.origins.includes(origin)) {
      throw new HttpException("ORIGIN_NOT_ALLOWED", 403);
    }
    this.cors(response, origin);
    response.header("cache-control", "no-store");
    const settings = await this.core.mysql.getCollectorSettings(project.id);
    return {
      schemaVersion: 1,
      version: settings?.version ?? 0,
      effectiveFrom: settings?.effectiveFrom ?? null,
      collectors: settings
        ? {
            api: settings.api,
            resources: settings.resources,
            firstScreen: settings.firstScreen,
            listRender: settings.listRender,
            longTasks: settings.longTasks,
            blankScreen: settings.blankScreen,
            breadcrumbs: settings.breadcrumbs,
          }
        : disabledCollectors(),
    };
  }

  private cors(response: FastifyReply, origin: string | undefined): void {
    if (origin) response.header("access-control-allow-origin", origin);
    response.header("vary", "Origin");
    response.header("access-control-allow-methods", "GET, OPTIONS");
    response.header("access-control-allow-headers", "Content-Type");
    response.header("access-control-max-age", "60");
  }
}
