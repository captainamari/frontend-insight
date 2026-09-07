// Proposed parameters for review, not approved defaults. Test-only import boundary.
import type {
  ScoreConfiguration,
  ScoreEvaluationInput,
} from "../src/score-evaluation.js";
import { operationalScoreFixture } from "./score-fixture.js";

export function qualityScoreFixture(): ScoreEvaluationInput {
  const input = operationalScoreFixture();
  const configuration: ScoreConfiguration = {
    scoreKey: "quality_score",
    displayName: "质量分数（参数建议测试）",
    libraryType: "quality",
    owner: "pending-business-owner-test-only",
    displayUnit: "points",
    scope: "project",
    granularity: "day",
    dimensions: [
      {
        key: "js_stability",
        displayName: "JS 稳定性",
        weight: 0.35,
        leaves: [
          {
            key: "js_leaf",
            metricKey: "js_error_rate",
            weight: 1,
            enabled: true,
            direction: "lower_better",
            target: { target: 0.001, ceiling: 0.01 },
            minimumSample: 1000,
          },
        ],
      },
      {
        key: "resource_stability",
        displayName: "资源稳定性",
        weight: 0.15,
        leaves: [
          {
            key: "resource_leaf",
            metricKey: "resource_error_rate",
            weight: 1,
            enabled: true,
            direction: "lower_better",
            target: { target: 0.001, ceiling: 0.02 },
            minimumSample: 1000,
          },
        ],
      },
      {
        key: "api_stability",
        displayName: "API 稳定性",
        weight: 0.3,
        leaves: [
          {
            key: "api_leaf",
            metricKey: "api_error_rate",
            weight: 1,
            enabled: true,
            direction: "lower_better",
            target: { target: 0.005, ceiling: 0.05 },
            minimumSample: 1000,
          },
        ],
      },
      {
        key: "page_performance",
        displayName: "页面性能",
        weight: 0.2,
        leaves: [
          {
            key: "lcp_leaf",
            metricKey: "lcp",
            weight: 0.5,
            enabled: true,
            direction: "lower_better",
            target: { target: 2500, ceiling: 4000 },
            minimumSample: 100,
          },
          {
            key: "inp_leaf",
            metricKey: "inp",
            weight: 0.3,
            enabled: true,
            direction: "lower_better",
            target: { target: 200, ceiling: 500 },
            minimumSample: 100,
          },
          {
            key: "cls_leaf",
            metricKey: "cls",
            weight: 0.2,
            enabled: true,
            direction: "lower_better",
            target: { target: 0.1, ceiling: 0.25 },
            minimumSample: 100,
          },
        ],
      },
    ],
    gate: { minimumEligibleDimensions: 3, minimumLeafWeightCoverage: 0.7 },
    colorBands: { greenMinimum: 85, yellowMinimum: 60 },
    radarDimensions: [
      "js_stability",
      "resource_stability",
      "api_stability",
      "page_performance",
    ],
  };
  const rates = [
    { key: "js_error_rate", numerator: "js_occurrences", denominator: "pv" },
    {
      key: "resource_error_rate",
      numerator: "resource_failures",
      denominator: "resource_requests",
    },
    { key: "api_error_rate", numerator: "api_failures", denominator: "api_requests" },
  ];
  const raw = [
    { key: "js_occurrences", value: 5, unit: "errors", sample: 1000 },
    { key: "pv", value: 1000, unit: "views", sample: 1000 },
    { key: "resource_failures", value: 20, unit: "errors", sample: 4000 },
    { key: "resource_requests", value: 4000, unit: "requests", sample: 4000 },
    { key: "api_failures", value: 10, unit: "errors", sample: 2000 },
    { key: "api_requests", value: 2000, unit: "requests", sample: 2000 },
    { key: "lcp", value: 3000, unit: "milliseconds", sample: 100 },
    { key: "inp", value: 350, unit: "milliseconds", sample: 100 },
    { key: "cls", value: 0.175, unit: "ratio", sample: 100 },
  ];
  const reference = input.binding.metrics[0]!;
  return {
    ...input,
    configuration,
    binding: {
      ...input.binding,
      libraryType: "quality",
      metrics: [
        ...raw.map((metric) => ({
          ...reference,
          metricKey: metric.key,
          unit: metric.unit,
          minimumSample: metric.sample === 100 ? 100 : 1000,
          libraryType: "quality" as const,
        })),
        ...rates.map((rate) => ({
          ...reference,
          metricKey: rate.key,
          unit: "ratio",
          minimumSample: 1000,
          libraryType: "quality" as const,
          formulaAst: {
            type: "binary" as const,
            operator: "/" as const,
            left: { type: "metric" as const, metricKey: rate.numerator },
            right: { type: "metric" as const, metricKey: rate.denominator },
          },
        })),
      ],
    },
    facts: Object.fromEntries(
      raw.map((metric) => [
        metric.key,
        {
          context: { ...input.context },
          value: metric.value,
          sampleSize: metric.sample,
          status: "available" as const,
          reason: null,
          availableFrom: input.context.from,
        },
      ]),
    ),
  };
}
