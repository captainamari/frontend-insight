export type GlobalRole = "admin" | "viewer";
export type ProjectRole = "owner" | "admin" | "viewer";
export type FeatureType = "data_view" | "action" | "long_view";
export type DataState = "healthy" | "delayed" | "no_data" | "broken";
export type RangePreset = "24h" | "7d" | "30d";
export type PageTemplate = "monitoring_dashboard" | "analysis_view" | "task_operation";
export type ExpectedFrequency = "daily" | "weekly" | "monthly" | "ad_hoc";
export type MetricStatus =
  | "available"
  | "insufficient_sample"
  | "missing_target"
  | "metric_not_available"
  | "data_delayed";
export type MetricDimensionKey =
  "usage_coverage" | "continuity_depth" | "task_completion" | "usage_efficiency";

export interface User {
  userId: string;
  globalRole: GlobalRole;
  displayName: string;
  email: string | null;
}

export interface Project {
  id: string;
  projectKey: string;
  name: string;
  timezone: string;
  status: "active" | "disabled";
  retentionDays: number;
  origins: string[];
  role?: ProjectRole;
}

export interface Feature {
  id: string;
  projectId: string;
  featureKey: string;
  name: string;
  description: string | null;
  featureType: FeatureType;
  pageDefinitionId: string | null;
  isKeyTask: boolean;
  taskWeight: number;
  taskTimeoutSeconds: number;
  operationLifecycleEnabled: boolean;
  configurationEffectiveFrom: string;
  longViewSuccessAfterMs: number;
  heartbeatIntervalMs: number;
  launchedAt: string | null;
  status: "active" | "disabled";
}

export interface ProjectModule {
  id: string;
  projectId: string;
  moduleKey: string;
  name: string;
  criticalityWeight: number;
  displayOrder: number;
  status: "active" | "disabled";
  effectiveFrom: string;
}

export interface PageDefinition {
  id: string;
  projectId: string;
  moduleId: string;
  normalizedRoute: string;
  name: string;
  templateKey: PageTemplate;
  isCore: boolean;
  criticalityWeight: number;
  expectedFrequency: ExpectedFrequency;
  status: "active" | "disabled";
  effectiveFrom: string;
}

export interface ProjectOperationalSettings {
  id: string;
  projectId: string;
  version: number;
  targetAccounts: number | null;
  expectedActiveWeekdays: number[];
  status: "active" | "superseded";
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface CollectorToggleSettings {
  enabled: boolean;
  sampleRate: number;
}

export interface ProjectCollectorSettings {
  id: string;
  projectId: string;
  version: number;
  api: CollectorToggleSettings & {
    slowThresholdMs: number;
    globalFetch: boolean;
  };
  resources: CollectorToggleSettings;
  firstScreen: CollectorToggleSettings;
  listRender: CollectorToggleSettings;
  longTasks: CollectorToggleSettings;
  blankScreen: CollectorToggleSettings;
  breadcrumbs: CollectorToggleSettings & { allowedActionKeys: string[] };
  status: "active" | "superseded";
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface MetricProfileItem {
  id: string;
  profileId: string;
  metricKey: string;
  dimensionKey: MetricDimensionKey;
  dimensionWeight: number;
  metricWeight: number;
  targetValue: number | null;
  floorValue: number | null;
  ceilingValue: number | null;
  targetMin: number | null;
  targetMax: number | null;
  toleranceMin: number | null;
  toleranceMax: number | null;
  minimumSample: number | null;
  enabled: boolean;
  required: boolean;
}

export interface MetricProfile {
  id: string;
  projectId: string;
  profileKey: string;
  name: string;
  version: number;
  status: "draft" | "active" | "retired";
  effectiveFrom: string | null;
  items: MetricProfileItem[];
}

export interface DataStatus {
  projectId: string;
  state: DataState;
  reason: string;
  lastReceivedAt: string | null;
  lastIngestedAt: string | null;
  lastQueryableAt: string | null;
  lastRequestId: string | null;
  lastSdkVersion: string | null;
  lastRejectionCode: string | null;
  acceptedEvents: number;
  rejectedEvents: number;
  deadLetterEvents: number;
}

export interface RangeQuery {
  from: string;
  to: string;
  timezone: string;
  granularity: "hour" | "day";
}

export interface OverviewMetrics {
  pv: number;
  visitors: number;
  accounts: number;
  sessions: number;
  last_received_at: string | null;
}

export interface OverviewResponse {
  range: RangeQuery;
  current: OverviewMetrics;
  comparison: {
    label: "previous_day_same_duration";
    metrics: OverviewMetrics;
  };
  semantics: {
    visitors: string;
    accounts: string;
    sessions: string;
  };
  sdkVersions: SdkVersionUsage[];
}

export interface SdkVersionUsage {
  sdk_name: string;
  sdk_version: string;
  events: number;
  last_received_at: string | null;
}

export interface TrendPoint {
  bucket: string;
  pv?: number;
  visitors?: number;
  exposed?: number;
  succeeded?: number;
  succeeded_accounts?: number;
  succeeded_visitors?: number;
}

export interface TrendResponse {
  range: RangeQuery;
  points: TrendPoint[];
  gapPolicy: string;
}

export interface FeatureAnalytics extends Feature {
  feature_key?: string;
  exposed_accounts?: number;
  exposed_visitors?: number;
  succeeded_accounts?: number;
  succeeded_visitors?: number;
  success_count?: number;
  repeat_accounts?: number;
  repeat_visitors?: number;
  last_succeeded_at?: string | null;
  accountConversionRate: number | null;
  visitorConversionRate: number | null;
}

export interface FeaturesResponse {
  range: RangeQuery;
  items: FeatureAnalytics[];
  trend: TrendPoint[];
  gapPolicy: string;
  sdkVersions: SdkVersionUsage[];
}

export interface PageAnalytics {
  route: string;
  pv: number;
  visitors: number;
  sessions: number;
  last_visit_at: string;
  last_received_at: string;
}

export interface PagesResponse {
  range: RangeQuery;
  page: number;
  pageSize: number;
  total: number;
  items: PageAnalytics[];
}

export interface FeatureDetailResponse {
  range: RangeQuery;
  feature: Feature;
  metrics: {
    exposed: number;
    started: number;
    succeeded: number;
    failed: number;
    succeeded_accounts: number;
    succeeded_visitors: number;
    repeat_accounts: number;
    repeat_visitors: number;
    visible_duration_ms: number;
  };
  trend: TrendPoint[];
  gapPolicy: string;
  sdkVersions: SdkVersionUsage[];
}

export interface OnboardingResponse {
  project: Project;
  status: DataStatus;
  integration: {
    package: string;
    endpoint: string;
    projectKey: string;
    csp: string;
  };
}

export interface M6ReadModelMeta {
  range: RangeQuery;
  dataStatus: DataStatus;
  updatedAt: string | null;
  definitionVersion: string;
}

export interface PageOperationalMetrics {
  route: string;
  pageViews: number;
  accounts: number;
  browsers: number;
  sessions: number;
  lastVisitAt: string | null;
  durationSamples: number;
  durationAverageMs: number | null;
  durationP50Ms: number | null;
  durationP75Ms: number | null;
  durationCoverage: number | null;
}

export interface TaskOperationalMetrics {
  started: number;
  succeeded: number;
  failed: number;
  canceled: number;
  abandoned: number;
  completionRate: number | null;
  adverseOutcomeRate: number | null;
  successDurationP50Ms: number | null;
  successDurationP75Ms: number | null;
}

export interface OperationalOverviewResponse extends M6ReadModelMeta {
  settingsVersion: number | null;
  summary: {
    pageViews: number;
    activeAccounts: number;
    crossDayAccounts: number;
    activeDates: number;
    expectedActiveDays: number;
    activeExpectedDays: number;
    activeDayCoverage: number | null;
    configuredModules: number;
    configuredPages: number;
    corePages: number;
    usedCorePages: number;
    keyTasks: number;
    usedKeyTasks: number;
    unclassifiedRoutes: number;
  };
  modules: Array<{
    id: string;
    moduleKey: string;
    name: string;
    pageViews: number;
    accounts: number;
    browsers: number;
    sessions: number;
    lastVisitAt: string | null;
    usedPages: number;
    configuredPages: number;
  }>;
  corePages: Array<
    PageDefinition & {
      metrics: PageOperationalMetrics | null;
    }
  >;
  keyTasks: Array<Feature & Partial<TaskOperationalMetrics>>;
  depth: {
    sampleSize: number;
    classifiedSampleSize: number;
    pageViewsP50: number | null;
    pageViewsP75: number | null;
    distinctPagesP50: number | null;
    distinctPagesP75: number | null;
    moduleBreadthP50: number | null;
    moduleBreadthP75: number | null;
  };
  taskSummary: TaskOperationalMetrics;
  unclassified: Array<{
    route: string;
    pageViews: number;
    accounts: number;
    browsers: number;
    sessions: number;
    lastVisitAt: string | null;
  }>;
}

export interface PageDetailResponse extends M6ReadModelMeta {
  classification:
    | {
        status: "classified";
        page: PageDefinition;
        module: ProjectModule | null;
      }
    | { status: "unclassified"; page: null; module: null };
  metrics: PageOperationalMetrics & {
    sessionDistinctPagesP50: number | null;
    sessionDistinctPagesP75: number | null;
    sessionModuleBreadthP50: number | null;
    sessionModuleBreadthP75: number | null;
  };
  templateTarget: {
    direction: "target_range";
    minMs: number;
    maxMs: number;
    toleranceMinMs: number;
    toleranceMaxMs: number;
  };
  depthGuidance: string;
  availableFrom: string | null;
  trend: TrendPoint[];
  gapPolicy: string;
  keyTasks: Feature[];
  definitions: MetricDefinition[];
}

export interface TaskDetailResponse extends M6ReadModelMeta {
  availableFrom: string | null;
  availabilityStatus: "none" | "partial" | "full";
  feature: Feature;
  metrics: TaskOperationalMetrics;
  semantics: {
    abandonment: string;
    pairing: string;
  };
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

export interface OperationalMetricItemResult {
  metricKey: string;
  displayName: string;
  rawValue: number | null;
  target: {
    targetValue: number | null;
    floorValue: number | null;
    ceilingValue: number | null;
    targetMin: number | null;
    targetMax: number | null;
    toleranceMin: number | null;
    toleranceMax: number | null;
  };
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

export interface OperationalIndexResponse extends M6ReadModelMeta {
  evaluationRange: RangeQuery;
  configurationAvailabilityStatus: "partial" | "full";
  profile: {
    id: string;
    profileKey: string;
    name: string;
    version: number;
    effectiveFrom: string | null;
  } | null;
  settings: ProjectOperationalSettings | null;
  availableFrom: string | null;
  availabilityStatus: "none" | "partial" | "full";
  rawMetrics: MetricResult[];
  index: {
    value: number | null;
    status: "available" | "unavailable";
    reasons: string[];
    eligibleDimensions: number;
    weightCoverage: number;
    definitionVersion: string;
    dimensions: Array<{
      dimensionKey: MetricDimensionKey;
      displayName: string;
      weight: number;
      score: number | null;
      contribution: number | null;
      eligible: boolean;
      eligibleMetricWeight: number;
      items: OperationalMetricItemResult[];
    }>;
  };
  configurationGaps: string[];
}

export interface MetricDefinition {
  metricKey: string;
  displayName: string;
  businessQuestion: string;
  entityType: "project" | "module" | "page" | "task";
  valueType: "count" | "ratio" | "duration" | "score";
  unit: string;
  layer: "fact" | "atomic" | "derived" | "composite";
  inputKeys: string[];
  formulaDescription: string;
  denominatorDescription: string;
  deduplicationKey: string;
  missingValuePolicy: string;
  scoreDirection: "higher_better" | "lower_better" | "target_range" | "none";
  minimumSample: number;
  definitionVersion: string;
  effectiveFrom: string;
  owner: string;
}

export interface MetricLineage {
  metricKey: string;
  nodes: Array<{
    id: string;
    label: string;
    layer: "fact" | "atomic" | "derived" | "composite";
    valueType: string;
    definitionVersion: string;
  }>;
  edges: Array<{ from: string; to: string }>;
  directUpstream: string[];
  directDownstream: string[];
}

export type ObservabilityErrorType = "js" | "resource" | "api";
export type ObservabilitySeverity = "critical" | "high" | "warning" | "info";

export interface ObservabilityMeta {
  range: RangeQuery;
  dataStatus: DataStatus;
  updatedAt: string | null;
  availableFrom: string | null;
  definitionVersion: string;
}

export interface PagePerformanceResponse extends ObservabilityMeta {
  definitionVersion: string;
  coverage: {
    pageViews: number;
    api: {
      observedPageViews: number;
      rate: number | null;
      sampleRate: number | null;
    };
    readiness: {
      observedPageViews: number;
      rate: number | null;
      sampleRate: number | null;
    };
    resources: {
      observedPageViews: number;
      rate: number | null;
      sampleRate: number | null;
    };
    listRender: {
      observedPageViews: number;
      rate: number | null;
      sampleRate: number | null;
    };
    longTasks: {
      observedPageViews: number;
      rate: number | null;
      sampleRate: number | null;
    };
    blankScreen: {
      observedPageViews: number;
      rate: number | null;
      sampleRate: number | null;
    };
    breadcrumbs: {
      observedErrors: number;
      errorEvents: number;
      rate: number | null;
      sampleRate: number | null;
    };
  };
  api: {
    status: "available" | "not_collected" | "insufficient_sample";
    availableFrom: string | null;
    items: Array<{
      requestMethod: string;
      requestPath: string;
      numerator: { successes: number; errors: number; slowRequests: number };
      denominator: number;
      successRate: number | null;
      errorRate: number | null;
      slowRequestRate: number | null;
      p50Ms: number | null;
      p90Ms: number | null;
      sampleRate: number | null;
      sampleSize: number;
      status: "available" | "not_collected" | "insufficient_sample";
      availableFrom: string | null;
      lastSeenAt: string | null;
    }>;
  };
  resources: {
    status: "available" | "not_collected";
    numerator: number;
    denominator: number;
    failureRate: number | null;
    sampleRate: number | null;
    availableFrom: string | null;
    releases: Array<{
      releaseVersion: string;
      numerator: number;
      denominator: number;
      failureRate: number | null;
      sampleRate: number | null;
      availableFrom: string | null;
      lastSeenAt: string | null;
    }>;
  };
  readiness: {
    status: "available" | "not_collected" | "insufficient_sample";
    availableFrom: string | null;
    items: Array<{
      templateKey: string;
      p50Ms: number | null;
      p90Ms: number | null;
      sampleSize: number;
      status: "available" | "not_collected" | "insufficient_sample";
      blankCandidateRate: number | null;
      blankCandidates: number;
      blankObservedPageViews: number;
      availableFrom: string | null;
    }>;
  };
  listRender: {
    status: "available" | "not_collected" | "insufficient_sample";
    availableFrom: string | null;
    items: Array<{
      route: string;
      rowCountBucket: string;
      p50Ms: number | null;
      p90Ms: number | null;
      sampleSize: number;
      status: "available" | "not_collected" | "insufficient_sample";
      availableFrom: string | null;
    }>;
  };
  longTasks: {
    status: "available" | "not_collected";
    count: number;
    durationMs: number;
    numerator: number;
    denominator: number;
    affectedPageViewRate: number | null;
    sampleRate: number | null;
    availableFrom: string | null;
  };
  blankScreen: {
    status: "available" | "not_collected";
    numerator: number;
    denominator: number;
    candidateRate: number | null;
    sampleRate: number | null;
    availableFrom: string | null;
    relatedErrors: {
      occurrences: number;
      affectedPageViews: number;
    };
    relatedResources: {
      numerator: number;
      denominator: number;
      failureRate: number | null;
    };
  };
  breadcrumbs: {
    status: "available" | "not_collected";
    numerator: number;
    denominator: number;
    coverageRate: number | null;
    sampleRate: number | null;
    availableFrom: string | null;
  };
}

export interface ErrorGroupSummary {
  groupId: string;
  errorType: ObservabilityErrorType;
  errorName: string | null;
  message: string | null;
  stackTopFrame: string | null;
  requestMethod: string | null;
  requestPath: string | null;
  httpStatus: number | null;
  resourceType: string | null;
  occurrences: number;
  affectedAccounts: number;
  affectedBrowsers: number;
  affectedPages: number;
  pages: string[];
  releases: string[];
  browserFamilies: string[];
  osFamilies: string[];
  viewportBuckets: string[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  severity: ObservabilitySeverity;
}

export interface WebVitalSummary {
  route: string;
  vitalName: "LCP" | "CLS" | "INP" | "FCP" | "TTFB";
  releaseVersion: string;
  sampleSize: number;
  p75: number | null;
  poorSamples: number;
  poorRate: number | null;
  lastSeenAt: string | null;
}

export interface ReleaseObservabilitySummary {
  releaseVersion: string;
  deploymentEnvironment: string | null;
  observabilityEvents: number;
  errors: number;
  errorGroups: number;
  poorVitalSamples: number;
  affectedBrowsers: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface FixedAlert {
  id: string;
  ruleKey: "error_spike" | "web_vital_poor" | "telemetry_delayed";
  severity: Exclude<ObservabilitySeverity, "info">;
  title: string;
  evidence: string;
  entityType: "error_group" | "page_vital" | "pipeline";
  entityKey: string;
  triggeredAt: string | null;
  definitionVersion: string;
}

export interface ObservabilityOverviewResponse extends ObservabilityMeta {
  summary: {
    errorOccurrences: number;
    errorGroups: number;
    affectedAccounts: number;
    affectedBrowsers: number;
    vitalSamples: number;
    poorVitalSamples: number;
    releases: number;
    activeAlerts: number;
  };
  errors: ErrorGroupSummary[];
  vitals: WebVitalSummary[];
  releases: ReleaseObservabilitySummary[];
  alerts: FixedAlert[];
  trend: Array<{
    bucket: string;
    errors: number;
    errorGroups: number;
    vitalSamples: number;
    poorVitalSamples: number;
  }>;
  alertPolicy: {
    definitionVersion: string;
    errorSpike: string;
    webVitalPoor: string;
    lifecycle: string;
  };
  boundaries: {
    operationalIndexVersion: "operational_v1_unchanged";
    sourceMaps: "disabled_pending_real_location_evidence";
    causality: string;
  };
}

export interface ErrorBreadcrumb {
  kind: "route" | "action" | "api" | "error";
  occurredAt: string;
  key: string;
  method?: string;
  path?: string;
  statusCode?: number;
}

export interface ErrorGroupDetailResponse extends ObservabilityMeta {
  item: ErrorGroupSummary;
  trend: Array<{
    bucket: string;
    occurrences: number;
    affectedBrowsers: number;
    affectedAccounts: number;
  }>;
  impact: Array<{
    route: string;
    releaseVersion: string;
    occurrences: number;
    affectedBrowsers: number;
    lastSeenAt: string | null;
  }>;
  breadcrumbSamples: Array<{
    occurredAt: string | null;
    route: string;
    releaseVersion: string;
    items: ErrorBreadcrumb[];
  }>;
  privacy: string;
}
