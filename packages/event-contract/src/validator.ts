import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import schemaV3 from "../schema/event-batch-v3.schema.json" with { type: "json" };
import {
  CONTRACT_LIMITS,
  REJECTION_CODES,
  STANDARD_EVENT_NAMES,
  SUPPORTED_SCHEMA_VERSIONS,
  type RejectionCode,
} from "./constants.js";
import type { FrontendInsightEventBatchV3 } from "./generated/event-batch-v3.js";
import { findCredentialLeak } from "./security.js";

export type FrontendInsightEventBatch = FrontendInsightEventBatchV3;

export interface ContractValidationError {
  code: RejectionCode;
  path: string;
  message: string;
}

export type ContractValidationResult =
  | { ok: true; value: FrontendInsightEventBatch }
  | { ok: false; errors: ContractValidationError[] };

export interface ValidationOptions {
  nowMs?: number;
  maximumClockSkewMs?: number;
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
const addFormats = addFormatsModule.default as unknown as FormatsPlugin;
addFormats(ajv);
const validateSchemaV3 = ajv.compile<FrontendInsightEventBatchV3>(schemaV3);

const standardEventNames = new Set<string>(STANDARD_EVENT_NAMES);
const customEventName = /^(?!page_|feature_)[a-z][a-z0-9_]{0,63}$/;
const operationInstanceId = /^op_[A-Za-z0-9_-]{16,64}$/;
const operationRequiredEvents = new Set(["feature_started", "feature_canceled"]);
const p1RequiredProperties: Record<string, readonly string[]> = {
  page_readiness: [
    "templateKey",
    "readinessDurationMs",
    "readinessState",
    "firstScreenCollected",
    "blankDetectionCollected",
    "firstScreenSampleRate",
    "blankDetectionSampleRate",
  ],
  api_request_summary: [
    "requestMethod",
    "requestPath",
    "statusCode",
    "durationMs",
    "requestCount",
    "errorCount",
    "successCount",
    "slowCount",
    "slowThresholdMs",
    "sampleRate",
  ],
  resource_summary: [
    "totalCount",
    "failedCount",
    "totalDurationMs",
    "observedPageViews",
    "sampleRate",
  ],
  list_render: ["rowCountBucket", "durationMs", "sampleRate"],
  long_task_summary: [
    "longTaskCount",
    "longTaskDurationMs",
    "longTaskMaximumMs",
    "observedPageViews",
    "sampleRate",
  ],
};

function error(
  code: RejectionCode,
  path: string,
  message: string,
): ContractValidationResult {
  return { ok: false, errors: [{ code, path, message }] };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function schemaErrors(
  errors: ErrorObject[] | null | undefined,
): ContractValidationError[] {
  return (errors ?? []).map((item) => ({
    code: REJECTION_CODES.schemaInvalid,
    path: item.instancePath || "$",
    message: item.message ?? "does not match the event schema",
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateTransportBatch(
  input: unknown,
  options: ValidationOptions = {},
): ContractValidationResult {
  if (!isRecord(input)) {
    return error(REJECTION_CODES.schemaInvalid, "$", "batch must be an object");
  }

  if (
    typeof input.schemaVersion !== "number" ||
    !SUPPORTED_SCHEMA_VERSIONS.includes(
      input.schemaVersion as (typeof SUPPORTED_SCHEMA_VERSIONS)[number],
    )
  ) {
    return error(
      REJECTION_CODES.schemaVersionUnsupported,
      "/schemaVersion",
      `supported schemaVersions are ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
    );
  }

  let batchBytes: number;
  try {
    batchBytes = byteLength(input);
  } catch {
    return error(REJECTION_CODES.schemaInvalid, "$", "batch must be JSON serializable");
  }
  if (batchBytes > CONTRACT_LIMITS.maximumBatchBytes) {
    return error(
      REJECTION_CODES.batchTooLarge,
      "$",
      `batch exceeds ${CONTRACT_LIMITS.maximumBatchBytes} bytes`,
    );
  }

  if (
    Array.isArray(input.events) &&
    input.events.length > CONTRACT_LIMITS.maximumEventsPerBatch
  ) {
    return error(
      REJECTION_CODES.batchEventLimitExceeded,
      "/events",
      `batch exceeds ${CONTRACT_LIMITS.maximumEventsPerBatch} events`,
    );
  }

  const credentialLeak = findCredentialLeak(input);
  if (credentialLeak) {
    return error(
      REJECTION_CODES.credentialDataRejected,
      credentialLeak.split(":")[0] ?? "$",
      "credential-like data is forbidden",
    );
  }

  if (Array.isArray(input.events)) {
    for (const [index, event] of input.events.entries()) {
      const path = `/events/${index}`;
      if (byteLength(event) > CONTRACT_LIMITS.maximumEventBytes) {
        return error(
          REJECTION_CODES.eventTooLarge,
          path,
          `event exceeds ${CONTRACT_LIMITS.maximumEventBytes} bytes`,
        );
      }
      if (
        isRecord(event) &&
        typeof event.eventName === "string" &&
        !standardEventNames.has(event.eventName) &&
        !customEventName.test(event.eventName)
      ) {
        return error(
          REJECTION_CODES.eventNameInvalid,
          `${path}/eventName`,
          "eventName is not a standard or valid custom event name",
        );
      }
      if (
        isRecord(event) &&
        "operationInstanceId" in event &&
        (typeof event.operationInstanceId !== "string" ||
          !operationInstanceId.test(event.operationInstanceId))
      ) {
        return error(
          REJECTION_CODES.operationInstanceInvalid,
          `${path}/operationInstanceId`,
          "operationInstanceId must be an opaque SDK-generated identifier",
        );
      }
      if (
        input.schemaVersion === 3 &&
        isRecord(event) &&
        typeof event.eventName === "string" &&
        operationRequiredEvents.has(event.eventName) &&
        !("operationInstanceId" in event)
      ) {
        return error(
          REJECTION_CODES.operationInstanceInvalid,
          `${path}/operationInstanceId`,
          "operation lifecycle event requires operationInstanceId",
        );
      }
      if (isRecord(event) && typeof event.eventName === "string") {
        const requiredProperties = p1RequiredProperties[event.eventName];
        if (requiredProperties) {
          if (!isRecord(event.properties)) {
            return error(
              REJECTION_CODES.schemaInvalid,
              `${path}/properties`,
              "P1 summary properties must be an object",
            );
          }
          const properties = event.properties;
          const missing = requiredProperties.find((key) => !(key in properties));
          if (missing) {
            return error(
              REJECTION_CODES.schemaInvalid,
              `${path}/properties/${missing}`,
              "required P1 summary property is missing",
            );
          }
          if (event.eventName === "page_readiness" && "sampleRate" in properties) {
            return error(
              REJECTION_CODES.schemaInvalid,
              `${path}/properties/sampleRate`,
              "page_readiness requires independent first-screen and blank-detection sample rates",
            );
          }
        }
        if ("breadcrumbs" in event && !event.eventName.startsWith("error_")) {
          return error(
            REJECTION_CODES.schemaInvalid,
            `${path}/breadcrumbs`,
            "breadcrumbs are only allowed on error events",
          );
        }
      }
    }
  }

  if (!validateSchemaV3(input)) {
    return { ok: false, errors: schemaErrors(validateSchemaV3.errors) };
  }

  const batch = input as unknown as FrontendInsightEventBatch;

  const eventIds = new Set<string>();
  const maximumClockSkewMs =
    options.maximumClockSkewMs ?? CONTRACT_LIMITS.maximumClockSkewMs;

  for (const [index, event] of batch.events.entries()) {
    const path = `/events/${index}`;

    if (eventIds.has(event.eventId)) {
      return error(
        REJECTION_CODES.duplicateEventId,
        `${path}/eventId`,
        "eventId must be unique within a batch",
      );
    }
    eventIds.add(event.eventId);

    if (options.nowMs !== undefined) {
      const occurredAtMs = Date.parse(event.occurredAt);
      if (Math.abs(occurredAtMs - options.nowMs) > maximumClockSkewMs) {
        return error(
          REJECTION_CODES.eventTimeOutOfRange,
          `${path}/occurredAt`,
          "occurredAt is outside the accepted clock-skew window",
        );
      }
    }
  }

  return { ok: true, value: batch };
}
