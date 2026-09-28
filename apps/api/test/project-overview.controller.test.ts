import { describe, expect, it, vi } from "vitest";
import { ProjectsController } from "../src/projects.controller.js";
import type { CoreService } from "../src/core.service.js";
import type { Principal } from "@frontend-insight/server-core";
const viewer: Principal = {
  userId: "v",
  displayName: "Viewer",
  globalRole: "viewer",
  email: null,
};
describe("R3 API authorization and schema", () => {
  function setup(role: string | null) {
    const core = {
      mysql: { getProjectRole: vi.fn().mockResolvedValue(role) },
      projectOverview: { overview: vi.fn().mockResolvedValue({}) },
    };
    return { core, c: new ProjectsController(core as unknown as CoreService) };
  }
  it("authorizes before parse/read and never reveals foreign metadata", async () => {
    const { c, core } = setup(null);
    await expect(c.overview("foreign", { env: "all" }, viewer)).rejects.toMatchObject({
      status: 403,
    });
    expect(core.projectOverview.overview).not.toHaveBeenCalled();
  });
  it.each([
    { env: "all" },
    { range: "24h" },
    { from: "yesterday" },
    { timezone: "UTC" },
    { metrics: "pv," },
    { metrics: Array.from({ length: 17 }, (_, n) => "metric_" + n).join(",") },
  ])("rejects invalid query %j", async (q) => {
    const { c, core } = setup("viewer");
    await expect(c.overview("p", q, viewer)).rejects.toMatchObject({ status: 400 });
    expect(core.projectOverview.overview).not.toHaveBeenCalled();
  });
  it("uses path authority and preserves explicit context", async () => {
    const { c, core } = setup("viewer");
    const q = {
      env: "dev",
      range: "custom",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
      metrics: "pv",
    };
    await c.overview("path-project", q, viewer);
    expect(core.projectOverview.overview).toHaveBeenCalledWith("path-project", {
      ...q,
      metrics: ["pv"],
    });
  });
});
