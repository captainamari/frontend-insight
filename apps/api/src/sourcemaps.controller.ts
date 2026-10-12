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
  StreamableFile,
} from "@nestjs/common";
import {
  SourceMapError,
  DiagnosticAccessError,
  type Principal,
} from "@frontend-insight/server-core";
import { z } from "zod";
import { CoreService } from "./core.service.js";
import { CurrentPrincipal, parseInput } from "./http.js";
import { PublicRoute } from "./auth.guard.js";
const id = z.string().regex(/^[a-f0-9]{64}$/),
  version = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
@Controller("api/projects/:projectId/diagnostics/sourcemaps")
export class SourceMapsController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}
  private async run<T>(
    project: string,
    p: Principal | null,
    object: string,
    action: string,
    fn: () => Promise<T>,
  ) {
    parseInput(z.string().uuid(), project);
    try {
      return await fn();
    } catch (e) {
      await this.core.diagnostics.audit(
        p?.userId ?? null,
        project,
        object,
        action,
        e instanceof SourceMapError
          ? e.state
          : e instanceof DiagnosticAccessError
            ? "forbidden"
            : "failed",
      );
      if (e instanceof DiagnosticAccessError) throw new HttpException(e.message, 403);
      if (e instanceof SourceMapError)
        throw new HttpException(
          e.message,
          ["not_found", "storage_missing"].includes(e.state)
            ? 404
            : ["expired", "deleted"].includes(e.state)
              ? 410
              : e.state === "identity_conflict"
                ? 409
                : e.state === "busy"
                  ? 429
                  : e.state === "storage_unavailable"
                    ? 503
                    : 422,
        );
      if (e instanceof HttpException) throw e;
      throw new HttpException("SOURCEMAP_STORAGE_UNAVAILABLE", 503);
    }
  }
  @Post("credentials")
  @Header("Cache-Control", "private, no-store")
  issue(
    @Param("projectId") project: string,
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
  ) {
    return this.run(project, p, "credential", "sourcemap.credential.issue", () =>
      this.core.sourceMaps.issue(
        p,
        project,
        parseInput(z.object({ days: z.number().int().min(1).max(30) }).strict(), body)
          .days,
      ),
    );
  }
  @Delete("credentials/:credential")
  @Header("Cache-Control", "private, no-store")
  revoke(
    @Param("projectId") project: string,
    @Param("credential") credential: string,
    @CurrentPrincipal() p: Principal,
  ) {
    parseInput(z.string().uuid(), credential);
    return this.run(project, p, credential, "sourcemap.credential.revoke", () =>
      this.core.sourceMaps.revoke(p, project, credential),
    );
  }
  @PublicRoute()
  @Post("upload")
  @Header("Cache-Control", "private, no-store")
  upload(
    @Param("projectId") project: string,
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    return this.run(project, null, "upload", "sourcemap.upload", async () => {
      const token = authorization?.startsWith("Bearer fi_sm_")
        ? authorization.slice(7)
        : "";
      await this.core.sourceMaps.uploadCredential(token, project);
      const v = parseInput(
        z
          .object({
            release: version,
            build: version,
            asset: z.string().max(2048),
            assetSha256: id,
            mapSha256: id,
            javascript: z.string().max(1398104),
            map: z.string().max(2796204),
            retentionDays: z.number().int().min(1).max(90).default(30),
          })
          .strict(),
        body,
      );
      return this.core.sourceMaps.upload(token, project, v);
    });
  }
  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@Param("projectId") project: string, @CurrentPrincipal() p: Principal) {
    return this.run(project, p, "artifacts", "sourcemap.list", () =>
      this.core.sourceMaps.list(p, project),
    );
  }
  @Delete(":id")
  @Header("Cache-Control", "private, no-store")
  remove(
    @Param("projectId") project: string,
    @Param("id") artifact: string,
    @CurrentPrincipal() p: Principal,
  ) {
    parseInput(id, artifact);
    return this.run(project, p, artifact, "sourcemap.delete", () =>
      this.core.sourceMaps.remove(p, project, artifact),
    );
  }
  @Post(":id/download")
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  download(
    @Param("projectId") project: string,
    @Param("id") artifact: string,
    @CurrentPrincipal() p: Principal,
  ) {
    parseInput(id, artifact);
    return this.run(
      project,
      p,
      artifact,
      "sourcemap.download",
      async () =>
        new StreamableFile(await this.core.sourceMaps.download(p, project, artifact), {
          type: "application/json",
          disposition: `attachment; filename="sourcemap-${artifact}.map"`,
        }),
    );
  }
}
