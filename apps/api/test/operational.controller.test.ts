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
    createModule: vi.fn(async (input) => input),
    getCollectorSettings: vi.fn(async () => null),
    listCollectorSettings: vi.fn(async () => []),
    createCollectorSettingsVersion: vi.fn(async (input) => input),
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

  it("retires profiles through the project-scoped admin boundary", async () => {
    const { controller: target, mysql } = controller("owner");
    await target.retireProfile("project-1", "profile-1", admin);
    expect(mysql.retireMetricProfile).toHaveBeenCalledWith({
      projectId: "project-1",
      profileId: "profile-1",
      actor: admin,
    });
  });

  it("lets viewers inspect collector versions but not publish them", async () => {
    const { controller: target, mysql } = controller("viewer");
    await expect(target.collectorSettings("project-1", viewer)).resolves.toEqual({
      active: null,
      versions: [],
    });
    await expect(
      target.createCollectorSettings(
        "project-1",
        {
          api: {
            enabled: false,
            sampleRate: 1,
            slowThresholdMs: 2000,
            globalFetch: false,
          },
          resources: { enabled: false, sampleRate: 1 },
          firstScreen: { enabled: false, sampleRate: 1 },
          listRender: { enabled: false, sampleRate: 1 },
          longTasks: { enabled: false, sampleRate: 1 },
          blankScreen: { enabled: false, sampleRate: 1 },
          breadcrumbs: { enabled: false, sampleRate: 1, allowedActionKeys: [] },
        },
        viewer,
      ),
    ).rejects.toEqual(expect.any(HttpException));
    expect(mysql.createCollectorSettingsVersion).not.toHaveBeenCalled();
  });

  it("publishes collector configuration as a clone-on-write version", async () => {
    const { controller: target, mysql } = controller("owner");
    const input = {
      api: {
        enabled: true,
        sampleRate: 0.2,
        slowThresholdMs: 1500,
        globalFetch: false,
      },
      resources: { enabled: false, sampleRate: 1 },
      firstScreen: { enabled: true, sampleRate: 1 },
      listRender: { enabled: false, sampleRate: 1 },
      longTasks: { enabled: false, sampleRate: 1 },
      blankScreen: { enabled: false, sampleRate: 1 },
      breadcrumbs: {
        enabled: true,
        sampleRate: 0.2,
        allowedActionKeys: ["report_opened"],
      },
    };
    await target.createCollectorSettings("project-1", input, admin);
    expect(mysql.createCollectorSettingsVersion).toHaveBeenCalledWith({
      ...input,
      projectId: "project-1",
      actor: admin,
    });
  });
});
