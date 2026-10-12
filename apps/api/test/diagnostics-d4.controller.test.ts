import { it, expect, vi } from "vitest";
import { DiagnosticsController } from "../src/diagnostics.controller.js";
import type { CoreService } from "../src/core.service.js";
import { DiagnosticAccessError, type Principal } from "@frontend-insight/server-core";
const project = "11111111-1111-4111-8111-111111111111",
  event = "evt_synthetic01",
  p = { userId: "u" } as Principal;
it("D4 search authorization precedes input parsing and disallows arbitrary fields", async () => {
  const authorize = vi
    .fn()
    .mockRejectedValue(new DiagnosticAccessError("DIAGNOSTICS_FORBIDDEN"));
  const c = new DiagnosticsController({
    diagnostics: { authorize, search: vi.fn() },
  } as unknown as CoreService);
  await expect(c.search(project, p, { term: "SECRET" })).rejects.toMatchObject({
    status: 403,
  });
  expect(authorize).toHaveBeenCalled();
  authorize.mockResolvedValue(undefined);
  await expect(
    c.search(project, p, {
      env: "dev",
      from: "2026-10-10T00:00:00Z",
      to: "2026-10-11T00:00:00Z",
      term: "test",
      field: "SQL",
    }),
  ).rejects.toMatchObject({ status: 400 });
});
it("D4 returns real downloadable files and delegates fresh export authorization", async () => {
  const exportEvidence = vi.fn().mockResolvedValue('{"synthetic":"原文"}');
  const c = new DiagnosticsController({
    diagnostics: { exportEvidence },
    diagnosticClient: {},
  } as unknown as CoreService);
  const file = await c.exportEvidence(project, event, p, { format: "json" });
  expect(file.getHeaders().disposition).toContain(
    'attachment; filename="diagnostic-evt_synthetic01.json"',
  );
  expect(exportEvidence).toHaveBeenCalledWith({}, p, project, event, "json");
});
