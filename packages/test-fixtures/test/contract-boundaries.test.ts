import {
  REJECTION_CODES,
  validateForConsumer,
  validateForIngestion,
  validateForProducer,
  validateTransportBatch,
  type FrontendInsightEventBatchV3,
} from "@frontend-insight/event-contract";
import { describe, expect, it } from "vitest";
import invalidP1Privacy from "../fixtures/invalid/p1-privacy.json" with { type: "json" };
import validP1Collectors from "../fixtures/valid/p1-collectors.json" with { type: "json" };
import { contractScenarios } from "../src/index.js";

const boundaries = [validateForProducer, validateForIngestion, validateForConsumer];

describe("golden event scenarios", () => {
  for (const scenario of contractScenarios) {
    it(`${scenario.name} has identical producer, ingestion and consumer semantics`, () => {
      const nowMs = Date.parse(scenario.valid.sentAt);
      for (const validate of boundaries) {
        const result = validate(scenario.valid, { nowMs });
        expect(result.ok).toBe(true);
      }

      expect(scenario.valid.events).toHaveLength(scenario.golden.eventCount);
      expect(scenario.valid.events.map((event) => event.eventName)).toEqual(
        scenario.golden.eventNames,
      );
      if (scenario.golden.featureKey) {
        expect(
          scenario.valid.events.some(
            (event) => event.featureKey === scenario.golden.featureKey,
          ),
        ).toBe(true);
      }
    });

    it(`${scenario.name} invalid fixture is rejected at every boundary`, () => {
      for (const validate of boundaries) {
        const result = validate(scenario.invalid);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.errors[0]?.code).toBe(
            scenario.invalidRejectionCode ?? REJECTION_CODES.schemaInvalid,
          );
        }
      }
    });
  }
});

describe("contract limits and rejection codes", () => {
  const source = contractScenarios[0]!.valid;

  it("rejects unsupported versions before schema validation", () => {
    const batch = { ...structuredClone(source), schemaVersion: 99 };
    const result = validateTransportBatch(batch);
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.schemaVersionUnsupported }],
    });
  });

  it.each([1, 2])("rejects retired schema v%s", (schemaVersion) => {
    const batch = { ...structuredClone(source), schemaVersion };
    expect(validateTransportBatch(batch)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.schemaVersionUnsupported }],
    });
  });

  it("accepts v3 operations and constrained observability events", () => {
    expect(validateTransportBatch(contractScenarios[0]!.valid).ok).toBe(true);
    expect(validateTransportBatch(contractScenarios.at(-1)!.valid).ok).toBe(true);
    const operation = contractScenarios.find((item) => item.name === "operation_v2")!;
    const invalid = structuredClone(operation.valid);
    delete invalid.events[2]!.operationInstanceId;
    expect(validateTransportBatch(invalid)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.operationInstanceInvalid }],
    });
  });

  it("accepts every P1 event family and rejects forbidden breadcrumb detail", () => {
    expect(
      validateTransportBatch(validP1Collectors, {
        nowMs: Date.parse(validP1Collectors.sentAt),
      }).ok,
    ).toBe(true);
    expect(validateTransportBatch(invalidP1Privacy)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.credentialDataRejected }],
    });

    const legacyReadiness = structuredClone(validP1Collectors);
    const readiness = legacyReadiness.events.find(
      (event) => event.eventName === "page_readiness",
    )!;
    const properties = readiness.properties as Record<string, unknown>;
    delete properties.firstScreenSampleRate;
    delete properties.blankDetectionSampleRate;
    properties.sampleRate = 0.5;
    expect(validateTransportBatch(legacyReadiness)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.schemaInvalid }],
    });
  });

  it("rejects credential fields and values without returning their values", () => {
    const fieldBatch = structuredClone(source) as unknown as Record<string, unknown>;
    fieldBatch.authorization = "credential-value";
    const fieldResult = validateTransportBatch(fieldBatch);
    expect(fieldResult).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.credentialDataRejected }],
    });
    expect(JSON.stringify(fieldResult)).not.toContain("credential-value");

    const valueBatch = structuredClone(source);
    valueBatch.events[0]!.accountRef = "Bearer credential-value";
    const valueResult = validateTransportBatch(valueBatch);
    expect(valueResult).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.credentialDataRejected }],
    });

    for (const forbiddenValue of [
      "person@example.invalid",
      "token=credential-value",
      "/api/devices?token=credential-value",
      "/page#private-fragment",
    ]) {
      const privacyBatch = structuredClone(source);
      privacyBatch.events[0]!.properties = { note: forbiddenValue };
      const privacyResult = validateTransportBatch(privacyBatch);
      expect(privacyResult).toMatchObject({
        ok: false,
        errors: [{ code: REJECTION_CODES.credentialDataRejected }],
      });
      expect(JSON.stringify(privacyResult)).not.toContain(forbiddenValue);
    }
  });

  it("rejects duplicate event IDs and excessive event counts", () => {
    const duplicate = structuredClone(source);
    duplicate.events[1]!.eventId = duplicate.events[0]!.eventId;
    expect(validateTransportBatch(duplicate)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.duplicateEventId }],
    });

    const tooMany = structuredClone(source) as FrontendInsightEventBatchV3;
    tooMany.events = Array.from({ length: 51 }, (_, index) => ({
      ...structuredClone(source.events[0]!),
      eventId: `evt_batch_limit_${String(index).padStart(3, "0")}`,
    }));
    expect(validateTransportBatch(tooMany)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.batchEventLimitExceeded }],
    });
  });

  it("uses explicit rejection codes for event and batch byte limits", () => {
    const oversizedEvent = structuredClone(source);
    oversizedEvent.events[0]!.properties = { value: "x".repeat(9 * 1024) };
    expect(validateTransportBatch(oversizedEvent)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.eventTooLarge }],
    });

    const oversizedBatch = structuredClone(source) as FrontendInsightEventBatchV3;
    const denseProperties = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`property_${index}`, "x".repeat(256)]),
    );
    oversizedBatch.events = Array.from({ length: 20 }, (_, index) => ({
      ...structuredClone(source.events[0]!),
      eventId: `evt_batch_bytes_${String(index).padStart(3, "0")}`,
      properties: denseProperties,
    }));
    expect(validateTransportBatch(oversizedBatch)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.batchTooLarge }],
    });
  });

  it("rejects reserved event names and excessive custom properties", () => {
    const reservedName = structuredClone(source);
    reservedName.events[0]!.eventName = "feature_custom";
    expect(validateTransportBatch(reservedName)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.eventNameInvalid }],
    });

    const tooManyProperties = structuredClone(source);
    tooManyProperties.events[0]!.properties = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`property_${index}`, index]),
    );
    expect(validateTransportBatch(tooManyProperties)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.schemaInvalid }],
    });
  });

  it("rejects event times outside the configured 24-hour window", () => {
    const result = validateTransportBatch(source, {
      nowMs: Date.parse(source.sentAt) + 48 * 60 * 60 * 1000,
    });
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.eventTimeOutOfRange }],
    });
  });

  it("accepts a constrained custom event and rejects unknown fields", () => {
    const custom = structuredClone(source);
    custom.events[0]!.eventName = "report_filtered";
    expect(validateTransportBatch(custom).ok).toBe(true);

    const unknown = structuredClone(source) as unknown as Record<string, unknown>;
    unknown.debugPayload = true;
    const result = validateTransportBatch(unknown);
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.schemaInvalid }],
    });
  });
});
