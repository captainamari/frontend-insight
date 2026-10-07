import { it, expect, vi } from "vitest";
import {
  SettingsController,
  probeSchema,
  exportQuery,
  ruleSchema,
} from "../src/settings.controller.js";
import type { CoreService } from "../src/core.service.js";
import type { FastifyRequest } from "fastify";
const id = "11111111-1111-4111-8111-111111111111",
  viewer = {
    userId: id,
    globalRole: "viewer" as const,
    displayName: "viewer",
    email: null,
  };
it("R7 requires server-side write authorization before settings mutation", async () => {
  const core = {
    mysql: { getProjectRole: vi.fn().mockResolvedValue("viewer") },
    settings: { saveProbe: vi.fn() },
  };
  const c = new SettingsController(core as unknown as CoreService);
  await expect(c.saveProbe(id, viewer, {}, {} as FastifyRequest)).rejects.toMatchObject(
    { status: 403 },
  );
  expect(core.settings.saveProbe).not.toHaveBeenCalled();
  core.mysql.getProjectRole.mockResolvedValue(null);
  await expect(c.integration(id, viewer)).rejects.toMatchObject({ status: 403 });
});
it("strict external inputs reject free SQL, fields, groupBy and future windows", () => {
  const q = { env: "dev", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" };
  expect(exportQuery.safeParse(q).success).toBe(true);
  for (const extra of [
    { sql: "select 1" },
    { fields: "user_id" },
    { groupBy: "pageRoute" },
    { formula: "x" },
    { token: "x" },
  ])
    expect(exportQuery.safeParse({ ...q, ...extra }).success).toBe(false);
  expect(exportQuery.safeParse({ ...q, to: "2099-01-01T00:00:00Z" }).success).toBe(
    false,
  );
});
it("contract versions and arbitrary rule fields cannot bypass the schema", () => {
  expect(
    probeSchema.safeParse({
      version: "0.8.0",
      status: "recommended",
      contractVersion: 2,
      releaseNotes: "x",
      upgradeAdvice: "x",
    }).success,
  ).toBe(false);
  expect(ruleSchema.safeParse({ ruleKey: "personal_score", config: {} }).success).toBe(
    false,
  );
});
