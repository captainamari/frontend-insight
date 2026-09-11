import {
  CANONICAL_CUSTOM_EVENT_NAMES,
  CANONICAL_EVENT_NAMES,
  CANONICAL_METRIC_KEYS,
} from "./generated/canonical-names.js";

export const CURRENT_SCHEMA_VERSION = 3 as const;
export const MIN_SUPPORTED_SCHEMA_VERSION = 3 as const;
export const SUPPORTED_SCHEMA_VERSIONS = [CURRENT_SCHEMA_VERSION] as const;

export const CONTRACT_LIMITS = Object.freeze({
  maximumBatchBytes: 64 * 1024,
  maximumEventBytes: 8 * 1024,
  maximumEventsPerBatch: 50,
  maximumClockSkewMs: 24 * 60 * 60 * 1000,
});

export const STANDARD_EVENT_NAMES = CANONICAL_EVENT_NAMES;
export const STANDARD_CUSTOM_EVENT_NAMES = CANONICAL_CUSTOM_EVENT_NAMES;
export const RESERVED_METRIC_KEYS = CANONICAL_METRIC_KEYS;

export const REJECTION_CODES = Object.freeze({
  schemaVersionUnsupported: "SCHEMA_VERSION_UNSUPPORTED",
  batchTooLarge: "BATCH_TOO_LARGE",
  batchEventLimitExceeded: "BATCH_EVENT_LIMIT_EXCEEDED",
  eventTooLarge: "EVENT_TOO_LARGE",
  schemaInvalid: "SCHEMA_INVALID",
  duplicateEventId: "DUPLICATE_EVENT_ID",
  credentialDataRejected: "CREDENTIAL_DATA_REJECTED",
  timestampOutOfRange: "TIMESTAMP_OUT_OF_RANGE",
  mixedEventContext: "MIXED_EVENT_CONTEXT",
});

export type RejectionCode = (typeof REJECTION_CODES)[keyof typeof REJECTION_CODES];
export type StandardEventName = (typeof STANDARD_EVENT_NAMES)[number];
