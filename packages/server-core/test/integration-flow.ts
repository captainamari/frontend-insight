import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import type { FrontendInsightEventBatchV1 } from "@frontend-insight/event-contract";
import { contractScenarios } from "@frontend-insight/test-fixtures";
import { hash } from "bcryptjs";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";

const apiUrl = process.env.M24_API_URL ?? "http://127.0.0.1:3000";
const mysqlUrl = process.env.MYSQL_URL;
const clickhouseUrl = process.env.CLICKHOUSE_URL;
if (!mysqlUrl || !clickhouseUrl) throw new Error("INTEGRATION_ENVIRONMENT_MISSING");

const projectId = "11111111-1111-4111-8111-111111111111";
const adminId = "55555555-5555-4555-8555-555555555555";
const viewerId = "88888888-8888-4888-8888-888888888888";
const adminPassword = "LocalAdmin-1234";
const viewerPassword = "LocalViewer-1234";
const origin = "http://localhost:4173";
const featureIds = {
  sales_dashboard: "22222222-2222-4222-8222-222222222222",
  report_export: "33333333-3333-4333-8333-333333333333",
  operations_wallboard: "44444444-4444-4444-8444-444444444444",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FLOW_ASSERTION_FAILED: ${message}`);
}

async function jsonRequest(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) body = JSON.parse(text) as Record<string, unknown>;
  return { response, body };
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", ...extra };
}

function shiftBatch(
  source: FrontendInsightEventBatchV1,
  sentAtMs: number,
): FrontendInsightEventBatchV1 {
  const sourceSentAt = Date.parse(source.sentAt);
  const batch = structuredClone(source);
  batch.sentAt = new Date(sentAtMs).toISOString();
  batch.events = batch.events.map((event) => ({
    ...event,
    eventTime: new Date(
      sentAtMs + Date.parse(event.eventTime) - sourceSentAt,
    ).toISOString(),
  })) as FrontendInsightEventBatchV1["events"];
  return batch;
}

async function seed(): Promise<void> {
  const pool = mysql.createPool(mysqlUrl!);
  const adminHash = await hash(adminPassword, 12);
  const viewerHash = await hash(viewerPassword, 12);
  try {
    await pool.execute(
      `INSERT INTO users (id, display_name, email, status, global_role)
       VALUES (?, 'Local Admin', 'admin@example.invalid', 'active', 'admin')
       ON DUPLICATE KEY UPDATE status = 'active', global_role = 'admin'`,
      [adminId],
    );
    await pool.execute(
      `INSERT INTO users (id, display_name, email, status, global_role)
       VALUES (?, 'Local Viewer', 'viewer@example.invalid', 'active', 'viewer')
       ON DUPLICATE KEY UPDATE status = 'active', global_role = 'viewer'`,
      [viewerId],
    );
    await pool.execute(
      `INSERT INTO identities (id, user_id, provider, subject, password_hash)
       VALUES (?, ?, 'local', ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), password_hash = VALUES(password_hash)`,
      [
        "66666666-6666-4666-8666-666666666666",
        adminId,
        "admin@example.invalid",
        adminHash,
      ],
    );
    await pool.execute(
      `INSERT INTO identities (id, user_id, provider, subject, password_hash)
       VALUES (?, ?, 'local', ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), password_hash = VALUES(password_hash)`,
      [
        "99999999-9999-4999-8999-999999999999",
        viewerId,
        "viewer@example.invalid",
        viewerHash,
      ],
    );
    await pool.execute(
      `INSERT INTO projects
         (id, project_key, name, timezone, status, retention_days, created_by_user_id)
       VALUES (?, 'fi_public_m1demo001', 'M2-M4 Fixture Project', 'UTC', 'active', 90, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'active', disabled_at = NULL`,
      [projectId, adminId],
    );
    await pool.execute(
      `INSERT INTO project_origins (id, project_id, origin, enabled)
       VALUES (?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE enabled = TRUE`,
      ["77777777-7777-4777-8777-777777777777", projectId, origin],
    );
    for (const [userId, role] of [
      [adminId, "owner"],
      [viewerId, "viewer"],
    ] as const) {
      await pool.execute(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
        [projectId, userId, role],
      );
    }
    const featureRows = [
      [featureIds.sales_dashboard, "sales_dashboard", "Sales dashboard", "data_view"],
      [featureIds.report_export, "report_export", "Report export", "action"],
      [
        featureIds.operations_wallboard,
        "operations_wallboard",
        "Operations wallboard",
        "long_view",
      ],
    ] as const;
    for (const [id, key, name, type] of featureRows) {
      await pool.execute(
        `INSERT INTO features
           (id, project_id, feature_key, name, feature_type, launched_at, status)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), 'active')
         ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'active', disabled_at = NULL`,
        [id, projectId, key, name, type],
      );
    }
    await pool.execute(
      `INSERT INTO project_data_status (project_id) VALUES (?)
       ON DUPLICATE KEY UPDATE project_id = VALUES(project_id)`,
      [projectId],
    );
  } finally {
    await pool.end();
  }
}

async function login(email: string, password: string) {
  const result = await jsonRequest("/api/auth/login", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password }),
  });
  assert(result.response.status === 200, `${email} login must return 200`);
  const accessToken = result.body.accessToken;
  const cookie = result.response.headers.get("set-cookie")?.split(";")[0];
  assert(typeof accessToken === "string", "login must return an access token");
  assert(
    typeof cookie === "string" && cookie.startsWith("fi_refresh="),
    "login must set an HttpOnly refresh cookie",
  );
  return { accessToken, cookie };
}

async function rawCount(client: ReturnType<typeof createClient>): Promise<number> {
  const response = await client.query({
    query:
      "SELECT count() AS count FROM raw_events WHERE project_id = {projectId:UUID}",
    query_params: { projectId },
    format: "JSONEachRow",
  });
  const rows = await response.json<{ count: string }>();
  return Number(rows[0]?.count ?? 0);
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`FLOW_TIMEOUT: ${description}`);
}

async function main(): Promise<void> {
  await seed();
  const clickhouse = createClient({
    url: clickhouseUrl!,
    username: process.env.CLICKHOUSE_USERNAME ?? "frontend_insight",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    database: process.env.CLICKHOUSE_DATABASE ?? "frontend_insight",
  });
  const startedAt = Date.now();
  try {
    const baselineRows = await rawCount(clickhouse);
    const batches = contractScenarios.map((scenario, index) =>
      shiftBatch(scenario.valid, startedAt - 5_000 - index * 1_000),
    );
    for (const batch of [...batches, ...batches]) {
      const accepted = await jsonRequest("/v1/events", {
        method: "POST",
        headers: jsonHeaders({ origin }),
        body: JSON.stringify(batch),
      });
      assert(
        accepted.response.status === 202,
        `ingestion rejected: ${JSON.stringify(accepted.body)}`,
      );
    }
    const insertedRows =
      batches.reduce((sum, batch) => sum + batch.events.length, 0) * 2;
    await waitFor(
      "Kafka events to become queryable",
      async () => (await rawCount(clickhouse)) >= baselineRows + insertedRows,
    );

    const admin = await login("admin@example.invalid", adminPassword);
    const viewer = await login("viewer@example.invalid", viewerPassword);
    const adminHeaders = jsonHeaders({ authorization: `Bearer ${admin.accessToken}` });
    const viewerHeaders = jsonHeaders({
      authorization: `Bearer ${viewer.accessToken}`,
    });

    const users = await jsonRequest("/api/admin/users", { headers: adminHeaders });
    assert(
      users.response.status === 200,
      "admin can list local users without password data",
    );
    assert(
      !JSON.stringify(users.body).includes("password"),
      "user API must never return password fields",
    );
    const membership = await jsonRequest(
      `/api/projects/${projectId}/members/${viewerId}`,
      {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    assert(membership.response.status === 200, "admin can maintain project membership");

    const viewerProjects = await jsonRequest("/api/projects", {
      headers: viewerHeaders,
    });
    assert(
      viewerProjects.response.status === 200,
      "viewer can list authorized projects",
    );
    const forbidden = await jsonRequest(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: viewerHeaders,
      body: JSON.stringify({ name: "forbidden" }),
    });
    assert(forbidden.response.status === 403, "viewer write must be forbidden");
    const memberListForbidden = await jsonRequest(
      `/api/projects/${projectId}/members`,
      {
        headers: viewerHeaders,
      },
    );
    assert(
      memberListForbidden.response.status === 403,
      "viewer cannot enumerate project membership",
    );

    const query = new URLSearchParams({
      from: new Date(startedAt - 10 * 60_000).toISOString(),
      to: new Date(startedAt + 60_000).toISOString(),
      timezone: "UTC",
      granularity: "hour",
    });
    const overview = await jsonRequest(
      `/api/projects/${projectId}/analytics/overview?${query}`,
      { headers: adminHeaders },
    );
    assert(
      overview.response.status === 200,
      `overview failed: ${JSON.stringify(overview.body)}`,
    );
    const current = overview.body.current as Record<string, number>;
    assert(
      current.pv === 3,
      `query-side eventId dedupe expected 3 PV, got ${current.pv}`,
    );
    assert(current.visitors === 3, "overview must expose browser count");
    assert(current.accounts === 3, "overview must expose HMAC account count");

    const features = await jsonRequest(
      `/api/projects/${projectId}/analytics/features?${query}`,
      { headers: adminHeaders },
    );
    assert(
      features.response.status === 200,
      `features failed: ${JSON.stringify(features.body)}`,
    );
    const featureItems = features.body.items as Array<Record<string, unknown>>;
    for (const scenario of contractScenarios) {
      const item = featureItems.find(
        (candidate) => candidate.featureKey === scenario.golden.featureKey,
      );
      assert(item, `feature result missing ${scenario.golden.featureKey}`);
      assert(
        item.success_count === 1,
        `${scenario.golden.featureKey} success must dedupe to one`,
      );
    }

    const detail = await jsonRequest(
      `/api/projects/${projectId}/analytics/features/${featureIds.operations_wallboard}?${query}`,
      { headers: adminHeaders },
    );
    assert(
      detail.response.status === 200,
      `feature detail failed: ${JSON.stringify(detail.body)}`,
    );
    const detailMetrics = detail.body.metrics as Record<string, number>;
    assert(
      detailMetrics.visible_duration_ms === 120_000,
      "long-view duration must use max cumulative heartbeat",
    );
    assert(
      Array.isArray(detail.body.trend),
      "feature detail must include trend points",
    );

    const status = await jsonRequest(`/api/projects/${projectId}/data-status`, {
      headers: adminHeaders,
    });
    assert(
      status.body.state === "healthy",
      `data status expected healthy: ${JSON.stringify(status.body)}`,
    );
    const metrics = await jsonRequest("/api/system/metrics", { headers: adminHeaders });
    assert(metrics.response.status === 200, "admin can inspect ingestion metrics");

    const refreshed = await jsonRequest("/api/auth/refresh", {
      method: "POST",
      headers: { cookie: admin.cookie },
    });
    assert(refreshed.response.status === 200, "refresh cookie must rotate the session");
    const rotatedCookie = refreshed.response.headers.get("set-cookie")?.split(";")[0];
    assert(
      typeof rotatedCookie === "string" && rotatedCookie !== admin.cookie,
      "refresh token must rotate",
    );
    const logout = await jsonRequest("/api/auth/logout", {
      method: "POST",
      headers: { cookie: rotatedCookie },
    });
    assert(logout.response.status === 204, "logout must revoke refresh session");

    const disabled = await jsonRequest(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "disabled" }),
    });
    assert(disabled.response.status === 200, "admin can disable a project");
    const rejected = await jsonRequest("/v1/events", {
      method: "POST",
      headers: jsonHeaders({ origin }),
      body: JSON.stringify(batches[0]),
    });
    assert(
      rejected.response.status === 403 && rejected.body.code === "PROJECT_DISABLED",
      "disabled projects must reject ingestion explicitly",
    );
    await jsonRequest(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "active" }),
    });

    const pool = mysql.createPool(mysqlUrl!);
    const [auditRows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE project_id = ? AND action = 'project.updated'",
      [projectId],
    );
    await pool.end();
    assert(Number(auditRows[0]?.count ?? 0) >= 2, "management changes must be audited");

    console.log(
      JSON.stringify({
        status: "passed",
        insertedRows,
        deduplicatedEvents: insertedRows / 2,
        overview: current,
        featureCount: featureItems.length,
        longViewVisibleDurationMs: detailMetrics.visible_duration_ms,
        dataState: status.body.state,
        runId: randomUUID(),
      }),
    );
  } finally {
    await clickhouse.close();
  }
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.stack : String(cause));
  process.exitCode = 1;
});
