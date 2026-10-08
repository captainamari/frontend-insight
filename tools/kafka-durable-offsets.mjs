// Run inside the consumer container. Log offsets/error codes only, never payloads.
import { createRequire } from "node:module";
let admin;
let stage = "load-client";
try {
  const require = createRequire(
    new URL("../apps/consumer/package.json", import.meta.url),
  );
  const { Kafka, logLevel } = require("kafkajs");
  const { REPEATED_TOPIC } = await import("../packages/server-core/dist/src/index.js");
  const topics = [
    process.env.KAFKA_EVENTS_TOPIC ?? "frontend-insight.events.v1",
    REPEATED_TOPIC,
  ];
  admin = new Kafka({
    clientId: "production-backup-offset-check",
    brokers: process.env.KAFKA_BROKERS.split(","),
    logLevel: logLevel.NOTHING,
    requestTimeout: 10000,
    retry: { retries: 0 },
  }).admin();
  stage = "connect";
  await admin.connect();
  stage = "fetch-committed";
  const committed = await admin.fetchOffsets({
    groupId: process.env.CONSUMER_GROUP_ID,
    topics,
  });
  const rows = [];
  for (const topic of topics) {
    stage = "fetch-log-end";
    const ends = await admin.fetchTopicOffsets(topic);
    stage = "compare-offsets";
    for (const end of ends) {
      const offset =
        committed
          .find((t) => t.topic === topic)
          ?.partitions.find((p) => p.partition === end.partition)?.offset ?? "-1";
      rows.push({
        topic,
        partition: end.partition,
        committed: offset,
        end: end.offset,
        // Uncommitted empty partitions have no data; nonempty ones must commit.
        drained:
          BigInt(end.offset) === 0n ||
          (BigInt(offset) >= 0n && BigInt(offset) === BigInt(end.offset)),
      });
    }
  }
  console.log(JSON.stringify(rows));
  if (!rows.length || rows.some((r) => !r.drained)) process.exitCode = 1;
} catch (error) {
  const safeCode = (value) => (/^[A-Za-z0-9_]+$/.test(String(value)) ? value : null);
  console.log(
    JSON.stringify({
      stage,
      error: safeCode(error.name),
      type: safeCode(error.type),
      code: safeCode(error.code),
      cause: safeCode(error.cause?.code),
    }),
  );
  process.exitCode = 1;
} finally {
  await admin?.disconnect().catch(() => {});
}
