import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { AdminController } from "../src/admin.controller.js";
import { AnalyticsController } from "../src/analytics.controller.js";
import { AuthController } from "../src/auth.controller.js";
import { AuthGuard } from "../src/auth.guard.js";
import { CoreService } from "../src/core.service.js";
import { IngestionController } from "../src/ingestion.controller.js";
import { ObservabilityController } from "../src/observability.controller.js";
import { OperationalController } from "../src/operational.controller.js";
import { ProjectsController } from "../src/projects.controller.js";
import { SystemController } from "../src/system.controller.js";

function injectionTokens(target: object): unknown[] {
  const metadata = Reflect.getMetadata("self:paramtypes", target) as
    Array<{ index: number; param: unknown }> | undefined;
  return (metadata ?? [])
    .sort((left, right) => left.index - right.index)
    .map((item) => item.param);
}

describe("NestJS runtime injection metadata", () => {
  it.each([
    AdminController,
    AnalyticsController,
    AuthController,
    IngestionController,
    ProjectsController,
    OperationalController,
    ObservabilityController,
    SystemController,
  ])("declares CoreService explicitly for %s", (controller) => {
    expect(injectionTokens(controller)).toEqual([CoreService]);
  });

  it("declares Reflector and CoreService explicitly for the global guard", () => {
    expect(injectionTokens(AuthGuard)).toEqual([Reflector, CoreService]);
  });
});
