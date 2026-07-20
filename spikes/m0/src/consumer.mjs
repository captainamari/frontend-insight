import http from "node:http";
import { createClient } from "@clickhouse/client";
import { Kafka, logLevel } from "kafkajs";
import { loadConfig } from "./config.mjs";

const config = loadConfig();
const clickhouse = createClient({
  ...config.clickhouse,
  clickhouse_settings: {
    date_time_input_format: "best_effort",
  },
});
const kafka = new Kafka({
  clientId: "frontend-insight-m0-clickhouse-consumer",
  brokers: config.kafka.brokers,
  logLevel: logLevel.ERROR,
});
const consumer = kafka.consumer({
  groupId: "frontend-insight-m0-clickhouse",
  allowAutoTopicCreation: false,
});
let ready = false;

function clickHouseTimestamp(value) {
  return new Date(value).toISOString().replace("T", " ").replace("Z", "");
}

function assertIngestionEvent(event) {
  if (Object.hasOwn(event, "accountRef")) {
    throw new Error("raw accountRef crossed the ingestion boundary");
  }
  if (!/^[0-9a-f]{64}$/.test(event.accountHash ?? "")) {
    throw new Error("event does not contain a valid HMAC-SHA256 accountHash");
  }
}

await clickhouse.command({
  query: `
    CREATE TABLE IF NOT EXISTS m0_browser_events (
      event_id UUID,
      event_type LowCardinality(String),
      project_key LowCardinality(String),
      feature_key LowCardinality(String),
      account_hash FixedString(64),
      session_id String,
      occurred_at DateTime64(3, 'UTC'),
      ingested_at DateTime64(3, 'UTC'),
      received_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = MergeTree
    ORDER BY (project_key, feature_key, occurred_at, event_id)
  `,
});

await consumer.connect();
await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: false });
await consumer.run({
  eachMessage: async ({ message }) => {
    const event = JSON.parse(message.value.toString("utf8"));
    assertIngestionEvent(event);
    await clickhouse.insert({
      table: "m0_browser_events",
      values: [
        {
          event_id: event.eventId,
          event_type: event.eventType,
          project_key: event.projectKey,
          feature_key: event.featureKey,
          account_hash: event.accountHash,
          session_id: event.sessionId,
          occurred_at: clickHouseTimestamp(event.occurredAt),
          ingested_at: clickHouseTimestamp(event.ingestedAt),
        },
      ],
      format: "JSONEachRow",
    });
  },
});
ready = true;

const healthServer = http.createServer((request, response) => {
  if (request.url === "/health/ready" && ready) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ready"}');
    return;
  }
  response.writeHead(503, { "content-type": "application/json" });
  response.end('{"status":"not_ready"}');
});
healthServer.listen(config.consumer.healthPort, "0.0.0.0");

console.log(
  JSON.stringify({
    message: "M0 ClickHouse consumer ready",
    topic: config.kafka.topic,
    healthPort: config.consumer.healthPort,
  }),
);

async function shutdown(signal) {
  ready = false;
  console.log(JSON.stringify({ message: "shutting down", signal }));
  await new Promise((resolve) => healthServer.close(resolve));
  await consumer.disconnect();
  await clickhouse.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
