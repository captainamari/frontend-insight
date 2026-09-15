import { CANONICAL_RANGES } from "@frontend-insight/event-contract/canonical";
export const projectRangeLabels = {
  "7d": "最近 7 天",
  "30d": "最近 30 天",
  "90d": "最近 3 个月",
  "180d": "最近半年",
  "365d": "最近 1 年",
  custom: "自定义",
} as const;
export type ProjectRange = (typeof CANONICAL_RANGES)[number]["key"];
export const entryRangeDays = (key: ProjectRange) => {
  const range = CANONICAL_RANGES.find((r) => r.key === key);
  return range && "days" in range ? range.days : 7;
};
export function safeRedirectTarget(
  value: unknown,
  exists: (path: string) => boolean,
): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((c) => c.charCodeAt(0) <= 32)
  )
    return "/projects";
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.startsWith("//") ||
      decoded.includes("\\") ||
      [...decoded].some((c) => c.charCodeAt(0) < 32)
    )
      return "/projects";
    const url = new URL(value, "https://local.invalid");
    if (
      url.origin !== "https://local.invalid" ||
      url.pathname === "/login" ||
      !exists(value)
    )
      return "/projects";
    return value;
  } catch {
    return "/projects";
  }
}
export interface EntryScore {
  scoreKey: string;
  value: number | null;
  status: string;
  color: string;
  versionId: string | null;
  version: number | null;
  reasons: string[];
  context: Record<string, unknown>;
  availableFrom: string | null;
}
export interface EntryCard {
  id: string;
  name: string;
  role: string;
  projectStatus: string;
  timezone: string;
  operational: EntryScore;
  quality: EntryScore;
  state: string;
  alert: boolean;
  reasons: string[];
  pipeline: {
    state: string;
    scope: string;
    projectState: string;
    reasons: string[];
    envVerified: boolean;
  };
  data: {
    state: string;
    reason: string;
    windowEvents: number | null;
    windowPageViews: number | null;
  };
  lastDataAt: string | null;
  range: {
    from: string;
    to: string;
    env: string;
    granularity: string;
    timezone: string;
    localFrom: string;
    localTo: string;
  };
  entry: { path: string; module: string };
}
export interface EntrySummary {
  items: EntryCard[];
  total: number;
  page: number;
  pageSize: number;
  search: string;
  located: string | null;
  query: {
    range: ProjectRange;
    env: string;
    from: string;
    to: string;
    granularity: string;
  };
  diagnostics: {
    metadataQueries: number;
    clickHouseQueries: number;
    elapsedMs: number;
  };
}
export const projectStateLabels: Record<string, string> = {
  normal: "正常",
  alert: "告警",
  missing_configuration: "待配置",
  insufficient_data: "数据不足",
};
export const pipelineLabels: Record<string, string> = {
  healthy: "链路正常",
  unknown: "环境链路未验证",
  no_data: "无数据",
  partial: "数据不完整",
  delayed: "链路延迟",
  broken: "链路异常",
};
const reasonLabels: Record<string, string> = {
  MISSING_CONFIGURATION: "尚未完成分数配置确认与激活",
  SCORE_CONFIGURATION_NOT_SAVED: "当前指标版本尚未保存分数配置",
  ENV_HEALTH_NOT_VERIFIED: "当前环境的链路健康尚不能独立验证",
  ENV_EXPOSURE_NOT_VERIFIED: "当前环境的完整曝光与样本尚不能验证",
  FIRST_NOT_CONNECTED: "首次未接入，尚未收到项目事件",
  NO_RETAINED_EVENTS_IN_ENV: "当前环境无保留事件，无法证明已接入或范围内正常无访问",
  NO_EVENTS_IN_RANGE: "已观测到当前环境事件，所选范围内无事件；链路完整性仍未验证",
  NO_PAGE_VIEWS_IN_RANGE: "范围内已观测事件，但没有页面访问事件",
  FACT_STORE_UNAVAILABLE: "数据存储暂不可用，请重试",
  PIPELINE_BROKEN: "项目链路异常",
  PIPELINE_DELAYED: "项目链路延迟",
  DEAD_LETTER_WITHOUT_QUERYABLE_DATA: "项目存在处理失败事件，尚无可查询数据",
  INGESTION_BEHIND_RECEIVE: "项目已接收事件尚未及时进入查询存储",
  SCORE_AT_OR_BELOW_80: "可用分数不高于 80",
  DATA_NO_DATA: "当前缺少可用于评分的完整事实",
  VERSION_RANGE_BOUNDARY: "查询范围跨越版本生效边界，不生成跨版本总分",
  ELIGIBLE_DIMENSIONS_BELOW_GATE: "可参与计算的维度不足",
  LEAF_WEIGHT_COVERAGE_BELOW_GATE: "可参与计算的指标权重覆盖不足",
  METRIC_PARTIAL: "该指标事实尚未完整交付",
  METRIC_NOT_COLLECTED: "该指标尚未采集",
  SCORE_MINIMUM_SAMPLE_NOT_MET: "有效样本未达到最低要求",
  SCORE_CONTEXT_MISMATCH: "查询与分数配置的范围或粒度不一致",
  PROJECT_SCORE_SCOPE_REQUIRED: "当前分数仅适用于模块，不能作为项目总分",
  SCORE_FACT_MISSING: "缺少评分事实",
};
export function entryReason(reason: string): string {
  const parts = reason.split(":"),
    code = parts.pop()!;
  let family = "";
  if (parts[0] === "operational_score") {
    family = "运营：";
    parts.shift();
  } else if (parts[0] === "quality_score") {
    family = "质量：";
    parts.shift();
  }
  const subject = parts.join(" · ");
  return family + (subject ? subject + "：" : "") + (reasonLabels[code] ?? code);
}
