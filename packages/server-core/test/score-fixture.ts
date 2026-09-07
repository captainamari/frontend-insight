// Synthetic unit-test inputs only. Never imported by runtime, seed or real queries.
import type {
  ScoreConfiguration,
  ScoreEvaluationInput,
} from "../src/score-evaluation.js";

export function operationalScoreFixture(): ScoreEvaluationInput {
  const keys = [
    "active_user_target_attainment",
    "core_page_coverage",
    "active_day_coverage",
    "cross_day_continuity",
    "session_distinct_pages_fit",
    "session_module_breadth_fit",
    "key_task_completion_rate",
    "task_adverse_outcome_rate",
    "key_task_duration_p50",
    "page_visible_duration_fit",
  ];
  const values = [0.8, 0.9, 1, 0.35, 6, 3.5, 0.86, 0.18, 180000, 0.75];
  const targets = [
    { floor: 0, target: 1 },
    { floor: 0, target: 1 },
    { floor: 0, target: 1 },
    { floor: 0, target: 0.5 },
    { toleranceMin: 0, targetMin: 1, targetMax: 4, toleranceMax: 8 },
    { toleranceMin: 0, targetMin: 1, targetMax: 2, toleranceMax: 5 },
    { floor: 0.5, target: 0.9 },
    { target: 0.1, ceiling: 0.5 },
    { target: 60000, ceiling: 300000 },
    { floor: 0, target: 1 },
  ];
  const directions = [
    "higher_better",
    "higher_better",
    "higher_better",
    "higher_better",
    "target_range",
    "target_range",
    "higher_better",
    "higher_better",
    "lower_better",
    "higher_better",
  ] as const;
  const layout = [
    {
      key: "usage_coverage",
      displayName: "使用覆盖",
      weight: 0.3,
      weights: [0.4, 0.35, 0.25],
      indices: [0, 1, 2],
    },
    {
      key: "continuity_depth",
      displayName: "持续使用与访问深度",
      weight: 0.25,
      weights: [0.4, 0.3, 0.3],
      indices: [3, 4, 5],
    },
    {
      key: "task_completion",
      displayName: "任务达成",
      weight: 0.3,
      weights: [0.7, 0.3],
      indices: [6, 7],
    },
    {
      key: "usage_efficiency",
      displayName: "使用效率",
      weight: 0.15,
      weights: [0.6, 0.4],
      indices: [8, 9],
    },
  ];
  const configuration: ScoreConfiguration = {
    scoreKey: "operational_score",
    displayName: "运营分数",
    libraryType: "operational",
    owner: "unit-test-only",
    displayUnit: "points",
    scope: "project",
    granularity: "day",
    dimensions: layout.map((dim) => ({
      key: dim.key,
      displayName: dim.displayName,
      weight: dim.weight,
      leaves: dim.indices.map((index, position) => ({
        key: keys[index]!,
        metricKey: keys[index]!,
        weight: dim.weights[position]!,
        enabled: true,
        direction: index === 7 ? "lower_better" : directions[index]!,
        target: targets[index]!,
        minimumSample: 5,
      })),
    })),
    gate: { minimumEligibleDimensions: 3, minimumLeafWeightCoverage: 0.7 },
    colorBands: { greenMinimum: 85, yellowMinimum: 60 },
    radarDimensions: layout.map((dim) => dim.key),
  };
  const context = {
    projectId: "fixture-project",
    env: "prod" as const,
    metricSetVersion: "fixture-metrics-v1",
    definitionVersion: "fixture-score-v1",
    scopeId: "fixture-project",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-08T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    granularity: "day" as const,
  };
  return {
    configuration,
    context,
    binding: {
      projectId: context.projectId,
      libraryType: "operational",
      metricSetVersion: context.metricSetVersion,
      definitionVersion: context.definitionVersion,
      metrics: keys.map((metricKey, index) => ({
        metricKey,
        projectId: context.projectId,
        libraryType: "operational",
        metricSetVersion: context.metricSetVersion,
        definitionVersion: "fixture-metric-v1",
        unit:
          index === 8
            ? "milliseconds"
            : index === 4
              ? "pages"
              : index === 5
                ? "modules"
                : "ratio",
        entityScopes: ["project"],
        timeGranularities: ["day"],
        minimumSample: 5,
        implementationStatus: "implemented",
        formulaAst: null,
        enabled: true,
      })),
    },
    facts: Object.fromEntries(
      keys.map((metricKey, index) => [
        metricKey,
        {
          context: { ...context },
          value: values[index]!,
          sampleSize: 100,
          status: "available",
          reason: null,
          availableFrom: context.from,
        },
      ]),
    ),
    pipelineStatus: "healthy",
    configurationConfirmed: true,
    effectiveAt: context.from,
    mode: "current",
  };
}
