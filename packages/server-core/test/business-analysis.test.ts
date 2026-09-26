import { describe, it, expect } from "vitest";
import {
  evaluateOverviewMetrics,
  segmentOverviewBuckets,
} from "../src/project-overview.js";
import { businessFactWindow, emptyBusinessObservation } from "../src/business-facts.js";
import { METRIC_CATALOG } from "../src/system-metric-catalog.js";
import type { MetricLibraryDefinition } from "../src/metric-library.js";
import { resolveProjectCalendar } from "@frontend-insight/event-contract/project-range";
const definition = (key: string) =>
  ({
    ...METRIC_CATALOG.find((m) => m.metricKey === key)!,
    id: key,
    libraryVersionId: "v1",
    formulaAst: null,
    enabled: true,
  }) as MetricLibraryDefinition;
const pv = definition("pv"),
  uv = definition("uv");
describe("R4-A module aggregation and shared evaluator", () => {
  it("keeps observed page-view users distinct from complete business UV and genuine zero from missing", () => {
    const f = businessFactWindow({
      ...emptyBusinessObservation(),
      events: 5,
      pv: 3,
      uv: 2,
      unidentified: 1,
      excluded: 1,
    });
    const results = evaluateOverviewMetrics(
      [pv, uv],
      ["pv", "uv"],
      f,
      "day",
      null,
      "module",
    );
    expect(results.map((m) => m.rawValue)).toEqual([3, 2]);
    expect(
      results.every(
        (m) =>
          m.value === null && m.reason === "IDENTITY_AND_ENV_COVERAGE_NOT_VERIFIED",
      ),
    ).toBe(true);
    expect(
      businessFactWindow({ ...emptyBusinessObservation(), events: 2, pv: 0, uv: 0 }).raw
        .pv?.value,
    ).toBe(0);
    expect(businessFactWindow(emptyBusinessObservation()).raw.pv?.value).toBeNull();
  });
  it("runs compatible module ratios from whole-window inputs, not average page ratios", () => {
    const ratio: MetricLibraryDefinition = {
      ...pv,
      origin: "business",
      metricKey: "views_per_user",
      unit: "ratio",
      entityScopes: ["module"],
      minimumSample: 0,
      formulaAst: {
        type: "binary",
        operator: "/",
        left: { type: "metric", metricKey: "pv" },
        right: { type: "metric", metricKey: "uv" },
      },
    };
    const run = (p: number, u: number) => {
      const f = businessFactWindow({
        ...emptyBusinessObservation(),
        events: p,
        pv: p,
        uv: u,
      });
      f.inputs = f.raw;
      return evaluateOverviewMetrics(
        [pv, uv, ratio],
        ["views_per_user"],
        f,
        "day",
        null,
        "module",
      )[0]!;
    };
    expect(run(10, 2).value).toBe(5);
    expect(run(90, 3).value).toBe(30);
    // Two users overlap across the pages: union=3, not 2+3.
    expect(run(100, 3).value).toBeCloseTo(100 / 3);
    expect(run(100, 3).value).not.toBe(17.5);
    expect(run(5, 0).value).toBeNull();
  });
  it("rejects non-module scopes and unavailable collectors, without mutating R3 scope", () => {
    const f = businessFactWindow({
      ...emptyBusinessObservation(),
      events: 2,
      pv: 2,
      uv: 1,
    });
    f.inputs = f.raw;
    expect(
      evaluateOverviewMetrics(
        [{ ...pv, entityScopes: ["project"] }],
        ["pv"],
        f,
        "day",
        null,
        "module",
      )[0]?.reason,
    ).toBe("MODULE_METRIC_SCOPE_REQUIRED");
    expect(evaluateOverviewMetrics([pv], ["pv"], f, "day", null)[0]?.value).toBe(2);
    expect(
      evaluateOverviewMetrics(
        [definition("operation_fail_rate")],
        ["operation_fail_rate"],
        f,
        "day",
        null,
        "module",
      )[0]?.reason,
    ).toBe("METRIC_NOT_COLLECTED");
  });
  it("does not substitute page percentiles or legacy operation duration for task samples", () => {
    const task = definition("task_duration");
    expect(task.percentiles).toEqual(["p50", "p90", "p75", "p99"]);
    const f = businessFactWindow({
      ...emptyBusinessObservation(),
      events: 100,
      pv: 100,
      uv: 10,
    });
    const result = evaluateOverviewMetrics(
      [task],
      ["task_duration"],
      f,
      "day",
      null,
      "module",
    )[0]!;
    expect(result.value).toBeNull();
    expect(result.rawValue).toBeNull();
    expect(result.reason).toContain("R4-B");
    expect(f.inputs.task_duration).toBeUndefined();
  });
  it("never relabels prior identity definitions or crosses activation boundaries", () => {
    const f = businessFactWindow({
      ...emptyBusinessObservation(),
      events: 1,
      pv: 1,
      uv: 1,
    });
    expect(
      evaluateOverviewMetrics(
        [{ ...uv, definitionVersion: "system-v1.8.0" }],
        ["uv"],
        f,
        "day",
        null,
        "module",
      )[0]?.rawValue,
    ).toBeNull();
    expect(
      evaluateOverviewMetrics(
        [pv],
        ["pv"],
        f,
        "day",
        "VERSION_RANGE_BOUNDARY",
        "module",
      )[0]?.rawValue,
    ).toBeNull();
    const q = resolveProjectCalendar(
      {
        range: "custom",
        env: "prod",
        from: "2026-03-08T05:00:00Z",
        to: "2026-03-09T04:00:00Z",
      },
      "America/New_York",
    );
    const segments = segmentOverviewBuckets(q.buckets, [
      {
        versionId: "old",
        effectiveFrom: q.from,
        effectiveTo: "2026-03-08T15:00:00.000Z",
      },
      {
        versionId: "new",
        effectiveFrom: "2026-03-08T15:00:00.000Z",
        effectiveTo: null,
      },
    ]);
    expect(segments.map((s) => s.versionId)).toEqual(["old", "new"]);
    expect(segments.every((s) => s.partial)).toBe(true);
  });
});
