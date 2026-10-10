import { Kafka, logLevel } from "kafkajs";
import { createHash } from "node:crypto";
// Synthetic D0 fixtures against the disposable CI service stack only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { hash } from "bcryptjs";
import { validBatches } from "@frontend-insight/test-fixtures";
import type {
  DiagnosticEnvelope,
  FrontendInsightEventBatchV3,
} from "@frontend-insight/event-contract";
import type { RowDataPacket } from "mysql2/promise";
import { MySqlStore } from "../src/mysql-store.js";
import { RuntimeDiagnostics } from "../src/runtime-diagnostics.js";
import { SettingsService } from "../src/settings.js";
import { SafeClickHouseLogger } from "../src/clickhouse-logger.js";
const base = process.env.FI_API_URL ?? "http://api:3000";
if (
  !process.env.MYSQL_URL ||
  !["api", "127.0.0.1", "localhost"].includes(new URL(base).hostname)
)
  throw new Error("ISOLATED_SERVICES_REQUIRED");
const mysql = new MySqlStore(process.env.MYSQL_URL);
const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
  username: process.env.CLICKHOUSE_USERNAME ?? "frontend_insight",
  password: process.env.CLICKHOUSE_PASSWORD ?? "m24-clickhouse-local-only",
  database: "frontend_insight",
  log: { LoggerClass: SafeClickHouseLogger },
});
const diagnostics = new RuntimeDiagnostics(mysql);
const raw = {
  message: "token=FI_D0_SYNTHETIC\nsecond line",
  stack:
    "Error: synthetic\n at fixture (https://fixture.invalid/app.js?token=synthetic:1:2)",
  url: "https://fixture.invalid/path?token=synthetic#hash",
  nested: { password: "synthetic", items: [1, { authorization: "Bearer synthetic" }] },
};
const d: DiagnosticEnvelope = {
  diagnosticVersion: 1,
  contentType: "application/json",
  source: "explicit",
  policyVersion: "d0-1",
  status: "complete",
  omittedBytes: 0,
  suppressed: 0,
  correlation: { traceId: "fixture_trace" },
  raw,
};
async function call(
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
  status = 200,
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin: "http://127.0.0.1:4174",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(r.status, status, `${method} ${path}: ${r.status}`);
  if (path.includes("/diagnostics/") && status === 200)
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  return (await r.json()) as Record<string, unknown>;
}
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean) {
  for (let i = 0; i < 60; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("D0_SERVICE_TIMEOUT");
}
let renamed = false;
try {
  const login = await call("/api/auth/login", "", "POST", {
    email: "admin@example.invalid",
    password: "LocalAdmin-1234",
  });
  const token = String(login.accessToken);
  const project = await call(
    "/api/projects",
    token,
    "POST",
    {
      name: "D0 isolated " + randomUUID(),
      timezone: "UTC",
      origins: ["http://127.0.0.1:4174"],
    },
    201,
  );
  const pid = String(project.id),
    app = String(project.appId),
    root = `/api/projects/${pid}/diagnostics`;
  const [admins] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE email='admin@example.invalid'",
  );
  const actor = {
    userId: String(admins[0]!.id),
    globalRole: "admin" as const,
    displayName: "D0",
    email: null,
  };
  const viewerId = await mysql.createLocalUser({
    email: `d0-${randomUUID()}@example.invalid`,
    displayName: "D0 viewer",
    globalRole: "viewer",
    passwordHash: await hash("LocalViewer-1234", 4),
  });
  const [viewer] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT email FROM users WHERE id=?",
    [viewerId],
  );
  const viewerToken = String(
    (
      await call("/api/auth/login", "", "POST", {
        email: viewer[0]!.email,
        password: "LocalViewer-1234",
      })
    ).accessToken,
  );
  await mysql.pool.execute(
    "INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'viewer')",
    [pid, viewerId],
  );
  const make = (
    envelope: DiagnosticEnvelope | undefined = d,
  ): FrontendInsightEventBatchV3 => {
    const b = structuredClone(validBatches[0]!);
    b.sentAt = Date.now();
    b.events = [
      {
        ...b.events[0]!,
        appId: app,
        eventId: "evt_" + randomUUID().replaceAll("-", ""),
        pageViewId: "pv_d0_shared0000",
        env: "dev",
        timestamp: Date.now(),
        event: "error",
        payload: {
          errorType: "js",
          errorCategory: "js",
          errorName: "Error",
          errorMessage: "Explicit diagnostic",
          stackTopFrame: "",
        },
        ...(envelope ? { diagnostic: structuredClone(envelope) } : {}),
      },
    ];
    return b;
  };
  const b = make(),
    event = b.events[0]!.eventId,
    path = root + "/instances/" + event;
  await call("/v1/events", "", "POST", b, 202);
  const ready = await until(
    () => call(path, token),
    (v) => v.state === "ready",
  );
  assert.deepEqual(ready.diagnostic, d);
  await call(path, viewerToken, "GET", undefined, 403);
  await call(path, "", "GET", undefined, 401);
  // Real legacy external credential remains unable to read diagnostics.
  const settings = new SettingsService(mysql),
    now = Date.now();
  const iface = await settings.createInterface(
    pid,
    actor.userId,
    "metric_snapshot",
    {
      env: "dev",
      from: new Date(now - 3600000).toISOString(),
      to: new Date(now).toISOString(),
      maxRangeDays: 1,
      expiresAt: new Date(now + 3600000).toISOString(),
      rateLimit: 5,
    },
    randomUUID(),
  );
  const issued = await settings.changeInterface(
    pid,
    actor.userId,
    iface.id,
    "enable",
    randomUUID(),
  );
  await call(path, issued.token!, "GET", undefined, 401);
  await call(root + "/grants/" + viewerId, token, "PUT", { read: true, export: false });
  assert.deepEqual((await call(path, viewerToken)).diagnostic, d);
  assert.deepEqual(await call(root + "/capabilities", viewerToken), {
    read: true,
    export: false,
  });
  await call(
    root + "/grants/" + viewerId,
    viewerToken,
    "PUT",
    { read: true, export: true },
    403,
  );
  await call(
    root + "/grants/" + viewerId,
    token,
    "PUT",
    { read: false, export: true },
    400,
  );
  await call(root + "/grants/" + viewerId, token, "PUT", { read: true, export: true });
  assert.equal((await call(root + "/capabilities", viewerToken)).export, true);
  const other = await call(
    "/api/projects",
    token,
    "POST",
    {
      name: "D0 cross " + randomUUID(),
      timezone: "UTC",
      origins: ["http://127.0.0.1:4174"],
    },
    201,
  );
  await call(
    `/api/projects/${other.id}/diagnostics/instances/${event}`,
    viewerToken,
    "GET",
    undefined,
    403,
  );
  await call(root + "/grants/" + viewerId, token, "PUT", {
    read: false,
    export: false,
  });
  await call(path, viewerToken, "GET", undefined, 403);
  await call(root + "/grants/" + viewerId, token, "PUT", { read: true, export: true });
  await mysql.pool.execute(
    "DELETE FROM project_members WHERE project_id=? AND user_id=?",
    [pid, viewerId],
  );
  await call(path, viewerToken, "GET", undefined, 403);
  await mysql.pool.execute(
    "INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'viewer')",
    [pid, viewerId],
  );
  await call(path, viewerToken, "GET", undefined, 403); // removal also erased old grant
  // Retried IDs do not consume more admission capacity or overwrite evidence.
  for (let i = 0; i < 3; i++) await call("/v1/events", "", "POST", b, 202);
  const changed = structuredClone(b);
  changed.events[0]!.diagnostic!.raw = { message: "different" };
  await call("/v1/events", "", "POST", changed, 409);
  const batch = make();
  batch.events = Array.from({ length: 22 }, () => make().events[0]!);
  await call("/v1/events", "", "POST", batch, 202);
  const limitedPath = root + "/instances/" + batch.events.at(-1)!.eventId;
  const limited = await call(limitedPath, token);
  assert.equal(limited.state, "rate_limited");
  assert.equal((limited.capture as { suppressed: number }).suppressed, 1);
  assert(!JSON.stringify(limited).includes("FI_D0_SYNTHETIC"));
  const count = async () => {
    const response = await ch.query({
      query:
        "SELECT uniqExact(event_id) AS n FROM raw_events WHERE project_id={p:UUID} AND event='error'",
      format: "JSONEachRow",
      query_params: { p: pid },
    });
    return Number((await response.json<{ n: string }>())[0]!.n);
  };
  await until(count, (n) => n === 23);
  const [rates] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT MAX(admitted) n FROM diagnostic_rate_windows WHERE project_id=?",
    [pid],
  );
  assert.equal(Number(rates[0]!.n), 20);
  const listed = await call(
    `/api/projects/${pid}/observability/occurrences?env=dev&range=7d&mode=all`,
    viewerToken,
  );
  assert(!JSON.stringify(listed).includes("FI_D0_SYNTHETIC"));
  assert(!JSON.stringify(listed).includes('"diagnostic"'));
  const rawRows = await ch.query({
    query: "SELECT payload_json FROM raw_events WHERE project_id={p:UUID}",
    format: "JSONEachRow",
    query_params: { p: pid },
  });
  assert(!(await rawRows.text()).includes("FI_D0_SYNTHETIC"));
  // Old SDK remains accepted and has no detail without implying absence of an error.
  const old = make(undefined);
  delete old.events[0]!.diagnostic;
  await call("/v1/events", "", "POST", old, 202);
  assert.equal(
    (await call(root + "/instances/" + old.events[0]!.eventId, token)).state,
    "not_enabled",
  );
  await until(count, (n) => n === 24);
  // Incremental policy affects new receipts only.
  await call(root + "/policy", token, "PUT", { retentionDays: 1 });
  const ttl = make();
  ttl.events[0]!.pageViewId = "pv_d0_ttl000000";
  await call("/v1/events", "", "POST", ttl, 202);
  await until(
    () => call(root + "/instances/" + ttl.events[0]!.eventId, token),
    (v) => v.state === "ready",
  );
  const [expiry] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT TIMESTAMPDIFF(DAY,created_at,expires_at) days FROM diagnostic_receipts WHERE project_id=? AND event_id=?",
    [pid, ttl.events[0]!.eventId],
  );
  assert.equal(Number(expiry[0]!.days), 1);
  await mysql.pool.execute(
    "UPDATE diagnostic_receipts SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE project_id=? AND event_id=?",
    [pid, ttl.events[0]!.eventId],
  );
  assert.equal(
    (await call(root + "/instances/" + ttl.events[0]!.eventId, token)).state,
    "expired",
  );
  // Real partial write: base raw insert succeeds while the detail table is unavailable.
  await ch.command({
    query: "RENAME TABLE diagnostic_details TO diagnostic_details_d0_fault",
  });
  renamed = true;
  const failing = make();
  failing.events[0]!.pageViewId = "pv_d0_fault0000";
  await call("/v1/events", "", "POST", failing, 202);
  const failPath = root + "/instances/" + failing.events[0]!.eventId;
  await until(
    () => call(failPath, token),
    (v) => v.state === "write_failed",
  );
  await until(count, (n) => n === 26);
  await ch.command({
    query: "RENAME TABLE diagnostic_details_d0_fault TO diagnostic_details",
  });
  renamed = false;
  await until(
    () => call(failPath, token),
    (v) => v.state === "ready",
  );
  assert.equal(await count(), 26);
  // CH TTL and read filter, even before asynchronous physical deletion.
  await ch.command({
    query:
      "ALTER TABLE diagnostic_details UPDATE expires_at=now()-INTERVAL 1 SECOND WHERE project_id={p:UUID} AND event_id={e:String}",
    query_params: { p: pid, e: event },
    clickhouse_settings: { mutations_sync: "1" },
  });
  assert.equal((await call(path, token)).state, "unavailable");
  await ch.command({
    query: "ALTER TABLE diagnostic_details MATERIALIZE TTL",
    clickhouse_settings: { mutations_sync: "1" },
  });
  const remaining = await ch.query({
    query:
      "SELECT count() n FROM diagnostic_details WHERE project_id={p:UUID} AND event_id={e:String}",
    format: "JSONEachRow",
    query_params: { p: pid, e: event },
  });
  assert.equal(Number((await remaining.json<{ n: string }>())[0]!.n), 0);
  const [audits] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT * FROM diagnostic_audit WHERE project_id=?",
    [pid],
  );
  assert(
    audits.some((a) => a.result === "forbidden") &&
      audits.some((a) => a.result === "unauthenticated") &&
      audits.some((a) => a.result === "ready"),
  );
  assert(!JSON.stringify(audits).includes("FI_D0_SYNTHETIC"));
  await diagnostics.cleanup();
  const kafka = new Kafka({
    brokers: (process.env.KAFKA_BROKERS ?? "kafka:9092").split(","),
    clientId: "d0-fixture",
    logLevel: logLevel.NOTHING,
  });
  const poison = JSON.stringify({
    envelopeVersion: 1,
    projectId: String(other.id),
    requestId: randomUUID(),
    receivedAt: new Date().toISOString(),
    origin: "http://127.0.0.1:4174",
    enrichments: [],
    batch: {
      ...b,
      events: b.events.map((e) => ({ ...e, userId: null, deptId: null, roleId: null })),
    },
  });
  const poisonHash = createHash("sha256").update(poison).digest("hex");
  const dead = kafka.consumer({ groupId: "d0-dlq-" + randomUUID() }),
    producer = kafka.producer();
  let dlqSafe = false;
  await dead.connect();
  await dead.subscribe({
    topic: "frontend-insight.events.dlq.v1",
    fromBeginning: true,
  });
  await dead.run({
    eachMessage: async ({ message }) => {
      const value = message.value?.toString() ?? "";
      if (value.includes(poisonHash)) {
        assert(!value.includes("FI_D0_SYNTHETIC"));
        assert(value.includes("DIAGNOSTICS_PROJECT_CONTEXT_INVALID"));
        dlqSafe = true;
      }
    },
  });
  await producer.connect();
  try {
    await producer.send({
      topic: "frontend-insight.events.v1",
      messages: [{ key: pid, value: poison }],
    });
    await until(
      async () => dlqSafe,
      (v) => v,
    );
  } finally {
    await producer.disconnect();
    await dead.disconnect();
  }
  const evidence = {
    testedCommit: process.env.GITHUB_SHA,
    projectId: pid,
    rawRoundtrip: true,
    dlqMetadataOnly: true,
    roleMatrix: true,
    revocation: true,
    externalTokenDenied: true,
    retries: true,
    rateLimitBaseCount: 26,
    ttl: true,
    partialWriteRetry: true,
    legacyV3: true,
  };
  const dir = process.env.FI_EVIDENCE_DIR ?? "artifacts";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/d0-services.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (renamed)
    await ch.command({
      query: "RENAME TABLE diagnostic_details_d0_fault TO diagnostic_details",
    });
  await Promise.all([mysql.close(), ch.close()]);
}
