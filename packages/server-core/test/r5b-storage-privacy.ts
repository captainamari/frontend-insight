import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { createClient } from "@clickhouse/client";
const projects = process.argv.slice(2);
assert(projects.length === 2 && projects.every((p) => /^[a-f0-9-]{36}$/.test(p)));
const forbidden = /FI_R5B_PRIVATE|person@example\.invalid|123456/;
const kafka = new Kafka({
  clientId: "r5b-privacy",
  brokers: (process.env.KAFKA_BROKERS ?? "kafka:9092").split(","),
  logLevel: logLevel.NOTHING,
});
const topic = process.env.KAFKA_EVENTS_TOPIC ?? "frontend-insight.events.v1";
const dlq = process.env.KAFKA_DLQ_TOPIC ?? "frontend-insight.events.dlq.v1";
const seen = new Set<string>();
const eventCounts = new Map<string, Set<string>>();
let violation = false;
const consumer = kafka.consumer({ groupId: "r5b-privacy-" + randomUUID() });
await consumer.connect();
await consumer.subscribe({ topic, fromBeginning: true });
await consumer.run({
  eachMessage: async ({ message }) => {
    const value = message.value?.toString() ?? "";
    let envelope: { projectId?: string; batch?: { events?: { eventId: string }[] } };
    try {
      envelope = JSON.parse(value);
    } catch {
      return;
    }
    if (!projects.includes(envelope.projectId ?? "")) return;
    if (forbidden.test(value)) violation = true;
    const ids = eventCounts.get(envelope.projectId!) ?? new Set<string>();
    for (const e of envelope.batch?.events ?? []) ids.add(e.eventId);
    eventCounts.set(envelope.projectId!, ids);
    if (ids.size >= 39) seen.add(envelope.projectId!);
  },
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 30000;
  while (!check() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 200));
  assert(check(), "R5B_STORAGE_EVIDENCE_TIMEOUT");
}
try {
  await until(() => seen.size === 2);
  assert(!violation, "R5B_KAFKA_LEAK");
} finally {
  await consumer.disconnect();
}
const client = createClient({
  url: process.env.CLICKHOUSE_URL!,
  username: process.env.CLICKHOUSE_USERNAME!,
  password: process.env.CLICKHOUSE_PASSWORD!,
  database: process.env.CLICKHOUSE_DATABASE ?? "frontend_insight",
});
try {
  for (const projectId of projects) {
    const r = await client.query({
      query: "SELECT * FROM raw_events WHERE project_id = {id:UUID} LIMIT 1000",
      query_params: { id: projectId },
      format: "JSONEachRow",
    });
    const rows = await r.json();
    assert(rows.length >= 37);
    assert(!forbidden.test(JSON.stringify(rows)), "R5B_CLICKHOUSE_LEAK");
  }
} finally {
  await client.close();
}
// Explicit poison is confined to the isolated test project; the dead-letter record must contain a hash only.
const poison = JSON.stringify({
  projectId: projects[0],
  invalid: "FI_R5B_PRIVATE_DLQ",
});
const hash = createHash("sha256").update(poison).digest("hex");
const dead = kafka.consumer({ groupId: "r5b-dlq-" + randomUUID() });
let received = false;
await dead.connect();
await dead.subscribe({ topic: dlq, fromBeginning: true });
await dead.run({
  eachMessage: async ({ message }) => {
    const value = message.value?.toString() ?? "";
    if (value.includes(hash)) {
      violation = forbidden.test(value);
      received = true;
    }
  },
});
const producer = kafka.producer();
await producer.connect();
try {
  await producer.send({ topic, messages: [{ key: projects[0]!, value: poison }] });
  await until(() => received);
  assert(!violation, "R5B_DLQ_LEAK");
} finally {
  await producer.disconnect();
  await dead.disconnect();
}
console.log(
  JSON.stringify({
    kafka: "passed",
    clickhouse: "passed",
    deadLetter: "passed",
    projects: projects.length,
  }),
);
