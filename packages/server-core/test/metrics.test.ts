import { describe, expect, it } from "vitest";
import {
  calculateOperationalIndex,
  DEFAULT_OPERATIONAL_PROFILE_ITEMS,
  METRIC_CATALOG,
  metricLineage,
  metricResult,
  normalizeMetricScore,
  PAGE_TEMPLATE_DURATION_TARGETS,
  validateMetricCatalog,
  type MetricDefinition,
} from "../src/metrics.js";
import type { MetricProfileItem } from "../src/model.js";

function profileItems(): MetricProfileItem[] {
  return DEFAULT_OPERATIONAL_PROFILE_ITEMS.map((item, index) => ({
    ...item,
    id: `item-${index}`,
    profileId: "profile-1",
  }));
}

function availableResults() {
  const values: Record<string, number> = {
    active_account_target_attainment: 1,
    core_page_coverage: 0.8,
    active_day_coverage: 1,
    cross_day_continuity: 0.5,
    session_distinct_pages_fit: 2,
    session_module_breadth_fit: 1,
    key_task_completion_rate: 0.9,
    task_adverse_outcome_rate: 0.1,
    key_task_duration_p50: 60_000,
    page_visible_duration_fit: 1,
  };
  return Object.entries(values).map(([metricKey, value]) =>
    metricResult({ metricKey, value, sampleSize: 10 }),
  );
}

describe("MetricCatalog", () => {
  it("contains unique, complete and acyclic versioned definitions", () => {
    expect(validateMetricCatalog()).toEqual([]);
    expect(new Set(METRIC_CATALOG.map((item) => item.metricKey)).size).toBe(
      METRIC_CATALOG.length,
    );
    expect(
      METRIC_CATALOG.every(
        (item) =>
          item.businessQuestion &&
          item.formulaDescription &&
          item.missingValuePolicy &&
          item.definitionVersion &&
          item.owner,
      ),
    ).toBe(true);
  });

  it("rejects duplicate, missing and cyclic dependencies", () => {
    const base: MetricDefinition = {
      ...METRIC_CATALOG[0]!,
      metricKey: "a",
      inputKeys: ["b"],
    };
    const errors = validateMetricCatalog([
      base,
      { ...base },
      { ...base, metricKey: "b", inputKeys: ["a"] },
      { ...base, metricKey: "c", inputKeys: ["missing"] },
    ]);
    expect(errors.some((item) => item.startsWith("DUPLICATE:a"))).toBe(true);
    expect(errors.some((item) => item.startsWith("MISSING_INPUT:c:missing"))).toBe(
      true,
    );
    expect(errors.some((item) => item.startsWith("CYCLE:"))).toBe(true);
  });

  it("builds JSON lineage through L0 facts", () => {
    const lineage = metricLineage("project_operational_index");
    expect(lineage?.nodes.some((node) => node.layer === "fact")).toBe(true);
    expect(lineage?.edges).toContainEqual({
      from: "dimension.usage_coverage",
      to: "project_operational_index",
    });
  });
});

describe("score normalization", () => {
  it("handles higher/lower/range boundaries and clamps", () => {
    expect(
      normalizeMetricScore(1.5, "higher_better", {
        targetValue: 1,
        floorValue: 0,
        ceilingValue: null,
        targetMin: null,
        targetMax: null,
        toleranceMin: null,
        toleranceMax: null,
      }),
    ).toBe(100);
    expect(
      normalizeMetricScore(0.3, "lower_better", {
        targetValue: 0.1,
        floorValue: null,
        ceilingValue: 0.5,
        targetMin: null,
        targetMax: null,
        toleranceMin: null,
        toleranceMax: null,
      }),
    ).toBeCloseTo(50);
    expect(
      normalizeMetricScore(2, "target_range", {
        targetValue: null,
        floorValue: null,
        ceilingValue: null,
        targetMin: 1,
        targetMax: 4,
        toleranceMin: 0,
        toleranceMax: 8,
      }),
    ).toBe(100);
    expect(
      normalizeMetricScore(6, "target_range", {
        targetValue: null,
        floorValue: null,
        ceilingValue: null,
        targetMin: 1,
        targetMax: 4,
        toleranceMin: 0,
        toleranceMax: 8,
      }),
    ).toBe(50);
  });

  it("applies distinct duration semantics for monitoring, analysis and task pages", () => {
    const durationMs = 1_000_000;
    const monitoring = normalizeMetricScore(
      durationMs,
      "target_range",
      PAGE_TEMPLATE_DURATION_TARGETS.monitoring_dashboard,
    );
    const analysis = normalizeMetricScore(
      durationMs,
      "target_range",
      PAGE_TEMPLATE_DURATION_TARGETS.analysis_view,
    );
    const task = normalizeMetricScore(
      durationMs,
      "target_range",
      PAGE_TEMPLATE_DURATION_TARGETS.task_operation,
    );
    expect(monitoring).toBe(100);
    expect(analysis).toBeGreaterThan(0);
    expect(analysis).toBeLessThan(100);
    expect(task).toBe(0);
  });
});

describe("project operational index", () => {
  it("uses the configured 30/25/30/15 hierarchy and exposes contributions", () => {
    const result = calculateOperationalIndex({
      results: availableResults(),
      profileItems: profileItems(),
      dataState: "healthy",
    });
    expect(result.status).toBe("available");
    expect(result.eligibleDimensions).toBe(4);
    expect(result.weightCoverage).toBeCloseTo(1);
    expect(result.value).toBeCloseTo(97.9, 1);
    expect(result.dimensions.map((item) => item.weight)).toEqual([
      0.3, 0.25, 0.3, 0.15,
    ]);
  });

  it.each([
    ["69.99%", 0.6999, "unavailable"],
    ["70%", 0.7, "available"],
    ["100%", 1, "available"],
  ] as const)("applies the %s leaf-weight gate", (_label, coverage, status) => {
    const items = profileItems();
    const results = availableResults();
    const sorted = items
      .map((item) => ({
        item,
        weight: item.dimensionWeight * item.metricWeight,
      }))
      .sort((left, right) => right.weight - left.weight);
    let kept = 0;
    const keys = new Set<string>();
    for (const { item, weight } of sorted) {
      if (kept + weight <= coverage + 0.000001) {
        keys.add(item.metricKey);
        kept += weight;
      }
    }
    if (coverage === 0.7) {
      keys.clear();
      for (const key of [
        "active_account_target_attainment",
        "core_page_coverage",
        "active_day_coverage",
        "cross_day_continuity",
        "session_distinct_pages_fit",
        "session_module_breadth_fit",
        "key_task_completion_rate",
      ]) {
        keys.add(key);
      }
    } else if (coverage === 1) {
      for (const item of items) keys.add(item.metricKey);
    }
    const unavailable = results.map((result) =>
      keys.has(result.metricKey)
        ? result
        : {
            ...result,
            value: null,
            status: "metric_not_available" as const,
            reason: "FIXTURE_UNAVAILABLE",
          },
    );
    const output = calculateOperationalIndex({
      results: unavailable,
      profileItems: items,
      dataState: "healthy",
    });
    if (coverage === 0.6999) {
      expect(output.weightCoverage).toBeLessThan(0.7);
    }
    expect(output.status).toBe(status);
  });

  it("keeps raw dimensions but suppresses total for delayed data", () => {
    const result = calculateOperationalIndex({
      results: availableResults(),
      profileItems: profileItems(),
      dataState: "delayed",
    });
    expect(result.value).toBeNull();
    expect(result.reasons).toContain("DATA_DELAYED");
    expect(result.dimensions.every((dimension) => dimension.score !== null)).toBe(true);
  });

  it("does not substitute missing account targets or insufficient samples", () => {
    const results = availableResults().map((result) =>
      result.metricKey === "active_account_target_attainment"
        ? {
            ...result,
            value: null,
            status: "missing_target" as const,
            reason: "TARGET_ACCOUNTS_NOT_CONFIGURED",
          }
        : result.metricKey === "key_task_completion_rate"
          ? { ...result, sampleSize: 1 }
          : result,
    );
    const output = calculateOperationalIndex({
      results,
      profileItems: profileItems(),
      dataState: "healthy",
    });
    const leaf = output.dimensions.flatMap((item) => item.items);
    expect(
      leaf.find((item) => item.metricKey === "active_account_target_attainment")
        ?.status,
    ).toBe("missing_target");
    expect(
      leaf.find((item) => item.metricKey === "key_task_completion_rate")?.status,
    ).toBe("insufficient_sample");
  });
});
