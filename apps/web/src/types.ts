export type GlobalRole = "admin" | "viewer";
export type ProjectRole = "owner" | "admin" | "viewer";
export type FeatureType = "data_view" | "action" | "long_view";
export type DataState = "healthy" | "delayed" | "no_data" | "broken";
export type RangePreset = "24h" | "7d" | "30d";

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
  longViewSuccessAfterMs: number;
  heartbeatIntervalMs: number;
  launchedAt: string | null;
  status: "active" | "disabled";
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
