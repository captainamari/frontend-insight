import { describe, expect, it } from "vitest";
import { resolveProjectCalendar as range } from "../src/project-range.js";

describe("R3 project calendar", () => {
  it.each([
    ["7d", "day"],
    ["30d", "day"],
    ["90d", "week"],
    ["180d", "month"],
    ["365d", "month"],
  ] as const)(
    "canonical %s uses %s and includes current local date",
    (key, granularity) => {
      const r = range(
        { range: key, env: "prod" },
        "Asia/Shanghai",
        new Date("2026-09-15T08:00:00Z"),
      );
      expect(r.granularity).toBe(granularity);
      expect(r.localTo).toBe("2026-09-15T16:00:00.000");
      expect(r.buckets[0]!.from).toBe(r.from);
      expect(r.buckets.at(-1)!.to).toBe(r.to);
      r.buckets.slice(1).forEach((b, i) => expect(b.from).toBe(r.buckets[i]!.to));
    },
  );
  it.each([
    ["2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", 23],
    ["2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", 25],
  ])("uses calendar DST day %s", (from, to, hours) => {
    const r = range(
      { range: "custom", env: "dev", from: String(from), to: String(to) },
      "America/New_York",
    );
    expect(r.buckets).toHaveLength(1);
    expect(Date.parse(r.to) - Date.parse(r.from)).toBe(Number(hours) * 3600000);
    expect(r.buckets[0]!.partial).toBe(false);
  });
  it("preserves R2 instants across zones, including partial buckets", () => {
    const input = {
      range: "7d" as const,
      env: "staging" as const,
      from: "2026-03-05T13:47:01.123Z",
      to: "2026-03-12T13:47:01.123Z",
    };
    for (const zone of ["UTC", "America/New_York", "Asia/Shanghai"]) {
      const r = range(input, zone);
      expect(r.from).toBe(input.from);
      expect(r.to).toBe(input.to);
      expect(r.buckets[0]!.partial).toBe(true);
    }
  });
  it("uses Monday and calendar month boundaries without 30-day approximations", () => {
    const week = range(
      {
        range: "90d",
        env: "prod",
        from: "2026-03-04T10:00:00Z",
        to: "2026-03-12T10:00:00Z",
      },
      "America/New_York",
    );
    expect(week.buckets[0]!.localStart).toBe("2026-03-02");
    expect(Date.parse(week.buckets[0]!.end) - Date.parse(week.buckets[0]!.start)).toBe(
      167 * 3600000,
    );
    const months = range(
      {
        range: "180d",
        env: "prod",
        from: "2026-01-31T00:00:00Z",
        to: "2026-04-01T00:00:00Z",
      },
      "UTC",
    );
    expect(months.buckets.map((b) => b.localStart)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
    expect(
      Date.parse(months.buckets[1]!.end) - Date.parse(months.buckets[1]!.start),
    ).toBe(28 * 86400000);
  });
  it("clamps the 13-month limit at month end and rejects malformed/custom truncation", () => {
    const input = {
      range: "custom" as const,
      env: "prod" as const,
      from: "2025-01-31T00:00:00Z",
      to: "2026-02-28T00:00:00Z",
    };
    expect(range(input, "UTC").to).toBe("2026-02-28T00:00:00.000Z");
    expect(() => range({ ...input, to: "2026-02-28T00:00:00.001Z" }, "UTC")).toThrow(
      "PROJECT_RANGE_TOO_LARGE",
    );
    for (const q of [
      { range: "custom", env: "prod" },
      { ...input, to: "bad" },
      { ...input, to: input.from },
    ])
      expect(() => range(q as typeof input, "UTC")).toThrow("PROJECT_RANGE_INVALID");
    expect(() => range(input, "+08:00")).toThrow("TIMEZONE_INVALID");
  });
});
