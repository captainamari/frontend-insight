import { diagnosticBudgetError } from "./diagnostics.js";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import schemaV3 from "../schema/event-batch-v3.schema.json" with { type: "json" };
import {
  CONTRACT_LIMITS,
  DIAGNOSTIC_LIMITS,
  REJECTION_CODES,
  SUPPORTED_SCHEMA_VERSIONS,
  type RejectionCode,
} from "./constants.js";
import type { FrontendInsightEventBatchV3 } from "./generated/event-batch-v3.js";
import { findCredentialLeak, findEventCredentialLeak } from "./security.js";

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

  const { events: inputEvents, ...batchMetadata } = input;
  const credentialLeak =
    findCredentialLeak(batchMetadata) ||
    (Array.isArray(inputEvents)
      ? inputEvents
          .map((e) =>
            isRecord(e) ? findEventCredentialLeak(e) : findCredentialLeak(e),
          )
          .find(Boolean)
      : findCredentialLeak(inputEvents));
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
    if (
      event.payload.usageVersion &&
      event.event === "page_leave" &&
      (event.payload.usageSequence === undefined ||
        event.payload.usageClosed === undefined)
    ) {
      return {
        ok: false,
        errors: [
          {
            path,
            code: REJECTION_CODES.schemaInvalid,
            message: "usage settlement requires sequence and terminal flag",
          },
        ],
      };
    }
    if (event.payload.qualityVersion) {
      const p = event.payload;
      const required =
        event.event === "page_view"
          ? ["qualityMask", "qualitySampleRate"]
          : event.event === "page_leave"
            ? [
                "qualityMask",
                "qualitySampleRate",
                "qualitySequence",
                "qualityClosed",
                "qualityDropped",
                "qualityFailed",
                "qualitySuppressed",
                "apiStarted",
                "apiCompleted",
                "resourceStarted",
                "resourceCompleted",
                "resourceFailed",
                "longtaskCount",
                "longtaskTotal",
              ]
            : ["qualitySampleRate"];
      const invalid =
        required.some((key) => p[key] === undefined) ||
        (event.event === "api" &&
          (!p.apiRequestId ||
            (p.failureType === "http"
              ? !(Number(p.statusCode) >= 400 && p.success === false)
              : ["network", "timeout"].includes(String(p.failureType))
                ? !(p.statusCode === 0 && p.success === false)
                : p.failureType === "none"
                  ? !(
                      Number(p.statusCode) >= 100 &&
                      Number(p.statusCode) < 400 &&
                      p.success === true
                    )
                  : p.failureType === "aborted"
                    ? !(p.statusCode === 0 && p.success === false)
                    : true))) ||
        (event.event === "page_leave" &&
          (Number(p.apiCompleted) > Number(p.apiStarted) ||
            Number(p.resourceCompleted) > Number(p.resourceStarted) ||
            Number(p.resourceFailed) > Number(p.resourceCompleted))) ||
        (event.event === "performance" &&
          p.metric === "list_render_duration" &&
          (!p.sampleId || !p.rowBucket));
      if (invalid)
        return error(
          REJECTION_CODES.schemaInvalid,
          `${path}/payload`,
          "invalid quality fact relationship",
        );
    }
    if (
      event.event === "custom" &&
      event.payload.name === "form_summary" &&
      Number(event.payload.validationFailureCount) > Number(event.payload.submitCount)
    ) {
      return error(
        REJECTION_CODES.schemaInvalid,
        `${path}/payload`,
        "invalid counter relationship",
      );
    }
    if (event.event === "custom" && event.payload.businessAdapter) {
      const expected: Record<string, string[]> = {
        feature_started: [],
        feature_succeeded: ["success"],
        feature_canceled: ["canceled"],
        feature_failed: ["rejected", "technical_failure", "unknown"],
      };
      const outcomes = expected[String(event.payload.name)];
      if (
        !outcomes ||
        (event.payload.name === "feature_started"
          ? event.payload.businessResult !== undefined
          : !outcomes.includes(String(event.payload.businessResult)))
      )
        return error(
          REJECTION_CODES.schemaInvalid,
          `${path}/payload`,
          "invalid business outcome relationship",
        );
    }
    const { diagnostic, ...baseEvent } = event;
    if (diagnostic) {
      if (event.event !== "error" && event.event !== "api")
        return error(
          REJECTION_CODES.schemaInvalid,
          path,
          "diagnostic requires error or api event",
        );
      if (
        byteLength(diagnostic) > DIAGNOSTIC_LIMITS.maximumEnvelopeBytes ||
        diagnosticBudgetError(diagnostic)
      )
        return error(
          REJECTION_CODES.eventTooLarge,
          path,
          "diagnostic exceeds 65536 bytes",
        );
      if (
        ["rate_limited", "too_large", "unavailable"].includes(diagnostic.status) &&
        Object.keys(diagnostic.raw).length
      )
        return error(
          REJECTION_CODES.schemaInvalid,
          path,
          "unavailable diagnostic must not carry raw content",
        );
    }
    if (byteLength(baseEvent) > CONTRACT_LIMITS.maximumEventBytes) {
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
