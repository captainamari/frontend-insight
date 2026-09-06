import { CANONICAL_METRIC_KEYS } from "@frontend-insight/event-contract";
import {
  SYSTEM_METRIC_SEED,
  type SystemMetricImplementationStatus,
} from "./generated/system-metric-seed.js";

export type SystemMetricCategory =
  "usage" | "operation" | "performance" | "stability" | "organization";
export type MetricEntityScope = "project" | "module" | "page" | "workflow";
export type MetricTimeGranularity = "5m" | "hour" | "day" | "week" | "month";

export interface SystemMetricDefinition {
  readonly origin: "system";
  readonly metricKey: string;
  readonly displayName: string;
  readonly businessDescription: string;
  readonly category: SystemMetricCategory;
  readonly formulaDescription: string;
  readonly numeratorDescription: string | null;
  readonly denominatorDescription: string | null;
  readonly deduplicationKey: string;
  readonly unit: string;
  readonly percentiles: readonly string[];
  readonly reportingTiming: string;
  readonly entityScopes: readonly MetricEntityScope[];
  readonly timeGranularities: readonly MetricTimeGranularity[];
  readonly minimumSample: number;
  readonly missingPolicy: string;
  readonly owner: string;
  readonly definitionVersion: string;
  readonly implementationStatus: SystemMetricImplementationStatus;
  readonly availableFrom: string | null;
  readonly unavailableReason: string | null;
  readonly milestone: string;
}

type CatalogDetails = Omit<
  SystemMetricDefinition,
  | "origin"
  | "metricKey"
  | "displayName"
  | "category"
  | "implementationStatus"
  | "milestone"
  | "owner"
  | "definitionVersion"
  | "availableFrom"
  | "unavailableReason"
> & {
  readonly unavailableReason?: string;
};

const DEFAULT_GRANULARITIES = ["5m", "hour", "day", "week", "month"] as const;
const DEFINITION_VERSION = "system-v1.8.0";
const OWNER = "product-analytics";
const PARTIAL_AVAILABLE_FROM = "2026-08-01T00:00:00.000Z";

const details: Readonly<Record<string, CatalogDetails>> = {
  pv: {
    businessDescription:
      "统计页面打开次数；每个被接收且通过 eventId 去重的 page_view 计一次。",
    formulaDescription: "count(accepted page_view)",
    numeratorDescription: "被接收的 page_view 事件数",
    denominatorDescription: null,
    deduplicationKey: "eventId",
    unit: "views",
    percentiles: [],
    reportingTiming: "页面路由进入后上报 page_view；SPA 切换先结算 leave 再上报 view。",
    entityScopes: ["project", "module", "page"],
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 0,
    missingPolicy:
      "健康且完整的时间桶无事件时可为 0；链路缺失、延迟或覆盖不完整时返回不可用，不能补 0。",
    unavailableReason:
      "现有 page_view 事实可查询，但 R6 尚未完成规范路由切换及完整 golden fixture。",
  },
  uv: {
    businessDescription: "统计活跃用户；登录态按 userId 去重，未登录按 deviceId 兜底。",
    formulaDescription:
      "uniq(coalesced identity(userId, deviceId)) over valid activity",
    numeratorDescription: "查询范围内去重后的活跃身份数",
    denominatorDescription: null,
    deduplicationKey: "project-HMAC(userId) else deviceId",
    unit: "users",
    percentiles: [],
    reportingTiming: "随有效页面或业务活动事实计算。",
    entityScopes: ["project", "module", "page"],
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 1,
    missingPolicy: "缺少 userId 时仅按规范使用 deviceId 兜底；链路不完整返回不可用。",
    unavailableReason:
      "现有查询只覆盖已识别账号，尚未实现未登录 deviceId 兜底，因此不能声称规范 UV 已完成。",
  },
  dau: activeUsers("项目时区自然日", "day"),
  wau: activeUsers("项目时区自然周", "week"),
  mau: activeUsers("项目时区自然月", "month"),
  vv: {
    businessDescription: "统计会话数；按 sessionId 去重，30 分钟无操作后生成新会话。",
    formulaDescription: "uniq(sessionId)",
    numeratorDescription: "查询范围内去重 sessionId 数",
    denominatorDescription: null,
    deduplicationKey: "sessionId",
    unit: "session_count",
    percentiles: [],
    reportingTiming: "客户端首个活动及会话续期时携带 sessionId。",
    entityScopes: ["project", "module", "page"],
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 1,
    missingPolicy: "缺少或不可信 sessionId 的事件不参与；链路异常不返回空趋势。",
    unavailableReason:
      "已有会话事实，但 R6 尚未完成 30 分钟切分与规范 golden fixture。",
  },
  module_penetration: ratio({
    businessDescription: "衡量功能模块触达范围。",
    formulaDescription: "unique module users / eligible system users",
    numeratorDescription: "访问目标功能模块的去重用户数",
    denominatorDescription: "受治理目录中的系统总用户数及其目录版本",
    deduplicationKey: "moduleId + project-HMAC(userId)",
    entityScopes: ["module"],
    reportingTiming: "由页面/任务有效活动与版本化用户目录聚合。",
    unavailableReason: "R4-A 尚未提供正式用户目录分母；禁止以 90 日活跃用户静默近似。",
  }),
  avg_usage_duration: {
    businessDescription: "衡量每个活跃用户的有效会话使用时长。",
    formulaDescription: "sum(valid session duration) / uv",
    numeratorDescription: "有效会话时长之和",
    denominatorDescription: "同范围规范 uv",
    deduplicationKey: "sessionId + visible segment id",
    unit: "milliseconds_per_user",
    percentiles: [],
    reportingTiming: "页面离开、隐藏和会话结束时结算有效可见时长。",
    entityScopes: ["project", "module", "page"],
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 1,
    missingPolicy:
      "缺失 page_leave 不计为 0；UV 为 0、覆盖不足或链路延迟时返回不可用。",
    unavailableReason: "R6 尚未提供规范有效会话时长与 UV 同范围查询。",
  },
  hourly_distribution: {
    businessDescription: "按项目时区小时展示 PV 与 UV 分布。",
    formulaDescription: "bucket(pv, uv) by project-local hour",
    numeratorDescription: "每个小时桶的 pv 与 uv",
    denominatorDescription: "所选范围内相应指标总量（仅用于占比展示）",
    deduplicationKey: "pv:eventId; uv:project-HMAC(userId) else deviceId per bucket",
    unit: "distribution",
    percentiles: [],
    reportingTiming: "随 page_view 和有效活动事实逐小时聚合。",
    entityScopes: ["project", "module", "page"],
    timeGranularities: ["hour", "day", "week", "month"],
    minimumSample: 1,
    missingPolicy:
      "缺失小时桶只在健康且覆盖完整时补 0；否则返回不可用状态而不是空趋势。",
    unavailableReason: "R6 尚未实现项目时区小时桶查询。",
  },
  bounce_rate: ratio({
    businessDescription:
      "衡量只访问一个不同页面的会话占比，UI 显示为跳出率（单页会话率）。",
    formulaDescription: "single-page vv / all vv",
    numeratorDescription: "仅包含一个不同 pageRoute 的会话数",
    denominatorDescription: "同范围总会话数（vv）",
    deduplicationKey: "sessionId + pageRoute",
    entityScopes: ["project", "module", "page"],
    reportingTiming: "会话完成或查询时按 sessionId 聚合。",
    unavailableReason: "R6 尚未实现单页会话事实查询。",
  }),
  task_duration: duration({
    businessDescription: "按任务类型衡量从进入操作页到提交成功的耗时。",
    formulaDescription:
      "successful terminal time - task entry time, grouped by workflow type",
    numeratorDescription: "成功任务实例的端到端耗时样本",
    denominatorDescription: "成功关联的任务实例数",
    deduplicationKey: "workflowInstanceId",
    percentiles: ["p50", "p90", "p75", "p99"],
    entityScopes: ["project", "module", "workflow"],
    reportingTiming: "显式工作流开始和成功终态分别上报。",
    unavailableReason:
      "已有 operation 成功耗时能力，但尚无 R4-B 规范工作流入口、任务类型及 P90 输出。",
  }),
  form_efficiency: {
    businessDescription:
      "以修改次数/提交、重置率和校验报错率描述表单效率，不采集字段值。",
    formulaDescription: "controlled form counters per submit attempt",
    numeratorDescription: "字段修改、重置及校验失败次数（分别输出）",
    denominatorDescription: "表单提交尝试次数",
    deduplicationKey: "formInstanceId + submitAttemptId",
    unit: "compound_form_metrics",
    percentiles: [],
    reportingTiming: "显式 trackForm 适配器在修改、重置、校验和提交时上报安全计数。",
    entityScopes: ["module", "page", "workflow"],
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 5,
    missingPolicy: "未启用表单适配器或无提交分母时返回不可用，不根据 DOM 推断。",
    unavailableReason: "R4-C 的脱敏表单汇总 collector 尚未实现。",
  },
  operation_fail_rate: ratio({
    businessDescription:
      "衡量显式业务操作被业务码判定为失败的比例，与 API 错误率分离。",
    formulaDescription: "business-rejected operations / all controlled operations",
    numeratorDescription: "业务码非成功的操作次数",
    denominatorDescription: "同一显式适配器上报的操作总次数",
    deduplicationKey: "operationInstanceId",
    entityScopes: ["project", "module", "workflow"],
    reportingTiming: "业务适配器在每次操作终态上报受控成功/拒绝结果。",
    unavailableReason:
      "R4-C 显式业务适配器尚未实现；不能由 HTTP 状态或 workflow failed 推断。",
  }),
  repeated_operation_rate: ratio({
    businessDescription:
      "衡量同一用户对同一业务对象 24 小时内至少操作三次的相关会话占比。",
    formulaDescription:
      "vv linked to >=3 same-user same-object operations in 24h / related vv",
    numeratorDescription: "命中重复操作规则的相关会话数",
    denominatorDescription: "具有受控业务对象引用的相关会话总数",
    deduplicationKey:
      "project-HMAC(userId) + project-HMAC(bizRef) + operationInstanceId",
    entityScopes: ["project", "module", "workflow"],
    reportingTiming: "显式业务操作适配器上报短期不可逆对象引用。",
    unavailableReason: "R4-C collector 与单独隐私评审尚未完成。",
  }),
  path_steps: {
    businessDescription:
      "以任务成功为终点回溯会话页面序列，输出去重页面数、总步数和回退步数。",
    formulaDescription: "page sequence before successful workflow terminal",
    numeratorDescription: "完成任务前的页面序列步数",
    denominatorDescription: "可关联到成功任务的工作流实例数",
    deduplicationKey: "workflowInstanceId + ordered pageViewId",
    unit: "steps",
    percentiles: ["p50", "p75", "p90", "p99"],
    reportingTiming: "page_view 与工作流实例显式关联后，在成功终态聚合。",
    entityScopes: ["module", "workflow"],
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 5,
    missingPolicy: "缺少显式实例关联时返回不可用，禁止按时间邻近推断。",
    unavailableReason: "R4-B 工作流事实与页面序列关联尚未实现。",
  },
  lcp: vital(
    "最大内容绘制时间",
    ["p75", "p90", "p50", "p99"],
    "milliseconds",
    "现有 web vital 采集使用旧事件形态且查询主要为 P75；R5-A 尚未完成规范 performance 事件、P90 与阈值版本。",
  ),
  inp: vital(
    "交互到下次绘制时间",
    ["p75", "p50", "p90", "p99"],
    "milliseconds",
    "现有 web vital 采集使用旧事件形态；R5-A 尚未完成规范 performance 事件及完整分位数。",
  ),
  cls: vital(
    "累积布局偏移",
    ["p75", "p50", "p90", "p99"],
    "score",
    "现有 web vital 采集使用旧事件形态；R5-A 尚未完成规范 performance 事件及完整分位数。",
  ),
  fcp: vital(
    "首次内容绘制时间",
    ["p90", "p50", "p75", "p99"],
    "milliseconds",
    "现有 web vital 采集使用旧事件形态；R5-A 尚未完成规范 performance 事件及 P90 主展示。",
  ),
  ttfb: vital(
    "首字节时间",
    ["p90", "p50", "p75", "p99"],
    "milliseconds",
    "现有 web vital 采集使用旧事件形态；R5-A 尚未完成规范 performance 事件及 P90 主展示。",
  ),
  first_screen_time: duration({
    businessDescription: "衡量业务显式声明的首屏完成时间。",
    formulaDescription: "explicit first-screen completed time - navigation start",
    numeratorDescription: "显式首屏完成耗时样本",
    denominatorDescription: "启用首屏埋点的页面访问数",
    deduplicationKey: "pageViewId",
    percentiles: ["p90", "p50", "p75", "p99"],
    entityScopes: ["project", "module", "page"],
    reportingTiming: "业务组件确认首屏完成时通过显式 API 上报。",
    unavailableReason: "R5-A 业务首屏显式 API 尚未实现。",
  }),
  api_duration: duration({
    businessDescription: "衡量受控 API 的耗时、成功率和慢请求率。",
    formulaDescription:
      "request terminal time - request start, grouped by allowlisted API route",
    numeratorDescription: "受控 API 请求耗时样本",
    denominatorDescription: "同适配器上报的 API 请求总数",
    deduplicationKey: "apiRequestId",
    percentiles: ["p50", "p90", "p75", "p99"],
    entityScopes: ["project", "module", "page"],
    reportingTiming: "显式 API 适配器在请求完成、失败或超时时上报汇总。",
    unavailableReason: "现有链路主要只有失败请求，R5-A 尚未提供成功分母。",
  }),
  api_slow_top: duration({
    businessDescription: "按 P90 排序展示受控 API 的慢请求 TOP。",
    formulaDescription: "topN(api route by p90(api_duration))",
    numeratorDescription: "每个受控 API 的 P90 耗时",
    denominatorDescription: "每个 API 的请求样本数",
    deduplicationKey: "allowlisted apiRoute + apiRequestId",
    percentiles: ["p90"],
    entityScopes: ["project", "module", "page"],
    reportingTiming: "与 api_duration 共用显式 API 汇总事实。",
    unavailableReason: "R5-A API 成功与失败请求汇总事实尚未实现。",
  }),
  list_render_duration: duration({
    businessDescription: "按页面和行数档位衡量列表渲染时间。",
    formulaDescription:
      "p90(explicit list render duration) by pageRoute and row-count bucket",
    numeratorDescription: "显式列表渲染耗时样本",
    denominatorDescription: "每个页面与行数档位的渲染样本数",
    deduplicationKey: "pageViewId + listRenderInstanceId",
    percentiles: ["p90", "p50", "p75", "p99"],
    entityScopes: ["page"],
    reportingTiming: "组件确认列表渲染完成时通过显式计时 API 上报。",
    unavailableReason: "R5-A 组件层计时 API 尚未实现。",
  }),
  longtask_count: {
    businessDescription: "统计页面内持续超过 50ms 的长任务次数。",
    formulaDescription: "count(PerformanceObserver longtask entries > 50ms)",
    numeratorDescription: "页面长任务条目数",
    denominatorDescription: "启用 longtask collector 的页面访问数（覆盖率）",
    deduplicationKey: "pageViewId + longtask entry startTime",
    unit: "tasks",
    percentiles: [],
    reportingTiming: "PerformanceObserver 收集并在 page_leave 汇总。",
    entityScopes: ["project", "module", "page"],
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 1,
    missingPolicy:
      "浏览器不支持或 collector 未启用时返回不可用并给出覆盖率，不返回 0。",
    unavailableReason: "R5-A longtask collector 尚未实现。",
  },
  longtask_total: duration({
    businessDescription: "统计页面长任务总阻塞时长。",
    formulaDescription: "sum(duration of longtask entries > 50ms)",
    numeratorDescription: "长任务持续时间之和",
    denominatorDescription: "启用 longtask collector 的页面访问数（覆盖率）",
    deduplicationKey: "pageViewId + longtask entry startTime",
    percentiles: [],
    entityScopes: ["project", "module", "page"],
    reportingTiming: "PerformanceObserver 收集并在 page_leave 汇总。",
    unavailableReason: "R5-A longtask collector 尚未实现。",
  }),
  js_error_rate: ratio({
    businessDescription:
      "衡量 JS 异常相对于页面访问的发生率，并按安全指纹聚合影响用户。",
    formulaDescription: "JS error occurrences / pv",
    numeratorDescription: "JS 异常实例数",
    denominatorDescription: "同范围 pv",
    deduplicationKey: "errorEventId; group by safe error fingerprint",
    entityScopes: ["project", "module", "page"],
    reportingTiming: "捕获允许的 JS 异常时上报 error 事件。",
    unavailableReason:
      "已有 JS 错误分子和 PV，但 R5-A 尚未提供规范 rate、影响用户和完整 coverage。",
  }),
  api_error_rate: ratio({
    businessDescription: "衡量 HTTP、网络或超时异常请求占 API 请求总数的比例。",
    formulaDescription: "failed controlled API requests / all controlled API requests",
    numeratorDescription: "HTTP、网络或超时异常请求数",
    denominatorDescription: "同一显式适配器上报的 API 请求总数",
    deduplicationKey: "apiRequestId",
    entityScopes: ["project", "module", "page"],
    reportingTiming: "显式 API 适配器在每次请求终态上报。",
    unavailableReason: "当前只有失败事实，无成功请求分母；R5-A 前不能计算 rate。",
  }),
  resource_error_rate: ratio({
    businessDescription: "衡量资源加载失败请求占资源请求总数的比例。",
    formulaDescription: "failed resource requests / all observed resource requests",
    numeratorDescription: "资源加载失败请求数",
    denominatorDescription: "同范围资源请求总数",
    deduplicationKey: "pageViewId + safe resource fingerprint",
    entityScopes: ["project", "module", "page"],
    reportingTiming: "资源加载完成或失败时由受控汇总 collector 上报。",
    unavailableReason: "当前只有失败分子，无资源请求总数；R5-A 前不能计算 rate。",
  }),
  blank_screen_rate: ratio({
    businessDescription: "衡量被固定规则判定为白屏的页面访问占启用检测访问的比例。",
    formulaDescription: "blank-screen page views / detector-enabled page views",
    numeratorDescription: "命中版本化白屏规则的 pageView 数",
    denominatorDescription: "启用白屏检测的 pageView 数",
    deduplicationKey: "pageViewId",
    entityScopes: ["project", "module", "page"],
    reportingTiming: "页面模板 opt-in 后在稳定观察窗口结算。",
    unavailableReason: "R5-A 白屏 opt-in collector 与规则版本尚未实现。",
  }),
  breadcrumb: {
    businessDescription: "错误发生前最多 50 条白名单语义操作，仅作为错误复现上下文。",
    formulaDescription:
      "ordered tail(max 50) of allowlisted semantic actions attached to an error",
    numeratorDescription: "错误实例随附的安全操作条目",
    denominatorDescription: "带 breadcrumb 的错误实例数（覆盖率）",
    deduplicationKey: "errorEventId + breadcrumb sequence",
    unit: "entries",
    percentiles: [],
    reportingTiming: "本地环形缓冲，仅在错误事件发送时附带。",
    entityScopes: ["page"],
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 1,
    missingPolicy:
      "无 collector 或无错误时不伪造空操作链；禁止上传 DOM 文本、表单值和凭据。",
    unavailableReason: "R5-A 安全 breadcrumb 环形缓冲尚未实现。",
  },
  dept_usage: organizationRatio(
    "部门",
    "departmentId",
    "R4-C 受治理部门目录、编制分母与小群体保护尚未实现。",
  ),
  role_usage: organizationRatio(
    "角色",
    "roleId",
    "R4-C 受治理角色目录、编制分母与小群体保护尚未实现。",
  ),
  role_feature_profile: {
    businessDescription: "展示角色与功能模块的 PV、有效时长 Top N，并执行小群体保护。",
    formulaDescription: "topN(pv, valid duration) by governed roleId and moduleId",
    numeratorDescription: "角色在功能模块内的 PV 与有效时长",
    denominatorDescription: "达到最小群体门槛的目录角色成员数",
    deduplicationKey: "directoryVersion + roleId + moduleId + eventId",
    unit: "ranked_profile",
    percentiles: [],
    reportingTiming: "由服务端目录映射后的安全聚合事实计算。",
    entityScopes: ["project", "module"],
    timeGranularities: ["day", "week", "month"],
    minimumSample: 5,
    missingPolicy: "缺少正式目录或低于小群体门槛时抑制结果，不以事件中的组织文本替代。",
    unavailableReason: "R4-C 组织目录、安全聚合与小群体保护尚未实现。",
  },
  abnormal_access: {
    businessDescription:
      "按经管理层评审的固定规则识别非工作时间、高频、多设备或越权访问。",
    formulaDescription: "versioned fixed-rule matches over governed access facts",
    numeratorDescription: "命中已批准规则的访问实例数",
    denominatorDescription: "规则适用且覆盖完整的访问实例数",
    deduplicationKey: "ruleVersion + accessEventId",
    unit: "rule_matches",
    percentiles: [],
    reportingTiming: "受治理访问事实入库后按固定规则评估。",
    entityScopes: ["project"],
    timeGranularities: ["day", "week", "month"],
    minimumSample: 1,
    missingPolicy: "规则未批准、覆盖不足或目录缺失时不可用；结果不得用于个人绩效。",
    unavailableReason: "R7 固定规则、治理评审和审计能力尚未实现。",
  },
};

function activeUsers(
  windowName: string,
  granularity: "day" | "week" | "month",
): CatalogDetails {
  return {
    businessDescription: `统计${windowName}内的去重活跃用户。`,
    formulaDescription: `uniq(coalesced identity(userId, deviceId)) in ${windowName}`,
    numeratorDescription: `${windowName}内去重后的活跃身份数`,
    denominatorDescription: null,
    deduplicationKey: "project-HMAC(userId) else deviceId",
    unit: "users",
    percentiles: [],
    reportingTiming: "随有效页面或业务活动事实计算。",
    entityScopes: ["project", "module", "page"],
    timeGranularities: [granularity],
    minimumSample: 1,
    missingPolicy: "必须按项目时区完整自然窗口计算；窗口或链路不完整时返回不可用。",
    unavailableReason: `R6 尚未实现${windowName}规范窗口查询。`,
  };
}

function ratio(
  input: Pick<
    CatalogDetails,
    | "businessDescription"
    | "formulaDescription"
    | "numeratorDescription"
    | "denominatorDescription"
    | "deduplicationKey"
    | "entityScopes"
    | "reportingTiming"
    | "unavailableReason"
  >,
): CatalogDetails {
  return {
    ...input,
    unit: "ratio",
    percentiles: [],
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 5,
    missingPolicy:
      "分母为 0、样本不足、覆盖不完整或数据延迟时返回不可用状态，绝不返回伪造的 0%。",
  };
}

function duration(
  input: Pick<
    CatalogDetails,
    | "businessDescription"
    | "formulaDescription"
    | "numeratorDescription"
    | "denominatorDescription"
    | "deduplicationKey"
    | "percentiles"
    | "entityScopes"
    | "reportingTiming"
    | "unavailableReason"
  >,
): CatalogDetails {
  return {
    ...input,
    unit: "milliseconds",
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 5,
    missingPolicy:
      "缺失结束事实不作为 0ms；样本不足、覆盖不完整或链路延迟时返回不可用。",
  };
}

function vital(
  subject: string,
  percentiles: readonly string[],
  unit: string,
  unavailableReason: string,
): CatalogDetails {
  return {
    businessDescription: `按 pageRoute 衡量${subject}。`,
    formulaDescription: `${percentiles[0]}(performance metric samples) by pageRoute`,
    numeratorDescription: `${subject}样本`,
    denominatorDescription: "有效 performance 样本数",
    deduplicationKey: "pageViewId + metric + sampleId",
    unit,
    percentiles,
    reportingTiming: "浏览器性能条目稳定或页面离开时上报 performance 事件。",
    entityScopes: ["project", "module", "page"],
    timeGranularities: DEFAULT_GRANULARITIES,
    minimumSample: 5,
    missingPolicy:
      "样本不足、浏览器不支持、collector 未启用或数据延迟时返回不可用并保留样本状态。",
    unavailableReason,
  };
}

function organizationRatio(
  label: string,
  key: string,
  unavailableReason: string,
): CatalogDetails {
  return ratio({
    businessDescription: `衡量${label}活跃人数相对正式编制人数的比例及功能分布。`,
    formulaDescription: `unique active governed users by ${key} / eligible directory users by ${key}`,
    numeratorDescription: `${label}内去重活跃用户数`,
    denominatorDescription: `${label}目录编制人数、目录版本与分母来源`,
    deduplicationKey: `directoryVersion + ${key} + project-HMAC(userId)`,
    entityScopes: ["project", "module"],
    reportingTiming: "由服务端受治理目录补充组织维度后聚合。",
    unavailableReason,
  });
}

const attachmentSeeds = SYSTEM_METRIC_SEED.filter(
  (seed): seed is typeof seed & { category: SystemMetricCategory } =>
    seed.category !== "score",
);

if (attachmentSeeds.some((seed) => !details[seed.metricKey])) {
  throw new Error("SYSTEM_METRIC_CATALOG_DETAILS_MISSING");
}
if (
  Object.keys(details).some(
    (key) => !attachmentSeeds.some((seed) => seed.metricKey === key),
  )
) {
  throw new Error("SYSTEM_METRIC_CATALOG_UNKNOWN_KEY");
}

export const METRIC_CATALOG: readonly SystemMetricDefinition[] = Object.freeze(
  attachmentSeeds.map((seed) => {
    const item = details[seed.metricKey]!;
    const unavailableReason = item.unavailableReason ?? null;
    return Object.freeze({
      origin: "system" as const,
      metricKey: seed.metricKey,
      displayName: seed.displayName,
      businessDescription: item.businessDescription,
      category: seed.category,
      formulaDescription: item.formulaDescription,
      numeratorDescription: item.numeratorDescription,
      denominatorDescription: item.denominatorDescription,
      deduplicationKey: item.deduplicationKey,
      unit: item.unit,
      percentiles: Object.freeze([...item.percentiles]),
      reportingTiming: item.reportingTiming,
      entityScopes: Object.freeze([...item.entityScopes]),
      timeGranularities: Object.freeze([...item.timeGranularities]),
      minimumSample: item.minimumSample,
      missingPolicy: item.missingPolicy,
      owner: OWNER,
      definitionVersion: DEFINITION_VERSION,
      implementationStatus: seed.implementationStatus,
      availableFrom:
        seed.implementationStatus === "partial" ? PARTIAL_AVAILABLE_FROM : null,
      unavailableReason,
      milestone: seed.milestone,
    });
  }),
);

const metricCatalogByKey = new Map(
  METRIC_CATALOG.map((item) => [item.metricKey, item]),
);

export const RESERVED_SYSTEM_METRIC_KEYS: ReadonlySet<string> = new Set(
  CANONICAL_METRIC_KEYS,
);

export function systemMetricDefinition(
  metricKey: string,
): SystemMetricDefinition | null {
  return metricCatalogByKey.get(metricKey) ?? null;
}

export interface SystemMetricReadResult {
  metricKey: string;
  value: number | null;
  trend: null;
  implementationStatus: SystemMetricImplementationStatus;
  availableFrom: string | null;
  status: "metric_not_available";
  reason: string;
}

export function unavailableSystemMetricResult(
  metricKey: string,
): SystemMetricReadResult | null {
  const definition = systemMetricDefinition(metricKey);
  if (!definition || definition.implementationStatus === "implemented") return null;
  return {
    metricKey,
    value: null,
    trend: null,
    implementationStatus: definition.implementationStatus,
    availableFrom: definition.availableFrom,
    status: "metric_not_available",
    reason: definition.unavailableReason ?? "METRIC_NOT_COLLECTED",
  };
}
