import { describe, it, expect, vi } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import type { MySqlStore } from "../src/mysql-store.js";
import type { Principal } from "../src/model.js";
import { RuntimeDiagnostics } from "../src/runtime-diagnostics.js";
const p = { userId: "synthetic" } as Principal;
const ch = {} as ClickHouseClient;
function fixture() {
  const diagnostics = new RuntimeDiagnostics({} as MySqlStore);
  const allowed = vi.spyOn(diagnostics, "allowed").mockResolvedValue(true);
  const audit = vi.spyOn(diagnostics, "audit").mockResolvedValue(undefined);
  const read = vi.spyOn(diagnostics, "read").mockResolvedValue({
    eventId: "evt_synthetic",
    projectId: "p",
    occurrence: null,
    state: "ready",
    expiresAt: null,
    storedEnvelopeJson: '{"raw":{"message":"token=测试\\n😀"}}',
  });
  return { diagnostics, allowed, audit, read };
}
describe("D4 export boundaries", () => {
  it("reauthorizes after evidence reading and refuses mid-request revocation", async () => {
    const { diagnostics, allowed, audit } = fixture();
    allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      diagnostics.exportEvidence(ch, p, "p", "evt_synthetic", "json"),
    ).rejects.toThrow("FORBIDDEN");
    expect(audit).not.toHaveBeenCalledWith(
      p.userId,
      "p",
      "evt_synthetic",
      "diagnostics.export.json",
      "success",
    );
  });
  it("preserves original stored text without treating parsed formatting as raw", async () => {
    const { diagnostics, read } = fixture();
    const json = JSON.parse(
      await diagnostics.exportEvidence(ch, p, "p", "evt_synthetic", "json"),
    );
    expect(json.evidence.storedEnvelopeJson).toBe(
      (await read.mock.results[0]!.value).storedEnvelopeJson,
    );
    const text = await diagnostics.exportEvidence(ch, p, "p", "evt_synthetic", "text");
    expect(text).toContain(json.evidence.storedEnvelopeJson);
  });
  it("rejects expired and missing instances, and bytes beyond the file budget", async () => {
    const { diagnostics, read, audit } = fixture();
    for (const [state, code] of [
      ["expired", "EXPIRED"],
      ["not_found", "NOT_FOUND"],
    ]) {
      read.mockResolvedValueOnce({
        eventId: "evt_synthetic",
        projectId: "p",
        occurrence: null,
        state: state!,
        expiresAt: null,
      });
      await expect(
        diagnostics.exportEvidence(ch, p, "p", "evt_synthetic", "json"),
      ).rejects.toThrow(code);
    }
    read.mockResolvedValueOnce({
      eventId: "evt_synthetic",
      projectId: "p",
      occurrence: null,
      state: "ready",
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    await expect(
      diagnostics.exportEvidence(ch, p, "p", "evt_synthetic", "json"),
    ).rejects.toThrow("EXPIRED");
    read.mockResolvedValueOnce({
      eventId: "evt_synthetic",
      projectId: "p",
      occurrence: null,
      state: "ready",
      expiresAt: null,
      storedEnvelopeJson: "界".repeat(180000),
    });
    await expect(
      diagnostics.exportEvidence(ch, p, "p", "evt_synthetic", "json"),
    ).rejects.toThrow("BYTE_BUDGET");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("界");
  });
});
