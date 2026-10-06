import { describe, it, expect } from "vitest";
import {
  projectOccurrence,
  qualityOccurrencePage,
  readQualityCursor,
  safeQualityPath,
  type PageQualityQuery,
} from "../src/page-quality.js";
const q: PageQualityQuery = {
  env: "dev",
  from: "2026-10-01T00:00:00Z",
  to: "2026-10-02T00:00:00Z",
  mode: "all",
  category: "all",
  limit: 2,
};
const secret = "test-cursor-signing-key";
const now = Date.parse("2026-10-04T00:00:00Z");
const row = (id: string, group = "a", category = "js") => ({
  event_id: id,
  error_group_id: group.repeat(64),
  error_type: category === "api" ? "api" : "js",
  error_category: category,
  at: 1790812800000,
  page_route: "/orders/:id",
  payload_json: "{}",
  env: "dev",
});
describe("R5-B occurrence projection and pagination", () => {
  it("deduplicates repeated delivery and pages stable timestamp ties without omissions", () => {
    const rows = [row("one"), row("two"), row("three", "b"), row("one")];
    const first = qualityOccurrencePage(rows, "p", q, secret, {
      asOf: now,
      after: null,
    });
    expect(first.totalOccurrences).toBe(3);
    expect(first.totalGroups).toBe(2);
    expect(first.items).toHaveLength(2);
    const next = { ...q, cursor: first.nextCursor! };
    const last = qualityOccurrencePage(
      rows,
      "p",
      next,
      secret,
      readQualityCursor("p", next, secret, now),
    );
    expect(last.items).toHaveLength(1);
    expect(
      new Set([...first.items, ...last.items].map((e) => e.occurrenceId)).size,
    ).toBe(3);
    expect(last.nextCursor).toBeNull();
    const latest = qualityOccurrencePage(rows, "p", { ...q, mode: "latest" }, secret, {
      asOf: now,
      after: null,
    });
    expect(latest.items).toHaveLength(2);
    expect(latest.items.find((e) => e.groupId.startsWith("a"))?.occurrences).toBe(2);
  });
  it("binds cursor to all query dimensions, rejects tampering, future and expired cursors", () => {
    const page = qualityOccurrencePage([row("1"), row("2"), row("3")], "p", q, secret, {
      asOf: now,
      after: null,
    });
    const next = { ...q, cursor: page.nextCursor! };
    for (const patch of [
      { env: "prod" },
      { category: "api" },
      { pageRoute: "/other" },
      { mode: "latest" as const },
      { groupId: "b".repeat(64) },
      { limit: 3 },
      { to: "2026-10-03T00:00:00Z" },
    ])
      expect(() => readQualityCursor("p", { ...next, ...patch }, secret, now)).toThrow(
        "CURSOR",
      );
    expect(() => readQualityCursor("foreign", next, secret, now)).toThrow("CURSOR");
    expect(() =>
      readQualityCursor("p", { ...next, cursor: next.cursor + "x" }, secret, now),
    ).toThrow("CURSOR");
    expect(() => readQualityCursor("p", next, secret, now + 3600001)).toThrow("CURSOR");
    expect(() => readQualityCursor("p", next, secret, now - 1)).toThrow("CURSOR");
  });
  it("only projects safe context, never legacy raw content or identities", () => {
    const item = projectOccurrence({
      ...row("safe"),
      page_route: "/orders/123456?token=SECRET",
      error_stack_frame: "at fn (https://host/app.js?token=SECRET:2:3)",
      error_message: "PRIVATE_DOM",
      user_id: "PRIVATE_ACCOUNT",
      ua: "PRIVATE_UA",
      browser: "PRIVATE_BROWSER",
      os: "PRIVATE_OS",
      request_path: "/orders/123456?token=SECRET",
      payload_json: JSON.stringify({
        headers: "PRIVATE_HEADER",
        body: "PRIVATE_BODY",
        breadcrumb: { b0: "navigation", b1: "PRIVATE_TEXT" },
      }),
    });
    expect(JSON.stringify(item)).not.toMatch(/PRIVATE|SECRET|123456/);
    expect(item.context.breadcrumbs).toEqual(["navigation"]);
    expect(item.stackFrames).toEqual(["/app.js"]);
    expect(item.context.statusCode).toBeNull();
    expect(safeQualityPath("/user/a@example.com")).toBeNull();
    expect(
      projectOccurrence({ ...row("x"), payload_json: "not json" }).context.breadcrumbs,
    ).toEqual([]);
  });
  it("filters categories, routes and groups before latest selection and counts", () => {
    const rows = [
      row("1", "a", "vue"),
      row("2", "a", "react"),
      row("3", "b", "api"),
      { ...row("4"), page_route: "/other" },
    ];
    const out = qualityOccurrencePage(
      rows,
      "p",
      { ...q, category: "vue", mode: "latest" },
      secret,
      { asOf: now, after: null },
    );
    expect(out.totalOccurrences).toBe(1);
    expect(out.items[0]?.category).toBe("vue");
    expect(
      projectOccurrence({ ...row("api"), error_type: "api", error_category: "timeout" })
        .category,
    ).toBe("api");
    expect(projectOccurrence({ ...row("old"), error_category: null }).category).toBe(
      "other",
    );
    expect(() =>
      qualityOccurrencePage(Array(50001).fill(row("1")), "p", q, secret, {
        asOf: now,
        after: null,
      }),
    ).toThrow("BUDGET");
  });
});
