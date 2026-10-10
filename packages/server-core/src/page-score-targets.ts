import type { PageTemplate } from "./model.js";

export interface NormalizationTarget {
  targetValue: number | null;
  floorValue: number | null;
  ceilingValue: number | null;
  targetMin: number | null;
  targetMax: number | null;
  toleranceMin: number | null;
  toleranceMax: number | null;
}

export const PAGE_TEMPLATE_DURATION_TARGETS: Readonly<
  Record<PageTemplate, NormalizationTarget>
> = Object.freeze({
  monitoring_dashboard: {
    targetValue: null,
    floorValue: null,
    ceilingValue: null,
    targetMin: 60_000,
    targetMax: 3_600_000,
    toleranceMin: 10_000,
    toleranceMax: 14_400_000,
  },
  analysis_view: {
    targetValue: null,
    floorValue: null,
    ceilingValue: null,
    targetMin: 30_000,
    targetMax: 600_000,
    toleranceMin: 5_000,
    toleranceMax: 1_800_000,
  },
  task_operation: {
    targetValue: null,
    floorValue: null,
    ceilingValue: null,
    targetMin: 10_000,
    targetMax: 180_000,
    toleranceMin: 2_000,
    toleranceMax: 900_000,
  },
});
