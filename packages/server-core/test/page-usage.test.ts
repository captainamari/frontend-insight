import { describe, it, expect } from "vitest";
import { pageUsageWindow, type UsageEvent } from "../src/page-usage.js";
const from = "2026-10-01T00:00:00.000Z",
  to = "2026-10-02T00:00:00.000Z";
function event(
  id: string,
  delta: number,
  overrides: Partial<UsageEvent> = {},
): UsageEvent {
  return {
    id,
    at: Date.parse(from) + delta,
    event: "page_view",
    route: "/a",
    user: "user",
    device: "device",
    session: "s1",
    pageView: id,
    duration: null,
    ...overrides,
  };
}
describe("R6 hand-computable page usage", () => {
  it("counts views, idempotent retries, identified/anonymous namespaces and cross-page vv", () => {
    const a = event("a", 0),
      b = event("b", 1000, { route: "/b" }),
      c = event("c", 2000, { user: null, device: "user", session: "s2" });
    const r = pageUsageWindow([a, a, b, c], from, to, "UTC", "/a");
    expect(r.inputs.pv?.value).toBe(2);
    expect(r.inputs.uv?.value).toBe(2);
    expect(r.inputs.vv?.value).toBe(2);
    expect(r.inputs.bounce_rate?.value).toBe(0.5);
    expect(r.identity).toMatchObject({ identified: 1, anonymous: 1 });
    expect(r.diagnostics.pageDepthP50).toBe(1);
  });
  it("sums distinct visible segments, preserves true zero, refuses missing leaves and empty denominators", () => {
    const a = event("a", 0),
      b = event("b", 2000, { user: null, device: "anon", session: "s2" });
    const leave = event("l", 1000, {
      event: "page_leave",
      pageView: "a",
      duration: 100,
    });
    const zero = event("z", 3000, {
      event: "page_leave",
      pageView: "b",
      duration: 0,
      user: null,
      device: "anon",
      session: "s2",
    });
    const r = pageUsageWindow([a, b, leave, leave, zero], from, to, "UTC");
    expect(r.inputs.avg_usage_duration?.value).toBe(50);
    expect(r.diagnostics.coverage).toBe(1);
    expect(r.diagnostics.visibleDuration.p50).toBe(0);
    const missing = pageUsageWindow([a, b, leave], from, to, "UTC");
    expect(missing.inputs.avg_usage_duration?.value).toBeNull();
    expect(missing.diagnostics.coverage).toBe(0.5);
    const empty = pageUsageWindow([], from, to, "UTC");
    expect(empty.inputs.bounce_rate?.value).toBeNull();
    expect(empty.hourly.every((h) => h.pv === null)).toBe(true);
  });
  it("keeps [from,to), pools cross-midnight vv, and never sums natural-period UV", () => {
    const start = "2026-09-30T23:55:00.000Z",
      end = "2026-10-01T00:10:00.000Z";
    const rows = [
      event("a", 0, { at: Date.parse(start) }),
      event("b", 0, { at: Date.parse(end) - 1, route: "/b" }),
      event("excluded", 0, { at: Date.parse(end) }),
    ];
    const r = pageUsageWindow(rows, start, end, "UTC");
    expect(r.inputs.pv?.value).toBe(2);
    expect(r.inputs.vv?.value).toBe(1);
    expect(r.inputs.dau?.value).toBeNull();
    expect(r.calendar.dau?.map((x) => x.value)).toEqual([1, 1]);
    expect(r.calendar.mau).toHaveLength(2);
    expect(r.inputs.bounce_rate?.value).toBe(0);
  });
  it("deduplicates DST repeated local hours and Monday weeks in the project timezone", () => {
    const start = "2026-11-01T04:00:00.000Z",
      end = "2026-11-02T06:00:00.000Z";
    const r = pageUsageWindow(
      [
        event("a", 0, { at: Date.parse("2026-11-01T05:30:00Z") }),
        event("b", 0, { at: Date.parse("2026-11-01T06:30:00Z") }),
        event("c", 0, { at: Date.parse("2026-11-02T05:30:00Z") }),
      ],
      start,
      end,
      "America/New_York",
    );
    expect(r.hourly[1]).toMatchObject({ pv: 2, uv: 1 });
    expect(r.calendar.wau?.map((x) => x.period)).toEqual(["2026-10-26", "2026-11-02"]);
  });
  it("missing identity is not counted as an anonymous person", () => {
    const r = pageUsageWindow(
      [event("a", 0, { user: null, device: "" })],
      from,
      to,
      "UTC",
    );
    expect(r.inputs.uv?.value).toBeNull();
    expect(r.identity.missing).toBe(1);
  });
});
