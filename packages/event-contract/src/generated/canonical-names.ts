/* AUTO-GENERATED from canonical-names.json. Do not edit directly. */

export const CANONICAL_PUBLIC_FIELDS = [
  "appId",
  "env",
  "release",
  "event",
  "timestamp",
  "pageUrl",
  "pageRoute",
  "userId",
  "deptId",
  "roleId",
  "sessionId",
  "deviceId",
  "ua",
  "os",
  "browser",
  "payload"
] as const;
export const CANONICAL_EVENT_NAMES = [
  "page_view",
  "page_leave",
  "performance",
  "api",
  "error",
  "custom"
] as const;
export const CANONICAL_CUSTOM_EVENT_NAMES = [
  "feature_exposed",
  "feature_started",
  "feature_succeeded",
  "feature_failed",
  "feature_canceled",
  "feature_long_view_started",
  "feature_long_view_heartbeat",
  "feature_long_view_ended",
  "workflow_started",
  "workflow_step_reached",
  "workflow_completed",
  "workflow_failed",
  "workflow_canceled"
] as const;
export const CANONICAL_ENVIRONMENTS = [
  "prod",
  "staging",
  "dev"
] as const;
export const CANONICAL_PERFORMANCE_METRICS = [
  "lcp",
  "inp",
  "cls",
  "fcp",
  "ttfb"
] as const;
export const CANONICAL_METRIC_KEYS = [
  "pv",
  "uv",
  "dau",
  "wau",
  "mau",
  "vv",
  "module_penetration",
  "avg_usage_duration",
  "hourly_distribution",
  "bounce_rate",
  "task_duration",
  "form_efficiency",
  "operation_fail_rate",
  "repeated_operation_rate",
  "path_steps",
  "lcp",
  "inp",
  "cls",
  "fcp",
  "ttfb",
  "first_screen_time",
  "api_duration",
  "api_slow_top",
  "list_render_duration",
  "longtask_count",
  "longtask_total",
  "js_error_rate",
  "api_error_rate",
  "resource_error_rate",
  "blank_screen_rate",
  "breadcrumb",
  "dept_usage",
  "role_usage",
  "role_feature_profile",
  "abnormal_access",
  "operational_score",
  "quality_score"
] as const;
export const CANONICAL_UI_CHINESE_NAMES = {
  "projects": "全部项目",
  "projectOverview": "项目概览",
  "projectBusiness": "业务分析",
  "projectPages": "页面分析",
  "projectMetrics": "指标管理",
  "projectSettings": "设置",
  "module": "功能模块",
  "pageQualityTab": "质量分析",
  "pageOperationsTab": "运营分析",
  "operationalScore": "运营分数",
  "qualityScore": "质量分数",
  "activeUser": "活跃用户",
  "sessionCount": "会话数（VV）"
} as const;
export const CANONICAL_ROUTES = {
  "projects": "/projects",
  "projectOverview": "/projects/:projectId/overview",
  "projectBusiness": "/projects/:projectId/business",
  "projectPages": "/projects/:projectId/pages",
  "projectMetrics": "/projects/:projectId/metrics",
  "projectSettings": "/projects/:projectId/settings"
} as const;
export const CANONICAL_API_NAMES = {
  "projectSummary": "/api/projects/summary",
  "projectOverview": "/api/projects/:projectId/overview",
  "moduleAnalysis": "/api/projects/:projectId/modules/:moduleId/analysis",
  "workflowAnalysis": "/api/projects/:projectId/workflows/:workflowId/analysis",
  "pageQuality": "/api/projects/:projectId/page-analysis/quality",
  "pageOperations": "/api/projects/:projectId/page-analysis/operations",
  "metricCatalog": "/api/projects/:projectId/metrics/catalog",
  "metricVersions": "/api/projects/:projectId/metrics/versions",
  "score": "/api/projects/:projectId/scores/:scoreKey",
  "probeVersions": "/api/projects/:projectId/settings/probe-versions",
  "exportInterfaces": "/api/projects/:projectId/settings/export-interfaces"
} as const;
export const CANONICAL_RANGES = [
  {
    "key": "7d",
    "granularity": "day",
    "days": 7
  },
  {
    "key": "30d",
    "granularity": "day",
    "days": 30
  },
  {
    "key": "90d",
    "granularity": "week",
    "days": 90
  },
  {
    "key": "180d",
    "granularity": "month",
    "days": 180
  },
  {
    "key": "365d",
    "granularity": "month",
    "days": 365
  },
  {
    "key": "custom",
    "granularity": "adaptive",
    "maximumMonths": 13
  }
] as const;
export const FORBIDDEN_ALIASES = {
  "publicFields": [
    "projectKey",
    "eventName",
    "eventTime",
    "visitorId",
    "accountRef",
    "route",
    "properties",
    "releaseVersion",
    "deploymentEnvironment",
    "browserFamily",
    "osFamily"
  ],
  "eventNames": [
    "web_vital",
    "error_js",
    "error_resource",
    "error_api",
    "feature_exposed",
    "feature_started",
    "feature_succeeded",
    "feature_failed",
    "feature_canceled",
    "feature_long_view_started",
    "feature_long_view_heartbeat",
    "feature_long_view_ended"
  ],
  "metricKeys": [
    "page_views",
    "active_accounts",
    "active_browsers",
    "sessions",
    "project_operational_index"
  ]
} as const;

export type CanonicalPublicField = (typeof CANONICAL_PUBLIC_FIELDS)[number];
export type CanonicalEventName = (typeof CANONICAL_EVENT_NAMES)[number];
export type CanonicalCustomEventName = (typeof CANONICAL_CUSTOM_EVENT_NAMES)[number];
export type CanonicalEnvironment = (typeof CANONICAL_ENVIRONMENTS)[number];
export type CanonicalMetricKey = (typeof CANONICAL_METRIC_KEYS)[number];
