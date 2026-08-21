/* AUTO-GENERATED from canonical-names.json. Do not edit directly. */

export type FrontendInsightEnvironment = "prod" | "staging" | "dev";
export type FrontendInsightEventName = "page_view" | "page_leave" | "performance" | "api" | "error" | "custom";
export type FrontendInsightCustomEventName = "feature_exposed" | "feature_started" | "feature_succeeded" | "feature_failed" | "feature_canceled" | "feature_long_view_started" | "feature_long_view_heartbeat" | "feature_long_view_ended" | "workflow_started" | "workflow_step_reached" | "workflow_completed" | "workflow_failed" | "workflow_canceled";

export type PayloadValue = string | number | boolean | null;

export interface FrontendInsightSdk {
  name: string;
  version: string;
}

export interface FrontendInsightEventV3 {
  eventId: string;
  event: FrontendInsightEventName;
  appId: string;
  env: FrontendInsightEnvironment;
  release: string;
  pageUrl: string;
  pageRoute: string;
  userId: string | null;
  deptId: string | null;
  roleId: string | null;
  sessionId: string;
  deviceId: string;
  pageViewId: string;
  ua: string;
  os: string;
  browser: string;
  timestamp: number;
  payload: Record<string, PayloadValue | Record<string, PayloadValue>>;
}

export interface FrontendInsightEventBatchV3 {
  schemaVersion: 3;
  sentAt: number;
  sdk: FrontendInsightSdk;
  events: FrontendInsightEventV3[];
}
