import { createClient } from "@clickhouse/client";
import type { FrontendInsightEventBatch } from "@frontend-insight/event-contract";
import {
  contractScenarios,
  invalidLegacyBatches,
} from "@frontend-insight/test-fixtures";
import { m5Fixture } from "../scripts/m5-fixture.js";
import { seedM6Fixture } from "../scripts/m6-fixture.js";

const apiUrl = process.env.M24_API_URL ?? "http://127.0.0.1:3000";
const mysqlUrl = process.env.MYSQL_URL;
const clickhouseUrl = process.env.CLICKHOUSE_URL;
if (!mysqlUrl || !clickhouseUrl) throw new Error("INTEGRATION_ENVIRONMENT_MISSING");

const origin = "http://localhost:4173";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`R0_FLOW_ASSERTION_FAILED: ${message}`);
}

async function jsonRequest(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  return {
    response,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function shiftedBatch(
  source: FrontendInsightEventBatch,
  now: number,
  scenarioIndex: number,
): FrontendInsightEventBatch {
  const batch = structuredClone(source);
  const firstTimestamp = batch.events[0]?.timestamp ?? now;
  batch.sentAt = now;
  batch.events = batch.events.map((event, eventIndex) => ({
    ...event,
    appId: m5Fixture.appId,
    eventId: `evt_r0_${scenarioIndex}_${eventIndex}_${now}`,
    timestamp: now + event.timestamp - firstTimestamp,
    deviceId: `dev_r0_${scenarioIndex}_${eventIndex}_${now}`,
    sessionId: `ses_r0_${scenarioIndex}_${now}`,
    pageViewId: `pv_r0_${scenarioIndex}_${eventIndex}_${now}`,
    userId: event.userId === null ? null : `opaque-user-r0-${scenarioIndex}`,
  }));
  return batch;
}

async function waitFor(description: string, operation: () => Promise<boolean>) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`R0_FLOW_TIMEOUT:${description}`);
}

await seedM6Fixture(mysqlUrl, {
  origins: [
    origin,
    "http://127.0.0.1:4173",
    "http://localhost:4174",
    "http://127.0.0.1:4174",
  ],
});

const startedAt = Date.now();
const batches = contractScenarios.map((scenario, index) =>
  shiftedBatch(scenario.valid, startedAt - (index + 1) * 1_000, index + 1),
);
const eventIds = batches.flatMap((batch) => batch.events.map((event) => event.eventId));

for (const batch of batches) {
  const accepted = await jsonRequest("/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(batch),
  });
  assert(
    accepted.response.status === 202,
    `v3 ingestion rejected: ${JSON.stringify(accepted.body)}`,
  );
  assert(
    JSON.stringify(accepted.body).includes("[3]"),
    "ingestion must advertise only contract v3",
  );
}

for (const legacy of invalidLegacyBatches) {
  const rejected = await jsonRequest("/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(legacy),
  });
  assert(rejected.response.status === 400, "legacy contract must return 400");
  assert(
    rejected.body.code === "SCHEMA_VERSION_UNSUPPORTED",
    "legacy contract must return the stable rejection code",
  );
}

const clickhouse = createClient({
  url: clickhouseUrl,
  username: process.env.CLICKHOUSE_USERNAME ?? "frontend_insight",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: process.env.CLICKHOUSE_DATABASE ?? "frontend_insight",
});
try {
  await waitFor("v3 facts to become queryable", async () => {
    const response = await clickhouse.query({
      query: `
        SELECT count() AS count
        FROM raw_events
        WHERE event_id IN {eventIds:Array(String)}
      `,
      query_params: { eventIds },
      format: "JSONEachRow",
    });
    const rows = await response.json<{ count: string }>();
    return Number(rows[0]?.count) === eventIds.length;
  });

  const response = await clickhouse.query({
    query: `
      SELECT
        countIf(schema_version != 3) AS non_v3,
        countIf(app_id != {appId:String}) AS wrong_app,
        countIf(user_id IS NOT NULL AND length(user_id) != 64) AS invalid_user_hash,
        countIf(position(page_url, '?') > 0 OR position(page_url, '#') > 0) AS unsafe_urls
      FROM raw_events
      WHERE event_id IN {eventIds:Array(String)}
    `,
    query_params: { appId: m5Fixture.appId, eventIds },
    format: "JSONEachRow",
  });
  const row = (
    await response.json<{
      non_v3: string;
      wrong_app: string;
      invalid_user_hash: string;
      unsafe_urls: string;
    }>()
  )[0];
  assert(Number(row?.non_v3) === 0, "ClickHouse must contain only v3 smoke facts");
  assert(Number(row?.wrong_app) === 0, "app_id must survive the pipeline");
  assert(Number(row?.invalid_user_hash) === 0, "user_id must be project-HMACed");
  assert(Number(row?.unsafe_urls) === 0, "page_url must omit query and hash");
} finally {
  await clickhouse.close();
}

console.log(
  JSON.stringify({
    status: "passed",
    milestone: "R0",
    contractVersion: 3,
    acceptedBatches: batches.length,
    acceptedEvents: eventIds.length,
    rejectedLegacyBatches: invalidLegacyBatches.length,
  }),
);
