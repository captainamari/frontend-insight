import { describe, expect, it } from "vitest";
import {
  repeatedOperationRate,
  type RepeatedOperationFact,
} from "../src/repeated-operation.js";
const day = 86400000;
const base: RepeatedOperationFact = {
  projectId: "p",
  env: "dev",
  user: "u",
  session: "s",
  objectType: "order",
  reference: "opaque",
  operationKey: "save",
  instanceId: "1",
  at: 0,
  received: 0,
};
const fact = (
  at: number,
  id: string,
  extra: Partial<RepeatedOperationFact> = {},
): RepeatedOperationFact => ({
  ...base,
  at,
  received: at,
  instanceId: id,
  session: id,
  ...extra,
});
const context = {
  projectId: "p",
  env: "dev",
  from: 0,
  to: day + 1,
  asOf: 4 * day,
  scannedFrom: -day,
  scannedTo: 3 * day,
  coverage: "proven" as const,
};
describe("C03 related-session rolling 24h rate", () => {
  it("counts 2/3/4 operations as zero/all/all related session cohorts, including the first session", () => {
    const events = [fact(0, "1"), fact(day / 2, "2"), fact(day, "3"), fact(day, "4")];
    expect(repeatedOperationRate(events.slice(0, 2), context)).toMatchObject({
      numerator: 0,
      denominator: 2,
      observedValue: 0,
    });
    expect(repeatedOperationRate(events.slice(0, 3), context)).toMatchObject({
      numerator: 3,
      denominator: 3,
      observedValue: 1,
    });
    expect(repeatedOperationRate(events, context)).toMatchObject({
      numerator: 4,
      denominator: 4,
    });
    expect(
      repeatedOperationRate(
        events.map((e) => ({ ...e, session: "same" })),
        context,
      ).denominator,
    ).toBe(1);
  });
  it("includes exactly 24h and crosses midnight without calendar-day grouping", () => {
    const events = [fact(0, "1"), fact(100, "2"), fact(day, "3")];
    expect(repeatedOperationRate(events, context).numerator).toBe(3);
    expect(
      repeatedOperationRate([events[0]!, events[1]!, fact(day + 1, "3")], {
        ...context,
        to: day + 2,
      }).numerator,
    ).toBe(0);
  });
  it("isolates identity, object type/reference, operation key, project and env", () => {
    for (const extra of [
      { user: "other" },
      { objectType: "other" },
      { reference: "other" },
      { operationKey: "other" },
      { projectId: "other" },
      { env: "prod" },
    ]) {
      expect(
        repeatedOperationRate(
          [fact(0, "1"), fact(1, "2"), fact(2, "3", extra)],
          context,
        ).numerator,
      ).toBe(0);
    }
  });
  it("deduplicates deliveries, respects received asOf and rejects conflicting instances", () => {
    const events = [fact(0, "1"), fact(1, "2")];
    expect(repeatedOperationRate([...events, events[0]!], context).numerator).toBe(0);
    expect(
      repeatedOperationRate([...events, fact(2, "3", { received: 5 * day })], context)
        .numerator,
    ).toBe(0);
    expect(repeatedOperationRate([...events, fact(2, "1")], context).reason).toBe(
      "CONFLICTING_OPERATION_INSTANCES",
    );
  });
  it("looks forward to mark earlier cohort session members but never adds outside session members to the denominator", () => {
    expect(
      repeatedOperationRate([fact(0, "1"), fact(1, "2"), fact(2, "3")], {
        ...context,
        to: 1,
      }),
    ).toMatchObject({ numerator: 1, denominator: 1 });
    expect(repeatedOperationRate([], { ...context, scannedFrom: 0 }).reason).toBe(
      "REPEATED_LOOKAROUND_INCOMPLETE",
    );
    expect(repeatedOperationRate([], { ...context, asOf: day }).reason).toBe(
      "REPEATED_LATENESS_WINDOW_OPEN",
    );
    expect(repeatedOperationRate([], { ...context, coverage: "expired" }).reason).toBe(
      "OBJECT_REFERENCE_COVERAGE_EXPIRED",
    );
  });
  it("returns only aggregates and scales to the bounded 50k-fact scan without quadratic windows", () => {
    const r = repeatedOperationRate(
      Array.from({ length: 50000 }, (_, i) => fact(i, String(i))),
      context,
    );
    expect(r).toMatchObject({ value: 1, numerator: 50000, denominator: 50000 });
    expect(JSON.stringify(r)).not.toContain("opaque");
    expect(() =>
      repeatedOperationRate(
        Array.from({ length: 50001 }, () => base),
        context,
      ),
    ).toThrow("REPEATED_FACT_LIMIT");
  });
});
