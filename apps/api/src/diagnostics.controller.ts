import {
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  Inject,
  Param,
  Put,
} from "@nestjs/common";
import { DiagnosticAccessError, type Principal } from "@frontend-insight/server-core";
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
