// Explicit synthetic preview only. Never used by project queries or ingestion.
import {
  evaluateScore,
  type ScoreConfiguration,
  type ScoreEvaluationInput,
} from "./score-evaluation.js";
import { METRIC_CATALOG } from "./system-metric-catalog.js";
export function scoreExamples(configuration: ScoreConfiguration) {
  const values: Record<string, number> = {
    active_user_target_attainment: 0.8,
    core_page_coverage: 0.9,
    active_day_coverage: 1,
    cross_day_continuity: 0.35,
    session_distinct_pages_fit: 6,
    session_module_breadth_fit: 3.5,
    key_task_completion_rate: 0.86,
    task_adverse_outcome_rate: 0.18,
    key_task_duration_p50: 180000,
    page_visible_duration_fit: 0.75,
    js_error_rate: 0.005,
    resource_error_rate: 0.005,
    api_error_rate: 0.005,
    lcp: 3000,
    inp: 350,
    cls: 0.175,
  };
  const keys = configuration.dimensions.flatMap((d) =>
    d.leaves.map((l) => l.metricKey),
  );
  if (keys.some((key) => !(key in values)))
    return {
      source: "fixed_fixture",
      reason: "自定义指标无固定示例；不会编造输入。",
      normal: null,
      partial: null,
      gateFailure: null,
      healthyZeroErrors: null,
      noData: null,
    };
  const context = {
    projectId: "fixed-fixture",
    scopeId: "fixed-fixture",
    env: "prod" as const,
    metricSetVersion: "fixture-metrics",
    definitionVersion: "fixture-score",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-08T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    granularity: configuration.granularity,
  };
  const input: ScoreEvaluationInput = {
    configuration,
    context,
    binding: {
      projectId: context.projectId,
      libraryType: configuration.libraryType,
      metricSetVersion: context.metricSetVersion,
      definitionVersion: context.definitionVersion,
      metrics: METRIC_CATALOG.filter((m) => keys.includes(m.metricKey)).map((m) => ({
        ...m,
        projectId: context.projectId,
        libraryType: configuration.libraryType,
        metricSetVersion: context.metricSetVersion,
        formulaAst: null,
        enabled: true,
        implementationStatus: "implemented",
      })),
    },
    facts: Object.fromEntries(
      keys.map((key) => [
        key,
        {
          context,
          value: values[key]!,
          sampleSize:
            key.endsWith("_rate") && configuration.libraryType === "quality"
              ? 1000
              : 100,
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
  const partial = structuredClone(input);
  for (const key of [
    "session_distinct_pages_fit",
    "session_module_breadth_fit",
    "key_task_duration_p50",
    "page_visible_duration_fit",
  ])
    delete (partial.facts as Record<string, unknown>)[key];
  const fail = structuredClone(partial);
  delete (fail.facts as Record<string, unknown>).key_task_completion_rate;
  const zero = structuredClone(input);
  for (const key of ["js_error_rate", "resource_error_rate", "api_error_rate"])
    if (zero.facts[key]) zero.facts[key]!.value = 0;
  return {
    source: "fixed_fixture",
    reason: "固定示例，与真实项目查询及历史记录隔离。",
    normal: evaluateScore(input),
    partial: evaluateScore(partial),
    gateFailure: evaluateScore(fail),
    healthyZeroErrors:
      configuration.libraryType === "quality" ? evaluateScore(zero) : null,
    noData: evaluateScore({ ...input, facts: {}, pipelineStatus: "no_data" }),
  };
}
