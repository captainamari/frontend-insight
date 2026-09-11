import { describe, it, expect, vi } from "vitest";
import { ProjectsController } from "../src/projects.controller.js";
import type { CoreService } from "../src/core.service.js";
import type { Principal } from "@frontend-insight/server-core";
const viewer: Principal = {
    userId: "viewer",
    displayName: "Viewer",
    email: null,
    globalRole: "viewer",
  },
  admin: Principal = { ...viewer, globalRole: "admin" };
const create = {
  name: "中文项目",
  timezone: "Asia/Shanghai",
  retentionDays: 90,
  origins: ["http://localhost:5173"],
};
function setup() {
  const core = {
    mysql: {
      createProject: vi.fn(),
      getProjectRole: vi.fn().mockResolvedValue(null),
      getProject: vi.fn(),
    },
    scores: { initializeProject: vi.fn() },
    projectSummary: { summary: vi.fn() },
  };
  return { core, c: new ProjectsController(core as unknown as CoreService) };
}
describe("R2 API authorization and input boundary", () => {
  it("rejects viewer writes before parsing and direct foreign project access", async () => {
    const { c, core } = setup();
    await expect(c.create(create, viewer)).rejects.toMatchObject({ status: 403 });
    await expect(c.access("foreign", viewer)).rejects.toMatchObject({ status: 403 });
    expect(core.mysql.createProject).not.toHaveBeenCalled();
    expect(core.mysql.getProject).not.toHaveBeenCalled();
  });
  it.each([
    "https://example.com/*",
    "https://*.example.com",
    "https://example.com/path",
    "https://example.com?x=1",
    "https://example.com/#hash",
    "https://user:password@example.com",
    "file:///x",
  ])("rejects non-exact origin %s", async (origin) => {
    const { c, core } = setup();
    await expect(
      c.create({ ...create, origins: [origin] }, admin),
    ).rejects.toMatchObject({ status: 400 });
    expect(core.mysql.createProject).not.toHaveBeenCalled();
  });
  it("rejects invalid timezone, bounds and injected fields", async () => {
    const { c } = setup();
    for (const values of [
      { timezone: "no/such_zone" },
      { retentionDays: 0 },
      { retentionDays: 366 },
      { role: "owner" },
    ])
      await expect(c.create({ ...create, ...values }, admin)).rejects.toMatchObject({
        status: 400,
      });
  });
  it("validates paging, range and env before aggregation", () => {
    const { c, core } = setup();
    for (const q of [
      { page: 0 },
      { pageSize: 13 },
      { pageSize: 100 },
      { env: "all" },
      { from: "yesterday" },
      { sql: "SELECT *" },
      { search: "x".repeat(121) },
    ])
      expect(() => c.summary(q, viewer)).toThrow();
    expect(core.projectSummary.summary).not.toHaveBeenCalled();
  });
  it("passes explicit template versions and initialization into the existing transaction", async () => {
    const { c, core } = setup();
    await c.create(create, admin);
    const input = core.mysql.createProject.mock.calls[0]![0];
    expect(input.actor).toEqual(admin);
    await input.initialize("transaction", "project");
    expect(core.scores.initializeProject).toHaveBeenCalledWith(
      "transaction",
      expect.objectContaining({ projectId: "project", timezone: "Asia/Shanghai" }),
    );
  });
});
