import { createHmac, randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { Kafka, logLevel } from "kafkajs";
import mysql from "mysql2/promise";
import { loadConfig } from "./config.mjs";

const config = loadConfig();
const runId = randomUUID();
const startedAt = new Date();
const results = [];

async function verifyStep(name, operation) {
  const stepStartedAt = performance.now();
  try {
    const details = await operation();
    results.push({
      name,
      status: "passed",
      durationMs: Math.round(performance.now() - stepStartedAt),
      details,
    });
  } catch (error) {
    results.push({
      name,
      status: "failed",
      durationMs: Math.round(performance.now() - stepStartedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function verifyMySql() {
  const pool = mysql.createPool({
    ...config.mysql,
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 16,
    timezone: "Z",
  });

  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB
    `);
    await pool.execute(
      "INSERT IGNORE INTO schema_migrations (version) VALUES (?)",
      ["m0_001_spike_runs"],
    );
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS m0_spike_runs (
        run_id CHAR(36) PRIMARY KEY,
        source VARCHAR(32) NOT NULL,
        created_at TIMESTAMP(3) NOT NULL
      ) ENGINE=InnoDB
    `);
    await pool.execute(
      "INSERT INTO m0_spike_runs (run_id, source, created_at) VALUES (?, ?, ?)",
      [runId, "node-pool", startedAt],
    );
    const [rows] = await pool.execute(
      "SELECT run_id, source FROM m0_spike_runs WHERE run_id = ?",
      [runId],
    );
    if (rows.length !== 1 || rows[0].source !== "node-pool") {
      throw new Error("inserted MySQL row could not be read back");
    }

    return { migration: "m0_001_spike_runs", rowsRead: rows.length };
  } finally {
    await pool.end();
  }
}

function clickHouseTimestamp(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

async function verifyClickHouse() {
  const client = createClient({
    ...config.clickhouse,
    clickhouse_settings: {
      date_time_input_format: "best_effort",
    },
  });

  try {
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS m0_spike_runs (
          run_id UUID,
          source LowCardinality(String),
          created_at DateTime64(3, 'UTC')
        ) ENGINE = MergeTree
        ORDER BY (run_id, created_at)
      `,
    });
    await client.insert({
      table: "m0_spike_runs",
      values: [
        {
          run_id: runId,
          source: "node-batch",
          created_at: clickHouseTimestamp(startedAt),
        },
      ],
      format: "JSONEachRow",
    });

    const queryResult = await client.query({
      query: `
        SELECT
          toString(run_id) AS run_id_text,
          source,
          toUnixTimestamp64Milli(created_at) AS created_at_ms
        FROM m0_spike_runs
        WHERE m0_spike_runs.run_id = {runId:UUID}
      `,
      query_params: { runId },
      format: "JSONEachRow",
    });
    const rows = await queryResult.json();
    if (
      rows.length !== 1 ||
      Number(rows[0].created_at_ms) !== startedAt.getTime()
    ) {
      throw new Error("ClickHouse DateTime64(3) precision was not preserved");
    }

    return {
      rowsRead: rows.length,
      storedTimestampMs: Number(rows[0].created_at_ms),
      batchFormat: "JSONEachRow",
    };
  } finally {
    await client.close();
  }
}

async function verifyKafka() {
  const probeTopic = `${config.kafka.topic}-probe`;
  const kafka = new Kafka({
    clientId: `frontend-insight-m0-${runId}`,
    brokers: config.kafka.brokers,
    logLevel: logLevel.ERROR,
  });
  const admin = kafka.admin();
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  const consumer = kafka.consumer({
    groupId: `frontend-insight-m0-${runId}`,
    allowAutoTopicCreation: false,
  });
  let timeout;

  try {
    await admin.connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic: probeTopic,
          numPartitions: 1,
          replicationFactor: 1,
        },
      ],
    });
    await admin.disconnect();

    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({ topic: probeTopic, fromBeginning: true });

    const received = new Promise((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Kafka message was not consumed within 30 seconds")),
        30_000,
      );
      consumer
        .run({
          eachMessage: async ({ message }) => {
            const body = JSON.parse(message.value.toString("utf8"));
            if (body.runId === runId) resolve(body);
          },
        })
        .catch(reject);
    });

    await producer.send({
      topic: probeTopic,
      messages: [
        {
          key: runId,
          value: JSON.stringify({ runId, occurredAt: startedAt.toISOString() }),
        },
      ],
    });
    const message = await received;
    clearTimeout(timeout);

    return { topic: probeTopic, consumedRunId: message.runId };
  } finally {
    clearTimeout(timeout);
    await Promise.allSettled([
      consumer.disconnect(),
      producer.disconnect(),
      admin.disconnect(),
    ]);
  }
}

function syntheticEvent() {
  return {
    eventId: randomUUID(),
    eventType: "m0_beacon_test",
    projectKey: "m0-local",
    featureKey: "browser-beacon",
    accountRef: "verify-account-opaque-001",
    sessionId: randomUUID(),
    occurredAt: new Date().toISOString(),
  };
}

async function verifyBrowserContract() {
  const optionsResponse = await fetch(`${config.api.baseUrl}/v1/events`, {
    method: "OPTIONS",
    headers: {
      origin: config.api.allowedOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  if (
    optionsResponse.status !== 204 ||
    optionsResponse.headers.get("access-control-allow-origin") !==
      config.api.allowedOrigin
  ) {
    throw new Error("CORS preflight did not allow the configured exact origin");
  }

  const event = syntheticEvent();
  const postResponse = await fetch(`${config.api.baseUrl}/v1/events`, {
    method: "POST",
    headers: {
      origin: config.api.allowedOrigin,
      "content-type": "text/plain;charset=UTF-8",
    },
    body: JSON.stringify({ events: [event] }),
  });
  if (postResponse.status !== 202) {
    throw new Error(`valid browser event was rejected with HTTP ${postResponse.status}`);
  }

  const rejectedResponse = await fetch(`${config.api.baseUrl}/v1/events`, {
    method: "POST",
    headers: {
      origin: config.api.allowedOrigin,
      "content-type": "text/plain;charset=UTF-8",
    },
    body: JSON.stringify({
      events: [{ ...syntheticEvent(), authorization: "Bearer must-not-pass" }],
    }),
  });
  const rejectedBody = await rejectedResponse.json();
  if (
    rejectedResponse.status !== 400 ||
    rejectedBody.error !== "credential_data_rejected"
  ) {
    throw new Error("credential leak guard did not reject a Bearer value");
  }

  const statsResponse = await fetch(`${config.api.baseUrl}/stats`);
  const stats = await statsResponse.json();
  if (!stats.lastEventIds.includes(event.eventId)) {
    throw new Error("accepted event was not reflected in aggregate-only stats");
  }

  const clickhouse = createClient({ ...config.clickhouse });
  const expectedAccountHash = createHmac(
    "sha256",
    config.ingestion.accountHmacKey,
  )
    .update(event.accountRef)
    .digest("hex");
  let pipelineRows = [];
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const pipelineResult = await clickhouse.query({
        query: `
          SELECT
            toString(event_id) AS event_id_text,
            account_hash
          FROM m0_browser_events
          WHERE m0_browser_events.event_id = {eventId:UUID}
        `,
        query_params: { eventId: event.eventId },
        format: "JSONEachRow",
      });
      pipelineRows = await pipelineResult.json();
      if (pipelineRows.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } finally {
    await clickhouse.close();
  }
  if (
    pipelineRows.length !== 1 ||
    pipelineRows[0].account_hash !== expectedAccountHash
  ) {
    throw new Error(
      "browser event did not reach ClickHouse with the expected account HMAC",
    );
  }

  const demoResponse = await fetch(config.demo.baseUrl);
  const csp = demoResponse.headers.get("content-security-policy") ?? "";
  const html = await demoResponse.text();
  if (
    demoResponse.status !== 200 ||
    !csp.includes(`connect-src 'self' ${config.api.publicUrl}`) ||
    !html.includes("/demo.js")
  ) {
    throw new Error("demo page did not expose the expected strict CSP contract");
  }

  return {
    corsOrigin: config.api.allowedOrigin,
    acceptedEventId: event.eventId,
    credentialGuard: "passed",
    csp: "passed",
    clickhouseEventId: pipelineRows[0].event_id_text,
    rawAccountReferencePersisted: false,
  };
}

let exitCode = 0;
try {
  await verifyStep("mysql-migration-and-pool", verifyMySql);
  await verifyStep("clickhouse-batch-and-datetime64", verifyClickHouse);
  await verifyStep("kafka-produce-and-consume", verifyKafka);
  await verifyStep("browser-cors-csp-and-beacon-contract", verifyBrowserContract);
} catch {
  exitCode = 1;
}

console.log(
  JSON.stringify(
    {
      runId,
      status: exitCode === 0 ? "passed" : "failed",
      platform: `${process.platform}/${process.arch}`,
      results,
    },
    null,
    2,
  ),
);
process.exitCode = exitCode;
