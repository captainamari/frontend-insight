import {
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  Inject,
  Param,
  Put,
  Post,
  StreamableFile,
} from "@nestjs/common";
import {
  DiagnosticAccessError,
  DiagnosticQueryError,
  ERROR_CATEGORIES,
  type Principal,
} from "@frontend-insight/server-core";
import { z } from "zod";
import { CoreService } from "./core.service.js";
import { CurrentPrincipal, parseInput } from "./http.js";

@Controller("api/projects/:projectId/diagnostics")
export class DiagnosticsController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}
  private async run<T>(project: string, task: () => Promise<T>) {
    parseInput(z.string().uuid(), project);
    try {
      return await task();
    } catch (e) {
      if (e instanceof DiagnosticAccessError) throw new HttpException(e.message, 403);
      if (e instanceof DiagnosticQueryError)
        throw new HttpException(
          e.message,
          e.message.includes("NOT_FOUND")
            ? 404
            : e.message.includes("EXPIRED")
              ? 410
              : 422,
        );
      throw e;
    }
  }
  @Get("instances/:eventId")
  @Header("Cache-Control", "private, no-store")
  async read(
    @Param("projectId") project: string,
    @Param("eventId") event: string,
    @CurrentPrincipal() p: Principal,
  ) {
    parseInput(z.string().regex(/^evt_[A-Za-z0-9_-]{8,64}$/), event);
    return this.run(project, () =>
      this.core.diagnostics.read(this.core.diagnosticClient, p, project, event),
    );
  }
  @Post("search")
  @Header("Cache-Control", "private, no-store")
  async search(
    @Param("projectId") project: string,
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
  ) {
    // Authorize before parsing diagnostic search data. Validation emits no input values.
    return this.run(project, async () => {
      try {
        await this.core.diagnostics.authorize(p, project, "search", "diagnostics.read");
      } catch (e) {
        await this.core.diagnostics.audit(
          p.userId,
          project,
          "search",
          "diagnostics.search",
          e instanceof DiagnosticAccessError ? "forbidden" : "failed",
        );
        throw e;
      }
      const q = parseInput(
        z
          .object({
            env: z.enum(["dev", "staging", "prod"]),
            from: z.string().datetime(),
            to: z.string().datetime(),
            term: z.string().min(2).max(128),
            field: z.enum(["message", "raw"]).default("raw"),
            category: z.enum(["all", ...ERROR_CATEGORIES]).default("all"),
            release: z
              .string()
              .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
              .optional(),
            groupId: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            pageRoute: z
              .string()
              .regex(/^\/[^?#]*$/)
              .max(512)
              .optional(),
            offset: z.number().int().min(0).max(500).default(0),
            limit: z.number().int().min(1).max(50).default(25),
            asOf: z.number().int().optional(),
          })
          .strict(),
        body,
      );
      return this.core.diagnostics.search(this.core.diagnosticClient, p, project, q);
    });
  }
  @Post("instances/:eventId/export")
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  async exportEvidence(
    @Param("projectId") project: string,
    @Param("eventId") event: string,
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
  ) {
    parseInput(z.string().regex(/^evt_[A-Za-z0-9_-]{8,64}$/), event);
    return this.run(project, async () => {
      const { format } = parseInput(
        z.object({ format: z.enum(["json", "text"]) }).strict(),
        body,
      );
      const text = await this.core.diagnostics.exportEvidence(
        this.core.diagnosticClient,
        p,
        project,
        event,
        format,
      );
      return new StreamableFile(Buffer.from(text), {
        type:
          format === "json"
            ? "application/json; charset=utf-8"
            : "text/plain; charset=utf-8",
        disposition: `attachment; filename="diagnostic-${event}.${format === "json" ? "json" : "txt"}"`,
      });
    });
  }
  @Get("capabilities")
  @Header("Cache-Control", "private, no-store")
  async capabilities(
    @Param("projectId") project: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.run(project, async () => ({
      read: await this.core.diagnostics.allowed(p, project, "diagnostics.read"),
      export: await this.core.diagnostics.allowed(p, project, "diagnostics.export"),
    }));
  }
  @Put("grants/:userId")
  @Header("Cache-Control", "private, no-store")
  async grant(
    @Param("projectId") project: string,
    @Param("userId") user: string,
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
  ) {
    parseInput(z.string().uuid(), user);
    const v = parseInput(
      z
        .object({ read: z.boolean(), export: z.boolean() })
        .strict()
        .refine((v) => !v.export || v.read),
      body,
    );
    return this.run(project, () =>
      this.core.diagnostics.grant(p, project, user, v.read, v.export),
    );
  }
  @Put("policy")
  @Header("Cache-Control", "private, no-store")
  async policy(
    @Param("projectId") project: string,
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
  ) {
    const v = parseInput(
      z.object({ retentionDays: z.number().int().min(1).max(90) }).strict(),
      body,
    );
    return this.run(project, () =>
      this.core.diagnostics.policy(p, project, v.retentionDays),
    );
  }
}
