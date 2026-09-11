/* AUTO-GENERATED from packages/event-contract/canonical-names.json. Do not edit directly. */

export type SystemMetricImplementationStatus = "implemented" | "partial" | "not_collected";

export interface SystemMetricSeed {
  metricKey: string;
  displayName: string;
  category: "usage" | "operation" | "performance" | "stability" | "organization" | "score";
  implementationStatus: SystemMetricImplementationStatus;
  milestone: string;
}

export const SYSTEM_METRIC_SEED: readonly SystemMetricSeed[] = Object.freeze(
  [
  {
    "metricKey": "pv",
    "displayName": "页面浏览量",
    "category": "usage",
    "implementationStatus": "partial",
    "milestone": "R6"
  },
  {
    "metricKey": "uv",
    "displayName": "活跃用户数",
    "category": "usage",
    "implementationStatus": "partial",
    "milestone": "R6"
  },
  {
    "metricKey": "dau",
    "displayName": "日活跃用户数",
    "category": "usage",
    "implementationStatus": "not_collected",
    "milestone": "R6"
  },
  {
    "metricKey": "wau",
    "displayName": "周活跃用户数",
    "category": "usage",
    "implementationStatus": "not_collected",
    "milestone": "R6"
  },
  {
    "metricKey": "mau",
    "displayName": "月活跃用户数",
    "category": "usage",
    "implementationStatus": "not_collected",
    "milestone": "R6"
  },
  {
    "metricKey": "vv",
    "displayName": "会话数（VV）",
    "category": "usage",
    "implementationStatus": "partial",
    "milestone": "R6"
  },
  {
    "metricKey": "module_penetration",
    "displayName": "功能模块渗透率",
    "category": "usage",
    "implementationStatus": "not_collected",
    "milestone": "R4-A"
  },
  {
    "metricKey": "avg_usage_duration",
    "displayName": "人均使用时长",
    "category": "usage",
    "implementationStatus": "not_collected",
    "milestone": "R6"
  },
  {
    "metricKey": "hourly_distribution",
    "displayName": "时段分布",
    "category": "usage",
    "implementationStatus": "not_collected",
    "milestone": "R6"
  },
  {
    "metricKey": "bounce_rate",
    "displayName": "跳出率（单页会话率）",
    "category": "usage",
    "implementationStatus": "not_collected",
    "milestone": "R6"
  },
  {
    "metricKey": "task_duration",
    "displayName": "任务耗时",
    "category": "operation",
    "implementationStatus": "partial",
    "milestone": "R4-B"
  },
  {
    "metricKey": "form_efficiency",
    "displayName": "表单效率",
    "category": "operation",
    "implementationStatus": "not_collected",
    "milestone": "R4-C"
  },
  {
    "metricKey": "operation_fail_rate",
    "displayName": "操作失败率",
    "category": "operation",
    "implementationStatus": "not_collected",
    "milestone": "R4-C"
  },
  {
    "metricKey": "repeated_operation_rate",
    "displayName": "重复操作率",
    "category": "operation",
    "implementationStatus": "not_collected",
    "milestone": "R4-C"
  },
  {
    "metricKey": "path_steps",
    "displayName": "操作路径步数",
    "category": "operation",
    "implementationStatus": "not_collected",
    "milestone": "R4-B"
  },
  {
    "metricKey": "lcp",
    "displayName": "最大内容绘制",
    "category": "performance",
    "implementationStatus": "partial",
    "milestone": "R5-A"
  },
  {
    "metricKey": "inp",
    "displayName": "交互到下次绘制",
    "category": "performance",
    "implementationStatus": "partial",
    "milestone": "R5-A"
  },
  {
    "metricKey": "cls",
    "displayName": "累积布局偏移",
    "category": "performance",
    "implementationStatus": "partial",
    "milestone": "R5-A"
  },
  {
    "metricKey": "fcp",
    "displayName": "首次内容绘制",
    "category": "performance",
    "implementationStatus": "partial",
    "milestone": "R5-A"
  },
  {
    "metricKey": "ttfb",
    "displayName": "首字节时间",
    "category": "performance",
    "implementationStatus": "partial",
    "milestone": "R5-A"
  },
  {
    "metricKey": "first_screen_time",
    "displayName": "业务首屏时间",
    "category": "performance",
    "implementationStatus": "not_collected",
    "milestone": "R5-A"
  },
  {
    "metricKey": "api_duration",
    "displayName": "接口耗时",
    "category": "performance",
    "implementationStatus": "not_collected",
    "milestone": "R5-A"
  },
  {
    "metricKey": "api_slow_top",
    "displayName": "慢接口 TOP",
    "category": "performance",
    "implementationStatus": "not_collected",
    "milestone": "R5-A"
  },
  {
    "metricKey": "list_render_duration",
    "displayName": "列表渲染耗时",
    "category": "performance",
    "implementationStatus": "not_collected",
    "milestone": "R5-A"
  },
  {
    "metricKey": "longtask_count",
    "displayName": "长任务次数",
    "category": "performance",
    "implementationStatus": "not_collected",
    "milestone": "R5-A"
  },
  {
    "metricKey": "longtask_total",
    "displayName": "长任务总时长",
    "category": "performance",
    "implementationStatus": "not_collected",
    "milestone": "R5-A"
  },
  {
    "metricKey": "js_error_rate",
    "displayName": "JS 错误率",
    "category": "stability",
    "implementationStatus": "partial",
    "milestone": "R5-A"
  },
  {
    "metricKey": "api_error_rate",
    "displayName": "API 错误率",
    "category": "stability",
    "implementationStatus": "not_collected",
    "milestone": "R5-A"
  },
  {
    "metricKey": "resource_error_rate",
    "displayName": "资源错误率",
    "category": "stability",
    "implementationStatus": "not_collected",
    "milestone": "R5-A"
  },
  {
    "metricKey": "blank_screen_rate",
    "displayName": "白屏率",
    "category": "stability",
    "implementationStatus": "not_collected",
    "milestone": "R5-A"
  },
  {
    "metricKey": "breadcrumb",
    "displayName": "安全操作面包屑",
    "category": "stability",
    "implementationStatus": "not_collected",
    "milestone": "R5-A"
  },
  {
    "metricKey": "dept_usage",
    "displayName": "部门使用率",
    "category": "organization",
    "implementationStatus": "not_collected",
    "milestone": "R4-C"
  },
  {
    "metricKey": "role_usage",
    "displayName": "角色使用率",
    "category": "organization",
    "implementationStatus": "not_collected",
    "milestone": "R4-C"
  },
  {
    "metricKey": "role_feature_profile",
    "displayName": "角色功能画像",
    "category": "organization",
    "implementationStatus": "not_collected",
    "milestone": "R4-C"
  },
  {
    "metricKey": "abnormal_access",
    "displayName": "异常访问",
    "category": "organization",
    "implementationStatus": "not_collected",
    "milestone": "R7"
  },
  {
    "metricKey": "operational_score",
    "displayName": "运营分数",
    "category": "score",
    "implementationStatus": "partial",
    "milestone": "R1-C"
  },
  {
    "metricKey": "quality_score",
    "displayName": "质量分数",
    "category": "score",
    "implementationStatus": "not_collected",
    "milestone": "R1-C"
  }
],
);
