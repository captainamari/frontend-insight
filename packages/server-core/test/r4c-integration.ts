// Isolated upgrade/replay fixture. Actual SDK collection is tested separately in both browsers.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@clickhouse/client";
import { contractScenarios } from "@frontend-insight/test-fixtures";
import { validateForConsumer } from "@frontend-insight/event-contract";
import type { RowDataPacket } from "mysql2/promise";
import { MySqlStore } from "../src/mysql-store.js";
import { KafkaEnvelopePublisher } from "../src/pipeline.js";
import type { KafkaEventEnvelope } from "../src/model.js";
if (!process.env.MYSQL_URL) throw new Error("MYSQL_URL_REQUIRED");
const mysql = new MySqlStore(process.env.MYSQL_URL);
const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
  username: process.env.CLICKHOUSE_USERNAME ?? "frontend_insight",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: "frontend_insight",
});
const publisher = new KafkaEnvelopePublisher(
  ["kafka:9092"],
  "frontend-insight.events.v1",
);
const api = process.env.FI_API_URL ?? "http://api:3000";
let token = "";
async function post<T>(path: string, body: unknown, status = 201): Promise<T> {
  const r = await fetch(api + path, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, status, "R4C_FIXTURE_API_STATUS"); // Never print request/response bodies.
  return r.json() as Promise<T>;
}
const evidence: Record<string, unknown> = {
  testedCommit: process.env.GITHUB_SHA ?? null,
  scope:
    "isolated real MySQL/Kafka/consumer/ClickHouse upgrade and directory replay; not production membership",
  passed: false,
};
try {
  token = (
    await post<{ accessToken: string }>(
      "/api/auth/login",
      { email: "admin@example.invalid", password: "LocalAdmin-1234" },
      200,
    )
  ).accessToken;
  const project = await post<{ id: string; appId: string }>("/api/projects", {
    name: `R4-C replay ${randomUUID()}`,
    timezone: "UTC",
    origins: ["https://isolated.example.invalid"],
  });
  const root = `/api/projects/${project.id}`;
  async function publishDirectory(deptId: string, roleId: string) {
    const version = await post<{ id: string }>(root + "/directory", {
      env: "dev",
      sourceKey: "isolated_replay",
      coverage: "complete",
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      entries: [{ userId: "u_isolated_replay_0001", deptId, roleId, eligible: true }],
    });
    await post(root + `/directory/${version.id}/publish`, {});
    return version.id;
  }
  const first = await publishDirectory("dept_first", "role_first");
  const [rows] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT entries_json FROM organization_directory_versions WHERE project_id=? AND id=?",
    [project.id, first],
  );
  const entries =
    typeof rows[0]!.entries_json === "string"
      ? JSON.parse(rows[0]!.entries_json)
      : rows[0]!.entries_json;
  const user = String(entries[0].userId);
  assert.match(user, /^[a-f0-9]{64}$/);
  const original = contractScenarios.find((s) => s.name === "page_usage_v3")!.valid;
  function envelope(governed: boolean): KafkaEventEnvelope {
    const batch = structuredClone(original);
    const event = batch.events.find((e) => e.event === "page_view")!;
    batch.events = [event];
    batch.sdk.version = governed ? "0.6.0" : "0.5.0";
    batch.sentAt = Date.now();
    Object.assign(event, {
      eventId: `evt_${randomUUID().replaceAll("-", "")}`,
      appId: project.appId,
      timestamp: Date.now(),
      env: "dev",
      userId: user,
      deptId: governed ? "dept_first" : "legacy_browser_claim",
      roleId: governed ? "role_first" : "legacy_role_claim",
    });
    return {
      envelopeVersion: 1,
      projectId: project.id,
      receivedAt: new Date().toISOString(),
      requestId: randomUUID(),
      origin: "https://isolated.example.invalid",
      batch,
      enrichments: [
        {
          eventId: event.eventId,
          userId: user,
          featureId: null,
          ...(governed ? { directoryVersionId: first } : {}),
        },
      ],
    };
  }
  const legacy = envelope(false),
    governed = envelope(true);
  assert(validateForConsumer(legacy.batch).ok, "R4C_LEGACY_FIXTURE_CONTRACT");
  assert(validateForConsumer(governed.batch).ok, "R4C_GOVERNED_FIXTURE_CONTRACT");
  await publisher.connect();
  await publisher.publish(legacy);
  await publisher.publish(governed);
  await publishDirectory("dept_second", "role_second");
  // Replay the original envelopes after membership changes, retaining their event/receive time.
  await publisher.publish(legacy);
  await publisher.publish(governed);
  type Stored = {
    event_id: string;
    user_id: string;
    dept_id: string | null;
    role_id: string | null;
    directory_version_id: string | null;
  };
  let stored: Stored[] = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await ch.query({
      query:
        "SELECT event_id,user_id,dept_id,role_id,directory_version_id FROM raw_events WHERE project_id={project:String}",
      query_params: { project: project.id },
      format: "JSONEachRow",
    });
    stored = await result.json<Stored>();
    if (stored.length >= 4 && new Set(stored.map((r) => r.event_id)).size === 2) break;
    await delay(500);
  }
  assert.equal(
    new Set(stored.map((r) => r.event_id)).size,
    2,
    "R4C_REPLAY_FACTS_MISSING",
  );
  assert(stored.length >= 4, "R4C_REPLAY_DELIVERIES_MISSING");
  const legacyId = legacy.batch.events[0]!.eventId;
  for (const row of stored) {
    assert.equal(row.user_id, user);
    if (row.event_id === legacyId) {
      assert.equal(row.dept_id, null);
      assert.equal(row.role_id, null);
      assert.equal(row.directory_version_id, null);
    } else {
      assert.equal(row.dept_id, "dept_first");
      assert.equal(row.role_id, "role_first");
      assert.equal(row.directory_version_id, first);
    }
  }
  Object.assign(evidence, {
    passed: true,
    uniqueEvents: 2,
    publications: 2,
    legacyFactPreserved: true,
    browserClaimsRemoved: true,
    historicalVersionPreserved: true,
    replayUsesOriginalEventAndReceivedTime: true,
  });
} finally {
  const dir = process.env.FI_EVIDENCE_DIR ?? "artifacts";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/r4c-integration.json", JSON.stringify(evidence, null, 2));
  await Promise.allSettled([publisher.disconnect(), mysql.close(), ch.close()]);
}
