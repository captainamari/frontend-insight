import { readFile } from "node:fs/promises";

const fixture = JSON.parse(
  await readFile(
    new URL(
      "../packages/test-fixtures/fixtures/valid/p1-collectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const events = fixture.events.map((event) => ({
  eventName: event.eventName,
  bytes: Buffer.byteLength(JSON.stringify(event), "utf8"),
}));
const sorted = events.map((event) => event.bytes).sort((left, right) => left - right);
const percentile = (value) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
const report = {
  fixture: "p1-collectors",
  eventsPerFixturePageView: events.length,
  eventBytesP50: percentile(0.5),
  eventBytesP95: percentile(0.95),
  uncompressedBatchBytes: Buffer.byteLength(JSON.stringify(fixture), "utf8"),
  events,
};

if (report.eventBytesP95 > 8 * 1024 || report.uncompressedBatchBytes > 64 * 1024) {
  throw new Error("P1_PAYLOAD_BUDGET_EXCEEDED");
}
console.log(JSON.stringify(report, null, 2));
