import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import schemaV3 from "../schema/event-batch-v3.schema.json" with { type: "json" };
import {
  CONTRACT_LIMITS,
  REJECTION_CODES,
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
    message: item.message ?? "does not match contract v3",
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
  if (input.schemaVersion !== 3) {
    return error(
      REJECTION_CODES.schemaVersionUnsupported,
      "/schemaVersion",
      `supported schemaVersion is ${SUPPORTED_SCHEMA_VERSIONS[0]}`,
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
      "credential-like or direct identifying data is forbidden",
    );
  }

  if (!validateSchemaV3(input)) {
    return { ok: false, errors: schemaErrors(validateSchemaV3.errors) };
  }
  const batch = input as unknown as FrontendInsightEventBatchV3;
  const eventIds = new Set<string>();
  const context = batch.events[0]
    ? `${batch.events[0].appId}|${batch.events[0].env}`
    : "";
  const maximumClockSkewMs =
    options.maximumClockSkewMs ?? CONTRACT_LIMITS.maximumClockSkewMs;

  for (const [index, event] of batch.events.entries()) {
    const path = `/events/${index}`;
    if (byteLength(event) > CONTRACT_LIMITS.maximumEventBytes) {
      return error(
        REJECTION_CODES.eventTooLarge,
        path,
        `event exceeds ${CONTRACT_LIMITS.maximumEventBytes} bytes`,
      );
    }
    if (eventIds.has(event.eventId)) {
      return error(
        REJECTION_CODES.duplicateEventId,
        `${path}/eventId`,
        "eventId must be unique within a batch",
      );
    }
    eventIds.add(event.eventId);
    if (`${event.appId}|${event.env}` !== context) {
      return error(
        REJECTION_CODES.mixedEventContext,
        path,
        "one batch cannot mix appId or env",
      );
    }
    if (
      options.nowMs !== undefined &&
      Math.abs(event.timestamp - options.nowMs) > maximumClockSkewMs
    ) {
      return error(
        REJECTION_CODES.timestampOutOfRange,
        `${path}/timestamp`,
        "timestamp is outside the accepted clock-skew window",
      );
    }
  }
  return { ok: true, value: batch };
}
