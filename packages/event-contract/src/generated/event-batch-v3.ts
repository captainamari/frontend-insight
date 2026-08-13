/* AUTO-GENERATED from schema/event-batch-v3.schema.json. Do not edit directly. */

export type Event = {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  eventId: string;
  eventName:
    | (
        | "page_view"
        | "page_leave"
        | "feature_exposed"
        | "feature_started"
        | "feature_succeeded"
        | "feature_failed"
        | "feature_canceled"
        | "feature_long_view_started"
        | "feature_long_view_heartbeat"
        | "feature_long_view_ended"
        | "error_js"
        | "error_resource"
        | "error_api"
        | "web_vital"
        | "page_readiness"
        | "api_request_summary"
        | "resource_summary"
        | "list_render"
        | "long_task_summary"
      )
    | string;
  visitorId: string;
  sessionId: string;
  pageViewId: string;
  operationInstanceId?: string;
  interactionType?: "click" | "submit" | "keyboard" | "programmatic" | "automatic";
  accountRef?: string;
  route: string;
  title?: string;
  timezoneOffsetMinutes?: number;
  featureKey?: string;
  reasonCode?: string;
  properties: PropertiesBag;
  occurredAt: string;
  deploymentEnvironment: "production" | "staging" | "development";
  releaseVersion: string;
  /**
   * @maxItems 50
   */
  breadcrumbs?: {
    kind: "route" | "action" | "api" | "error";
    occurredAt: string;
    key: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "OTHER";
    path?: string;
    statusCode?: number;
  }[];
} & {
  eventId: string;
  eventName:
    | (
        | "page_view"
        | "page_leave"
        | "feature_exposed"
        | "feature_started"
        | "feature_succeeded"
        | "feature_failed"
        | "feature_canceled"
        | "feature_long_view_started"
        | "feature_long_view_heartbeat"
        | "feature_long_view_ended"
        | "error_js"
        | "error_resource"
        | "error_api"
        | "web_vital"
        | "page_readiness"
        | "api_request_summary"
        | "resource_summary"
        | "list_render"
        | "long_task_summary"
      )
    | string;
  visitorId: string;
  sessionId: string;
  pageViewId: string;
  operationInstanceId?: string;
  interactionType?: "click" | "submit" | "keyboard" | "programmatic" | "automatic";
  accountRef?: string;
  route: string;
  title?: string;
  timezoneOffsetMinutes?: number;
  featureKey?: string;
  reasonCode?: string;
  properties: PropertiesBag;
  occurredAt: string;
  deploymentEnvironment: "production" | "staging" | "development";
  releaseVersion: string;
  /**
   * @maxItems 50
   */
  breadcrumbs?: {
    kind: "route" | "action" | "api" | "error";
    occurredAt: string;
    key: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "OTHER";
    path?: string;
    statusCode?: number;
  }[];
};
export type PropertyValue = string | number | boolean | null;

/**
 * Canonical Pre-1.0 transport contract with opt-in performance summaries and privacy-bounded diagnostics.
 */
export interface FrontendInsightEventBatchV3 {
  schemaVersion: 3;
  projectKey: string;
  sentAt: string;
  sdk: Sdk;
  /**
   * @minItems 1
   * @maxItems 50
   */
  events: [Event, ...Event[]];
}
export interface Sdk {
  name: string;
  version: string;
}
export interface PropertiesBag {
  [k: string]: PropertyValue;
}
