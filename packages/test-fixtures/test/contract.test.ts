import { describe, it, expect } from "vitest";
import {
  validateForProducer,
  validateForIngestion,
  validateForConsumer,
  validateTransportBatch,
} from "@frontend-insight/event-contract";
import { contractScenarios } from "../src/index.js";
describe("R4-B workflow privacy and association tuples", () => {
  const workflow = contractScenarios.find((s) =>
    s.valid.events.some((e) => e.payload.name === "workflow_started"),
  )!.valid;
  it.each([
    "labels",
    "reasonCode",
    "featureKey",
    "visibleDurationMs",
    "businessId",
    "token",
    "cookie",
    "body",
    "query",
    "domText",
  ])("rejects workflow field %s at every boundary", (key) => {
    const batch = structuredClone(workflow);
    Object.assign(batch.events[0]!.payload, {
      [key]: key === "labels" ? { private: "FI_PRIVATE" } : "FI_PRIVATE",
    });
    expect(validateForProducer(batch).ok).toBe(false);
    expect(validateForIngestion(batch).ok).toBe(false);
    expect(validateForConsumer(batch).ok).toBe(false);
  });
  it("rejects missing instance association and caller business identifiers", () => {
    const batch = structuredClone(workflow);
    delete batch.events[1]!.payload.workflowInstanceId;
    expect(validateTransportBatch(batch).ok).toBe(false);
    batch.events[1]!.payload.workflowInstanceId = "customer-123";
    expect(validateTransportBatch(batch).ok).toBe(false);
  });
});
