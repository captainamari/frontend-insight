import { describe, it, expect, vi } from "vitest";
import { ProjectsController } from "../src/projects.controller.js";
import { MetricLibraryController } from "../src/metric-library.controller.js";
import type { CoreService } from "../src/core.service.js";
import type { Principal } from "@frontend-insight/server-core";
const viewer: Principal = {
  userId: "viewer",
  displayName: "Viewer",
  email: null,
  globalRole: "viewer",
};
describe("R4-A HTTP boundaries", () => {
  const setup = (role: string | null) => {
    const core = {
      mysql: { getProjectRole: vi.fn().mockResolvedValue(role) },
      businessAnalysis: { analysis: vi.fn() },
      metricLibrary: { saveDisplayBindings: vi.fn() },
    };
    return {
      core,
      controller: new ProjectsController(core as unknown as CoreService),
      bindings: new MetricLibraryController(core as unknown as CoreService),
    };
  };
  it("authorizes before schema/metadata and denies forged viewer binding writes", async () => {
    const { controller, core, bindings } = setup(null);
    await expect(
      controller.business("foreign", { bad: true }, viewer),
    ).rejects.toMatchObject({ status: 403 });
    expect(core.businessAnalysis.analysis).not.toHaveBeenCalled();
    await expect(
      bindings.saveBusinessBindings("foreign", "v", { metricKeys: ["pv"] }, viewer),
    ).rejects.toMatchObject({ status: 403 });
    expect(core.metricLibrary.saveDisplayBindings).not.toHaveBeenCalled();
  });
  it.each([
    { moduleId: "foreign" },
    { versionId: "fake" },
    { env: "all" },
    { timezone: "UTC" },
    { metrics: "old;SELECT" },
    { from: "yesterday" },
    { extra: true },
  ])("rejects strict malformed input %j", async (q) => {
    const { controller, core } = setup("viewer");
    await expect(controller.business("p", q, viewer)).rejects.toMatchObject({
      status: 400,
    });
    expect(core.businessAnalysis.analysis).not.toHaveBeenCalled();
  });
  it("passes canonical scope and version selection after authorization", async () => {
    const { controller, core } = setup("viewer");
    const moduleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await controller.business("p", { moduleId, env: "dev", metrics: "pv,uv" }, viewer);
    expect(core.businessAnalysis.analysis).toHaveBeenCalledWith(
      "p",
      expect.objectContaining({ moduleId, env: "dev", metrics: ["pv", "uv"] }),
    );
  });
});
