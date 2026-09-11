// Historical fixture regression only; no runtime entrypoint.
import {
  metricDefinition,
  normalizeMetricScore,
  type MetricResult,
  type OperationalIndexResult,
  type OperationalDimensionResult,
  type OperationalMetricItemResult,
  type MetricStatus,
} from "../src/metrics.js";
import type { MetricDimensionKey, MetricProfileItem } from "../src/model.js";
import type { DataState } from "../src/status.js";
const VERSION = "operational-v1";
const dimensionLabels: Record<MetricDimensionKey, string> = {
  usage_coverage: "使用覆盖",
  continuity_depth: "持续使用与访问深度",
  task_completion: "任务达成",
  usage_efficiency: "使用效率",
};

export function calculateOperationalIndex(input: {
  results: readonly MetricResult[];
  profileItems: readonly MetricProfileItem[];
  dataState: DataState;
}): OperationalIndexResult {
  const byKey = new Map(input.results.map((result) => [result.metricKey, result]));
  const dimensions = (Object.keys(dimensionLabels) as MetricDimensionKey[]).map(
    (dimensionKey): OperationalDimensionResult => {
      const configured = input.profileItems.filter(
        (item) => item.enabled && item.dimensionKey === dimensionKey,
      );
      const itemResults = configured.map((item): OperationalMetricItemResult => {
        const definitionItem = metricDefinition(item.metricKey);
        const raw = byKey.get(item.metricKey);
        const minimumSample = item.minimumSample ?? definitionItem?.minimumSample ?? 0;
        let status: MetricStatus = raw?.status ?? "metric_not_available";
        let reason = raw?.reason ?? "METRIC_INPUT_MISSING";
        if (
          status === "available" &&
          raw?.sampleSize !== null &&
          raw?.sampleSize !== undefined &&
          raw.sampleSize < minimumSample
        ) {
          status = "insufficient_sample";
          reason = `MINIMUM_SAMPLE_${minimumSample}`;
        }
        const target = {
          targetValue: item.targetValue,
          floorValue: item.floorValue,
          ceilingValue: item.ceilingValue,
          targetMin: item.targetMin,
          targetMax: item.targetMax,
          toleranceMin: item.toleranceMin,
          toleranceMax: item.toleranceMax,
        };
        const score =
          status === "available" &&
          raw?.value !== null &&
          raw?.value !== undefined &&
          definitionItem
            ? normalizeMetricScore(raw.value, definitionItem.scoreDirection, target)
            : null;
        if (status === "available" && score === null) {
          status = "missing_target";
          reason = "NORMALIZATION_TARGET_INCOMPLETE";
        }
        const dimensionWeight = item.dimensionWeight;
        return {
          metricKey: item.metricKey,
          displayName: definitionItem?.displayName ?? item.metricKey,
          rawValue: raw?.value ?? null,
          target,
          sampleSize: raw?.sampleSize ?? null,
          status,
          reason: status === "available" ? null : reason,
          score,
          metricWeight: item.metricWeight,
          leafConfiguredWeight: dimensionWeight * item.metricWeight,
          contribution:
            score === null ? null : dimensionWeight * item.metricWeight * score,
          definitionVersion: definitionItem?.definitionVersion ?? "unknown",
          availableFrom: raw?.availableFrom ?? null,
        };
      });
      const eligibleItems = itemResults.filter((item) => item.score !== null);
      const eligibleMetricWeight = eligibleItems.reduce(
        (sum, item) => sum + item.metricWeight,
        0,
      );
      const score =
        eligibleMetricWeight > 0
          ? eligibleItems.reduce(
              (sum, item) => sum + item.score! * item.metricWeight,
              0,
            ) / eligibleMetricWeight
          : null;
      const weight = configured[0]?.dimensionWeight ?? 0;
      return {
        dimensionKey,
        displayName: dimensionLabels[dimensionKey],
        weight,
        score,
        contribution: score === null ? null : score * weight,
        eligible: score !== null,
        eligibleMetricWeight,
        items: itemResults,
      };
    },
  );
  const enabledItems = input.profileItems.filter((item) => item.enabled);
  const totalLeafWeight = enabledItems.reduce(
    (sum, item) => sum + item.dimensionWeight * item.metricWeight,
    0,
  );
  const eligibleLeafWeight = dimensions
    .flatMap((dimension) => dimension.items)
    .filter((item) => item.score !== null)
    .reduce((sum, item) => sum + item.leafConfiguredWeight, 0);
  const weightCoverage = totalLeafWeight > 0 ? eligibleLeafWeight / totalLeafWeight : 0;
  const eligible = dimensions.filter((dimension) => dimension.eligible);
  const reasons: string[] = [];
  if (input.dataState !== "healthy") {
    reasons.push(`DATA_${input.dataState.toUpperCase()}`);
  }
  if (eligible.length < 3) reasons.push("ELIGIBLE_DIMENSIONS_BELOW_3");
  if (weightCoverage + Number.EPSILON < 0.7) {
    reasons.push("WEIGHT_COVERAGE_BELOW_70_PERCENT");
  }
  const eligibleDimensionWeight = eligible.reduce(
    (sum, dimension) => sum + dimension.weight,
    0,
  );
  const value =
    reasons.length === 0 && eligibleDimensionWeight > 0
      ? eligible.reduce(
          (sum, dimension) => sum + dimension.score! * dimension.weight,
          0,
        ) / eligibleDimensionWeight
      : null;
  return {
    value,
    status: value === null ? "unavailable" : "available",
    reasons,
    eligibleDimensions: eligible.length,
    weightCoverage,
    dimensions,
    definitionVersion: VERSION,
  };
}
