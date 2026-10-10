import { it, expect, vi } from "vitest";
import { PageOperationsController } from "../src/page-operations.controller.js";
import type { CoreService } from "../src/core.service.js";
const principal = {
  userId: "v",
  globalRole: "viewer" as const,
  displayName: "v",
  email: null,
};
it("R6 authorization precedes queries and strict scope rejects unsafe inputs", async () => {
  const core = {
    mysql: { getProjectRole: vi.fn().mockResolvedValue(null) },
    pageUsage: { read: vi.fn() },
  };
  const c = new PageOperationsController(core as unknown as CoreService);
  await expect(c.read("p", {}, principal)).rejects.toMatchObject({ status: 403 });
  expect(core.pageUsage.read).not.toHaveBeenCalled();
  core.mysql.getProjectRole.mockResolvedValue("viewer");
  for (const query of [
    { pageRoute: "/a?secret=yes" },
    { env: "unknown" },
    { token: "private" },
    { versionId: "other" },
  ])
    await expect(c.read("p", query, principal)).rejects.toMatchObject({ status: 400 });
  expect(core.pageUsage.read).not.toHaveBeenCalled();
});
