import type { ScoreConfiguration, ScoreLeaf } from "./score-evaluation.js";
import type { MetricLibraryType } from "./metric-library.js";
export const SCORE_TEMPLATE_APPROVAL = Object.freeze({
  owner: "Jesse",
  approvedAt: "2026-09-09",
  source: "Jesse 2026-09-09 R1-C 正式补充确认 Q12 / D3-A；requirements-v1.8 §18.8",
  parameterVersion: "quality-default-2026-09-09.1",
});
function leaf(
  metricKey: string,
  weight: number,
  direction: ScoreLeaf["direction"],
  target: Record<string, number>,
  minimumSample = 5,
): ScoreLeaf {
  return {
    key: metricKey,
    metricKey,
    weight,
    direction,
    target,
    minimumSample,
    enabled: true,
  };
}
export function defaultScoreTemplate(type: MetricLibraryType) {
  const higher = (key: string, w: number, floor = 0, target = 1) =>
    leaf(key, w, "higher_better", { floor, target });
  const lower = (key: string, w: number, target: number, ceiling: number, sample = 5) =>
    leaf(key, w, "lower_better", { target, ceiling }, sample);
  const dimensions: ScoreConfiguration["dimensions"] =
    type === "operational"
      ? [
          {
            key: "usage_coverage",
            displayName: "使用覆盖",
            weight: 0.3,
            leaves: [
              higher("active_user_target_attainment", 0.4),
              higher("core_page_coverage", 0.35),
              higher("active_day_coverage", 0.25),
            ],
          },
          {
            key: "continuity_depth",
            displayName: "持续使用与访问深度",
            weight: 0.25,
            leaves: [
              higher("cross_day_continuity", 0.4, 0, 0.5),
              leaf("session_distinct_pages_fit", 0.3, "target_range", {
                toleranceMin: 0,
                targetMin: 1,
                targetMax: 4,
                toleranceMax: 8,
              }),
              leaf("session_module_breadth_fit", 0.3, "target_range", {
                toleranceMin: 0,
                targetMin: 1,
                targetMax: 2,
                toleranceMax: 5,
              }),
            ],
          },
          {
            key: "task_completion",
            displayName: "任务达成",
            weight: 0.3,
            leaves: [
              higher("key_task_completion_rate", 0.7, 0.5, 0.9),
              lower("task_adverse_outcome_rate", 0.3, 0.1, 0.5),
            ],
          },
          {
            key: "usage_efficiency",
            displayName: "使用效率",
            weight: 0.15,
            leaves: [
              lower("key_task_duration_p50", 0.6, 60000, 300000),
              higher("page_visible_duration_fit", 0.4),
            ],
          },
        ]
      : [
          {
            key: "js_stability",
            displayName: "JS 稳定性",
            weight: 0.35,
            leaves: [lower("js_error_rate", 1, 0.001, 0.01, 1000)],
          },
          {
            key: "resource_stability",
            displayName: "资源稳定性",
            weight: 0.15,
            leaves: [lower("resource_error_rate", 1, 0.001, 0.02, 1000)],
          },
          {
            key: "api_stability",
            displayName: "API 稳定性",
            weight: 0.3,
            leaves: [lower("api_error_rate", 1, 0.005, 0.05, 1000)],
          },
          {
            key: "page_performance",
            displayName: "页面性能",
            weight: 0.2,
            leaves: [
              lower("lcp", 0.5, 2500, 4000, 100),
              lower("inp", 0.3, 200, 500, 100),
              lower("cls", 0.2, 0.1, 0.25, 100),
            ],
          },
        ];
  const configuration: ScoreConfiguration = {
    scoreKey: type + "_score",
    displayName: type === "operational" ? "运营分数" : "质量分数",
    libraryType: type,
    owner: "Jesse",
    displayUnit: "points",
    scope: "project",
    granularity: "day",
    dimensions,
    gate: { minimumEligibleDimensions: 3, minimumLeafWeightCoverage: 0.7 },
    colorBands: { greenMinimum: 85, yellowMinimum: 60 },
    radarDimensions: dimensions.map((d) => d.key),
  };
  return {
    version: type + "-default-2026-09-09.1",
    approval:
      type === "quality"
        ? SCORE_TEMPLATE_APPROVAL
        : {
            owner: "Jesse",
            approvedAt: "2026-09-09",
            source:
              "Jesse 2026-09-09 正式确认 Q04/Q05 及既有运营默认参数；requirements-v1.8 §18.3",
            parameterVersion: "operational-default-2026-09-09.1",
          },
    configuration,
  };
}

/** Editing business settings does not silently adopt a newer template. */
export function selectedScoreTemplate(
  type: MetricLibraryType,
  previous: ReturnType<typeof defaultScoreTemplate> | null,
  requestedVersion?: string,
) {
  if (previous && previous.configuration.libraryType !== type) return null;
  const current = defaultScoreTemplate(type);
  if (!requestedVersion) return previous ?? current;
  if (requestedVersion === current.version) return current;
  return requestedVersion === previous?.version ? previous : null;
}
