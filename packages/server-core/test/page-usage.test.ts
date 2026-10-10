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
    usageVersion: "r6-1",
    usageSequence: 1,
    usageClosed: true,
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

it("R6 duration requires terminal and contiguous settlements, not just a hidden segment", () => {
  const a = event("a", 0),
    hidden = event("h", 1000, {
      event: "page_leave",
      pageView: "a",
      duration: 100,
      usageClosed: false,
    });
  const terminal = event("t", 2000, {
    event: "page_leave",
    pageView: "a",
    duration: 200,
    usageSequence: 2,
  });
  expect(
    pageUsageWindow([a, hidden], from, to, "UTC").inputs.avg_usage_duration?.value,
  ).toBeNull();
  expect(
    pageUsageWindow([a, terminal], from, to, "UTC").inputs.avg_usage_duration?.value,
  ).toBeNull();
  expect(
    pageUsageWindow([a, hidden, terminal], from, to, "UTC").inputs.avg_usage_duration
      ?.value,
  ).toBe(300);
  expect(
    pageUsageWindow(
      [{ ...a, usageVersion: "legacy" }, hidden, terminal],
      from,
      to,
      "UTC",
    ).inputs.avg_usage_duration?.value,
  ).toBeNull();
});

it("R6 spring DST gap and a leap-month boundary preserve calendar identities", () => {
  const spring = pageUsageWindow(
    [
      event("a", 0, { at: Date.parse("2026-03-08T06:59:00Z") }),
      event("b", 0, { at: Date.parse("2026-03-08T07:01:00Z") }),
    ],
    "2026-03-08T05:00:00Z",
    "2026-03-09T04:00:00Z",
    "America/New_York",
  );
  expect(spring.inputs.dau?.value).toBe(1);
  expect(spring.hourly[2]?.pv).toBeNull();
  expect(spring.hourly[3]?.pv).toBe(1);
  const leap = pageUsageWindow(
    [
      event("c", 0, { at: Date.parse("2024-02-29T23:59:00Z") }),
      event("d", 0, { at: Date.parse("2024-03-01T00:00:00Z") }),
    ],
    "2024-02-29T00:00:00Z",
    "2024-03-02T00:00:00Z",
    "UTC",
  );
  expect(leap.calendar.mau?.map((r) => r.period)).toEqual(["2024-02", "2024-03"]);
  expect(leap.inputs.mau?.value).toBeNull();
});
