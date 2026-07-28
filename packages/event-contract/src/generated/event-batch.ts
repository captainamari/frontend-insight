/* AUTO-GENERATED from schema/event-batch.schema.json. Do not edit directly. */

export type Event = {
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
        | "feature_long_view_started"
        | "feature_long_view_heartbeat"
        | "feature_long_view_ended"
      )
    | string;
  eventTime: string;
  visitorId: string;
  sessionId: string;
  pageViewId: string;
  accountRef?: string;
  route: string;
  title?: string;
  timezoneOffsetMinutes?: number;
  featureKey?: string;
  reasonCode?: string;
  properties: PropertiesBag;
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
        | "feature_long_view_started"
        | "feature_long_view_heartbeat"
        | "feature_long_view_ended"
      )
    | string;
  eventTime: string;
  visitorId: string;
  sessionId: string;
  pageViewId: string;
  accountRef?: string;
  route: string;
  title?: string;
  timezoneOffsetMinutes?: number;
  featureKey?: string;
  reasonCode?: string;
  properties: PropertiesBag;
};
export type PropertyValue = string | number | boolean | null;

/**
 * Browser-to-ingestion transport contract. accountRef must be HMACed and removed before Kafka.
 */
export interface FrontendInsightEventBatchV1 {
  schemaVersion: 1;
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
