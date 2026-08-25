import { createClient } from "@clickhouse/client";
import type { FrontendInsightEventBatch } from "@frontend-insight/event-contract";
import {
  contractScenarios,
  invalidLegacyBatches,
} from "@frontend-insight/test-fixtures";
import type { RowDataPacket } from "mysql2/promise";
import mysql from "mysql2/promise";
import { m5Fixture } from "../scripts/m5-fixture.js";
import { SYSTEM_METRIC_SEED } from "../src/generated/system-metric-seed.js";

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

async function verifySeedSnapshot() {
  const pool = mysql.createPool(mysqlUrl!);
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM users
          WHERE id IN (?, ?) AND status = 'active') AS users,
         (SELECT COUNT(*) FROM identities
          WHERE provider = 'local' AND subject IN (?, ?)
            AND password_hash IS NOT NULL) AS identities,
         (SELECT COUNT(*) FROM projects
          WHERE id = ? AND app_id = ? AND status = 'active') AS projects,
         (SELECT COUNT(*) FROM modules
          WHERE project_id = ? AND status = 'active') AS modules,
         (SELECT COUNT(*) FROM page_definitions
          WHERE project_id = ? AND status = 'active') AS pages,
         (SELECT COUNT(*) FROM workflow_definitions
          WHERE project_id = ? AND status = 'active') AS workflows,
         (SELECT COUNT(*) FROM metric_definitions md
          JOIN metric_library_versions mlv ON mlv.id = md.library_version_id
          WHERE mlv.manifest_version = '1.8.0' AND mlv.status = 'active') AS metrics,
         (SELECT COUNT(*) FROM score_definitions sd
          JOIN metric_library_versions mlv ON mlv.id = sd.library_version_id
          WHERE mlv.manifest_version = '1.8.0' AND sd.status = 'active') AS scores`,
      [
        m5Fixture.admin.id,
        m5Fixture.viewer.id,
        m5Fixture.admin.email,
        m5Fixture.viewer.email,
        m5Fixture.projectId,
        m5Fixture.appId,
        m5Fixture.projectId,
        m5Fixture.projectId,
        m5Fixture.projectId,
      ],
    );
    const row = rows[0];
    const actual = {
      users: Number(row?.users),
      identities: Number(row?.identities),
      projects: Number(row?.projects),
      modules: Number(row?.modules),
      pages: Number(row?.pages),
      workflows: Number(row?.workflows),
      metrics: Number(row?.metrics),
      scores: Number(row?.scores),
    };
    assert(actual.users === 2, "R0 seed must create both local users");
    assert(actual.identities === 2, "R0 seed must create both password identities");
    assert(actual.projects === 1, "R0 seed must create the documented appId");
    assert(actual.modules === 2, "R0 seed must create two fixture modules");
    assert(actual.pages === 3, "R0 seed must create three fixture pages");
    assert(actual.workflows === 1, "R0 seed must create the workflow definition");
    assert(
      actual.metrics === SYSTEM_METRIC_SEED.length,
      "R0 seed must create every canonical metric",
    );
    assert(actual.scores === 2, "R0 seed must create operational and quality scores");
    return actual;
  } finally {
    await pool.end();
  }
}

async function verifyDocumentedLogins() {
  const evidence = [];
  for (const fixture of [m5Fixture.admin, m5Fixture.viewer]) {
    const login = await jsonRequest("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: fixture.email, password: fixture.password }),
    });
    assert(
      login.response.status === 200,
      `documented login failed for ${fixture.email}: ${JSON.stringify(login.body)}`,
    );
    const user = login.body.user as Record<string, unknown> | undefined;
    assert(
      user?.email === fixture.email,
      `login returned the wrong user for ${fixture.email}`,
    );
    assert(
      typeof login.body.accessToken === "string",
      "login must return an access token",
    );
    evidence.push({ email: fixture.email, status: login.response.status });
  }
  return evidence;
}

const seedSnapshot = await verifySeedSnapshot();
const documentedLogins = await verifyDocumentedLogins();

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
    seedSnapshot,
    documentedLogins,
  }),
);
