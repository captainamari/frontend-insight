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
import { SafeClickHouseLogger } from "../src/clickhouse-logger.js";
if (!process.env.MYSQL_URL) throw new Error("MYSQL_URL_REQUIRED");
const mysql = new MySqlStore(process.env.MYSQL_URL);
const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
  username: process.env.CLICKHOUSE_USERNAME ?? "frontend_insight",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: "frontend_insight",
  log: { LoggerClass: SafeClickHouseLogger },
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
let stage = "API_SETUP";
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
  stage = "KAFKA_PUBLISH";
  await publisher.connect();
  await publisher.publish(legacy);
  await publisher.publish(governed);
  stage = "DIRECTORY_CHANGE";
  await publishDirectory("dept_second", "role_second");
  // Replay the original envelopes after membership changes, retaining their event/receive time.
  await publisher.publish(legacy);
  await publisher.publish(governed);
  stage = "CLICKHOUSE_REPLAY";
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
  stage = "ORGANIZATION_HISTORICAL_FIXTURE";
  // Isolated historical snapshot fixture: publication UI is verified above; only this
  // test-owned project receives a historical fixture timestamp through direct MySQL.
  // Event facts still pass through real Kafka -> consumer -> ClickHouse, never direct CH inserts.
  const historical = await post<{ id: string; appId: string }>("/api/projects", {
    name: `R4-C historical organization fixture ${randomUUID()}`,
    timezone: "UTC",
    origins: ["https://isolated.example.invalid"],
  });
  const hroot = `/api/projects/${historical.id}`;
  const day = 86400000;
  const start = Math.floor(Date.now() / day) * day - 3 * day;
  const module = await post<{ id: string }>(hroot + "/modules", {
    moduleKey: "organization_fixture",
    name: "Isolated organization",
    effectiveFrom: new Date(start).toISOString(),
  });
  await post(hroot + "/page-definitions", {
    moduleId: module.id,
    name: "Isolated page",
    pageRoute: "/",
    templateKey: "task_operation",
    isCore: true,
    criticalityWeight: 1,
    expectedFrequency: "daily",
    effectiveFrom: new Date(start).toISOString(),
  });
  const historicalDirectory = await post<{ id: string }>(hroot + "/directory", {
    env: "dev",
    sourceKey: "isolated_historical_fixture",
    coverage: "complete",
    validUntil: new Date(Date.now() + day).toISOString(),
    entries: Array.from({ length: 6 }, (_, i) => ({
      userId: `u_isolated_history_000${i}`,
      deptId: "dept_fixture",
      roleId: "role_fixture",
      eligible: true,
    })),
  });
  await post(hroot + `/directory/${historicalDirectory.id}/publish`, {});
  await mysql.pool.execute(
    "UPDATE organization_directory_versions SET published_at=? WHERE id=? AND project_id=? AND source_key='isolated_historical_fixture'",
    [new Date(start), historicalDirectory.id, historical.id],
  );
  const [historyRows] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT entries_json FROM organization_directory_versions WHERE id=? AND project_id=?",
    [historicalDirectory.id, historical.id],
  );
  const historyEntries =
    typeof historyRows[0]!.entries_json === "string"
      ? JSON.parse(historyRows[0]!.entries_json)
      : historyRows[0]!.entries_json;
  for (let i = 0; i < 6; i++) {
    const batch = structuredClone(original);
    batch.sdk.version = "0.6.0";
    batch.sentAt = start + 3000;
    const view = batch.events.find((e) => e.event === "page_view")!;
    const leave = batch.events.find((e) => e.event === "page_leave")!;
    assert(leave, "R4C_LEAVE_FIXTURE_REQUIRED");
    batch.events = [view, leave];
    for (const [j, event] of batch.events.entries())
      Object.assign(event, {
        eventId: `evt_${randomUUID().replaceAll("-", "")}`,
        appId: historical.appId,
        timestamp: start + 1000 * (j + 1),
        env: "dev",
        userId: historyEntries[i].userId,
        deptId: "dept_fixture",
        roleId: "role_fixture",
        pageRoute: "/",
        pageViewId: `pv_${randomUUID().replaceAll("-", "")}`,
      });
    leave.pageViewId = view.pageViewId;
    leave.payload = { visibleDurationMs: 1000 };
    assert(validateForConsumer(batch).ok, "R4C_ORGANIZATION_FIXTURE_CONTRACT");
    const historicalEnvelope: KafkaEventEnvelope = {
      envelopeVersion: 1,
      projectId: historical.id,
      receivedAt: new Date(start + 3000).toISOString(),
      requestId: randomUUID(),
      origin: "https://isolated.example.invalid",
      batch,
      enrichments: batch.events.map((e) => ({
        eventId: e.eventId,
        userId: e.userId,
        featureId: null,
        directoryVersionId: historicalDirectory.id,
      })),
    };
    await publisher.publish(historicalEnvelope);
    if (i < 4) {
      const small = structuredClone(historicalEnvelope);
      small.receivedAt = new Date(start + day + 3000).toISOString();
      small.batch.sentAt += day;
      small.requestId = randomUUID();
      const smallPageViewId = `pv_${randomUUID().replaceAll("-", "")}`;
      for (const event of small.batch.events) {
        event.pageViewId = smallPageViewId;
        event.eventId = `evt_${randomUUID().replaceAll("-", "")}`;
        event.timestamp += day;
      }
      small.enrichments = small.batch.events.map((e) => ({
        eventId: e.eventId,
        userId: e.userId,
        featureId: null,
        directoryVersionId: historicalDirectory.id,
      }));
      await publisher.publish(small);
    }
  }
  stage = "ORGANIZATION_REAL_AGGREGATE";
  const hquery = new URLSearchParams({
    env: "dev",
    range: "7d",
    moduleId: module.id,
    from: new Date(start).toISOString(),
    to: new Date(start + day).toISOString(),
  });
  let organization:
    | {
        values:
          | {
              groups: {
                active: number;
                eligible: number;
                observedRatio: number;
                pv: number;
                visibleDurationMs: number | null;
              }[];
            }[]
          | null;
        reason: string;
      }
    | undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(api + hroot + "/business?" + hquery, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, "R4C_ORGANIZATION_API_STATUS");
    organization = (
      (await response.json()) as { organization: NonNullable<typeof organization> }
    ).organization;
    if (organization.values?.[0]?.groups[0]?.pv === 6) break;
    await delay(500);
  }
  assert.equal(
    organization?.reason,
    "ORGANIZATION_ACTIVITY_COVERAGE_NOT_VERIFIED",
    "R4C_ORGANIZATION_COVERAGE",
  );
  assert.equal(organization?.values?.[0]?.groups.length, 2, "R4C_ORGANIZATION_GROUPS");
  for (const row of organization!.values![0]!.groups) {
    assert.equal(row.active, 6, "R4C_ORGANIZATION_ACTIVE");
    assert.equal(row.eligible, 6, "R4C_ORGANIZATION_ELIGIBLE");
    assert.equal(row.observedRatio, 1, "R4C_ORGANIZATION_RATIO");
    assert.equal(row.pv, 6, "R4C_ORGANIZATION_PV");
    assert.equal(row.visibleDurationMs, 6000, "R4C_ORGANIZATION_DURATION");
  }
  stage = "ORGANIZATION_SUPPRESSION_AND_PERFORMANCE";
  const smallQuery = new URLSearchParams(hquery);
  smallQuery.set("from", new Date(start + day).toISOString());
  smallQuery.set("to", new Date(start + 2 * day).toISOString());
  const smallResponse = await fetch(api + hroot + "/business?" + smallQuery, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(smallResponse.status, 200, "R4C_SMALL_GROUP_API_STATUS");
  const smallResult = (await smallResponse.json()) as {
    organization: { status: string; values: unknown };
  };
  assert.equal(
    smallResult.organization.status,
    "privacy_suppressed",
    "R4C_SMALL_GROUP_SUPPRESSION",
  );
  assert.equal(smallResult.organization.values, null, "R4C_SMALL_GROUP_FAMILY_NULL");
  const unionQuery = new URLSearchParams(hquery);
  unionQuery.set("to", new Date(start + 2 * day).toISOString());
  const unionResponse = await fetch(api + hroot + "/business?" + unionQuery, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(unionResponse.status, 200, "R4C_UNION_API_STATUS");
  assert.equal(
    ((await unionResponse.json()) as { organization: { values: unknown } }).organization
      .values,
    null,
    "R4C_UNION_FAMILY_NULL",
  );
  const rawMs: number[] = [],
    diagnostics: unknown[] = [];
  for (let i = 0; i < 23; i++) {
    const begin = performance.now();
    const response = await fetch(api + hroot + "/business?" + hquery, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, "R4C_ORGANIZATION_PERFORMANCE_STATUS");
    const body = (await response.json()) as { diagnostics: unknown };
    if (i >= 3) {
      rawMs.push(performance.now() - begin);
      diagnostics.push(body.diagnostics);
    }
  }
  const p95 = [...rawMs].sort((a, b) => a - b)[Math.ceil(rawMs.length * 0.95) - 1]!;
  assert(p95 <= 2000, "R4C_ORGANIZATION_P95_BUDGET");
  evidence.performanceSamples = [
    {
      warmups: 3,
      sampleCount: 20,
      p95Algorithm: "nearest-rank",
      p95,
      rawMs,
      diagnostics,
      scope: "isolated 6-person fixture; not production capacity",
    },
  ];
  evidence.organization = {
    observedActive: 6,
    eligible: 6,
    observedRatio: 1,
    pv: 6,
    visibleDurationMs: 6000,
    source: "isolated historical MySQL snapshot; Kafka/consumer/ClickHouse/API facts",
    completeBusinessActivityCoverage: false,
  };
  stage = "R4C_VERSION_UPGRADE";
  const oldVersion = await post<{ id: string }>(hroot + "/metrics/versions", {
    type: "operational",
  });
  // Test-owned draft representing the inherited system-v1.8.0 snapshot; never modify an active snapshot.
  await mysql.pool.execute(
    "UPDATE metric_definitions SET definition_version='system-v1.8.0',implementation_status='not_collected',unit=CASE WHEN metric_key IN ('dept_usage','role_usage') THEN 'ratio' ELSE unit END WHERE library_version_id=? AND milestone='R4-C'",
    [oldVersion.id],
  );
  await post(hroot + `/metrics/versions/${oldVersion.id}/activate`, {});
  async function definitions(versionId: string) {
    const response = await fetch(api + hroot + `/metrics/versions/${versionId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200, "R4C_VERSION_READ_STATUS");
    return response.json() as Promise<{
      definitions: {
        metricKey: string;
        definitionVersion: string;
        implementationStatus: string;
      }[];
    }>;
  }
  const beforeRefresh = await definitions(oldVersion.id);
  await post(hroot + `/metrics/versions/${oldVersion.id}/r4c-facts`, {}, 409);
  const updated = await post<{ id: string }>(hroot + "/metrics/versions", {
    type: "operational",
    sourceVersionId: oldVersion.id,
  });
  await post(hroot + `/metrics/versions/${updated.id}/r4c-facts`, {});
  const newSnapshot = await definitions(updated.id);
  assert.equal(
    newSnapshot.definitions.find((d) => d.metricKey === "form_efficiency")
      ?.definitionVersion,
    "r4c-facts-2026-09-29.1",
    "R4C_NEW_DEFINITION_VERSION",
  );
  assert.equal(
    newSnapshot.definitions.find((d) => d.metricKey === "form_efficiency")
      ?.implementationStatus,
    "partial",
    "R4C_STATUS_HONEST",
  );
  assert.equal(
    JSON.stringify((await definitions(oldVersion.id)).definitions),
    JSON.stringify(beforeRefresh.definitions),
    "R4C_OLD_ACTIVE_IMMUTABLE",
  );
  const binding = await fetch(
    api + hroot + `/metrics/versions/${updated.id}/business-bindings`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        metricKeys: [
          "form_efficiency",
          "operation_fail_rate",
          "dept_usage",
          "role_usage",
          "role_feature_profile",
        ],
      }),
    },
  );
  assert.equal(binding.status, 200, "R4C_BINDING_STATUS");
  const reviewed = await post<{ valid: boolean }>(
    hroot + `/metrics/versions/${updated.id}/validate`,
    {},
    200,
  );
  assert(reviewed.valid, "R4C_DRAFT_VALIDATION");
  await post(hroot + `/metrics/versions/${updated.id}/activate`, {});
  assert.equal(
    JSON.stringify((await definitions(oldVersion.id)).definitions),
    JSON.stringify(beforeRefresh.definitions),
    "R4C_OLD_HISTORY_IMMUTABLE",
  );
  evidence.metricVersions = {
    draftRefreshed: true,
    activeRefreshRejected: true,
    oldDefinitionsUnchanged: true,
    bindingsVerified: true,
    validationPassed: true,
    newDraftActivated: true,
    scope: "isolated test project only",
  };
  Object.assign(evidence, {
    passed: true,
    uniqueEvents: 2,
    publications: 2,
    legacyFactPreserved: true,
    browserClaimsRemoved: true,
    historicalVersionPreserved: true,
    replayUsesOriginalEventAndReceivedTime: true,
  });
} catch (cause) {
  const code =
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z0-9_]{1,64}$/.test(cause.code)
      ? cause.code
      : "UNEXPECTED";
  Object.assign(evidence, { failureStage: stage, errorCode: code });
  console.error(JSON.stringify({ code: "R4C_REPLAY_FAILED", stage, errorCode: code }));
  process.exitCode = 1;
} finally {
  const dir = process.env.FI_EVIDENCE_DIR ?? "artifacts";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/r4c-integration.json", JSON.stringify(evidence, null, 2));
  await Promise.allSettled([publisher.disconnect(), mysql.close(), ch.close()]);
}
