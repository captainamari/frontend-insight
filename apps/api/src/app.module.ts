import {
  ScoreManagementController,
  ScoreReadController,
} from "./score-management.controller.js";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller.js";
import { AnalyticsController } from "./analytics.controller.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { CoreService } from "./core.service.js";
import { ApiExceptionFilter } from "./http.js";
import { IngestionController } from "./ingestion.controller.js";
import { MetricLibraryController } from "./metric-library.controller.js";
import { ObservabilityController } from "./observability.controller.js";
import { OperationalController } from "./operational.controller.js";
import { ProjectsController } from "./projects.controller.js";
import { SystemController } from "./system.controller.js";
import { ScorePreflightController } from "./score-preflight.controller.js";

@Module({
  controllers: [
    AdminController,
    AuthController,
    IngestionController,
    ProjectsController,
    AnalyticsController,
    MetricLibraryController,
    ScorePreflightController,
    ScoreManagementController,
    ScoreReadController,
    OperationalController,
    ObservabilityController,
    SystemController,
  ],
  providers: [
    CoreService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
