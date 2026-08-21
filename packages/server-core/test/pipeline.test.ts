import { createHmac } from "node:crypto";
import type { FrontendInsightEventBatchV3 } from "@frontend-insight/event-contract";
import {
  contractScenarios,
  invalidLegacyBatches,
} from "@frontend-insight/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { KafkaEventEnvelope, ProjectIngestionConfig } from "../src/model.js";
import type { MySqlStore } from "../src/mysql-store.js";
import {
  IngestionManager,
  type EnvelopePublisher,
  type IngestionError,
} from "../src/pipeline.js";

const nowMs = Date.parse("2026-08-19T16:00:02.000Z");
const project: ProjectIngestionConfig = {
  id: "11111111-1111-4111-8111-111111111111",
  appId: "ops-admin",
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
      pageDefinitionId: null,
      isKeyTask: false,
      taskWeight: 1,
      taskTimeoutSeconds: 900,
      operationLifecycleEnabled: false,
      configurationEffectiveFrom: "2026-08-01T00:00:00.000Z",
      longViewSuccessAfterMs: 30_000,
      heartbeatIntervalMs: 60_000,
      launchedAt: null,
      status: "active",
    },
  ],
};

function fixture(): FrontendInsightEventBatchV3 {
  return structuredClone(contractScenarios[0]!.valid);
}

function featureFixture(name = "feature_exposed"): FrontendInsightEventBatchV3 {
  const source = fixture();
  source.events = [
    {
      ...source.events[0]!,
      eventId: "evt_feature000001",
      event: "custom",
      payload: { name, featureKey: "sales_dashboard" },
    },
  ];
  return source;
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
  const manager = new IngestionManager(
    store,
    { publish } as EnvelopePublisher,
    "h".repeat(32),
    { now: () => nowMs, maximumRequestsPerMinute: 2 },
  );
  return { manager, publish, markReceived, markRejected };
}

const context = {
  origin: "https://app.example.test",
  ip: "10.0.0.1",
  nowMs,
};

describe("contract v3 ingestion pipeline", () => {
  it("HMACs userId in-place before Kafka and retains no raw reference", async () => {
    const source = fixture();
    const rawUserId = source.events[0]!.userId!;
    const { manager, publish, markReceived } = setup();
    const result = await manager.accept(source, context);
    expect(result).toMatchObject({ acceptedEvents: 2, supportedSchemaVersions: [3] });
    const envelope = publish.mock.calls[0]![0];
    const expected = createHmac("sha256", "h".repeat(32))
      .update(`${project.id}:${rawUserId}`)
      .digest("hex");
    expect(envelope.batch.events[0]?.userId).toBe(expected);
    expect(envelope.enrichments[0]?.userId).toBe(expected);
    expect(JSON.stringify(envelope)).not.toContain(rawUserId);
    expect(markReceived).toHaveBeenCalledOnce();
  });

  it.each(invalidLegacyBatches)(
    "rejects legacy contract without normalization",
    async (legacy) => {
      const { manager, publish } = setup();
      await expect(manager.accept(legacy, context)).rejects.toMatchObject({
        code: "SCHEMA_VERSION_UNSUPPORTED",
        statusCode: 400,
      });
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("validates controlled feature stages from custom payload names", async () => {
    const { manager, publish } = setup();
    await manager.accept(featureFixture(), context);
    expect(publish).toHaveBeenCalledOnce();

    const longView = featureFixture("feature_long_view_started");
    await expect(manager.accept(longView, context)).rejects.toMatchObject({
      code: "FEATURE_STAGE_INVALID",
      statusCode: 400,
    });
  });

  it.each([
    ["https://evil.example.test", "ORIGIN_NOT_ALLOWED"],
    [undefined, "ORIGIN_NOT_ALLOWED"],
  ])("rejects a disallowed origin before publishing", async (origin, code) => {
    const { manager, publish, markRejected } = setup();
    await expect(
      manager.accept(fixture(), { ...context, origin }),
    ).rejects.toMatchObject({
      code,
      statusCode: 403,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(markRejected).toHaveBeenCalledOnce();
  });

  it("returns a stable 503 only when Kafka persistence fails", async () => {
    const { manager } = setup({ publishError: true });
    await expect(manager.accept(fixture(), context)).rejects.toEqual(
      expect.objectContaining<Partial<IngestionError>>({
        code: "KAFKA_UNAVAILABLE",
        statusCode: 503,
      }),
    );
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
