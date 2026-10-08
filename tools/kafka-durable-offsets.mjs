// Run inside the consumer container; inspect both durable and short-reference topics.
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../apps/consumer/package.json", import.meta.url),
);
const { Kafka, logLevel } = require("kafkajs");
const { REPEATED_TOPIC } = await import("../packages/server-core/dist/src/index.js");
const topics = [
  process.env.KAFKA_EVENTS_TOPIC ?? "frontend-insight.events.v1",
  REPEATED_TOPIC,
];
const admin = new Kafka({
  clientId: "production-backup-offset-check",
  brokers: process.env.KAFKA_BROKERS.split(","),
  logLevel: logLevel.NOTHING,
  requestTimeout: 10000,
  retry: { retries: 0 },
}).admin();
try {
  await admin.connect();
  const committed = await admin.fetchOffsets({
    groupId: process.env.CONSUMER_GROUP_ID,
    topics,
  });
  const rows = [];
  for (const topic of topics) {
    for (const end of await admin.fetchTopicOffsets(topic)) {
      const offset =
        committed
          .find((t) => t.topic === topic)
          ?.partitions.find((p) => p.partition === end.partition)?.offset ?? "-1";
      // Never-committed empty partitions have no data to lose. Any nonempty
      // partition requires an actual committed offset at its current log end.
      rows.push({
        topic,
        partition: end.partition,
        committed: offset,
        end: end.offset,
        drained:
          BigInt(end.offset) === 0n ||
          (BigInt(offset) >= 0n && BigInt(offset) === BigInt(end.offset)),
      });
    }
  }
  console.log(JSON.stringify(rows));
  if (!rows.length || rows.some((r) => !r.drained)) process.exitCode = 1;
} finally {
  await admin.disconnect();
}
