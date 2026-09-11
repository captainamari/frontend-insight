import type { MetricDimensionKey, MetricProfileItem, PageTemplate } from "./model.js";

export type MetricEntityType = "project" | "module" | "page" | "task";
export type MetricValueType = "count" | "ratio" | "duration" | "score";
export type MetricLayer = "fact" | "atomic" | "derived" | "composite";
export type ScoreDirection = "higher_better" | "lower_better" | "target_range" | "none";
export type MetricStatus =
  | "available"
  | "insufficient_sample"
  | "missing_target"
  | "metric_not_available"
  | "data_delayed";

export interface MetricDefinition {
  metricKey: string;
  displayName: string;
  businessQuestion: string;
  entityType: MetricEntityType;
  valueType: MetricValueType;
  unit: string;
  layer: MetricLayer;
  inputKeys: string[];
  formulaDescription: string;
  denominatorDescription: string;
  deduplicationKey: string;
  missingValuePolicy: string;
  scoreDirection: ScoreDirection;
  minimumSample: number;
  definitionVersion: string;
  effectiveFrom: string;
  owner: string;
}

export interface MetricResult {
  metricKey: string;
  value: number | null;
  status: MetricStatus;
  sampleSize: number | null;
  definitionVersion: string;
  availableFrom: string | null;
  reason: string | null;
  inputs: Array<{ metricKey: string; value: number | null }>;
}

export interface NormalizationTarget {
  targetValue: number | null;
  floorValue: number | null;
  ceilingValue: number | null;
  targetMin: number | null;
  targetMax: number | null;
  toleranceMin: number | null;
  toleranceMax: number | null;
}

export interface LineageNode {
  id: string;
  label: string;
  layer: MetricLayer;
  valueType: MetricValueType;
  definitionVersion: string;
}

export interface MetricLineage {
  metricKey: string;
  nodes: LineageNode[];
  edges: Array<{ from: string; to: string }>;
  directUpstream: string[];
  directDownstream: string[];
}

const VERSION = "operational-v1.0.0";
const EFFECTIVE_FROM = "2026-07-01T00:00:00.000Z";
const OWNER = "product-analytics";

function definition(
  input: Omit<MetricDefinition, "definitionVersion" | "effectiveFrom" | "owner">,
): MetricDefinition {
  return {
    ...input,
    definitionVersion: VERSION,
    effectiveFrom: EFFECTIVE_FROM,
    owner: OWNER,
  };
}

const factDefaults = {
  entityType: "project" as const,
  valueType: "count" as const,
  unit: "events",
  layer: "fact" as const,
  inputKeys: [],
  denominatorDescription: "not applicable",
  deduplicationKey: "eventId",
  missingValuePolicy: "No accepted event means no fact; it is not imputed as zero.",
  scoreDirection: "none" as const,
  minimumSample: 0,
};

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

const OPERATIONAL_SCORE_INPUT_DEFINITIONS: readonly MetricDefinition[] = [
  definition({
    ...factDefaults,
    metricKey: "fact.page_view",
    displayName: "页面打开事实",
    businessQuestion: "哪些已去重的页面访问被平台接收？",
    formulaDescription: "Accepted page_view events after eventId deduplication.",
  }),
  definition({
    ...factDefaults,
    metricKey: "fact.page_leave_duration",
    displayName: "页面可见时长片段事实",
    businessQuestion: "哪些页面访问报告了有效前台可见时长？",
    formulaDescription:
      "Valid page_leave.visibleDurationMs fragments after eventId deduplication.",
  }),
  definition({
    ...factDefaults,
    metricKey: "fact.operation_started",
    displayName: "任务开始事实",
    businessQuestion: "哪些 v3 任务实例真实开始？",
    formulaDescription:
      "custom events with payload.name=feature started, grouped by SDK-generated operationInstanceId.",
    deduplicationKey: "operationInstanceId + eventId",
  }),
  definition({
    ...factDefaults,
    metricKey: "fact.operation_succeeded",
    displayName: "任务成功事实",
    businessQuestion: "哪些已开始任务到达成功终态？",
    formulaDescription: "First custom succeeded terminal per operationInstanceId.",
    deduplicationKey: "operationInstanceId",
  }),
  definition({
    ...factDefaults,
    metricKey: "fact.operation_failed",
    displayName: "任务失败事实",
    businessQuestion: "哪些已开始任务到达明确失败终态？",
    formulaDescription: "First custom failed terminal per operationInstanceId.",
    deduplicationKey: "operationInstanceId",
  }),
  definition({
    ...factDefaults,
    metricKey: "fact.operation_canceled",
    displayName: "任务取消事实",
    businessQuestion: "哪些任务由用户明确取消？",
    formulaDescription: "First custom canceled terminal per operationInstanceId.",
    deduplicationKey: "operationInstanceId",
  }),
  definition({
    ...factDefaults,
    metricKey: "fact.valid_activity",
    displayName: "有效使用事实",
    businessQuestion: "哪些活动属于已注册且启用的运营实体？",
    formulaDescription:
      "Registered page views and successful registered feature/task activity; onboarding, demo and unclassified routes are excluded.",
  }),
  definition({
    metricKey: "pv",
    displayName: "页面访问量",
    businessQuestion: "页面在所选时间内被打开多少次？",
    entityType: "page",
    valueType: "count",
    unit: "views",
    layer: "atomic",
    inputKeys: ["fact.page_view"],
    formulaDescription: "count(page_view)",
    denominatorDescription: "not applicable",
    deduplicationKey: "eventId",
    missingValuePolicy:
      "A healthy range with no events is zero; unavailable data is null.",
    scoreDirection: "none",
    minimumSample: 0,
  }),
  definition({
    metricKey: "uv",
    displayName: "活跃账号",
    businessQuestion: "有多少已识别业务账号在使用产品？",
    entityType: "project",
    valueType: "count",
    unit: "users",
    layer: "atomic",
    inputKeys: ["fact.valid_activity"],
    formulaDescription: "uniq(user_id) over valid registered activity",
    denominatorDescription: "not applicable",
    deduplicationKey: "project-HMACed user_id",
    missingValuePolicy:
      "Accounts without an user reference are not replaced with browser identifiers.",
    scoreDirection: "higher_better",
    minimumSample: 1,
  }),
  definition({
    metricKey: "unique_devices",
    displayName: "活跃浏览器",
    businessQuestion: "有多少浏览器存储实例在使用产品？",
    entityType: "project",
    valueType: "count",
    unit: "browser instances",
    layer: "atomic",
    inputKeys: ["fact.valid_activity"],
    formulaDescription: "uniq(device_id) over valid registered activity",
    denominatorDescription: "not applicable",
    deduplicationKey: "deviceId",
    missingValuePolicy: "Browser instances are not described as people.",
    scoreDirection: "none",
    minimumSample: 1,
  }),
  definition({
    metricKey: "page_duration_samples",
    displayName: "页面时长样本",
    businessQuestion: "多少次页面访问具有有效可见时长？",
    entityType: "page",
    valueType: "count",
    unit: "page views",
    layer: "atomic",
    inputKeys: ["fact.page_leave_duration"],
    formulaDescription:
      "count(pageViewId) after summing valid visible-duration fragments per pageViewId",
    denominatorDescription: "not applicable",
    deduplicationKey: "pageViewId",
    missingValuePolicy: "Missing page_leave is excluded, not counted as zero duration.",
    scoreDirection: "none",
    minimumSample: 1,
  }),
  definition({
    metricKey: "page_duration_coverage",
    displayName: "页面时长覆盖率",
    businessQuestion: "页面时长样本是否足以代表全部访问？",
    entityType: "page",
    valueType: "ratio",
    unit: "ratio",
    layer: "derived",
    inputKeys: ["page_duration_samples", "pv"],
    formulaDescription: "page views with valid duration ÷ all page views",
    denominatorDescription: "All page_view instances in the same scope and range.",
    deduplicationKey: "pageViewId",
    missingValuePolicy: "A zero denominator returns metric_not_available.",
    scoreDirection: "none",
    minimumSample: 1,
  }),
  definition({
    metricKey: "page_visible_duration_p50",
    displayName: "页面可见时长 p50",
    businessQuestion: "典型一次页面访问实际在前台可见多久？",
    entityType: "page",
    valueType: "duration",
    unit: "milliseconds",
    layer: "derived",
    inputKeys: ["page_duration_samples"],
    formulaDescription:
      "p50(sum(valid visibleDurationMs fragments grouped by pageViewId))",
    denominatorDescription: "Page views with valid visible-duration fragments.",
    deduplicationKey: "pageViewId",
    missingValuePolicy: "Insufficient samples return null and retain the sample count.",
    scoreDirection: "target_range",
    minimumSample: 5,
  }),
  definition({
    metricKey: "session_distinct_pages_p50",
    displayName: "会话不同页面数 p50",
    businessQuestion: "一次典型工作会话覆盖多少种页面？",
    entityType: "project",
    valueType: "count",
    unit: "routes per session",
    layer: "derived",
    inputKeys: ["fact.page_view"],
    formulaDescription: "p50(uniq(normalized route) grouped by sessionId)",
    denominatorDescription: "Sessions containing at least one page_view.",
    deduplicationKey: "sessionId + normalized route",
    missingValuePolicy: "No qualifying session returns metric_not_available.",
    scoreDirection: "target_range",
    minimumSample: 5,
  }),
  definition({
    metricKey: "session_module_breadth_p50",
    displayName: "会话模块广度 p50",
    businessQuestion: "一次典型工作会话会跨越多少业务模块？",
    entityType: "project",
    valueType: "count",
    unit: "modules per session",
    layer: "derived",
    inputKeys: ["fact.page_view"],
    formulaDescription:
      "p50(uniq(explicit moduleKey) grouped by sessionId); unclassified routes are excluded",
    denominatorDescription: "Sessions with at least one registered active page.",
    deduplicationKey: "sessionId + moduleId",
    missingValuePolicy: "No registered page session returns metric_not_available.",
    scoreDirection: "target_range",
    minimumSample: 5,
  }),
  definition({
    metricKey: "active_user_target_attainment",
    displayName: "活跃账号目标达成",
    businessQuestion: "实际活跃账号是否达到管理员配置的业务目标？",
    entityType: "project",
    valueType: "ratio",
    unit: "ratio",
    layer: "derived",
    inputKeys: ["uv"],
    formulaDescription: "active users ÷ configured target users",
    denominatorDescription: "Versioned configured target users.",
    deduplicationKey: "project-HMACed user_id",
    missingValuePolicy:
      "A missing target returns missing_target; browsers are never substituted.",
    scoreDirection: "higher_better",
    minimumSample: 1,
  }),
  definition({
    metricKey: "core_page_coverage",
    displayName: "核心页面使用覆盖率",
    businessQuestion: "显式标记的核心页面是否真实被访问？",
    entityType: "project",
    valueType: "ratio",
    unit: "ratio",
    layer: "derived",
    inputKeys: ["pv"],
    formulaDescription:
      "sum(weight of used active core pages) ÷ sum(weight of active core pages)",
    denominatorDescription: "Configured weight of all active core pages.",
    deduplicationKey: "pageDefinitionId",
    missingValuePolicy: "No configured core page returns metric_not_available.",
    scoreDirection: "higher_better",
    minimumSample: 1,
  }),
  definition({
    metricKey: "active_day_coverage",
    displayName: "活跃日覆盖率",
    businessQuestion: "产品是否在管理员配置的预期工作日持续使用？",
    entityType: "project",
    valueType: "ratio",
    unit: "ratio",
    layer: "derived",
    inputKeys: ["fact.valid_activity"],
    formulaDescription:
      "expected local dates with valid activity ÷ expected local dates in range",
    denominatorDescription:
      "Dates matching the versioned expected-active-weekday calendar.",
    deduplicationKey: "project local calendar date",
    missingValuePolicy: "An empty business calendar returns missing_target.",
    scoreDirection: "higher_better",
    minimumSample: 1,
  }),
  definition({
    metricKey: "cross_day_continuity",
    displayName: "跨日持续使用率",
    businessQuestion: "成功使用产品的账号中有多少跨至少两个本地日期使用？",
    entityType: "project",
    valueType: "ratio",
    unit: "ratio",
    layer: "derived",
    inputKeys: ["fact.valid_activity", "uv"],
    formulaDescription:
      "users active on at least two project-local dates ÷ active users",
    denominatorDescription: "Active identified users in the same range.",
    deduplicationKey: "user_id + project local date",
    missingValuePolicy: "A zero user denominator returns metric_not_available.",
    scoreDirection: "higher_better",
    minimumSample: 2,
  }),
  definition({
    metricKey: "key_task_completion_rate",
    displayName: "关键任务加权达成率",
    businessQuestion: "已开始的关键任务有多少成功完成？",
    entityType: "project",
    valueType: "ratio",
    unit: "ratio",
    layer: "derived",
    inputKeys: ["fact.operation_started", "fact.operation_succeeded"],
    formulaDescription:
      "task-weighted succeeded operation instances ÷ task-weighted started instances",
    denominatorDescription: "Started v3 instances for active key tasks.",
    deduplicationKey: "operationInstanceId",
    missingValuePolicy: "No v3 started instance returns metric_not_available.",
    scoreDirection: "higher_better",
    minimumSample: 5,
  }),
  definition({
    metricKey: "task_adverse_outcome_rate",
    displayName: "关键任务不利终态率",
    businessQuestion: "关键任务中失败、取消或超时未结束的比例是否可控？",
    entityType: "project",
    valueType: "ratio",
    unit: "ratio",
    layer: "derived",
    inputKeys: [
      "fact.operation_started",
      "fact.operation_succeeded",
      "fact.operation_failed",
      "fact.operation_canceled",
    ],
    formulaDescription:
      "task-weighted (failed + canceled + timed-out open instances) ÷ task-weighted started instances",
    denominatorDescription: "Started v3 instances for active key tasks.",
    deduplicationKey: "operationInstanceId",
    missingValuePolicy:
      "Open instances become approximate abandonment only after task timeout.",
    scoreDirection: "lower_better",
    minimumSample: 5,
  }),
  definition({
    metricKey: "key_task_duration_p50",
    displayName: "关键任务成功耗时 p50",
    businessQuestion: "典型关键任务从开始到成功需要多久？",
    entityType: "project",
    valueType: "duration",
    unit: "milliseconds",
    layer: "derived",
    inputKeys: ["fact.operation_started", "fact.operation_succeeded"],
    formulaDescription:
      "task-weighted p50(first succeeded time - started time) by operationInstanceId",
    denominatorDescription: "Successfully paired v3 key-task instances.",
    deduplicationKey: "operationInstanceId",
    missingValuePolicy: "Failed, canceled and open instances are not duration samples.",
    scoreDirection: "lower_better",
    minimumSample: 5,
  }),
  definition({
    metricKey: "page_visible_duration_fit",
    displayName: "页面可见时长目标符合度",
    businessQuestion: "核心页面停留是否符合各自模板和业务目标？",
    entityType: "project",
    valueType: "ratio",
    unit: "ratio",
    layer: "derived",
    inputKeys: ["page_visible_duration_p50", "page_duration_coverage"],
    formulaDescription:
      "normalize each eligible page p50 against its monitoring/analysis/task template range, then calculate the criticality-weighted mean fit",
    denominatorDescription: "Eligible configured active core pages.",
    deduplicationKey: "pageDefinitionId",
    missingValuePolicy: "Pages without representative duration samples are excluded.",
    scoreDirection: "higher_better",
    minimumSample: 5,
  }),
  definition({
    metricKey: "session_distinct_pages_fit",
    displayName: "会话页面范围符合度",
    businessQuestion: "会话覆盖页面数是否处于项目期望范围？",
    entityType: "project",
    valueType: "count",
    unit: "routes per session",
    layer: "derived",
    inputKeys: ["session_distinct_pages_p50"],
    formulaDescription:
      "Normalize session distinct-page p50 against the profile target range.",
    denominatorDescription: "Qualifying vv.",
    deduplicationKey: "sessionId + normalized route",
    missingValuePolicy: "No session sample returns metric_not_available.",
    scoreDirection: "target_range",
    minimumSample: 5,
  }),
  definition({
    metricKey: "session_module_breadth_fit",
    displayName: "会话模块范围符合度",
    businessQuestion: "会话跨模块范围是否符合产品任务路径？",
    entityType: "project",
    valueType: "count",
    unit: "modules per session",
    layer: "derived",
    inputKeys: ["session_module_breadth_p50"],
    formulaDescription:
      "Normalize session module-breadth p50 against the profile target range.",
    denominatorDescription: "Sessions with registered page activity.",
    deduplicationKey: "sessionId + moduleId",
    missingValuePolicy: "No registered session sample returns metric_not_available.",
    scoreDirection: "target_range",
    minimumSample: 5,
  }),
  ...(
    [
      ["dimension.usage_coverage", "使用覆盖"],
      ["dimension.continuity_depth", "持续使用与访问深度"],
      ["dimension.task_completion", "任务达成"],
      ["dimension.usage_efficiency", "使用效率"],
    ] as const
  ).map(([metricKey, displayName]) =>
    definition({
      metricKey,
      displayName,
      businessQuestion: `${displayName}维度的合格分项表现如何？`,
      entityType: "project",
      valueType: "score",
      unit: "score 0–100",
      layer: "composite",
      inputKeys:
        metricKey === "dimension.usage_coverage"
          ? [
              "active_user_target_attainment",
              "core_page_coverage",
              "active_day_coverage",
            ]
          : metricKey === "dimension.continuity_depth"
            ? [
                "cross_day_continuity",
                "session_distinct_pages_fit",
                "session_module_breadth_fit",
              ]
            : metricKey === "dimension.task_completion"
              ? ["key_task_completion_rate", "task_adverse_outcome_rate"]
              : ["key_task_duration_p50", "page_visible_duration_fit"],
      formulaDescription:
        "Weighted average of eligible normalized leaf metrics within this dimension.",
      denominatorDescription: "Sum of eligible metric weights in the dimension.",
      deduplicationKey: "not applicable",
      missingValuePolicy: "No eligible leaf metric returns metric_not_available.",
      scoreDirection: "none",
      minimumSample: 0,
    }),
  ),
  definition({
    metricKey: "operational_score",
    displayName: "项目运营指数",
    businessQuestion: "项目的使用覆盖、持续性、任务达成和使用效率总体如何？",
    entityType: "project",
    valueType: "score",
    unit: "score 0–100",
    layer: "composite",
    inputKeys: [
      "dimension.usage_coverage",
      "dimension.continuity_depth",
      "dimension.task_completion",
      "dimension.usage_efficiency",
    ],
    formulaDescription:
      "Weighted average of eligible dimensions; shown only with at least three dimensions, at least 70% leaf-weight coverage and healthy data.",
    denominatorDescription: "Sum of eligible dimension weights.",
    deduplicationKey: "not applicable",
    missingValuePolicy:
      "Missing, delayed or insufficient inputs never become zero scores.",
    scoreDirection: "none",
    minimumSample: 0,
  }),
] as const;

/** Existing pre-R1-C score inputs. Kept internal until R1-C migrates the score model. */
export function operationalMetricDefinitions(): readonly MetricDefinition[] {
  return OPERATIONAL_SCORE_INPUT_DEFINITIONS;
}

const catalogByKey = new Map(
  OPERATIONAL_SCORE_INPUT_DEFINITIONS.map((item) => [item.metricKey, item] as const),
);

export function validateMetricCatalog(
  definitions: readonly MetricDefinition[] = OPERATIONAL_SCORE_INPUT_DEFINITIONS,
): string[] {
  const errors: string[] = [];
  const byKey = new Map<string, MetricDefinition>();
  for (const item of definitions) {
    if (byKey.has(item.metricKey)) errors.push(`DUPLICATE:${item.metricKey}`);
    byKey.set(item.metricKey, item);
  }
  for (const item of definitions) {
    for (const inputKey of item.inputKeys) {
      if (!byKey.has(inputKey)) {
        errors.push(`MISSING_INPUT:${item.metricKey}:${inputKey}`);
      }
    }
  }
  const state = new Map<string, "visiting" | "visited">();
  const visit = (metricKey: string, path: string[]): void => {
    if (state.get(metricKey) === "visiting") {
      errors.push(`CYCLE:${[...path, metricKey].join("->")}`);
      return;
    }
    if (state.get(metricKey) === "visited") return;
    state.set(metricKey, "visiting");
    for (const inputKey of byKey.get(metricKey)?.inputKeys ?? []) {
      if (byKey.has(inputKey)) visit(inputKey, [...path, metricKey]);
    }
    state.set(metricKey, "visited");
  };
  for (const metricKey of byKey.keys()) visit(metricKey, []);
  return [...new Set(errors)];
}

const catalogErrors = validateMetricCatalog();
if (catalogErrors.length) {
  throw new Error(`METRIC_CATALOG_INVALID:${catalogErrors.join(",")}`);
}

export function metricDefinition(metricKey: string): MetricDefinition | null {
  return catalogByKey.get(metricKey) ?? null;
}

export function metricLineage(metricKey: string): MetricLineage | null {
  const root = catalogByKey.get(metricKey);
  if (!root) return null;
  const reachable = new Set<string>();
  const collect = (key: string): void => {
    if (reachable.has(key)) return;
    reachable.add(key);
    for (const inputKey of catalogByKey.get(key)?.inputKeys ?? []) collect(inputKey);
  };
  collect(metricKey);
  const edges: MetricLineage["edges"] = [];
  for (const key of reachable) {
    for (const inputKey of catalogByKey.get(key)?.inputKeys ?? []) {
      if (reachable.has(inputKey)) edges.push({ from: inputKey, to: key });
    }
  }
  return {
    metricKey,
    nodes: [...reachable].map((key) => {
      const item = catalogByKey.get(key)!;
      return {
        id: item.metricKey,
        label: item.displayName,
        layer: item.layer,
        valueType: item.valueType,
        definitionVersion: item.definitionVersion,
      };
    }),
    edges,
    directUpstream: [...root.inputKeys],
    directDownstream: OPERATIONAL_SCORE_INPUT_DEFINITIONS.filter((item) =>
      item.inputKeys.includes(metricKey),
    ).map((item) => item.metricKey),
  };
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function normalizeMetricScore(
  value: number,
  direction: ScoreDirection,
  target: NormalizationTarget,
): number | null {
  if (direction === "none") return null;
  if (direction === "higher_better") {
    if (
      target.targetValue === null ||
      target.floorValue === null ||
      target.targetValue === target.floorValue
    ) {
      return null;
    }
    return clamp(
      (100 * (value - target.floorValue)) / (target.targetValue - target.floorValue),
    );
  }
  if (direction === "lower_better") {
    if (
      target.targetValue === null ||
      target.ceilingValue === null ||
      target.targetValue === target.ceilingValue
    ) {
      return null;
    }
    return clamp(
      (100 * (target.ceilingValue - value)) /
        (target.ceilingValue - target.targetValue),
    );
  }
  if (
    target.targetMin === null ||
    target.targetMax === null ||
    target.toleranceMin === null ||
    target.toleranceMax === null ||
    target.targetMin > target.targetMax ||
    target.toleranceMin >= target.targetMin ||
    target.toleranceMax <= target.targetMax
  ) {
    return null;
  }
  if (value >= target.targetMin && value <= target.targetMax) return 100;
  if (value < target.targetMin) {
    return clamp(
      (100 * (value - target.toleranceMin)) / (target.targetMin - target.toleranceMin),
    );
  }
  return clamp(
    (100 * (target.toleranceMax - value)) / (target.toleranceMax - target.targetMax),
  );
}

export type DefaultProfileItem = Omit<MetricProfileItem, "id" | "profileId">;

export const DEFAULT_OPERATIONAL_PROFILE_ITEMS: readonly DefaultProfileItem[] = [
  {
    metricKey: "active_user_target_attainment",
    dimensionKey: "usage_coverage",
    dimensionWeight: 0.3,
    metricWeight: 0.4,
    targetValue: 1,
    floorValue: 0,
    ceilingValue: null,
    targetMin: null,
    targetMax: null,
    toleranceMin: null,
    toleranceMax: null,
    minimumSample: 1,
    enabled: true,
    required: true,
  },
  {
    metricKey: "core_page_coverage",
    dimensionKey: "usage_coverage",
    dimensionWeight: 0.3,
    metricWeight: 0.35,
    targetValue: 1,
    floorValue: 0,
    ceilingValue: null,
    targetMin: null,
    targetMax: null,
    toleranceMin: null,
    toleranceMax: null,
    minimumSample: 1,
    enabled: true,
    required: true,
  },
  {
    metricKey: "active_day_coverage",
    dimensionKey: "usage_coverage",
    dimensionWeight: 0.3,
    metricWeight: 0.25,
    targetValue: 1,
    floorValue: 0,
    ceilingValue: null,
    targetMin: null,
    targetMax: null,
    toleranceMin: null,
    toleranceMax: null,
    minimumSample: 1,
    enabled: true,
    required: true,
  },
  {
    metricKey: "cross_day_continuity",
    dimensionKey: "continuity_depth",
    dimensionWeight: 0.25,
    metricWeight: 0.4,
    targetValue: 0.5,
    floorValue: 0,
    ceilingValue: null,
    targetMin: null,
    targetMax: null,
    toleranceMin: null,
    toleranceMax: null,
    minimumSample: 2,
    enabled: true,
    required: false,
  },
  {
    metricKey: "session_distinct_pages_fit",
    dimensionKey: "continuity_depth",
    dimensionWeight: 0.25,
    metricWeight: 0.3,
    targetValue: null,
    floorValue: null,
    ceilingValue: null,
    targetMin: 1,
    targetMax: 4,
    toleranceMin: 0,
    toleranceMax: 8,
    minimumSample: 5,
    enabled: true,
    required: false,
  },
  {
    metricKey: "session_module_breadth_fit",
    dimensionKey: "continuity_depth",
    dimensionWeight: 0.25,
    metricWeight: 0.3,
    targetValue: null,
    floorValue: null,
    ceilingValue: null,
    targetMin: 1,
    targetMax: 2,
    toleranceMin: 0,
    toleranceMax: 5,
    minimumSample: 5,
    enabled: true,
    required: false,
  },
  {
    metricKey: "key_task_completion_rate",
    dimensionKey: "task_completion",
    dimensionWeight: 0.3,
    metricWeight: 0.7,
    targetValue: 0.9,
    floorValue: 0.5,
    ceilingValue: null,
    targetMin: null,
    targetMax: null,
    toleranceMin: null,
    toleranceMax: null,
    minimumSample: 5,
    enabled: true,
    required: false,
  },
  {
    metricKey: "task_adverse_outcome_rate",
    dimensionKey: "task_completion",
    dimensionWeight: 0.3,
    metricWeight: 0.3,
    targetValue: 0.1,
    floorValue: null,
    ceilingValue: 0.5,
    targetMin: null,
    targetMax: null,
    toleranceMin: null,
    toleranceMax: null,
    minimumSample: 5,
    enabled: true,
    required: false,
  },
  {
    metricKey: "key_task_duration_p50",
    dimensionKey: "usage_efficiency",
    dimensionWeight: 0.15,
    metricWeight: 0.6,
    targetValue: 60_000,
    floorValue: null,
    ceilingValue: 300_000,
    targetMin: null,
    targetMax: null,
    toleranceMin: null,
    toleranceMax: null,
    minimumSample: 5,
    enabled: true,
    required: false,
  },
  {
    metricKey: "page_visible_duration_fit",
    dimensionKey: "usage_efficiency",
    dimensionWeight: 0.15,
    metricWeight: 0.4,
    targetValue: 1,
    floorValue: 0,
    ceilingValue: null,
    targetMin: null,
    targetMax: null,
    toleranceMin: null,
    toleranceMax: null,
    minimumSample: 5,
    enabled: true,
    required: false,
  },
] as const;

export interface OperationalDimensionResult {
  dimensionKey: MetricDimensionKey;
  displayName: string;
  weight: number;
  score: number | null;
  contribution: number | null;
  eligible: boolean;
  eligibleMetricWeight: number;
  items: OperationalMetricItemResult[];
}

export interface OperationalMetricItemResult {
  metricKey: string;
  displayName: string;
  rawValue: number | null;
  target: NormalizationTarget;
  sampleSize: number | null;
  status: MetricStatus;
  reason: string | null;
  score: number | null;
  metricWeight: number;
  leafConfiguredWeight: number;
  contribution: number | null;
  definitionVersion: string;
  availableFrom: string | null;
}

export interface OperationalIndexResult {
  value: number | null;
  status: "available" | "unavailable";
  reasons: string[];
  eligibleDimensions: number;
  weightCoverage: number;
  dimensions: OperationalDimensionResult[];
  definitionVersion: string;
}

export function metricResult(input: {
  metricKey: string;
  value: number | null;
  sampleSize: number | null;
  status?: MetricStatus;
  availableFrom?: string | null;
  reason?: string | null;
  inputs?: Array<{ metricKey: string; value: number | null }>;
}): MetricResult {
  const definitionItem = metricDefinition(input.metricKey);
  if (!definitionItem)
    throw new Error(`METRIC_DEFINITION_NOT_FOUND:${input.metricKey}`);
  return {
    metricKey: input.metricKey,
    value: input.value,
    status:
      input.status ?? (input.value === null ? "metric_not_available" : "available"),
    sampleSize: input.sampleSize,
    definitionVersion: definitionItem.definitionVersion,
    availableFrom: input.availableFrom ?? null,
    reason: input.reason ?? null,
    inputs: input.inputs ?? [],
  };
}
