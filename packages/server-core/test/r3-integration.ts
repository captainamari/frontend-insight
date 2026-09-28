// Isolated R3 projects and raw observations; never a source of production scoring facts.
import assert from "node:assert/strict";
import {
  resolveProjectCalendar,
  localDateTime,
  projectLocalInstant,
  type ProjectRangeKey,
} from "@frontend-insight/event-contract/project-range";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createClient } from "@clickhouse/client";
import { MySqlStore } from "../src/mysql-store.js";
import { OverviewFactStore } from "../src/overview-facts.js";
import { defaultScoreTemplate } from "../src/score-templates.js";
import type { ScoreManagementService } from "../src/score-management.js";
import type { ProjectOverviewService } from "../src/project-overview.js";
import type { MetricLibraryVersion } from "../src/metric-library.js";
import type { RowDataPacket } from "mysql2/promise";
const apiUrl = process.env.FI_API_URL ?? "http://127.0.0.1:3000";
if (!process.env.MYSQL_URL) throw new Error("MYSQL_URL_REQUIRED");
const mysql = new MySqlStore(process.env.MYSQL_URL);
const factStore = new OverviewFactStore({
  url: process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
  username: process.env.CLICKHOUSE_USERNAME ?? "frontend_insight",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: "frontend_insight",
});
const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
  username: process.env.CLICKHOUSE_USERNAME ?? "frontend_insight",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: "frontend_insight",
});
type Overview = Awaited<ReturnType<ProjectOverviewService["overview"]>>;
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
  return String(((await r.json()) as { accessToken: string }).accessToken);
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
  assert(r.headers.get("x-request-id"), "request ID on success and failure");
  return (text ? JSON.parse(text) : undefined) as T;
}
const evidence: Record<string, unknown> = {
  testedCommit: process.env.GITHUB_SHA,
  milestone: "R3",
  source: "isolated integration fixtures; real API/MySQL/ClickHouse",
  manualAcceptance: "pending user",
};
try {
  const admin = await login("admin"),
    viewer = await login("viewer");
  const project = await call<{ id: string; appId: string; name: string }>(
    admin,
    "/api/projects",
    "POST",
    {
      name: "R3 isolated overview " + randomUUID(),
      timezone: "America/New_York",
      origins: ["http://localhost:4173"],
    },
    201,
  );
  const root = `/api/projects/${project.id}`,
    path = root + "/overview";
  const denied = await call<{ code: string }>(viewer, path, "GET", undefined, 403);
  assert.equal(denied.code, "PROJECT_FORBIDDEN");
  const [users] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE email='viewer@example.invalid'",
  );
  await call(admin, root + "/members/" + String(users[0]!.id), "PUT", {
    role: "viewer",
  });
  const empty = await call<Overview>(viewer, path);
  assert.equal(empty.data.reason, "FIRST_NOT_CONNECTED");
  assert.equal(empty.operational.version, null);
  assert.equal(empty.alerts.status, "unavailable");
  const from = new Date(Date.now() - 7 * 86400000).toISOString(),
    to = new Date().toISOString();
  const reviewQuery = { from, to, env: "prod", granularity: "day" };
  const module = await call<{ id: string }>(
    admin,
    root + "/modules",
    "POST",
    {
      moduleKey: "r3_module",
      name: "R3 isolated module",
      effectiveFrom: "2025-01-01T00:00:00Z",
    },
    201,
  );
  await call(
    admin,
    root + "/page-definitions",
    "POST",
    {
      moduleId: module.id,
      name: "R3 page",
      pageRoute: "/r3",
      templateKey: "task_operation",
      isCore: true,
      criticalityWeight: 1,
      expectedFrequency: "daily",
      effectiveFrom: "2025-01-01T00:00:00Z",
    },
    201,
  );
  await call(
    admin,
    root + "/operational-settings/versions",
    "POST",
    {
      targetUsers: 10,
      expectedActiveWeekdays: [1, 2, 3, 4, 5],
      effectiveFrom: "2025-01-01T00:00:00Z",
    },
    201,
  );
  const workflow = await call<{ id: string; latestVersion: { id: string } }>(
    admin,
    root + "/workflow-definitions",
    "POST",
    {
      moduleId: module.id,
      workflowKey: "r3_workflow",
      name: "R3 isolated workflow definition",
      startPolicy: "first_step",
      timeoutSeconds: 600,
      terminalPolicy: {
        completedStepKey: "done",
        failedStepKey: null,
        canceledStepKey: null,
        timeoutState: "approximate_abandoned",
      },
      steps: [
        {
          stepKey: "start",
          name: "Start",
          stepOrder: 1,
          triggerKind: "selector",
          triggerConfig: { event: "click", selector: "#start" },
        },
        {
          stepKey: "done",
          name: "Done",
          stepOrder: 2,
          triggerKind: "selector",
          triggerConfig: { event: "click", selector: "#done" },
        },
      ],
    },
    201,
  );
  await call(
    admin,
    root + `/workflow-definitions/${workflow.id}/activate`,
    "POST",
    { versionId: workflow.latestVersion.id },
    201,
  );
  const versions: Record<string, string> = {};
  for (const type of ["operational", "quality"] as const) {
    const list = await call<MetricLibraryVersion[]>(
        admin,
        root + "/metrics/versions?type=" + type,
      ),
      version = list.find((v) => v.status === "draft")!;
    versions[type] = version.id;
    const base = root + "/score-management";
    const options = await call<
      Awaited<ReturnType<ScoreManagementService["businessOptions"]>>
    >(admin, base + "/business-options");
    await call(admin, base + "/versions/" + version.id, "PUT", {
      configuration: defaultScoreTemplate(type).configuration,
      business: {
        confirmed: true,
        scopeId: project.id,
        optionsDigest: options.optionsDigest,
        workflowWeights: Object.fromEntries(options.workflows.map((w) => [w.id, 1])),
        durationMinimumSample: 5,
      },
    });
    if (type === "operational") {
      const bindingPath = root + `/metrics/versions/${version.id}/overview-bindings`;
      await call(viewer, bindingPath, "PUT", { metricKeys: ["pv"] }, 403);
      await call(admin, bindingPath, "PUT", { metricKeys: ["pv", "uv", "vv"] });
      await call(admin, bindingPath, "PUT", { metricKeys: ["pv", "pv"] }, 400);
      await call(admin, bindingPath, "PUT", { metricKeys: ["missing_metric"] }, 400);
    }
    await call(
      admin,
      base + "/versions/" + version.id + "/review",
      "POST",
      reviewQuery,
      201,
    );
    if (type === "operational") {
      await call(
        admin,
        root + `/metrics/versions/${version.id}/overview-bindings`,
        "PUT",
        { metricKeys: ["pv", "uv", "vv"] },
      );
      await call(
        admin,
        root + `/metrics/versions/${version.id}/activate`,
        "POST",
        undefined,
        409,
      );
      await call(
        admin,
        base + "/versions/" + version.id + "/review",
        "POST",
        reviewQuery,
        201,
      );
    }
    await call(
      admin,
      root + `/metrics/versions/${version.id}/activate`,
      "POST",
      undefined,
      201,
    );
  }
  const configured = await call<Overview>(viewer, path);
  assert.equal(configured.metrics.cards.length, 3);
  assert.equal(configured.operational.version!.id, versions.operational);
  assert.equal(configured.quality.version!.id, versions.quality);
  assert.notEqual(versions.operational, versions.quality);
  assert.equal(configured.operational.result!.value, null);
  assert.equal(configured.quality.result!.value, null);
  // 36,000 observations spanning 90 event dates. All are explicitly synthetic.
  const now = Date.now();
  const stamp = (n: number) =>
    new Date(n).toISOString().replace("T", " ").replace("Z", "");
  const values = Array.from({ length: 36000 }, (_, i) => ({
    event_id: randomUUID(),
    project_id: project.id,
    app_id: project.appId,
    env: i % 10 === 0 ? "staging" : "prod",
    event: "page_view",
    timestamp: stamp(now - Math.floor(i / 400) * 86400000),
    received_at: stamp(now),
    request_id: randomUUID(),
    schema_version: 3,
    page_route: "/r3",
    user_id: "isolated-hmac-" + (i % 10),
    session_id: "r3-session-" + i,
    device_id: "r3-device",
  }));
  await ch.insert({ table: "raw_events", format: "JSONEachRow", values });
  await ch.insert({
    table: "raw_events",
    format: "JSONEachRow",
    values: Array.from({ length: 20 }, (_, i) => ({
      ...values[i]!,
      event_id: randomUUID(),
      env: "prod",
      event: "error",
      error_group_id: "r3-group",
      error_type: "js",
      error_category: "runtime",
      error_name: "R3 isolated",
      error_message: "isolated fixture",
      timestamp: stamp(now),
      received_at: stamp(now),
      device_id: "error-browser-" + i,
    })),
  });
  await ch.insert({
    table: "raw_events",
    format: "JSONEachRow",
    values: [
      {
        ...values[0]!,
        event_id: randomUUID(),
        env: "staging",
        event: "error",
        error_group_id: "r3-info-only",
        error_type: "js",
        error_category: "runtime",
        error_name: "R3 isolated below threshold",
        timestamp: stamp(now),
        received_at: stamp(now),
      },
    ],
  });
  const instant = new Date(now + 1000).toISOString();
  const narrow =
    path +
    "?" +
    new URLSearchParams({
      range: "custom",
      env: "prod",
      from: configured.operational.version!.activatedAt!,
      to: instant,
    });
  const observed = await call<Overview>(viewer, narrow);
  assert.equal(observed.pipeline.envVerified, false);
  assert.equal(observed.data.state, "partial");
  assert.equal(
    observed.metrics.cards.find((m) => m.definition.metricKey === "pv")!.rawValue,
    360,
  );
  assert.equal(
    observed.metrics.cards.find((m) => m.definition.metricKey === "pv")!.value,
    null,
  );
  assert.equal(observed.alerts.status, "alerts_observed");
  assert(observed.alerts.items.some((a) => a.ruleKey === "error_spike"));
  const belowThreshold = await call<Overview>(
    viewer,
    narrow.replace("env=prod", "env=staging"),
  );
  assert.equal(belowThreshold.alerts.status, "no_alerts_observed");
  assert.equal(belowThreshold.alerts.items.length, 0);
  assert.equal(belowThreshold.pipeline.envVerified, false);
  const otherEnv = await call<Overview>(viewer, narrow.replace("env=prod", "env=dev"));
  assert.equal(otherEnv.lastDataAt, null);
  assert.equal(otherEnv.alerts.status, "unavailable");
  assert.notEqual(otherEnv.identity, observed.identity);
  for (const bad of [
    "env=all",
    "range=24h",
    "range=custom&from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z",
    "metrics=unbound_metric",
    "timezone=UTC",
  ])
    await call(admin, path + "?" + bad, "GET", undefined, 400);
  // Mutations are confined to this R3 project, after accepted R1/R2 tests.
  const copied = await call<{ version: MetricLibraryVersion; metricKeys: string[] }>(
    admin,
    root + `/metrics/versions/${versions.operational}/overview-bindings`,
    "PUT",
    { metricKeys: ["pv"] },
  );
  assert.notEqual(copied.version.id, versions.operational);
  assert.deepEqual(copied.metricKeys, ["pv"]);
  await call(
    admin,
    root + `/score-management/versions/${copied.version.id}/review`,
    "POST",
    reviewQuery,
    201,
  );
  await call(
    admin,
    root + `/metrics/versions/${copied.version.id}/activate`,
    "POST",
    undefined,
    201,
  );
  const switched = await call<Overview>(admin, path);
  assert.equal(switched.operational.version!.id, copied.version.id);
  assert.equal(switched.quality.version!.id, versions.quality);
  assert.equal(configured.operational.version!.id, versions.operational);
  assert(switched.metrics.trends.some((b) => b.versionId === null));
  await call(
    admin,
    root + `/metrics/versions/${versions.operational}/activate`,
    "POST",
    undefined,
    201,
  );
  const reactivated = await call<Overview>(admin, path);
  assert.equal(reactivated.operational.version!.id, versions.operational);
  assert.notEqual(reactivated.identity, configured.identity);
  const measurements = [];
  for (const range of [
    "7d",
    "30d",
    "90d",
    "180d",
    "365d",
    "custom",
    "long-day",
    "long-week",
  ]) {
    const params = new URLSearchParams({
      range: range === "long-day" ? "7d" : range === "long-week" ? "90d" : range,
      env: "prod",
    });
    if (["custom", "long-day", "long-week"].includes(range)) {
      const start = new Date(
        localDateTime(new Date(now).toISOString(), "America/New_York") + "Z",
      );
      const day = start.getUTCDate();
      start.setUTCDate(1);
      start.setUTCMonth(start.getUTCMonth() - 13);
      start.setUTCDate(
        Math.min(
          day,
          new Date(
            Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
          ).getUTCDate(),
        ),
      );
      params.set(
        "from",
        projectLocalInstant(start.toISOString().slice(0, -1), "America/New_York"),
      );
      params.set("to", new Date(now).toISOString());
    }
    const calendar = resolveProjectCalendar(
      {
        range: params.get("range") as ProjectRangeKey,
        env: "prod",
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined,
      },
      "America/New_York",
      new Date(now),
    );
    params.set("from", calendar.from);
    params.set("to", calendar.to);
    const raw = await factStore.read(project.id, "prod", calendar.buckets, [
      { pageRoute: "/r3", from: calendar.from, to: calendar.to },
    ]);
    const prodTimes = values
      .filter((v) => v.env === "prod")
      .map((v) => Date.parse(v.timestamp.replace(" ", "T") + "Z"));
    const countIn = (from: string, to: string) => {
      const a = Date.parse(from),
        b = Date.parse(to);
      return prodTimes.filter((t) => t >= a && t < b).length;
    };
    assert.equal(raw.window.raw.pv!.value, countIn(calendar.from, calendar.to));
    assert.equal(
      raw.buckets.reduce((n, b) => n + b.events, 0),
      raw.window.events,
    );
    calendar.buckets.forEach((b, i) => {
      const expected = countIn(b.from, b.to);
      assert.equal(raw.buckets[i]!.raw.pv!.value, expected || null);
    });
    const url = path + "?" + params;
    console.log(
      JSON.stringify({
        phase: "R3 performance",
        range,
        buckets: calendar.buckets.length,
      }),
    );
    for (let i = 0; i < 5; i++) await call(admin, url);
    const durationsMs: number[] = [],
      diagnostics = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      const r = await call<Overview>(admin, url);
      durationsMs.push(performance.now() - start);
      diagnostics.push(r.diagnostics);
      assert.notEqual(r.data.reason, "FACT_STORE_UNAVAILABLE");
      assert(r.diagnostics.scans.rowsRead > 0);
      assert.equal(r.diagnostics.metadataQueries, 6);
      assert.equal(r.diagnostics.clickHouseQueries, 4);
    }
    const p95Ms = [...durationsMs].sort((a, b) => a - b)[
      Math.ceil(durationsMs.length * 0.95) - 1
    ]!;
    measurements.push({
      range,
      query: {
        from: calendar.from,
        to: calendar.to,
        timezone: calendar.timezone,
        env: calendar.env,
        granularity: calendar.granularity,
        buckets: calendar.buckets.length,
      },
      warmups: 5,
      samples: 40,
      algorithm: "nearest-rank ceil(n*0.95)-1 on sorted samples",
      durationsMs,
      p95Ms,
      diagnostics,
    });
    assert(p95Ms <= 2000, `${range} p95=${p95Ms}`);
  }
  const [audit] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT action FROM audit_logs WHERE project_id=?",
    [project.id],
  );
  assert(audit.some((a) => a.action === "metric_library.overview_bindings_saved"));
  Object.assign(evidence, {
    projectId: project.id,
    projectName: project.name,
    projectCount: 1,
    observations: values.length + 21,
    eventCoverageDays: 90,
    receivedAtCoverage: "all synthetic insertions received now",
    physicalRetentionDays: 90,
    longWindowLimitation:
      "180/365 days and 13 months include unpopulated history; this is not a production capacity benchmark",
    mysqlApi: "passed",
    clickHouse: "passed",
    permissionAudit: "passed",
    independentVersionsAndReactivation: "passed",
    measurements,
    environment: {
      node: process.version,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      cpus: os.cpus().length,
      memoryBytes: os.totalmem(),
    },
  });
  const dir = process.env.FI_EVIDENCE_DIR ?? "artifacts";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/r3-integration.json", JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({
      projectId: project.id,
      testedCommit: process.env.GITHUB_SHA,
      observations: evidence.observations,
      eventCoverageDays: evidence.eventCoverageDays,
      environment: evidence.environment,
      p95: measurements.map((m) => ({
        range: m.range,
        ...m.query,
        p95Ms: m.p95Ms,
        maxRowsRead: Math.max(...m.diagnostics.map((d) => d.scans.rowsRead)),
        maxBytesRead: Math.max(...m.diagnostics.map((d) => d.scans.bytesRead)),
        metadataQueries: m.diagnostics[0]!.metadataQueries,
        clickHouseQueries: m.diagnostics[0]!.clickHouseQueries,
      })),
    }),
  );
} finally {
  await Promise.all([mysql.close(), ch.close(), factStore.close()]);
}
