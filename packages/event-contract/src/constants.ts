export const CURRENT_SCHEMA_VERSION = 2 as const;
export const MIN_SUPPORTED_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_SCHEMA_VERSIONS = [1, CURRENT_SCHEMA_VERSION] as const;

export const CONTRACT_LIMITS = Object.freeze({
  maximumBatchBytes: 64 * 1024,
  maximumEventBytes: 8 * 1024,
  maximumEventsPerBatch: 50,
  maximumClockSkewMs: 24 * 60 * 60 * 1000,
});

export const STANDARD_EVENT_NAMES = [
  "page_view",
  "page_leave",
  "feature_exposed",
  "feature_started",
  "feature_succeeded",
  "feature_failed",
  "feature_canceled",
  "feature_long_view_started",
  "feature_long_view_heartbeat",
  "feature_long_view_ended",
  "error_js",
  "error_resource",
  "error_api",
  "web_vital",
] as const;

export const OBSERVABILITY_EVENT_NAMES = [
  "error_js",
  "error_resource",
  "error_api",
  "web_vital",
] as const;

export const REJECTION_CODES = Object.freeze({
  schemaVersionUnsupported: "SCHEMA_VERSION_UNSUPPORTED",
  batchTooLarge: "BATCH_TOO_LARGE",
  batchEventLimitExceeded: "BATCH_EVENT_LIMIT_EXCEEDED",
  eventTooLarge: "EVENT_TOO_LARGE",
  eventNameInvalid: "EVENT_NAME_INVALID",
  schemaInvalid: "SCHEMA_INVALID",
  duplicateEventId: "DUPLICATE_EVENT_ID",
  credentialDataRejected: "CREDENTIAL_DATA_REJECTED",
  eventTimeOutOfRange: "EVENT_TIME_OUT_OF_RANGE",
  operationInstanceInvalid: "OPERATION_INSTANCE_INVALID",
});

export type RejectionCode = (typeof REJECTION_CODES)[keyof typeof REJECTION_CODES];
export type StandardEventName = (typeof STANDARD_EVENT_NAMES)[number];
