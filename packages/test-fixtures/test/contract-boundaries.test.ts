import {
  REJECTION_CODES,
  validateForConsumer,
  validateForIngestion,
  validateForProducer,
  validateTransportBatch,
} from "@frontend-insight/event-contract";
import { describe, expect, it } from "vitest";
import {
  contractScenarios,
  invalidLegacyBatches,
  invalidPrivacyBatch,
} from "../src/index.js";

describe("contract v3 boundaries", () => {
  it.each(contractScenarios)(
    "accepts the canonical $name fixture at producer, ingestion and consumer",
    ({ valid, golden }) => {
      expect(validateForProducer(valid).ok).toBe(true);
      expect(validateForIngestion(valid).ok).toBe(true);
      expect(validateForConsumer(valid).ok).toBe(true);
      expect(valid.events.map((item) => item.event)).toEqual(golden.events);
      expect(valid.events).toHaveLength(golden.eventCount);
      if (golden.customEvents) {
        expect(valid.events.map((item) => item.payload.name)).toEqual(
          golden.customEvents,
        );
      }
    },
  );

  it.each(contractScenarios)(
    "rejects the paired $name legacy or alias fixture",
    ({ invalid, invalidRejectionCode }) => {
      const result = validateTransportBatch(invalid);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]?.code).toBe(invalidRejectionCode);
    },
  );

  it.each(invalidLegacyBatches)("rejects v1 and v2 without normalization", (legacy) => {
    expect(validateTransportBatch(legacy)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.schemaVersionUnsupported }],
    });
  });

  it("rejects direct identifiers and credential-like values", () => {
    expect(validateTransportBatch(invalidPrivacyBatch)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.credentialDataRejected }],
    });
  });

  it("requires every event to carry the complete canonical context", () => {
    const source = structuredClone(contractScenarios[0]!.valid);
    const incomplete = source.events[0] as unknown as Record<string, unknown>;
    delete incomplete.env;
    const result = validateTransportBatch(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe(REJECTION_CODES.schemaInvalid);
  });

  it("does not allow one batch to mix appId or env", () => {
    const source = structuredClone(contractScenarios[0]!.valid);
    source.events[1]!.env = "staging";
    expect(validateTransportBatch(source)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.mixedEventContext }],
    });
  });

  it("rejects duplicate event IDs and oversized payload values", () => {
    const duplicate = structuredClone(contractScenarios[0]!.valid);
    duplicate.events[1]!.eventId = duplicate.events[0]!.eventId;
    expect(validateTransportBatch(duplicate)).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.duplicateEventId }],
    });

    const oversized = structuredClone(contractScenarios[2]!.valid);
    const labels = (oversized.events[0]!.payload.labels ??= {});
    labels.oversized = "x".repeat(257);
    const result = validateTransportBatch(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe(REJECTION_CODES.schemaInvalid);
  });

  it("validates epoch-millisecond clock skew", () => {
    const source = structuredClone(contractScenarios[0]!.valid);
    const result = validateTransportBatch(source, {
      nowMs: source.events[0]!.timestamp + 2 * 24 * 60 * 60 * 1000,
      maximumClockSkewMs: 24 * 60 * 60 * 1000,
    });
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: REJECTION_CODES.timestampOutOfRange }],
    });
  });
});
