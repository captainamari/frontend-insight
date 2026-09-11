import {
  preflightScoreConfiguration,
  type Principal,
} from "@frontend-insight/server-core";
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { CoreService } from "./core.service.js";
import { CurrentPrincipal } from "./http.js";

@Controller("api/projects/:projectId/metrics/versions/:versionId/scores")
export class ScorePreflightController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @Post("preflight")
  @HttpCode(200)
  async preflight(
    @Param("projectId") projectId: string,
    @Param("versionId") versionId: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ) {
    const role = await this.core.mysql.getProjectRole(principal, projectId);
    if (!role) throw new HttpException("PROJECT_FORBIDDEN", 403);
    if (principal.globalRole !== "admin" || !["owner", "admin"].includes(role))
      throw new HttpException("WRITE_FORBIDDEN", 403);
    const snapshot = await this.core.metricLibrary.getVersion(projectId, versionId);
    return preflightScoreConfiguration(body, snapshot);
  }
}
