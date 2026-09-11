import type { Principal } from "@frontend-insight/server-core";
import { Controller, Get, HttpException, Inject } from "@nestjs/common";
import { PublicRoute } from "./auth.guard.js";
import { CoreService } from "./core.service.js";
import { CurrentPrincipal } from "./http.js";

@Controller()
export class SystemController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @PublicRoute()
  @Get("health/live")
  live() {
    return { status: "ok", service: "api" };
  }

  @PublicRoute()
  @Get("health/ready")
  async ready() {
    await Promise.all([
      this.core.mysql.ping(),
      this.core.analytics.ping(),
      this.core.observability.ping(),
      this.core.publisher.ping(),
    ]);
    return { status: "ready", mysql: "ok", clickhouse: "ok", kafka: "ok" };
  }

  @Get("api/system/metrics")
  metrics(@CurrentPrincipal() principal: Principal) {
    if (principal.globalRole !== "admin") {
      throw new HttpException("ADMIN_REQUIRED", 403);
    }
    return {
      ingestion: this.core.ingestion.getMetrics(),
      analytics: this.core.analytics.getMetrics(),
      observability: this.core.observability.getMetrics(),
      scope: "current_api_process",
      payloadLogging: false,
    };
  }
}
