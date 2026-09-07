import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ScorePreflightController } from "../src/score-preflight.controller.js";
import type { CoreService } from "../src/core.service.js";
import { operationalScoreFixture } from "../../../packages/server-core/test/score-fixture.js";

const admin = {
  userId: "admin",
  globalRole: "admin" as const,
  displayName: "Admin",
  email: null,
};
function fixture(role: "owner" | "viewer" | null) {
  const input = operationalScoreFixture();
  const mysql = { getProjectRole: vi.fn(async () => role) };
  const metricLibrary = {
    getVersion: vi.fn(async () => ({
      version: {
        id: input.binding.metricSetVersion,
        projectId: input.binding.projectId,
        libraryType: "operational",
      },
      definitions: input.binding.metrics.map((metric) => ({
        ...metric,
        implementationStatus: "partial",
      })),
    })),
  };
  return {
    input,
    mysql,
    metricLibrary,
    controller: new ScorePreflightController({
      mysql,
      metricLibrary,
    } as unknown as CoreService),
  };
}
describe("R1-C configuration-only preflight API", () => {
  it("registers the version-scoped endpoint and returns no numerical preview", async () => {
    expect(Reflect.getMetadata("path", ScorePreflightController)).toBe(
      "api/projects/:projectId/metrics/versions/:versionId/scores",
    );
    const f = fixture("owner");
    const result = await f.controller.preflight(
      "fixture-project",
      "fixture-metrics-v1",
      f.input.configuration,
      admin,
    );
    expect(result.value).toBeNull();
    expect(result.saved).toBe(false);
    expect(result.readiness).toContainEqual({
      key: "core_page_coverage",
      reason: "partial",
    });
    expect(f.metricLibrary.getVersion).toHaveBeenCalledWith(
      "fixture-project",
      "fixture-metrics-v1",
    );
  });
  it.each([null, "viewer"] as const)(
    "rejects unauthorized role %s before reading the snapshot",
    async (role) => {
      const f = fixture(role);
      await expect(
        f.controller.preflight("other", "secret", {}, admin),
      ).rejects.toThrow();
      expect(f.metricLibrary.getVersion).not.toHaveBeenCalled();
    },
  );
  it("rejects global viewer even when project role is owner", async () => {
    const f = fixture("owner");
    await expect(
      f.controller.preflight(
        "fixture-project",
        "v1",
        {},
        { ...admin, globalRole: "viewer" },
      ),
    ).rejects.toThrow("WRITE_FORBIDDEN");
    expect(f.metricLibrary.getVersion).not.toHaveBeenCalled();
  });
  it("rejects caller-supplied values and arbitrary fields", async () => {
    const f = fixture("owner");
    await expect(
      f.controller.preflight(
        "fixture-project",
        "v1",
        { ...(f.input.configuration as object), facts: { score: 100 } },
        admin,
      ),
    ).rejects.toThrow("SCORE_FIELD_NOT_ALLOWED");
  });
});
