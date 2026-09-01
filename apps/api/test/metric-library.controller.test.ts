import "reflect-metadata";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { CoreService } from "../src/core.service.js";
import { MetricLibraryController } from "../src/metric-library.controller.js";

const admin = {
  userId: "admin-user",
  globalRole: "admin" as const,
  displayName: "Admin",
  email: null,
};
const viewer = {
  userId: "viewer-user",
  globalRole: "viewer" as const,
  displayName: "Viewer",
  email: null,
};

function fixture(role: "owner" | "viewer" | null, versionStatus = "draft") {
  const mysql = { getProjectRole: vi.fn(async () => role) };
  const version = {
    id: "11111111-1111-4111-8111-111111111119",
    projectId: "project-a",
    libraryType: "operational" as const,
    version: 2,
    status: versionStatus,
  };
  const metricLibrary = {
    catalog: vi.fn(async () => ({ system: [], business: [], activeVersion: null })),
    listVersions: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version, definitions: [] })),
    createDraft: vi.fn(async () => ({
      ...version,
      id: "22222222-2222-4222-8222-222222222229",
      status: "draft",
    })),
    saveBusinessMetric: vi.fn(async (input) => ({
      version: { ...version, id: input.versionId },
      definition: input.definition,
      validation: { valid: true },
    })),
    validateVersion: vi.fn(async () => ({ valid: true })),
    activateVersion: vi.fn(async () => ({ ...version, status: "active" })),
    abandonDraft: vi.fn(async () => undefined),
    deleteBusinessMetric: vi.fn(async () => undefined),
    diff: vi.fn(async () => ({})),
    impact: vi.fn(async () => ({})),
    lineage: vi.fn(async () => ({})),
    definition: vi.fn(async () => ({})),
  };
  const core = { mysql, metricLibrary } as unknown as CoreService;
  return {
    controller: new MetricLibraryController(core),
    mysql,
    metricLibrary,
    version,
  };
}

const businessMetric = {
  metricKey: "engagement_ratio",
  displayName: "参与率",
  businessDescription: "每会话页面参与率",
  category: "usage",
  numeratorDescription: "浏览量",
  denominatorDescription: "会话数",
  deduplicationKey: "eventId + sessionId",
  unit: "ratio",
  entityScope: "project",
  timeGranularity: "day",
  minimumSample: 5,
  missingPolicy: "缺失传播",
  owner: "product-analytics",
  enabled: true,
  formulaAst: {
    type: "binary",
    operator: "/",
    left: { type: "metric", metricKey: "ratio_a" },
    right: { type: "metric", metricKey: "ratio_b" },
  },
};

describe("R1-B metric library authorization and immutable editing", () => {
  it("mounts the metric library below the public API prefix", () => {
    expect(Reflect.getMetadata("path", MetricLibraryController)).toBe(
      "api/projects/:projectId/metrics",
    );
    expect(
      Reflect.getMetadata("__httpCode__", MetricLibraryController.prototype.validate),
    ).toBe(200);
  });

  it("allows a project viewer to read the catalog and versions", async () => {
    const { controller, metricLibrary } = fixture("viewer");
    await controller.catalog("project-a", { type: "operational" }, viewer);
    await controller.versions("project-a", { type: "quality" }, viewer);
    expect(metricLibrary.catalog).toHaveBeenCalledWith("project-a", "operational");
    expect(metricLibrary.listVersions).toHaveBeenCalledWith("project-a", "quality");
  });

  it("rejects viewer writes before creating a draft or saving a definition", async () => {
    const { controller, metricLibrary } = fixture("viewer");
    await expect(
      controller.createVersion("project-a", { type: "operational" }, viewer),
    ).rejects.toEqual(expect.any(HttpException));
    await expect(
      controller.saveDefinition(
        "project-a",
        "11111111-1111-4111-8111-111111111119",
        businessMetric.metricKey,
        businessMetric,
        viewer,
      ),
    ).rejects.toEqual(expect.any(HttpException));
    expect(metricLibrary.createDraft).not.toHaveBeenCalled();
    expect(metricLibrary.saveBusinessMetric).not.toHaveBeenCalled();
  });

  it("automatically copies an activated snapshot before an admin edit", async () => {
    const { controller, metricLibrary, version } = fixture("owner", "active");
    await controller.saveDefinition(
      "project-a",
      version.id,
      businessMetric.metricKey,
      businessMetric,
      admin,
    );
    expect(metricLibrary.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-a",
        sourceVersionId: version.id,
        actor: admin,
      }),
    );
    expect(metricLibrary.saveBusinessMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: "22222222-2222-4222-8222-222222222229",
        actor: admin,
      }),
    );
  });

  it("copies an activated snapshot before deleting a business metric", async () => {
    const { controller, metricLibrary, version } = fixture("owner", "active");
    await expect(
      controller.deleteDefinition(
        "project-a",
        version.id,
        businessMetric.metricKey,
        admin,
      ),
    ).resolves.toEqual({ versionId: "22222222-2222-4222-8222-222222222229" });
    expect(metricLibrary.deleteBusinessMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: "22222222-2222-4222-8222-222222222229",
        metricKey: businessMetric.metricKey,
      }),
    );
  });

  it("rejects users without project membership and never queries library data", async () => {
    const { controller, metricLibrary } = fixture(null);
    await expect(
      controller.catalog("project-b", { type: "operational" }, admin),
    ).rejects.toMatchObject({ status: 403 });
    expect(metricLibrary.catalog).not.toHaveBeenCalled();
  });
});
