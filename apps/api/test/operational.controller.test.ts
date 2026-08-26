import "reflect-metadata";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { CoreService } from "../src/core.service.js";
import { OperationalController } from "../src/operational.controller.js";

const admin = {
  userId: "admin",
  globalRole: "admin" as const,
  displayName: "Admin",
  email: null,
};
const viewer = {
  userId: "viewer",
  globalRole: "viewer" as const,
  displayName: "Viewer",
  email: null,
};

function controller(role: "owner" | "viewer" | null) {
  const mysql = {
    getProjectRole: vi.fn(async () => role),
    listModules: vi.fn(async () => []),
    listWorkflowDefinitions: vi.fn(async () => []),
    createModule: vi.fn(async (input) => input),
    createPageDefinition: vi.fn(async (input) => input),
    createWorkflowDefinition: vi.fn(async (input) => input),
    retireMetricProfile: vi.fn(async () => undefined),
  };
  const core = { mysql } as unknown as CoreService;
  return { controller: new OperationalController(core), mysql };
}

describe("M6 operational authorization", () => {
  it("allows an authorized viewer to read project-scoped configuration", async () => {
    const { controller: target, mysql } = controller("viewer");
    await expect(target.listModules("project-1", viewer)).resolves.toEqual([]);
    expect(mysql.listModules).toHaveBeenCalledWith("project-1");
  });

  it("rejects viewer writes before touching the store", async () => {
    const { controller: target, mysql } = controller("viewer");
    await expect(
      target.createModule(
        "project-1",
        {
          moduleKey: "energy",
          name: "能源管理",
          criticalityWeight: 1,
          displayOrder: 0,
        },
        viewer,
      ),
    ).rejects.toEqual(expect.any(HttpException));
    expect(mysql.createModule).not.toHaveBeenCalled();
  });

  it("allows project admins to create a validated module", async () => {
    const { controller: target, mysql } = controller("owner");
    await target.createModule(
      "project-1",
      {
        moduleKey: "energy",
        name: "能源管理",
        criticalityWeight: 1,
        displayOrder: 0,
      },
      admin,
    );
    expect(mysql.createModule).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        moduleKey: "energy",
        actor: admin,
      }),
    );
  });

  it("rejects users without project membership", async () => {
    const { controller: target } = controller(null);
    await expect(target.listModules("project-1", admin)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("normalizes dynamic page routes before persistence", async () => {
    const { controller: target, mysql } = controller("owner");
    await target.createPage(
      "project-1",
      {
        pageRoute: "/orders/123/550e8400-e29b-41d4-a716-446655440000",
        moduleId: "10111111-1111-4111-8111-111111111111",
        name: "订单详情",
        templateKey: "task_operation",
        isCore: true,
        criticalityWeight: 1,
        expectedFrequency: "daily",
      },
      admin,
    );
    expect(mysql.createPageDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ pageRoute: "/orders/:id/:id" }),
    );
  });

  it("creates a project-scoped workflow draft with validated terminal steps", async () => {
    const { controller: target, mysql } = controller("owner");
    await target.createWorkflow(
      "project-1",
      {
        moduleId: "10111111-1111-4111-8111-111111111111",
        workflowKey: "model_download",
        name: "模型下载",
        startPolicy: "first_step",
        timeoutSeconds: 600,
        terminalPolicy: {
          completedStepKey: "completed",
          failedStepKey: null,
          canceledStepKey: null,
          timeoutState: "approximate_abandoned",
        },
        steps: [
          {
            stepKey: "requested",
            name: "发起下载",
            stepOrder: 1,
            triggerKind: "selector",
            triggerConfig: { selector: ".download-button" },
          },
          {
            stepKey: "completed",
            name: "下载完成",
            stepOrder: 2,
            triggerKind: "operation_terminal",
            triggerConfig: { state: "completed" },
          },
        ],
      },
      admin,
    );
    expect(mysql.createWorkflowDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        workflowKey: "model_download",
        actor: admin,
      }),
    );
  });

  it("rejects viewer workflow writes before touching the store", async () => {
    const { controller: target, mysql } = controller("viewer");
    await expect(
      target.disableWorkflow("project-1", "workflow-1", viewer),
    ).rejects.toEqual(expect.any(HttpException));
    expect(mysql.createWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("retires profiles through the project-scoped admin boundary", async () => {
    const { controller: target, mysql } = controller("owner");
    await target.retireProfile("project-1", "profile-1", admin);
    expect(mysql.retireMetricProfile).toHaveBeenCalledWith({
      projectId: "project-1",
      profileId: "profile-1",
      actor: admin,
    });
  });
});
