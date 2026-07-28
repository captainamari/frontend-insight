import { createHmac } from "node:crypto";
import type { FrontendInsightEventBatchV1 } from "@frontend-insight/event-contract";
import { contractScenarios } from "@frontend-insight/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { KafkaEventEnvelope, ProjectIngestionConfig } from "../src/model.js";
import type { MySqlStore } from "../src/mysql-store.js";
import {
  IngestionManager,
  type EnvelopePublisher,
  type IngestionError,
} from "../src/pipeline.js";

const nowMs = Date.parse("2026-07-19T17:10:00.000Z");
const project: ProjectIngestionConfig = {
  id: "11111111-1111-4111-8111-111111111111",
  projectKey: "fi_public_m1demo001",
  name: "Fixture",
  timezone: "UTC",
  status: "active",
  retentionDays: 90,
  origins: ["https://app.example.test"],
  features: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      projectId: "11111111-1111-4111-8111-111111111111",
      featureKey: "sales_dashboard",
      name: "Sales dashboard",
      description: null,
      featureType: "data_view",
      longViewSuccessAfterMs: 30_000,
      heartbeatIntervalMs: 60_000,
      launchedAt: null,
      status: "active",
    },
  ],
};

function fixture(): FrontendInsightEventBatchV1 {
  return structuredClone(contractScenarios[0]!.valid);
}

function setup(
  options: { publishError?: boolean; projectOverride?: ProjectIngestionConfig } = {},
) {
  const markReceived = vi.fn(async () => {});
  const markRejected = vi.fn(async () => {});
  const store = {
    getIngestionProject: vi.fn(async () => options.projectOverride ?? project),
    markReceived,
    markRejected,
  } as unknown as MySqlStore;
  const publish = vi.fn(async (_envelope: KafkaEventEnvelope) => {
    void _envelope;
    if (options.publishError) throw new Error("offline");
  });
  const publisher = { publish } as EnvelopePublisher;
  const manager = new IngestionManager(store, publisher, "h".repeat(32), {
    now: () => nowMs,
    maximumRequestsPerMinute: 2,
  });
  return { manager, publish, markReceived, markRejected };
}

const context = {
  origin: "https://app.example.test",
  ip: "10.0.0.1",
  nowMs,
};

describe("ingestion pipeline", () => {
  it("HMACs account references and removes them before Kafka", async () => {
    const { manager, publish, markReceived } = setup();
    const result = await manager.accept(fixture(), context);
    expect(result.acceptedEvents).toBe(3);
    const envelope = publish.mock.calls[0]![0];
    expect(envelope.batch.events.every((event) => event.accountRef === undefined)).toBe(
      true,
    );
    expect(envelope.enrichments[0]?.accountId).toBe(
      createHmac("sha256", "h".repeat(32))
        .update(`${project.id}:opaque-account-001`)
        .digest("hex"),
    );
    expect(JSON.stringify(envelope)).not.toContain("opaque-account-001");
    expect(markReceived).toHaveBeenCalledOnce();
    expect(manager.getMetrics()).toMatchObject({ requests: 1, acceptedEvents: 3 });
  });

  it.each([
    [
      "origin",
      { ...context, origin: "https://evil.example.test" },
      "ORIGIN_NOT_ALLOWED",
    ],
    ["missing origin", { ...context, origin: undefined }, "ORIGIN_NOT_ALLOWED"],
  ])("rejects %s before publishing", async (_name, requestContext, code) => {
    const { manager, publish, markRejected } = setup();
    await expect(manager.accept(fixture(), requestContext)).rejects.toMatchObject({
      code,
      statusCode: 403,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(markRejected).toHaveBeenCalledOnce();
  });

  it("rejects a stage that is invalid for the registered feature type", async () => {
    const { manager } = setup();
    const batch = fixture();
    batch.events[1]!.eventName = "feature_started";
    await expect(manager.accept(batch, context)).rejects.toMatchObject({
      code: "FEATURE_STAGE_INVALID",
      statusCode: 400,
    });
  });

  it("returns a stable 503 only when Kafka persistence fails", async () => {
    const { manager } = setup({ publishError: true });
    await expect(manager.accept(fixture(), context)).rejects.toEqual(
      expect.objectContaining<Partial<IngestionError>>({
        code: "KAFKA_UNAVAILABLE",
        statusCode: 503,
      }),
    );
    expect(manager.getMetrics().kafkaFailures).toBe(1);
  });

  it("rejects malformed project keys before touching the project cache", async () => {
    const { manager, publish } = setup();
    const batch = fixture();
    batch.projectKey = "fi_public_short";
    await expect(manager.accept(batch, context)).rejects.toMatchObject({
      code: "PROJECT_KEY_INVALID",
      statusCode: 400,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(manager.getMetrics()).toMatchObject({ requests: 1, rejectedEvents: 3 });
  });

  it("accounts for over-size rejections in operational metrics", async () => {
    const { manager } = setup();
    await expect(
      manager.accept({ ...fixture(), padding: "x".repeat(70 * 1024) }, context),
    ).rejects.toMatchObject({ code: "BATCH_TOO_LARGE", statusCode: 413 });
    expect(manager.getMetrics().rejectionCodes.BATCH_TOO_LARGE).toBe(1);
  });

  it("enforces the project, origin and IP rate-limit key", async () => {
    const { manager } = setup();
    await manager.accept(fixture(), context);
    await manager.accept(fixture(), context);
    await expect(manager.accept(fixture(), context)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
    });
  });
});
