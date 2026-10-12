import { describe, it, expect, vi } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  diagnosticMatches,
  searchDiagnostics,
  type DiagnosticSearchQuery,
} from "../src/diagnostic-search.js";
const q: DiagnosticSearchQuery = {
  env: "dev",
  from: "2026-10-10T00:00:00Z",
  to: "2026-10-11T00:00:00Z",
  term: "token=测试\n😀",
  field: "raw",
  category: "all",
  offset: 0,
  limit: 1,
};
const rows = [1, 2, 3].map((n) => ({
  event_id: `evt_fixture0${n}`,
  error_group_id: "a".repeat(64),
  at: 1791586800000,
  error_type: "js",
  error_category: "js",
  payload_json: "{}",
  env: "dev",
  release: "r1",
}));
function client(
  base = rows,
  details = rows.map((r) => ({
    event_id: r.event_id,
    envelope_json: JSON.stringify({ raw: { error: { message: "Token=测试\n😀" } } }),
  })),
) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      json: async () => ({ data: base, statistics: { rows_read: 4 } }),
    })
    .mockResolvedValueOnce({
      json: async () => ({ data: details, statistics: { rows_read: 3 } }),
    });
  return { ch: { query } as unknown as ClickHouseClient, query };
}
describe("D4 bounded authorized search primitive", () => {
  it("matches decoded values, literal metacharacters, Unicode and newline, not keys", () => {
    const raw = {
      error: { message: "A.*\n中文😀" },
      console: [{ parameters: ["MixedCase"] }],
      hiddenkey: "no",
    };
    expect(diagnosticMatches(raw, "a.*\n中", "message")).toBe(true);
    expect(diagnosticMatches(raw, "mixedcase", "raw")).toBe(true);
    expect(diagnosticMatches(raw, "mixedcase", "message")).toBe(false);
    expect(diagnosticMatches(raw, "hiddenkey", "raw")).toBe(false);
  });
  it("searches candidates before pagination, ties are stable and query term never reaches SQL", async () => {
    const { ch, query } = client();
    const first = await searchDiagnostics(ch, "project", q);
    expect(first.total).toBe(3);
    expect(first.items[0]!.eventId).toBe("evt_fixture03");
    expect(first.nextOffset).toBe(1);
    expect(first.statistics.rowsRead).toBe(7);
    expect(JSON.stringify(query.mock.calls)).not.toContain(q.term);
    expect(query.mock.calls[0]![0].query_params).toMatchObject({
      project: "project",
      env: "dev",
      from: q.from,
      to: q.to,
    });
    const next = await searchDiagnostics(client().ch, "project", {
      ...q,
      offset: 1,
      asOf: first.asOf,
    });
    expect(next.items[0]!.eventId).toBe("evt_fixture02");
  });
  it("fails closed on overflow/timeouts and validates budgets without reading", async () => {
    const { ch, query } = client();
    await expect(
      searchDiagnostics(ch, "p", { ...q, to: "2026-11-10T00:00:00Z" }),
    ).rejects.toThrow("BUDGET");
    expect(query).not.toHaveBeenCalled();
    await expect(
      searchDiagnostics(client(Array(501).fill(rows[0])).ch, "p", q),
    ).rejects.toThrow("CANDIDATE_BUDGET");
    const failed = {
      query: vi.fn().mockRejectedValue(new Error("SQL WITH PRIVATE TEXT")),
    } as unknown as ClickHouseClient;
    await expect(searchDiagnostics(failed, "p", q)).rejects.toThrow(
      "EXECUTION_BUDGET_OR_UNAVAILABLE",
    );
  });
});
