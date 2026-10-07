import { describe, it, expect } from "vitest";
import {
  probeDistribution,
  evaluateAbnormal,
  abnormalSubject,
  type SettingsFact,
  type AbnormalConfig,
} from "../src/settings-facts.js";
const from = "2026-10-07T00:00:00.000Z",
  to = "2026-10-08T00:00:00.000Z";
function event(id: string, at: string, version = "0.8.0"): SettingsFact {
  return {
    event_id: id,
    at: Date.parse(at),
    sdk_version: version,
    schema_version: 3,
    event: "custom",
    user_id: "hashed-user",
    device_id: id,
    operation_instance_id: id,
    feature_stage: "started",
    request_id: "request",
  };
}
const config: AbnormalConfig = {
  env: "dev",
  threshold: 2,
  minimumSample: 2,
  baselineDays: 7,
  minimumBaselineDays: 2,
  multiplier: 2,
  workStart: 9,
  workEnd: 18,
  workDays: [1, 2, 3, 4, 5],
  visibleRoles: ["owner"],
  sharedSubjects: [],
  exceptions: [],
};
describe("R7 hand-computable observed facts, not approved production policy", () => {
  it("uses event-id idempotence, unknown-inclusive denominator and [from,to)", () => {
    const a = event("a", from),
      b = event("b", "2026-10-07T10:00:00Z", "");
    const d = probeDistribution([a, a, b, event("outside", to)], from, to);
    expect(d.denominator).toBe(2);
    expect(d.items.map((v) => [v.version, v.count, v.share])).toEqual([
      ["0.8.0", 1, 0.5],
      ["unknown", 1, 0.5],
    ]);
    expect(d.items[1]!.lastObservedAt).toBe("2026-10-07T10:00:00.000Z");
    expect(probeDistribution([], from, to).dataState).toBe("no_data");
  });
  it("threshold is inclusive; duplicates cannot manufacture multi-device or counts", () => {
    const a = event("a", from),
      b = event("b", "2026-10-07T01:00:00Z");
    const r = evaluateAbnormal([a, a, b], "outside_hours", config, from, to, "UTC");
    expect(r.items[0]).toMatchObject({ status: "hit", observed: 2 });
    expect(
      evaluateAbnormal([a, a], "multi_device", config, from, to, "UTC").items[0]!
        .status,
    ).toBe("insufficient_sample");
    expect(
      evaluateAbnormal([a, b], "multi_device", config, from, to, "UTC").items[0]!
        .observed,
    ).toBe(2);
  });
  it("project timezone and inclusive work-start / exclusive work-end", () => {
    const rows = [
      event("a", "2026-10-07T01:00:00Z"),
      event("b", "2026-10-07T10:00:00Z"),
    ];
    expect(
      evaluateAbnormal(
        rows,
        "outside_hours",
        { ...config, threshold: 1 },
        from,
        to,
        "Asia/Shanghai",
      ).items[0],
    ).toMatchObject({ observed: 1, status: "hit" });
  });
  it("requires sufficient observed baseline days and normalizes comparable volume", () => {
    const rows = [
      event("a", from),
      event("b", "2026-10-07T01:00:00Z"),
      event("c", "2026-10-06T01:00:00Z"),
      event("d", "2026-10-05T01:00:00Z"),
    ];
    expect(
      evaluateAbnormal(rows, "historical_volume", config, from, to, "UTC").items[0],
    ).toMatchObject({ observed: 2, baseline: 1, status: "hit" });
    expect(
      evaluateAbnormal(rows.slice(0, 3), "historical_volume", config, from, to, "UTC")
        .items[0]!.reason,
    ).toBe("BASELINE_DAYS_MISSING");
  });
  it("suppresses shared accounts and overlapping travel/on-call exceptions", () => {
    const rows = [event("a", from), event("b", from)],
      subject = abnormalSubject("hashed-user");
    expect(
      evaluateAbnormal(
        rows,
        "outside_hours",
        { ...config, sharedSubjects: [subject] },
        from,
        to,
        "UTC",
      ).items[0]!.reason,
    ).toBe("SHARED_ACCOUNT");
    for (const reason of ["travel", "on_call"]) {
      expect(
        evaluateAbnormal(
          rows,
          "outside_hours",
          { ...config, exceptions: [{ subject, from, to, reason }] },
          from,
          to,
          "UTC",
        ).items[0],
      ).toMatchObject({ reason: "APPROVED_EXCEPTION", observed: null });
    }
  });
  it("never converts views or device counts into denied routes/IP facts", () => {
    for (const key of ["multi_ip", "permission_denied"])
      expect(
        evaluateAbnormal([event("a", from)], key, config, from, to, "UTC").status,
      ).toBe("not_collected");
    expect(
      evaluateAbnormal(
        [{ ...event("a", from), event: "page_view", feature_stage: null }],
        "outside_hours",
        config,
        from,
        to,
        "UTC",
      ).items,
    ).toEqual([]);
  });
});
