import {
  IngestionError,
  readWorkflowFactDefinitions,
} from "@frontend-insight/server-core";
import { z } from "zod";
import { parseInput } from "./http.js";
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Options,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicRoute } from "./auth.guard.js";
import { CoreService } from "./core.service.js";

@Controller("v1/events")
export class IngestionController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @PublicRoute()
  @Options()
  @HttpCode(204)
  options(
    @Headers("origin") origin: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply,
  ): void {
    if (origin) response.header("access-control-allow-origin", origin);
    response.header("vary", "Origin");
    response.header("access-control-allow-methods", "POST, OPTIONS");
    response.header("access-control-allow-headers", "Content-Type");
    response.header("access-control-max-age", "600");
  }

  @PublicRoute()
  @Post("workflow-config")
  @HttpCode(200)
  async workflowConfig(
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    const input = parseInput(
      z
        .object({
          appId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
          env: z.enum(["prod", "staging", "dev"]),
        })
        .strict(),
      body,
    );
    const project = await this.core.mysql.getIngestionProject(input.appId);
    if (
      !project ||
      project.status !== "active" ||
      !origin ||
      !project.origins.includes(origin)
    )
      throw new IngestionError("WORKFLOW_CONFIG_FORBIDDEN", 403);
    response
      .header("access-control-allow-origin", origin)
      .header("vary", "Origin")
      .header("cache-control", "no-store");
    const definitions = (
      await readWorkflowFactDefinitions(this.core.mysql.pool, project.id)
    ).filter(
      (d) => d.status === "active" && d.objectStatus === "active" && !d.archived,
    );
    return {
      appId: input.appId,
      env: input.env,
      schemaVersion: 3,
      definitions: definitions.map((d) => ({
        workflowKey: d.workflowKey,
        version: d.version,
        startPolicy: d.startPolicy,
        timeoutSeconds: d.timeoutSeconds,
        terminalPolicy: d.terminalPolicy,
        steps: d.steps.map((s) => ({
          stepKey: s.stepKey,
          stepOrder: s.stepOrder,
          triggerKind: s.triggerKind,
          triggerConfig: s.triggerConfig,
        })),
      })),
      operationKeys: project.features
        .filter((f) => f.status === "active" && f.operationLifecycleEnabled)
        .map((f) => f.featureKey),
    };
  }

  @PublicRoute()
  @Options("workflow-config")
  @HttpCode(204)
  workflowConfigOptions(
    @Headers("origin") origin: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    this.options(origin, response);
  }

  @PublicRoute()
  @Post()
  @HttpCode(202)
  async ingest(
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
    @Headers("content-length") contentLength: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    if (origin) response.header("access-control-allow-origin", origin);
    response.header("vary", "Origin");
    return this.core.ingestion.accept(body, {
      origin,
      ip: request.ip,
      ...(contentLength ? { contentLength: Number(contentLength) } : {}),
    });
  }
}
