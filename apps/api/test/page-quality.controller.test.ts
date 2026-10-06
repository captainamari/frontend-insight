import { describe, it, expect, vi } from "vitest";
import { ObservabilityController } from "../src/observability.controller.js";
import type { CoreService } from "../src/core.service.js";
const principal = {
  userId: "v",
  globalRole: "viewer" as const,
  displayName: "v",
  email: null,
};
const q = {
  env: "dev",
  range: "custom",
  from: "2026-10-01T00:00:00Z",
  to: "2026-10-02T00:00:00Z",
};
function setup(role: string | null) {
  const core = {
    mysql: {
      getProjectRole: vi.fn().mockResolvedValue(role),
      getProject: vi.fn().mockResolvedValue({ timezone: "Asia/Shanghai" }),
      getDataStatus: vi.fn().mockResolvedValue({ lastReceivedAt: null }),
    },
    pageQuality: { read: vi.fn().mockResolvedValue({ items: [] }) },
  };
  return { core, c: new ObservabilityController(core as unknown as CoreService) };
}
describe("R5-B project authorization and query contracts", () => {
  it("denies foreign reads before parsing and querying, allows authorized viewer", async () => {
    const denied = setup(null);
    await expect(
      denied.c.occurrences("foreign", { token: "private" }, principal),
    ).rejects.toMatchObject({ status: 403 });
    expect(denied.core.pageQuality.read).not.toHaveBeenCalled();
    const allowed = setup("viewer");
    const result = await allowed.c.occurrences("p", q, principal);
    expect(result.timezone).toBe("Asia/Shanghai");
    expect(allowed.core.pageQuality.read).toHaveBeenCalledWith(
      "p",
      expect.objectContaining({
        mode: "latest",
        category: "all",
        limit: 25,
        env: "dev",
      }),
    );
  });
  it("rejects unknown fields, unsafe paths, malformed categories and unbounded limits", async () => {
    const { c, core } = setup("viewer");
    for (const change of [
      { token: "private" },
      { pageRoute: "/orders?secret=1" },
      { category: "unknown" },
      { limit: 1000 },
      { cursor: "x".repeat(1025) },
      { from: "2026-10-03T00:00:00Z" },
    ])
      await expect(
        c.occurrences("p", { ...q, ...change }, principal),
      ).rejects.toMatchObject({ status: 400 });
    expect(core.pageQuality.read).not.toHaveBeenCalled();
  });
});
