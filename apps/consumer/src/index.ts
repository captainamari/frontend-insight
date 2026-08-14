import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { validateForConsumer } from "@frontend-insight/event-contract";
import {
  MySqlStore,
  type EventEnrichment,
  type KafkaEventEnvelope,
} from "@frontend-insight/server-core";
import {
  loadConsumerEnvironment,
  type ConsumerEnvironment,
} from "@frontend-insight/shared-config";
import {
  Kafka,
  logLevel,
  type Consumer,
  type EachBatchPayload,
  type Producer,
} from "kafkajs";

interface ConsumerMetrics {
  ready: boolean;
  processedEvents: number;
  insertedBatches: number;
  retries: number;
  deadLetters: number;
  lag: number;
  lastErrorCode: string | null;
}

function clickHouseTimestamp(value: string): string {
  return new Date(value).toISOString().replace("T", " ").replace("Z", "");
}

function errorCode(cause: unknown): string {
  if (cause instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(cause.message)) {
    return cause.message;
  }
  return "CONSUMER_PROCESSING_FAILED";
}

function propertyString(
  properties: Record<string, unknown>,
  key: string,
): string | null {
  return typeof properties[key] === "string" ? String(properties[key]) : null;
}

function propertyNumber(
  properties: Record<string, unknown>,
  key: string,
): number | null {
  const value = properties[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedErrorMessage(value: string | null): string {
  return (value ?? "")
    .replace(/\b\d{3,}\b/g, ":number")
    .replace(/\b[0-9a-f]{8,}\b/gi, ":hex")
    .replace(/["'][^"']{8,}["']/g, '":value"')
    .slice(0, 256);
}

function normalizedStackFrame(value: string | null): string {
  return (value ?? "")
    .replace(/:\d+:\d+(?=\)?$)/, ":line:column")
    .replace(/([._-])[0-9a-f]{8,}(?=\.(?:js|mjs|css)\b)/gi, "$1:hash")
    .replace(/\b[0-9a-f]{12,}\b/gi, ":hash")
    .slice(0, 256);
}

export function observabilityGroupId(
  eventName: string,
  properties: Record<string, unknown>,
): string | null {
  if (!eventName.startsWith("error_")) return null;
  const status = propertyNumber(properties, "statusCode");
  const statusClass = status === null ? "" : `${Math.floor(status / 100)}xx`;
  const canonical = [
    eventName,
    propertyString(properties, "errorName"),
    normalizedErrorMessage(propertyString(properties, "errorMessage")),
    normalizedStackFrame(propertyString(properties, "stackTopFrame")),
    propertyString(properties, "resourceType"),
    propertyString(properties, "requestMethod"),
    propertyString(properties, "requestPath"),
    statusClass,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export class EventConsumerRuntime {
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private readonly dlqProducer: Producer;
  private readonly clickhouse: ClickHouseClient;
  private readonly mysql: MySqlStore;
  private readonly attempts = new Map<string, number>();
  private healthServer: Server | undefined;
  readonly metrics: ConsumerMetrics = {
    ready: false,
    processedEvents: 0,
    insertedBatches: 0,
    retries: 0,
    deadLetters: 0,
    lag: 0,
    lastErrorCode: null,
  };

  constructor(private readonly environment: ConsumerEnvironment) {
    this.kafka = new Kafka({
      clientId: "frontend-insight-consumer",
      brokers: environment.KAFKA_BROKERS,
      logLevel: logLevel.NOTHING,
    });
    this.consumer = this.kafka.consumer({
      groupId: environment.CONSUMER_GROUP_ID,
      allowAutoTopicCreation: false,
      maxWaitTimeInMs: environment.CONSUMER_FLUSH_TIMEOUT_MS,
      retry: { retries: environment.CONSUMER_MAX_RETRIES },
    });
    this.dlqProducer = this.kafka.producer({ allowAutoTopicCreation: false });
    this.clickhouse = createClient({
      url: environment.CLICKHOUSE_URL,
      username: environment.CLICKHOUSE_USERNAME,
      password: environment.CLICKHOUSE_PASSWORD,
      database: environment.CLICKHOUSE_DATABASE,
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
    this.mysql = new MySqlStore(environment.MYSQL_URL);
  }

  async start(): Promise<void> {
    this.startHealthServer();
    await Promise.all([this.consumer.connect(), this.dlqProducer.connect()]);
    await this.consumer.subscribe({
      topic: this.environment.KAFKA_EVENTS_TOPIC,
      fromBeginning: true,
    });
    this.metrics.ready = true;
    await this.consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: (payload) => this.eachBatch(payload),
    });
  }

  async stop(): Promise<void> {
    this.metrics.ready = false;
    await this.consumer.stop().catch(() => {});
    await Promise.allSettled([
      this.consumer.disconnect(),
      this.dlqProducer.disconnect(),
      this.clickhouse.close(),
      this.mysql.close(),
      new Promise<void>((resolve) => {
        if (!this.healthServer) return resolve();
        this.healthServer.close(() => resolve());
      }),
    ]);
  }

  private async eachBatch(payload: EachBatchPayload): Promise<void> {
    const {
      batch,
      resolveOffset,
      heartbeat,
      commitOffsetsIfNecessary,
      isRunning,
      pause,
    } = payload;
    const messages = batch.messages.slice(0, this.environment.CONSUMER_BATCH_SIZE);
    const attemptKey = `${batch.topic}:${batch.partition}:${messages[0]?.offset ?? "empty"}`;
    try {
      const envelopes: KafkaEventEnvelope[] = [];
      const rows: unknown[] = [];
      const acceptedMessages: typeof messages = [];
      for (const message of messages) {
        try {
          const envelope = this.parseEnvelope(message.value);
          rows.push(...this.rows(envelope));
          envelopes.push(envelope);
          acceptedMessages.push(message);
        } catch (cause) {
          await this.deadLetter(message.value, {
            topic: batch.topic,
            partition: batch.partition,
            offset: message.offset,
            code: errorCode(cause),
          });
          resolveOffset(message.offset);
        }
      }
      if (rows.length) {
        await this.clickhouse.insert({
          table: "raw_events",
          values: rows,
          format: "JSONEachRow",
        });
      }
      for (const envelope of envelopes) {
        await this.mysql.markIngested(envelope.projectId, envelope.receivedAt);
      }
      for (const message of acceptedMessages) resolveOffset(message.offset);
      await commitOffsetsIfNecessary();
      await heartbeat();
      this.attempts.delete(attemptKey);
      this.metrics.processedEvents += rows.length;
      this.metrics.insertedBatches += 1;
      this.metrics.lastErrorCode = null;
      this.metrics.lag = Math.max(
        0,
        Number(batch.highWatermark) - Number(messages.at(-1)?.offset ?? 0) - 1,
      );
    } catch (cause) {
      const attempts = (this.attempts.get(attemptKey) ?? 0) + 1;
      this.attempts.set(attemptKey, attempts);
      this.metrics.retries += 1;
      this.metrics.lastErrorCode = errorCode(cause);
      if (!isRunning()) return;
      if (attempts < this.environment.CONSUMER_MAX_RETRIES) throw cause;
      this.metrics.ready = false;
      const resume = pause();
      setTimeout(() => {
        this.attempts.delete(attemptKey);
        this.metrics.ready = true;
        resume();
      }, this.environment.CONSUMER_RETRY_PAUSE_MS);
      await heartbeat();
    }
  }

  private parseEnvelope(value: Buffer | null): KafkaEventEnvelope {
    if (!value) throw new Error("KAFKA_MESSAGE_EMPTY");
    let parsed: KafkaEventEnvelope;
    try {
      parsed = JSON.parse(value.toString("utf8")) as KafkaEventEnvelope;
    } catch {
      throw new Error("KAFKA_ENVELOPE_INVALID");
    }
    if (parsed.envelopeVersion !== 1 || !parsed.projectId || !parsed.requestId) {
      throw new Error("KAFKA_ENVELOPE_INVALID");
    }
    const validation = validateForConsumer(parsed.batch);
    if (!validation.ok) throw new Error("KAFKA_EVENT_CONTRACT_INVALID");
    if (validation.value.events.some((event) => event.accountRef !== undefined)) {
      throw new Error("RAW_ACCOUNT_REF_AFTER_INGESTION");
    }
    return parsed;
  }

  private rows(envelope: KafkaEventEnvelope) {
    const enrichments = new Map(
      envelope.enrichments.map((item) => [item.eventId, item] as const),
    );
    return envelope.batch.events.map((event) => {
      const enrichment: EventEnrichment | undefined = enrichments.get(event.eventId);
      if (!enrichment) throw new Error("EVENT_ENRICHMENT_MISSING");
      const properties = event.properties as Record<string, unknown>;
      const errorGroupId = observabilityGroupId(event.eventName, properties);
      return {
        event_id: event.eventId,
        schema_version: envelope.batch.schemaVersion,
        sdk_name: envelope.batch.sdk.name,
        sdk_version: envelope.batch.sdk.version,
        project_id: envelope.projectId,
        event_name: event.eventName,
        event_time: clickHouseTimestamp(event.occurredAt),
        received_at: clickHouseTimestamp(envelope.receivedAt),
        visitor_id: event.visitorId,
        session_id: event.sessionId,
        page_view_id: event.pageViewId,
        account_id: enrichment.accountId,
        feature_id: enrichment.featureId,
        feature_key: event.featureKey ?? null,
        feature_stage: event.eventName.startsWith("feature_")
          ? event.eventName.slice("feature_".length)
          : null,
        operation_instance_id:
          "operationInstanceId" in event ? (event.operationInstanceId ?? null) : null,
        interaction_type:
          "interactionType" in event ? (event.interactionType ?? null) : null,
        release_version: event.releaseVersion,
        deployment_environment: event.deploymentEnvironment,
        browser_family: propertyString(properties, "browserFamily"),
        os_family: propertyString(properties, "osFamily"),
        viewport_bucket: propertyString(properties, "viewportBucket"),
        error_type: event.eventName.startsWith("error_")
          ? event.eventName.slice("error_".length)
          : null,
        error_name: propertyString(properties, "errorName"),
        error_message: propertyString(properties, "errorMessage"),
        error_stack_frame: propertyString(properties, "stackTopFrame"),
        error_group_id: errorGroupId,
        request_method: propertyString(properties, "requestMethod"),
        request_path: propertyString(properties, "requestPath"),
        http_status: propertyNumber(properties, "statusCode"),
        resource_type: propertyString(properties, "resourceType"),
        vital_name: propertyString(properties, "vitalName"),
        vital_value: propertyNumber(properties, "vitalValue"),
        vital_rating: propertyString(properties, "vitalRating"),
        navigation_type: propertyString(properties, "navigationType"),
        collector_sample_rate: propertyNumber(properties, "sampleRate"),
        first_screen_sample_rate: propertyNumber(properties, "firstScreenSampleRate"),
        blank_detection_sample_rate: propertyNumber(
          properties,
          "blankDetectionSampleRate",
        ),
        request_count: propertyNumber(properties, "requestCount"),
        request_success_count: propertyNumber(properties, "successCount"),
        request_error_count: propertyNumber(properties, "errorCount"),
        request_slow_count: propertyNumber(properties, "slowCount"),
        slow_threshold_ms: propertyNumber(properties, "slowThresholdMs"),
        resource_total_count: propertyNumber(properties, "totalCount"),
        resource_failed_count: propertyNumber(properties, "failedCount"),
        resource_total_duration_ms: propertyNumber(properties, "totalDurationMs"),
        readiness_template: propertyString(properties, "templateKey"),
        readiness_state: propertyString(properties, "readinessState"),
        first_screen_collected:
          typeof properties.firstScreenCollected === "boolean"
            ? properties.firstScreenCollected
            : null,
        blank_detection_collected:
          typeof properties.blankDetectionCollected === "boolean"
            ? properties.blankDetectionCollected
            : null,
        row_count_bucket: propertyString(properties, "rowCountBucket"),
        long_task_count: propertyNumber(properties, "longTaskCount"),
        long_task_duration_ms: propertyNumber(properties, "longTaskDurationMs"),
        long_task_maximum_ms: propertyNumber(properties, "longTaskMaximumMs"),
        observed_page_views: propertyNumber(properties, "observedPageViews"),
        breadcrumbs_json:
          "breadcrumbs" in event && Array.isArray(event.breadcrumbs)
            ? JSON.stringify(event.breadcrumbs)
            : null,
        duration_ms:
          typeof properties.durationMs === "number"
            ? properties.durationMs
            : typeof properties.readinessDurationMs === "number"
              ? properties.readinessDurationMs
              : null,
        route: event.route,
        title: event.title ?? null,
        visible_duration_ms:
          typeof properties.visibleDurationMs === "number"
            ? properties.visibleDurationMs
            : null,
        properties_json: JSON.stringify(event.properties),
        request_id: envelope.requestId,
        origin: envelope.origin,
      };
    });
  }

  private async deadLetter(
    value: Buffer | null,
    metadata: {
      topic: string;
      partition: number;
      offset: string;
      code: string | null;
    },
  ): Promise<void> {
    const messageHash = createHash("sha256")
      .update(value ?? Buffer.alloc(0))
      .digest("hex");
    let projectId: string | null = null;
    try {
      projectId =
        (JSON.parse(value?.toString("utf8") ?? "{}") as { projectId?: string })
          .projectId ?? null;
    } catch {
      // Do not include the raw poison payload in dead letter data.
    }
    await this.dlqProducer.send({
      topic: this.environment.KAFKA_DLQ_TOPIC,
      messages: [
        {
          key: projectId ?? "unknown-project",
          value: JSON.stringify({
            ...metadata,
            projectId,
            messageHash,
            failedAt: new Date().toISOString(),
          }),
        },
      ],
    });
    if (projectId) await this.mysql.markDeadLetter(projectId).catch(() => {});
    this.metrics.deadLetters += 1;
  }

  private startHealthServer(): void {
    this.healthServer = createServer((request, response) => {
      if (request.url === "/health/live") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/health/ready" && this.metrics.ready) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ready", metrics: this.metrics }));
        return;
      }
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "not_ready" }));
    });
    this.healthServer.listen(this.environment.CONSUMER_HEALTH_PORT, "0.0.0.0");
  }
}

export async function bootstrapConsumer(): Promise<void> {
  const runtime = new EventConsumerRuntime(loadConsumerEnvironment());
  const shutdown = async () => {
    await runtime.stop();
    process.exitCode = 0;
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  await runtime.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapConsumer().catch((cause) => {
    console.error(
      JSON.stringify({
        service: "consumer",
        code: errorCode(cause),
      }),
    );
    process.exitCode = 1;
  });
}
