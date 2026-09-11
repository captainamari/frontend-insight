import { describe, expect, it } from "vitest";
import {
  buildRangeQuery,
  fillTrendGaps,
  isRangePreset,
  rangeSearch,
} from "../src/range.js";

describe("dashboard URL ranges", () => {
  it("keeps the selected preset recognizable after a shared URL is refreshed", () => {
    expect(isRangePreset("24h")).toBe(true);
    expect(isRangePreset("7d")).toBe(true);
    expect(isRangePreset("30d")).toBe(true);
    expect(isRangePreset("90d")).toBe(false);
  });

  it("uses one project timezone for every API query", () => {
    const query = buildRangeQuery(
      "7d",
      "Asia/Shanghai",
      new Date("2026-07-27T12:00:00.000Z"),
    );
    expect(query).toEqual({
      from: "2026-07-20T12:00:00.000Z",
      to: "2026-07-27T12:00:00.000Z",
      timezone: "Asia/Shanghai",
      granularity: "hour",
    });
    expect(new URLSearchParams(rangeSearch(query)).get("timezone")).toBe(
      "Asia/Shanghai",
    );
  });
});

describe("trend gap policy", () => {
  it("inserts a null point instead of connecting across a missing bucket", () => {
    const range = {
      from: "2026-07-27T00:00:00.000Z",
      to: "2026-07-27T05:00:00.000Z",
      timezone: "UTC",
      granularity: "hour" as const,
    };
    const result = fillTrendGaps(
      [
        { bucket: "2026-07-27 00:00:00", pv: 3, visitors: 2 },
        { bucket: "2026-07-27 03:00:00", pv: 5, visitors: 4 },
      ],
      range,
      "pv",
      "visitors",
    );
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({ primary: null, secondary: null });
    expect(result[2]).toMatchObject({ primary: 5, secondary: 4 });
  });

  it("does not invent zeros for a complete series", () => {
    const range = {
      from: "2026-07-27T00:00:00.000Z",
      to: "2026-07-27T02:00:00.000Z",
      timezone: "UTC",
      granularity: "hour" as const,
    };
    expect(
      fillTrendGaps(
        [
          { bucket: "2026-07-27 00:00:00", exposed: 4, succeeded: 1 },
          { bucket: "2026-07-27 01:00:00", exposed: 0, succeeded: 0 },
        ],
        range,
        "exposed",
        "succeeded",
      ),
    ).toEqual([
      {
        bucket: "2026-07-27 00:00:00",
        primary: 4,
        secondary: 1,
      },
      {
        bucket: "2026-07-27 01:00:00",
        primary: 0,
        secondary: 0,
      },
    ]);
  });
});
