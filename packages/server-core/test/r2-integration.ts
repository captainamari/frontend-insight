import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createClient } from "@clickhouse/client";
import type { RowDataPacket } from "mysql2/promise";
import { MySqlStore } from "../src/mysql-store.js";
import { MetricLibraryService } from "../src/metric-library.js";
import { ScoreManagementService } from "../src/score-management.js";
import { ProjectSummaryService } from "../src/project-summary.js";
import { AnalyticsStore } from "../src/analytics.js";
import { defaultScoreTemplate } from "../src/score-templates.js";
import type { Principal, ProjectRecord } from "../src/model.js";
const apiUrl = process.env.FI_API_URL ?? "http://127.0.0.1:3000";
if (!process.env.MYSQL_URL) throw new Error("MYSQL_URL_REQUIRED");
const mysql = new MySqlStore(process.env.MYSQL_URL),
  pool = mysql.pool;
const chConfig = {
  url: process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
  username: process.env.CLICKHOUSE_USERNAME ?? "frontend_insight",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: "frontend_insight",
};
const ch = createClient(chConfig),
  analytics = new AnalyticsStore(chConfig, mysql),
  scores = new ScoreManagementService(mysql, new MetricLibraryService(mysql)),
  summaryService = new ProjectSummaryService(mysql, scores, analytics);
type Summary = Awaited<ReturnType<ProjectSummaryService["summary"]>>;
async function login(role: "admin" | "viewer") {
  const r = await fetch(apiUrl + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: role + "@example.invalid",
      password: role === "admin" ? "LocalAdmin-1234" : "LocalViewer-1234",
    }),
  });
  assert.equal(r.status, 200);
  return (await r.json()) as {
    accessToken: string;
    user: { userId: string; id?: string };
  };
}
async function call<T>(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
): Promise<T> {
  const r = await fetch(apiUrl + path, {
    signal: AbortSignal.timeout(15000),
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  assert.equal(r.status, status, `${method} ${path}: ${text}`);
  if (status >= 400) {
    const error = JSON.parse(text) as { requestId: string };
    assert(error.requestId);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
const templates = {
  operational: defaultScoreTemplate("operational").version,
  quality: defaultScoreTemplate("quality").version,
};
const base = {
  timezone: "Asia/Shanghai",
  retentionDays: 90,
  origins: ["http://localhost:4173"],
  templates,
};
const range = {
  range: "7d" as const,
  env: "prod" as const,
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-08T00:00:00.000Z",
};
const search = "R2 入口验收 " + (process.env.GITHUB_RUN_ID ?? Date.now()) + " ";
const query = (extra: Record<string, string> = {}) =>
  "/api/projects/summary?" +
  new URLSearchParams({ ...range, search, page: "1", pageSize: "12", ...extra });
const evidence: Record<string, unknown> = {
  testedCommit: process.env.GITHUB_SHA,
  search,
};
try {
  const a = await login("admin"),
    v = await login("viewer"),
    adminToken = a.accessToken,
    viewerToken = v.accessToken;
  const [users] = await pool.query<RowDataPacket[]>(
    "SELECT id,global_role,display_name FROM users WHERE email IN ('admin@example.invalid','viewer@example.invalid')",
  );
  const au = users.find((u) => u.global_role === "admin")!,
    vu = users.find((u) => u.global_role === "viewer")!;
  const actor: Principal = {
    userId: String(au.id),
    globalRole: "admin",
    displayName: "Admin",
    email: null,
  };
  await call(viewerToken, "/api/projects", "POST", { ...base, name: "forged" }, 403);
  await call(viewerToken, "/api/projects/templates", "GET", undefined, 403);
  for (const origin of [
    "https://*.example.com",
    "https://example.com/x",
    "https://example.com?secret=x",
    "https://example.com/#hash",
  ])
    await call(
      adminToken,
      "/api/projects",
      "POST",
      { ...base, name: "invalid", origins: [origin] },
      400,
    );
  const failedName = search + "rollback";
  await call(
    adminToken,
    "/api/projects",
    "POST",
    {
      ...base,
      name: failedName,
      creationId: randomUUID(),
      templates: { ...templates, quality: "invalid-version" },
    },
    400,
  );
  assert.equal(
    (
      await pool.query<RowDataPacket[]>("SELECT id FROM projects WHERE name=?", [
        failedName,
      ])
    )[0].length,
    0,
    "quality failure must roll back project AND operational draft",
  );
  const request = { ...base, name: search + "00", creationId: randomUUID() };
  const [first, retry] = await Promise.all([
    call<ProjectRecord>(adminToken, "/api/projects", "POST", request, 201),
    call<ProjectRecord>(adminToken, "/api/projects", "POST", request, 201),
  ]);
  assert.equal(first.id, retry.id);
  const simultaneousRetries = await Promise.all(
    Array.from({ length: 12 }, () =>
      call<ProjectRecord>(adminToken, "/api/projects", "POST", request, 201),
    ),
  );
  assert(
    simultaneousRetries.every((project) => project.id === first.id),
    "retries exceeding pool size stay idempotent without connection starvation",
  );
  await call(
    adminToken,
    "/api/projects",
    "POST",
    { ...request, name: request.name + " changed" },
    409,
  );
  const projects = [first];
  for (let i = 1; i < 20; i++)
    projects.push(
      await call<ProjectRecord>(
        adminToken,
        "/api/projects",
        "POST",
        {
          ...base,
          name: search + String(i).padStart(2, "0"),
          timezone: i % 2 ? "America/New_York" : "Asia/Shanghai",
          creationId: randomUUID(),
        },
        201,
      ),
    );
  for (const project of projects)
    await mysql.setProjectMember({
      projectId: project.id,
      userId: String(vu.id),
      role: "viewer",
      actor,
    });
  const hidden = await call<ProjectRecord>(
    adminToken,
    "/api/projects",
    "POST",
    { ...base, name: "R2 secret " + randomUUID() },
    201,
  );
  await call(viewerToken, `/api/projects/${hidden.id}/access`, "GET", undefined, 403);
  await call(
    viewerToken,
    `/api/projects/${hidden.id}/scores/quality_score?` +
      new URLSearchParams({
        env: "prod",
        from: range.from,
        to: range.to,
        granularity: "day",
      }),
    "GET",
    undefined,
    403,
  );
  const invisible = await call<Summary>(
    viewerToken,
    query({ search: hidden.name, locate: hidden.id }),
  );
  assert.equal(invisible.total, 0);
  assert.equal(invisible.located, null);
  assert(!JSON.stringify(invisible).includes(hidden.id));
  const [versions] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM metric_library_versions WHERE project_id=?",
    [first.id],
  );
  assert.equal(versions.length, 2);
  assert(versions.every((r) => r.status === "draft"));
  assert.notEqual(versions[0]!.id, versions[1]!.id);
  const [configs] = await pool.query<RowDataPacket[]>(
    "SELECT s.* FROM score_definitions s JOIN metric_library_versions v ON v.id=s.library_version_id WHERE v.project_id=?",
    [first.id],
  );
  assert.equal(configs.length, 2);
  assert(
    configs.every(
      (s) =>
        !(
          typeof s.dependency_snapshot === "string"
            ? JSON.parse(s.dependency_snapshot)
            : s.dependency_snapshot
        ).confirmed,
    ),
  );
  for (const version of versions)
    await call(
      adminToken,
      `/api/projects/${first.id}/metrics/versions/${String(version.id)}/activate`,
      "POST",
      undefined,
      400,
    );
  const [audit] = await pool.query<RowDataPacket[]>(
    "SELECT action,metadata FROM audit_logs WHERE project_id=?",
    [first.id],
  );
  assert.equal(audit.filter((r) => r.action === "project.created").length, 1);
  assert.equal(
    audit.filter((r) => r.action === "score.template_initialized").length,
    2,
  );
  assert(!JSON.stringify(audit).includes(adminToken));
  // Isolated raw observations for R2 only. These are NOT scoring facts or real project scores.
  const values = projects.flatMap((p, i) =>
    ["prod", "staging"].flatMap((env) =>
      Array.from({ length: 100 }, (_, n) => ({
        event_id: randomUUID(),
        project_id: p.id,
        app_id: p.appId,
        env,
        event: "page_view",
        timestamp:
          env === "prod" ? "2026-09-02 08:00:00.000" : "2026-09-03 08:00:00.000",
        received_at: `2026-09-${env === "prod" ? "02" : "03"} 08:00:${String(i).padStart(2, "0")}.000`,
        request_id: randomUUID(),
        schema_version: 3,
        page_route: "/r2-observation",
        session_id: "r2-session-" + n,
        device_id: "r2-device",
      })),
    ),
  );
  await ch.insert({ table: "raw_events", values, format: "JSONEachRow" });
  const result = await call<Summary>(adminToken, query());
  assert.equal(result.total, 20);
  assert.equal(result.items.length, 12);
  assert.equal(result.items[0]!.id, projects[19]!.id);
  assert(
    result.items.every((p) => p.operational.value === null && p.quality.value === null),
  );
  assert(result.items.every((p) => p.pipeline.state === "unknown"));
  const second = await call<Summary>(adminToken, query({ page: "2" }));
  assert.equal(second.diagnostics.metadataQueries, 4);
  assert.equal(second.diagnostics.clickHouseQueries, 1);
  assert.equal(new Set([...result.items, ...second.items].map((p) => p.id)).size, 20);
  for (const pageSize of ["24", "48"])
    assert.equal(
      (await call<Summary>(viewerToken, query({ pageSize }))).items.length,
      20,
    );
  assert.equal((await call<Summary>(adminToken, query({ page: "999" }))).page, 2);
  const located = await call<Summary>(adminToken, query({ locate: first.id }));
  assert.equal(located.page, 2);
  assert(located.items.some((p) => p.id === first.id));
  const staging = await call<Summary>(adminToken, query({ env: "staging" }));
  assert.notEqual(staging.items[0]!.lastDataAt, result.items[0]!.lastDataAt);
  const empty = await call<Summary>(adminToken, query({ env: "dev" }));
  assert(empty.items.every((p) => p.lastDataAt === null && p.data.state === "no_data"));
  const noVisits = await call<Summary>(
    adminToken,
    query({
      range: "custom",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-02T00:00:00Z",
    }),
  );
  assert(
    noVisits.items.every(
      (p) => p.data.reason === "NO_EVENTS_IN_RANGE" && p.lastDataAt !== null,
    ),
  );
  assert.notEqual(
    result.items.find((p) => p.timezone === "Asia/Shanghai")!.range.localFrom,
    result.items.find((p) => p.timezone === "America/New_York")!.range.localFrom,
  );
  for (const bad of [
    { pageSize: "100" },
    { env: "all" },
    { page: "0" },
    { range: "custom", from: "2024-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
  ])
    await call(adminToken, query(bad), "GET", undefined, 400);
  // Cross-page alert moves to front even though timestamp would otherwise put it last.
  await pool.execute(
    "UPDATE project_data_status SET last_received_at='2026-09-02',dead_letter_events=1,last_queryable_at=NULL WHERE project_id=?",
    [first.id],
  );
  const alert = await call<Summary>(adminToken, query());
  assert.equal(alert.items[0]!.id, first.id);
  assert.equal(alert.items[0]!.state, "alert");
  assert(alert.items[0]!.reasons.some((r) => r.includes("MISSING_CONFIGURATION")));
  // Same current active version, exact same read model and digest as accepted R1-C.
  const seed = "11111111-1111-4111-8111-111111111111",
    seedProject = await mysql.getProject(seed);
  assert(seedProject);
  const seedSummary = await summaryService.summary(actor, {
    ...range,
    search: seedProject.name,
    page: 1,
    pageSize: 12,
  });
  const card = seedSummary.items.find((p) => p.id === seed)!;
  assert(card);
  assert.notEqual(card.operational.versionId, card.quality.versionId);
  for (const type of ["operational", "quality"] as const) {
    const single = await scores.read(seed, type + "_score", {
      env: "prod",
      from: range.from,
      to: range.to,
      granularity: "day",
    });
    assert.equal(card[type].versionId, single.context.metricSetVersion);
    assert.equal(
      card[type].context.definitionVersion,
      single.context.definitionVersion,
    );
    assert.equal(card[type].value, single.value);
  }
  // R2 observes a real reviewed operational activation without relabeling the old response
  // or changing the independent quality version. Only the existing seed test project changes.
  const versionsPath = `/api/projects/${seed}/metrics/versions`;
  const existing = await call<{ id: string; status: string }[]>(
    adminToken,
    versionsPath + "?type=operational",
  );
  for (const draft of existing.filter((v) => v.status === "draft"))
    await call(adminToken, versionsPath + "/" + draft.id, "DELETE", undefined, 204);
  const nextVersion = await call<{ id: string }>(
    adminToken,
    versionsPath,
    "POST",
    { type: "operational", sourceVersionId: card.operational.versionId },
    201,
  );
  await call(
    adminToken,
    `/api/projects/${seed}/score-management/versions/${nextVersion.id}/review`,
    "POST",
    { env: "prod", from: range.from, to: range.to, granularity: "day" },
    201,
  );
  await call(
    adminToken,
    versionsPath + "/" + nextVersion.id + "/activate",
    "POST",
    undefined,
    201,
  );
  const switched = await summaryService.summary(actor, {
    ...range,
    search: seedProject.name,
    page: 1,
    pageSize: 12,
  });
  const switchedCard = switched.items.find((p) => p.id === seed)!;
  assert.equal(switchedCard.operational.versionId, nextVersion.id);
  assert.notEqual(card.operational.versionId, nextVersion.id);
  assert.equal(switchedCard.quality.versionId, card.quality.versionId);
  assert.equal(switchedCard.operational.value, null);
  assert(switchedCard.operational.reasons.includes("VERSION_RANGE_BOUNDARY"));
  // Actual counters instrument SQL executions; compare one candidate, 20, and page-size changes.
  const counts = [];
  for (const [filter, size] of [
    [first.name, 12],
    [search, 12],
    [search, 24],
    [search, 48],
  ] as const) {
    const r = await summaryService.summary(actor, {
      ...range,
      search: filter,
      page: 1,
      pageSize: size,
    });
    assert.equal(r.diagnostics.metadataQueries, 4);
    assert.equal(r.diagnostics.clickHouseQueries, 1);
    counts.push(r.diagnostics);
  }
  // 40 HTTP samples after 5 warmups, includes authorization + DB + ClickHouse + serialization.
  for (let i = 0; i < 5; i++) await call(adminToken, query());
  const durations: number[] = [];
  let scan = 0;
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    const r = await call<Summary>(adminToken, query());
    durations.push(performance.now() - start);
    scan = Math.max(scan, r.diagnostics.clickHouse?.rowsRead ?? 0);
  }
  const sorted = [...durations].sort((a, b) => a - b),
    p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;

  Object.assign(evidence, {
    implementation: "R2",
    realMySqlApi: "passed",
    clickHouse: "passed; isolated R2 raw observations",
    creationRollback: "passed",
    idempotency: "passed",
    permissions: "passed",
    independentActiveVersions: "passed",
    queryCounts: counts,
    performance: {
      environment: {
        node: process.version,
        arch: process.arch,
        platform: process.platform,
        cpu: os.cpus()[0]?.model,
        cpus: os.cpus().length,
        memoryBytes: os.totalmem(),
      },
      projects: 20,
      rawRows: values.length,
      scope: "authorized HTTP summary; UI navigation measured separately in E2E",
      method: "5 warmups then 40 sequential requests; nearest-rank p95",
      durationsMs: durations,
      p95Ms: p95,
      passed: p95 <= 2000,
      maxRowsRead: scan,
    },
    manualAcceptance: "pending Jesse",
  });
  const dir = process.env.FI_EVIDENCE_DIR ?? "artifacts";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/r2-integration.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  assert(scan > 0, "ClickHouse scan statistics must be observed");
  assert(p95 <= 2000, `20-project API p95 exceeded: ${p95}`);
} finally {
  await Promise.all([mysql.close(), analytics.close(), ch.close()]);
}
