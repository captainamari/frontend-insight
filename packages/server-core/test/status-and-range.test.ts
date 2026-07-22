import { describe, expect, it } from "vitest";
import { previousLocalCalendarDay, validateAnalyticsRange } from "../src/analytics.js";
import { FixedWindowRateLimiter } from "../src/auth.js";
import type { DataStatusRecord } from "../src/model.js";
import { evaluateDataStatus } from "../src/status.js";

const base: DataStatusRecord = {
  projectId: "project",
  lastReceivedAt: null,
  lastIngestedAt: null,
  lastQueryableAt: null,
  lastRequestId: null,
  lastSdkVersion: null,
  lastRejectionCode: null,
  acceptedEvents: 0,
  rejectedEvents: 0,
  deadLetterEvents: 0,
};

describe("data status", () => {
  it("distinguishes no data, delayed, broken and healthy", () => {
    const nowMs = Date.parse("2026-07-19T17:10:00.000Z");
    expect(evaluateDataStatus(base, { nowMs }).state).toBe("no_data");
    expect(
      evaluateDataStatus(
        { ...base, lastReceivedAt: "2026-07-19T17:09:00.000Z" },
        { nowMs },
      ).state,
    ).toBe("delayed");
    expect(
      evaluateDataStatus(
        {
          ...base,
          lastReceivedAt: "2026-07-19T17:09:00.000Z",
          deadLetterEvents: 1,
        },
        { nowMs },
      ).state,
    ).toBe("broken");
    expect(
      evaluateDataStatus(
        {
          ...base,
          lastReceivedAt: "2026-07-19T17:09:00.000Z",
          lastQueryableAt: "2026-07-19T17:09:30.000Z",
        },
        { nowMs },
      ).state,
    ).toBe("healthy");
  });
});

describe("analytics range semantics", () => {
  it("limits range and hourly granularity", () => {
    expect(() =>
      validateAnalyticsRange({
        from: "2026-01-01T00:00:00.000Z",
        to: "2027-03-01T00:00:00.000Z",
        timezone: "UTC",
        granularity: "day",
      }),
    ).toThrow("ANALYTICS_RANGE_TOO_LARGE");
    expect(() =>
      validateAnalyticsRange({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-03-01T00:00:00.000Z",
        timezone: "UTC",
        granularity: "hour",
      }),
    ).toThrow("GRANULARITY_TOO_FINE");
  });

  it("shifts comparisons by a local calendar day across DST", () => {
    expect(
      previousLocalCalendarDay("2026-03-09T07:00:00.000Z", "America/Los_Angeles"),
    ).toBe("2026-03-08T08:00:00.000Z");
    expect(
      previousLocalCalendarDay("2026-11-02T08:00:00.000Z", "America/Los_Angeles"),
    ).toBe("2026-11-01T07:00:00.000Z");
  });
});

describe("login rate limiter", () => {
  it("opens a fresh window after expiry", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(2, 1_000, () => now);
    expect(limiter.take("ip")).toBe(true);
    expect(limiter.take("ip")).toBe(true);
    expect(limiter.take("ip")).toBe(false);
    now = 1_000;
    expect(limiter.take("ip")).toBe(true);
  });
});
