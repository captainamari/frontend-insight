import { describe, it, expect, vi } from "vitest";
import type { CoreService } from "../src/core.service.js";
import { ScoreManagementController } from "../src/score-management.controller.js";
import type { Principal } from "@frontend-insight/server-core";
const viewer: Principal = {
  userId: "viewer",
  globalRole: "viewer",
  displayName: "Viewer",
  email: null,
};
const admin: Principal = { ...viewer, userId: "admin", globalRole: "admin" };
function setup(role: string | null) {
  const scores = {
    get: vi.fn(),
    save: vi.fn(),
    trial: vi.fn(),
    review: vi.fn(),
    query: vi.fn(),
    history: vi.fn(),
  };
  const controller = new ScoreManagementController({
    mysql: { getProjectRole: vi.fn().mockResolvedValue(role) },
    scores,
  } as unknown as CoreService);
  return { scores, controller };
}
describe("R1-C score API authorization and privacy boundary", () => {
  it("allows viewer configuration and history reads, refuses every write before parsing", async () => {
    const { controller, scores } = setup("viewer");
    await controller.get("p", "v", viewer);
    await controller.history("p", "v", viewer);
    expect(scores.get).toHaveBeenCalledWith("p", "v");
    for (const method of ["save", "trial", "review"] as const)
      await expect(
        controller[method]("p", "v", { secret: "must not be read" }, viewer),
      ).rejects.toMatchObject({ status: 403 });
    expect(scores.save).not.toHaveBeenCalled();
    expect(scores.trial).not.toHaveBeenCalled();
    expect(scores.review).not.toHaveBeenCalled();
  });
  it("requires project membership even for a global admin", async () => {
    const { controller, scores } = setup(null);
    await expect(controller.get("foreign", "v", admin)).rejects.toMatchObject({
      status: 403,
    });
    expect(scores.get).not.toHaveBeenCalled();
  });
  it("rejects injected raw facts, SQL and arbitrary query properties", async () => {
    const { controller, scores } = setup("owner");
    await expect(
      controller.result(
        "p",
        "v",
        {
          env: "prod",
          from: "2026-09-01T00:00:00Z",
          to: "2026-09-02T00:00:00Z",
          granularity: "day",
          facts: { value: 100 },
        },
        admin,
      ),
    ).rejects.toThrow();
    await expect(
      controller.save(
        "p",
        "v",
        { configuration: {}, business: {}, sql: "select password" },
        admin,
      ),
    ).rejects.toThrow();
    expect(scores.query).not.toHaveBeenCalled();
    expect(scores.save).not.toHaveBeenCalled();
  });
});
