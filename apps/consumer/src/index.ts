import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { validateForConsumer } from "@frontend-insight/event-contract";
import {
  MySqlStore,
  SafeClickHouseLogger,
  REPEATED_TOPIC,
  parseObjectOperations,
  projectRepeatedOperations,
  readDirectories,
  directoryAt,
  governConsumerOrganization,
  readWorkflowFactDefinitions,
  workflowEventDefinitionError,
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
  lastDeadLetterCode: string | null;
  lag: number;
  lastErrorCode: string | null;
}

function clickHouseTimestamp(value: string | number): string {
  return new Date(value).toISOString().replace("T", " ").replace("Z", "");
}

function errorCode(cause: unknown): string {
  if (cause instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(cause.message)) {
    return cause.message;
  }
  return "CONSUMER_PROCESSING_FAILED";
}

function propertyString(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === "string" ? String(payload[key]) : null;
}

function propertyNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
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
  event: string,
  payload: Record<string, unknown>,
): string | null {
  const isApiFailure =
    event === "api" &&
    payload.success === false &&
    payload.failureType !== "business" &&
    payload.failureType !== "aborted";
  if (event !== "error" && !isApiFailure) return null;
  const status = propertyNumber(payload, "statusCode");
  const statusClass = status === null ? "" : `${Math.floor(status / 100)}xx`;
  const canonical = [
    event === "error" ? propertyString(payload, "errorType") : "api",
    propertyString(payload, "errorName"),
    normalizedErrorMessage(propertyString(payload, "errorMessage")),
    normalizedStackFrame(propertyString(payload, "stackTopFrame")),
    propertyString(payload, "resourceType"),
    propertyString(payload, "requestMethod"),
    propertyString(payload, "requestPath"),
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
    lastDeadLetterCode: null,
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
      readUncommitted: false,
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
      log: { LoggerClass: SafeClickHouseLogger },
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
    await this.consumer.subscribe({ topic: REPEATED_TOPIC, fromBeginning: true });
    this.metrics.ready = true;
    await this.consumer.run({
      // KafkaJS must persist hidden transactional control-only batches too.
      autoCommit: true,
      autoCommitThreshold: 1,
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
    const messages = batch.messages.slice(
      0,
      batch.topic === REPEATED_TOPIC ? 1 : this.environment.CONSUMER_BATCH_SIZE,
    );
    const attemptKey = `${batch.topic}:${batch.partition}:${messages[0]?.offset ?? "empty"}`;
    try {
      if (batch.topic === REPEATED_TOPIC) {
        const objects = [];
        for (const message of messages) {
          try {
            objects.push(
              ...parseObjectOperations(
                JSON.parse(message.value?.toString() ?? "null"),
                Date.now(),
              ),
            );
          } catch {
            await this.deadLetter(message.value, {
              topic: batch.topic,
              partition: batch.partition,
              offset: message.offset,
              code: "OBJECT_ENVELOPE_INVALID_OR_EXPIRED",
            });
          }
        }
        // Bounded batch writes/read; no per-object or per-user queries.
        if (objects.length > 50) throw new Error("OBJECT_BATCH_LIMIT");
        await projectRepeatedOperations(this.clickhouse, objects);
        for (const message of messages) resolveOffset(message.offset);
        // Resolve only durable work. KafkaJS includes hidden control records when
        // the last visible message is resolved, while preserving an unread suffix.
        await commitOffsetsIfNecessary();
        await heartbeat();
        return;
      }
      const envelopes: KafkaEventEnvelope[] = [];
      const rows: unknown[] = [];
      const parsedMessages: {
        message: (typeof messages)[number];
        envelope: KafkaEventEnvelope;
      }[] = [];
      for (const message of messages) {
        try {
          const envelope = this.parseEnvelope(message.value);
          parsedMessages.push({ message, envelope });
        } catch (cause) {
          await this.deadLetter(message.value, {
            topic: batch.topic,
            partition: batch.partition,
            offset: message.offset,
            code: errorCode(cause),
          });
        }
      }
      const workflowProjectIds = [
        ...new Set(
          parsedMessages
            .filter(({ envelope }) =>
              envelope.batch.events.some((event) => event.payload.workflowInstanceId),
            )
            .map(({ envelope }) => envelope.projectId),
        ),
      ];
      // Metadata failures retry the batch; they are not poison-event evidence.
      const definitions = workflowProjectIds.length
        ? await readWorkflowFactDefinitions(this.mysql.pool, workflowProjectIds)
        : [];
      const [projectRows] = workflowProjectIds.length
        ? await this.mysql.pool.query(
            "SELECT id,app_id FROM projects WHERE id IN (?)",
            [workflowProjectIds],
          )
        : [[]];
      const projects = projectRows as { id: string; app_id: string }[];
      const organizationProjects = [
        ...new Set(
          parsedMessages
            .filter(({ envelope }) =>
              envelope.enrichments.some((e) => e.directoryVersionId),
            )
            .map(({ envelope }) => envelope.projectId),
        ),
      ];
      const directories = organizationProjects.length
        ? await readDirectories(this.mysql.pool, organizationProjects)
        : [];
      const efficiencyProjects = [
        ...new Set(
          parsedMessages
            .filter(({ envelope }) =>
              envelope.batch.events.some(
                (e) => e.payload.name === "form_summary" || e.payload.businessAdapter,
              ),
            )
            .map(({ envelope }) => envelope.projectId),
        ),
      ];
      const [efficiencyRows] = efficiencyProjects.length
        ? await this.mysql.pool.query(
            "SELECT f.project_id,f.feature_key,f.feature_type,f.operation_lifecycle_enabled,p.app_id FROM features f JOIN projects p ON p.id=f.project_id WHERE f.project_id IN (?)",
            [efficiencyProjects],
          )
        : [[]];
      const efficiencyRegistry = efficiencyRows as {
        project_id: string;
        feature_key: string;
        feature_type: string;
        operation_lifecycle_enabled: boolean;
        app_id: string;
      }[];
      for (const { message, envelope } of parsedMessages) {
        try {
          if (envelope.batch.events.some((event) => event.payload.workflowInstanceId)) {
            const project = projects.find((p) => p.id === envelope.projectId);
            if (
              !project ||
              envelope.batch.events.some((event) => event.appId !== project.app_id)
            )
              throw new Error("WORKFLOW_PROJECT_CONTEXT_INVALID");
            for (const event of envelope.batch.events) {
              const error = workflowEventDefinitionError(
                event,
                definitions.filter((d) => d.projectId === envelope.projectId),
              );
              if (error) throw new Error(error);
            }
          }
          for (const event of envelope.batch.events) {
            const enrichment = envelope.enrichments.find(
              (e) => e.eventId === event.eventId,
            );
            const directory = enrichment?.directoryVersionId
              ? directoryAt(
                  directories.filter((d) => d.projectId === envelope.projectId),
                  event.env,
                  event.timestamp,
                  Date.parse(envelope.receivedAt),
                )
              : null;
            governConsumerOrganization(
              event,
              enrichment?.directoryVersionId,
              directory,
            );
          }
          for (const event of envelope.batch.events) {
            if (event.payload.name !== "form_summary" && !event.payload.businessAdapter)
              continue;
            const key =
              event.payload.name === "form_summary"
                ? event.payload.formId
                : event.payload.featureKey;
            const feature = efficiencyRegistry.find(
              (f) =>
                f.project_id === envelope.projectId &&
                f.app_id === event.appId &&
                f.feature_key === key,
            );
            if (
              !feature ||
              (event.payload.name === "form_summary"
                ? feature.feature_type !== "action"
                : !feature.operation_lifecycle_enabled)
            )
              throw new Error("EFFICIENCY_REGISTRY_INVALID");
          }
          if (envelope.batch.events.some((e) => e.payload.objectReference))
            throw new Error("OBJECT_REFERENCE_IN_LONG_CHANNEL");
          rows.push(...this.rows(envelope));
          envelopes.push(envelope);
        } catch (cause) {
          await this.deadLetter(message.value, {
            topic: batch.topic,
            partition: batch.partition,
            offset: message.offset,
            code: errorCode(cause),
          });
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
      // Do not resolve a later dead-lettered message before earlier rows and
      // their metadata are durable: auto-commit must never skip failed writes.
      for (const message of messages) resolveOffset(message.offset);
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
    if (
      parsed.envelopeVersion !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.projectId,
      ) ||
      !parsed.requestId
    ) {
      throw new Error("KAFKA_ENVELOPE_INVALID");
    }
    const validation = validateForConsumer(parsed.batch);
    if (!validation.ok) throw new Error("KAFKA_EVENT_CONTRACT_INVALID");
    if (
      validation.value.events.some(
        (event) => event.userId !== null && !/^[a-f0-9]{64}$/.test(event.userId),
      )
    ) {
      throw new Error("RAW_USER_ID_AFTER_INGESTION");
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
      const payload = event.payload as Record<string, unknown>;
      const errorGroupId = observabilityGroupId(event.event, payload);
      const customName =
        event.event === "custom" ? propertyString(payload, "name") : null;
      const workflowVersion = propertyNumber(payload, "workflowDefinitionVersion");
      const workflowStepOrder = propertyNumber(payload, "workflowStepOrder");
      return {
        event_id: event.eventId,
        schema_version: envelope.batch.schemaVersion,
        sdk_name: envelope.batch.sdk.name,
        sdk_version: envelope.batch.sdk.version,
        sdk_usage: envelope.batch.sdk.usageCoverage
          ? JSON.stringify(envelope.batch.sdk.usageCoverage)
          : null,
        sdk_collectors: envelope.batch.sdk.collectors
          ? JSON.stringify(envelope.batch.sdk.collectors)
          : null,
        project_id: envelope.projectId,
        app_id: event.appId,
        env: event.env,
        release: event.release,
        event: event.event,
        timestamp: clickHouseTimestamp(event.timestamp),
        received_at: clickHouseTimestamp(envelope.receivedAt),
        page_url: event.pageUrl,
        page_route: event.pageRoute,
        user_id: event.userId,
        directory_version_id: enrichment.directoryVersionId ?? null,
        dept_id: event.deptId,
        role_id: event.roleId,
        device_id: event.deviceId,
        session_id: event.sessionId,
        page_view_id: event.pageViewId,
        ua: event.ua,
        os: event.os,
        browser: event.browser,
        feature_id: enrichment.featureId,
        feature_key: propertyString(payload, "featureKey"),
        feature_stage: customName?.startsWith("feature_")
          ? customName.slice("feature_".length)
          : null,
        operation_instance_id: propertyString(payload, "operationInstanceId"),
        interaction_type: propertyString(payload, "interactionType"),
        workflow_instance_id: propertyString(payload, "workflowInstanceId"),
        workflow_key: propertyString(payload, "workflowKey"),
        workflow_definition_version:
          workflowVersion === null ? null : Math.trunc(workflowVersion),
        workflow_step_key: propertyString(payload, "workflowStepKey"),
        workflow_step_order:
          workflowStepOrder === null ? null : Math.trunc(workflowStepOrder),
        viewport_bucket: propertyString(payload, "viewportBucket"),
        error_category:
          event.event === "error"
            ? propertyString(payload, "errorCategory")
            : event.event === "api" &&
                payload.success === false &&
                payload.failureType !== "business" &&
                payload.failureType !== "aborted"
              ? propertyString(payload, "failureType")
              : null,
        error_type:
          event.event === "error"
            ? propertyString(payload, "errorType")
            : event.event === "api" &&
                payload.success === false &&
                payload.failureType !== "business" &&
                payload.failureType !== "aborted"
              ? "api"
              : null,
        error_name: propertyString(payload, "errorName"),
        error_message: propertyString(payload, "errorMessage"),
        error_stack_frame: propertyString(payload, "stackTopFrame"),
        error_group_id: errorGroupId,
        request_method: propertyString(payload, "requestMethod"),
        request_path: propertyString(payload, "requestPath"),
        http_status: propertyNumber(payload, "statusCode"),
        resource_type: propertyString(payload, "resourceType"),
        vital_name: propertyString(payload, "metric"),
        vital_value: propertyNumber(payload, "value"),
        vital_rating: propertyString(payload, "rating"),
        navigation_type: propertyString(payload, "navigationType"),
        duration_ms: typeof payload.durationMs === "number" ? payload.durationMs : null,
        visible_duration_ms:
          typeof payload.visibleDurationMs === "number"
            ? payload.visibleDurationMs
            : null,
        payload_json: JSON.stringify(event.payload),
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
      if (
        typeof projectId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          projectId,
        )
      )
        projectId = null;
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
    this.metrics.lastDeadLetterCode = metadata.code;
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
