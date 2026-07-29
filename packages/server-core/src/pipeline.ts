import { createHmac, randomUUID } from "node:crypto";
import {
  SUPPORTED_SCHEMA_VERSIONS,
  validateForIngestion,
  type FrontendInsightEventBatch,
} from "@frontend-insight/event-contract";
import { Kafka, logLevel, type Producer } from "kafkajs";
import type { MySqlStore } from "./mysql-store.js";
import type {
  EventEnrichment,
  FeatureRecord,
  KafkaEventEnvelope,
  ProjectIngestionConfig,
} from "./model.js";

export class IngestionError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "IngestionError";
  }
}

export interface IngestionContext {
  origin: string | undefined;
  ip: string;
  nowMs?: number;
  contentLength?: number;
}

export interface IngestionAcceptance {
  requestId: string;
  acceptedEvents: number;
  supportedSchemaVersions: readonly number[];
}

export interface EnvelopePublisher {
  publish(envelope: KafkaEventEnvelope): Promise<void>;
}

export interface IngestionMetricsSnapshot {
  requests: number;
  acceptedEvents: number;
  rejectedEvents: number;
  kafkaFailures: number;
  rejectionCodes: Readonly<Record<string, number>>;
  latencyP95Ms: number;
}

export class KafkaEnvelopePublisher implements EnvelopePublisher {
  private readonly producer: Producer;
  private connected = false;

  constructor(
    brokers: string[],
    private readonly topic: string,
  ) {
    this.producer = new Kafka({
      clientId: "frontend-insight-api",
      brokers,
      logLevel: logLevel.NOTHING,
    }).producer({ allowAutoTopicCreation: false, idempotent: true });
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) await this.producer.disconnect();
    this.connected = false;
  }

  async publish(envelope: KafkaEventEnvelope): Promise<void> {
    await this.connect();
    await this.producer.send({
      topic: this.topic,
      acks: -1,
      messages: [
        {
          key: envelope.projectId,
          value: JSON.stringify(envelope),
          headers: {
            requestId: envelope.requestId,
            envelopeVersion: "1",
          },
        },
      ],
    });
  }
}

class IngestionRateLimiter {
  private readonly entries = new Map<string, { count: number; startedAt: number }>();

  constructor(
    private readonly maximumPerMinute: number,
    private readonly now: () => number,
  ) {}

  take(key: string): boolean {
    const timestamp = this.now();
    if (this.entries.size > 10_000) {
      for (const [candidate, value] of this.entries) {
        if (timestamp - value.startedAt >= 60_000) this.entries.delete(candidate);
      }
    }
    const current = this.entries.get(key);
    if (!current || timestamp - current.startedAt >= 60_000) {
      this.entries.set(key, { count: 1, startedAt: timestamp });
      return true;
    }
    if (current.count >= this.maximumPerMinute) return false;
    current.count += 1;
    return true;
  }
}

const stageByFeatureType: Record<string, ReadonlySet<string>> = {
  data_view: new Set([
    "feature_exposed",
    "feature_started",
    "feature_succeeded",
    "feature_failed",
    "feature_canceled",
  ]),
  action: new Set([
    "feature_exposed",
    "feature_started",
    "feature_succeeded",
    "feature_failed",
    "feature_canceled",
  ]),
  long_view: new Set([
    "feature_exposed",
    "feature_succeeded",
    "feature_failed",
    "feature_long_view_started",
    "feature_long_view_heartbeat",
    "feature_long_view_ended",
  ]),
};
const operationLifecycleEvents = new Set([
  "feature_started",
  "feature_succeeded",
  "feature_failed",
  "feature_canceled",
]);

interface CachedProject {
  expiresAt: number;
  project: ProjectIngestionConfig | null;
}

export class IngestionManager {
  private readonly cache = new Map<string, CachedProject>();
  private readonly limiter: IngestionRateLimiter;
  private readonly latencySamples: number[] = [];
  private readonly metrics = {
    requests: 0,
    acceptedEvents: 0,
    rejectedEvents: 0,
    kafkaFailures: 0,
    rejectionCodes: new Map<string, number>(),
  };

  constructor(
    private readonly store: MySqlStore,
    private readonly publisher: EnvelopePublisher,
    private readonly accountHmacKey: string,
    private readonly options: {
      projectCacheTtlMs?: number;
      maximumRequestsPerMinute?: number;
      now?: () => number;
    } = {},
  ) {
    if (accountHmacKey.length < 32) throw new Error("ACCOUNT_HMAC_KEY_TOO_SHORT");
    this.limiter = new IngestionRateLimiter(
      options.maximumRequestsPerMinute ?? 600,
      options.now ?? Date.now,
    );
  }

  invalidateProject(projectKey: string): void {
    this.cache.delete(projectKey);
  }

  getMetrics(): IngestionMetricsSnapshot {
    const sorted = [...this.latencySamples].sort((left, right) => left - right);
    return {
      requests: this.metrics.requests,
      acceptedEvents: this.metrics.acceptedEvents,
      rejectedEvents: this.metrics.rejectedEvents,
      kafkaFailures: this.metrics.kafkaFailures,
      rejectionCodes: Object.fromEntries(this.metrics.rejectionCodes),
      latencyP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    };
  }

  async accept(
    input: unknown,
    context: IngestionContext,
  ): Promise<IngestionAcceptance> {
    const startedAt = performance.now();
    this.metrics.requests += 1;
    const nowMs = context.nowMs ?? (this.options.now ?? Date.now)();
    let project: ProjectIngestionConfig | null = null;
    let eventCount =
      typeof input === "object" && input !== null && "events" in input
        ? Array.isArray((input as { events: unknown }).events)
          ? (input as { events: unknown[] }).events.length
          : 1
        : 1;
    try {
      const serialized = JSON.stringify(input);
      const rawBytes = new TextEncoder().encode(serialized).byteLength;
      if ((context.contentLength ?? rawBytes) > 64 * 1024 || rawBytes > 64 * 1024) {
        throw new IngestionError("BATCH_TOO_LARGE", 413);
      }
      const projectKey =
        typeof input === "object" && input !== null && "projectKey" in input
          ? String((input as { projectKey: unknown }).projectKey)
          : "";
      if (!/^fi_public_[A-Za-z0-9_-]{8,64}$/.test(projectKey)) {
        throw new IngestionError("PROJECT_KEY_INVALID", 400);
      }
      project = await this.project(projectKey, nowMs);
      if (!project) throw new IngestionError("PROJECT_NOT_FOUND", 404);
      this.assertProject(project, context);
      const rateKey = `${project.id}:${context.origin ?? "no-origin"}:${context.ip}`;
      if (!this.limiter.take(rateKey)) throw new IngestionError("RATE_LIMITED", 429);
      const validation = validateForIngestion(input, { nowMs });
      if (!validation.ok) {
        throw new IngestionError(validation.errors[0]?.code ?? "SCHEMA_INVALID", 400, {
          path: validation.errors[0]?.path,
        });
      }
      const { batch, enrichments } = this.sanitize(project, validation.value);
      const requestId = randomUUID();
      const envelope: KafkaEventEnvelope = {
        envelopeVersion: 1,
        projectId: project.id,
        receivedAt: new Date(nowMs).toISOString(),
        requestId,
        origin: context.origin ?? "",
        batch,
        enrichments,
      };
      try {
        await this.publisher.publish(envelope);
      } catch {
        this.metrics.kafkaFailures += 1;
        throw new IngestionError("KAFKA_UNAVAILABLE", 503);
      }
      await this.store
        .markReceived({
          projectId: project.id,
          requestId,
          sdkVersion: batch.sdk.version,
          eventCount: batch.events.length,
        })
        .catch(() => {});
      this.metrics.acceptedEvents += batch.events.length;
      return {
        requestId,
        acceptedEvents: batch.events.length,
        supportedSchemaVersions: SUPPORTED_SCHEMA_VERSIONS,
      };
    } catch (cause) {
      const error =
        cause instanceof IngestionError
          ? cause
          : new IngestionError("INGESTION_INTERNAL_ERROR", 500);
      eventCount = Math.min(eventCount, 50);
      this.metrics.rejectedEvents += eventCount;
      this.metrics.rejectionCodes.set(
        error.code,
        (this.metrics.rejectionCodes.get(error.code) ?? 0) + 1,
      );
      if (project) {
        await this.store
          .markRejected(project.id, error.code, eventCount)
          .catch(() => {});
      }
      throw error;
    } finally {
      this.latencySamples.push(performance.now() - startedAt);
      if (this.latencySamples.length > 1_000) this.latencySamples.shift();
    }
  }

  private async project(
    projectKey: string,
    nowMs: number,
  ): Promise<ProjectIngestionConfig | null> {
    if (!projectKey) return null;
    const cached = this.cache.get(projectKey);
    if (cached && cached.expiresAt > nowMs) return cached.project;
    const project = await this.store.getIngestionProject(projectKey);
    if (this.cache.size >= 1_000) {
      for (const [candidate, value] of this.cache) {
        if (value.expiresAt <= nowMs) this.cache.delete(candidate);
      }
      if (this.cache.size >= 1_000) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(projectKey, {
      project,
      expiresAt: nowMs + (this.options.projectCacheTtlMs ?? 30_000),
    });
    return project;
  }

  private assertProject(
    project: ProjectIngestionConfig,
    context: IngestionContext,
  ): void {
    if (project.status !== "active") throw new IngestionError("PROJECT_DISABLED", 403);
    if (!context.origin || !project.origins.includes(context.origin)) {
      throw new IngestionError("ORIGIN_NOT_ALLOWED", 403);
    }
  }

  private sanitize(
    project: ProjectIngestionConfig,
    source: FrontendInsightEventBatch,
  ): { batch: FrontendInsightEventBatch; enrichments: EventEnrichment[] } {
    const features = new Map(
      project.features.map((feature) => [feature.featureKey, feature]),
    );
    const enrichments: EventEnrichment[] = [];
    const events = source.events.map((sourceEvent) => {
      const event = structuredClone(sourceEvent);
      const feature = event.featureKey ? features.get(event.featureKey) : undefined;
      const operationInstanceId =
        "operationInstanceId" in event && typeof event.operationInstanceId === "string"
          ? event.operationInstanceId
          : undefined;
      if (event.featureKey) {
        this.assertFeature(
          event.eventName,
          feature,
          source.schemaVersion,
          operationInstanceId,
        );
      }
      const accountId = event.accountRef
        ? createHmac("sha256", this.accountHmacKey)
            .update(`${project.id}:${event.accountRef}`)
            .digest("hex")
        : null;
      delete event.accountRef;
      enrichments.push({
        eventId: event.eventId,
        accountId,
        featureId: feature?.id ?? null,
      });
      return event;
    });
    return {
      batch: {
        ...source,
        events,
      } as FrontendInsightEventBatch,
      enrichments,
    };
  }

  private assertFeature(
    eventName: string,
    feature: FeatureRecord | undefined,
    schemaVersion: number,
    operationInstanceId: string | undefined,
  ): void {
    if (!feature) throw new IngestionError("FEATURE_NOT_FOUND", 400);
    if (feature.status !== "active") throw new IngestionError("FEATURE_DISABLED", 403);
    if (!stageByFeatureType[feature.featureType]?.has(eventName)) {
      throw new IngestionError("FEATURE_STAGE_INVALID", 400, {
        featureType: feature.featureType,
        eventName,
      });
    }
    if (
      schemaVersion === 2 &&
      feature.operationLifecycleEnabled &&
      feature.featureType !== "long_view" &&
      operationLifecycleEvents.has(eventName) &&
      !operationInstanceId
    ) {
      throw new IngestionError("OPERATION_INSTANCE_REQUIRED", 400, {
        featureType: feature.featureType,
        eventName,
      });
    }
  }
}
