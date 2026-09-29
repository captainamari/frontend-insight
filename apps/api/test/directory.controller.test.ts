import { describe, it, expect, vi } from "vitest";
import { ProjectsController } from "../src/projects.controller.js";
import type { CoreService } from "../src/core.service.js";
const admin = {
  userId: "a",
  globalRole: "admin" as const,
  displayName: "a",
  email: null,
};
const viewer = { ...admin, globalRole: "viewer" as const };
const input = {
  env: "dev",
  sourceKey: "fixture",
  coverage: "unknown",
  validUntil: "2027-01-01T00:00:00Z",
  entries: [
    {
      userId: "u_opaque_fixture_0001",
      deptId: "dept_fixture",
      roleId: null,
      eligible: true,
    },
  ],
};
function setup(role: string | null) {
  const core = {
    mysql: { getProjectRole: vi.fn().mockResolvedValue(role) },
    directory: { create: vi.fn(), list: vi.fn(), publish: vi.fn() },
  };
  return { core, controller: new ProjectsController(core as unknown as CoreService) };
}
describe("R4-C directory HTTP authorization and privacy", () => {
  it("denies viewer writes and personal directory reads before parsing", async () => {
    const { controller, core } = setup("viewer");
    await expect(controller.createDirectory("p", input, viewer)).rejects.toMatchObject({
      status: 403,
    });
    await expect(controller.directory("p", viewer)).rejects.toMatchObject({
      status: 403,
    });
    expect(core.directory.create).not.toHaveBeenCalled();
  });
  it("denies cross-project administrators", async () => {
    const { controller } = setup(null);
    await expect(
      controller.createDirectory("foreign", input, admin),
    ).rejects.toMatchObject({ status: 403 });
  });
  it.each([
    { ...input, name: "private-name" },
    { ...input, entries: [{ ...input.entries[0], roleId: ["role_one", "role_two"] }] },
    { ...input, entries: [{ ...input.entries[0], userId: "real@example.com" }] },
  ])("rejects uncontrolled import without returning its values", async (body) => {
    const { controller, core } = setup("admin");
    await expect(controller.createDirectory("p", body, admin)).rejects.toMatchObject({
      status: 400,
      message: "DIRECTORY_INVALID",
    });
    expect(core.directory.create).not.toHaveBeenCalled();
  });
  it("passes controlled import with the authorized actor", async () => {
    const { controller, core } = setup("admin");
    await controller.createDirectory("p", input, admin);
    expect(core.directory.create).toHaveBeenCalledWith("p", "a", input);
  });
});
