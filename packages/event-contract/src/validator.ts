import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import schema from "../schema/event-batch.schema.json" with { type: "json" };
import {
  CONTRACT_LIMITS,
  CURRENT_SCHEMA_VERSION,
  REJECTION_CODES,
  STANDARD_EVENT_NAMES,
  type RejectionCode,
} from "./constants.js";
import type { FrontendInsightEventBatchV1 } from "./generated/event-batch.js";
import { findCredentialLeak } from "./security.js";

export interface ContractValidationError {
  code: RejectionCode;
  path: string;
  message: string;
}

export type ContractValidationResult =
  | { ok: true; value: FrontendInsightEventBatchV1 }
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
const validateSchema = ajv.compile<FrontendInsightEventBatchV1>(schema);

const standardEventNames = new Set<string>(STANDARD_EVENT_NAMES);
const customEventName = /^(?!page_|feature_)[a-z][a-z0-9_]{0,63}$/;

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

  if (input.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return error(
      REJECTION_CODES.schemaVersionUnsupported,
      "/schemaVersion",
      `supported schemaVersion is ${CURRENT_SCHEMA_VERSION}`,
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
    }
  }

  if (!validateSchema(input)) {
    return { ok: false, errors: schemaErrors(validateSchema.errors) };
  }

  const batch = input as unknown as FrontendInsightEventBatchV1;

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
      const eventTimeMs = Date.parse(event.eventTime);
      if (Math.abs(eventTimeMs - options.nowMs) > maximumClockSkewMs) {
        return error(
          REJECTION_CODES.eventTimeOutOfRange,
          `${path}/eventTime`,
          "eventTime is outside the accepted clock-skew window",
        );
      }
    }
  }

  return { ok: true, value: batch };
}
