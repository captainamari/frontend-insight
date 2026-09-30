// Isolated R4-A projects and raw observations; never a source of production scoring facts.
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
import { defaultScoreTemplate } from "../src/score-templates.js";
import type { ScoreManagementService } from "../src/score-management.js";
import type { BusinessAnalysisService } from "../src/business-analysis.js";
import type { MetricLibraryVersion } from "../src/metric-library.js";
import type { RowDataPacket } from "mysql2/promise";
const apiUrl = process.env.FI_API_URL ?? "http://127.0.0.1:3000";
if (!process.env.MYSQL_URL) throw new Error("MYSQL_URL_REQUIRED");
const mysql = new MySqlStore(process.env.MYSQL_URL);
const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
  username: process.env.CLICKHOUSE_USERNAME ?? "frontend_insight",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: "frontend_insight",
});
type Overview = Awaited<ReturnType<BusinessAnalysisService["analysis"]>>;
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
  milestone: "R4-A",
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
      name: "R4-A isolated overview " + randomUUID(),
      timezone: "America/New_York",
      origins: ["http://localhost:4173"],
    },
    201,
  );
  const root = `/api/projects/${project.id}`,
    path = root + "/business";
  const unauthenticated = await fetch(apiUrl + path);
  assert.equal(unauthenticated.status, 401);
  assert(!JSON.stringify(await unauthenticated.json()).includes(project.name));
  const denied = await call<{ code: string }>(viewer, path, "GET", undefined, 403);
  assert.equal(denied.code, "PROJECT_FORBIDDEN");
  const [users] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE email='viewer@example.invalid'",
  );
  await call(admin, root + "/members/" + String(users[0]!.id), "PUT", {
    role: "viewer",
  });
  const empty = await call<Overview>(viewer, path);
  assert.equal(empty.data.reason, "NO_MODULE_IN_RANGE");
  assert.equal(empty.metrics.version, null);
  const from = new Date(Date.now() - 7 * 86400000).toISOString(),
    to = new Date().toISOString();
  const reviewQuery = { from, to, env: "prod", granularity: "day" };
  const module = await call<{ id: string }>(
    admin,
    root + "/modules",
    "POST",
    {
      moduleKey: "r4a_module",
      name: "R4-A isolated module",
      effectiveFrom: "2025-01-01T00:00:00Z",
    },
    201,
  );
  assert.equal((await call<Overview>(viewer, path)).metrics.status, "missing_active");
  await call(
    admin,
    root + "/page-definitions",
    "POST",
    {
      moduleId: module.id,
      name: "R4-A page",
      pageRoute: "/r4a",
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
      workflowKey: "r4a_workflow",
      name: "R4-A isolated workflow definition",
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
    if (type === "operational") {
      // Freeze the inherited R4-A unavailable-definition fixture before activation.
      // R4-C separately verifies that the new partial definition can be bound.
      await mysql.pool.execute(
        "UPDATE metric_definitions SET implementation_status='not_collected',definition_version='system-v1.8.0' WHERE library_version_id=? AND metric_key='operation_fail_rate'",
        [version.id],
      );
    }

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
      const bindingPath = root + `/metrics/versions/${version.id}/business-bindings`;
      await call(viewer, bindingPath, "PUT", { metricKeys: ["pv"] }, 403);
      await call(admin, bindingPath, "PUT", {
        metricKeys: ["pv", "uv", "task_duration"],
      });
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
        root + `/metrics/versions/${version.id}/business-bindings`,
        "PUT",
        { metricKeys: ["pv", "uv", "task_duration"] },
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
  assert.equal(configured.metrics.version!.id, versions.operational);
  assert.equal(configured.workflows.length, 2);
  assert.equal(configured.workflowFacts.status, "no_facts");
  const second = await call<{ id: string }>(
    admin,
    root + "/page-definitions",
    "POST",
    {
      moduleId: module.id,
      name: "R4-A second page",
      pageRoute: "/r4a-second",
      templateKey: "task_operation",
      isCore: false,
      criticalityWeight: 1,
      expectedFrequency: "daily",
      effectiveFrom: "2025-01-01T00:00:00Z",
    },
    201,
  );
  const now = Date.now(),
    stamp = (t: number) => new Date(t).toISOString().replace("T", " ").replace("Z", "");
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
    page_route: i % 2 === 0 ? "/r4a" : "/r4a-second",
    user_id: "isolated-hmac-" + (Math.floor(i / 2) % 10),
    session_id: "r4a-session-" + i,
    device_id: "r4a-device",
  }));
  await ch.insert({ table: "raw_events", format: "JSONEachRow", values });
  // Duplicate event IDs must not increase observations. Includes no payload values.
  await ch.insert({
    table: "raw_events",
    format: "JSONEachRow",
    values: values.slice(1, 5),
  });
  const instant = new Date(now + 1000).toISOString();
  const params = new URLSearchParams({
    range: "custom",
    env: "prod",
    moduleId: module.id,
    from: configured.metrics.version!.activatedAt!,
    to: instant,
  });
  const observed = await call<Overview>(viewer, path + "?" + params);
  assert.equal(observed.observation!.pv, 360);
  assert.equal(observed.observation!.uv, 10);
  assert.equal(
    observed.metrics.cards.find((m) => m.definition.metricKey === "pv")!.rawValue,
    360,
  );
  assert.equal(
    observed.metrics.cards.find((m) => m.definition.metricKey === "uv")!.rawValue,
    10,
  );
  assert(observed.metrics.cards.every((m) => m.value === null));
  assert.equal(
    observed.pages.reduce((n, p) => n + Number(p.observation?.pv ?? 0), 0),
    360,
  );
  assert(
    observed.pages.reduce((n, p) => n + (p.observation.uv ?? 0), 0) >
      observed.observation!.uv!,
  );
  assert.equal(observed.penetration.value, null);
  assert.equal(observed.penetration.denominator, null);
  assert.equal(observed.penetration.directoryVersion, null);
  assert.equal(observed.penetration.reason, "PENETRATION_SOURCE_MISSING");
  assert(!JSON.stringify(observed).includes("isolated-hmac-"));
  // Page aggregate + frozen score workflow facts + workflow facts/SDK metadata.
  assert.equal(observed.diagnostics.clickHouseQueries, 5);
  for (const bad of [
    "env=all",
    "range=24h",
    "moduleId=" + randomUUID(),
    "timezone=UTC",
    "metrics=unbound",
    "range=custom&from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z",
  ])
    await call(
      admin,
      path + "?" + bad,
      "GET",
      undefined,
      bad.startsWith("moduleId") ? 404 : 400,
    );
  await call(
    viewer,
    root + `/metrics/versions/${versions.operational}/business-bindings`,
    "PUT",
    { metricKeys: ["pv"] },
    403,
  );
  await call(
    admin,
    root + `/metrics/versions/${versions.operational}/business-bindings`,
    "PUT",
    { metricKeys: ["module_penetration"] },
    400,
  );
  await call(
    admin,
    root + `/metrics/versions/${versions.operational}/business-bindings`,
    "PUT",
    { metricKeys: ["operation_fail_rate"] },
    400,
  );
  const copied = await call<{ version: MetricLibraryVersion; metricKeys: string[] }>(
    admin,
    root + `/metrics/versions/${versions.operational}/business-bindings`,
    "PUT",
    { metricKeys: ["pv", "uv"] },
  );
  assert.notEqual(copied.version.id, versions.operational);
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
  await call(admin, path + "?versionId=" + versions.operational, "GET", undefined, 409);
  await call(
    admin,
    root + `/metrics/versions/${versions.operational}/activate`,
    "POST",
    undefined,
    201,
  );
  const reactivated = await call<Overview>(viewer, path + "?" + params);
  assert.notEqual(reactivated.identity, observed.identity);
  assert(
    reactivated.metrics.trends.some(
      (b) => b.reason === "HISTORICAL_VERSION_NOT_RECALCULATED",
    ),
  );
  // Membership moves apply by event time. Disable second page after observations: history stays unchanged.
  await call(admin, root + `/page-definitions/${second.id}`, "PATCH", {
    status: "disabled",
    effectiveFrom: instant,
  });
  const historical = await call<Overview>(viewer, path + "?" + params);
  assert.equal(historical.observation!.pv, 360);
  const largeModule = await call<{ id: string }>(
    admin,
    root + "/modules",
    "POST",
    {
      moduleKey: "r4a_large",
      name: "R4-A 24 pages",
      effectiveFrom: "2025-01-01T00:00:00Z",
    },
    201,
  );
  for (let i = 0; i < 24; i++)
    await call(
      admin,
      root + "/page-definitions",
      "POST",
      {
        moduleId: largeModule.id,
        name: "R4-A load page " + i,
        pageRoute: "/r4a-load-" + i,
        templateKey: "task_operation",
        isCore: false,
        criticalityWeight: 1,
        expectedFrequency: "daily",
        effectiveFrom: "2025-01-01T00:00:00Z",
      },
      201,
    );
  await ch.insert({
    table: "raw_events",
    format: "JSONEachRow",
    values: values.map((v, i) => ({
      ...v,
      event_id: randomUUID(),
      page_route: "/r4a-load-" + (i % 24),
    })),
  });
  const [foreignModules] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT id FROM modules WHERE project_id<>? LIMIT 1",
    [project.id],
  );
  assert(foreignModules.length);
  await call(
    viewer,
    path + "?moduleId=" + String(foreignModules[0]!.id),
    "GET",
    undefined,
    404,
  );
  await call(
    viewer,
    root + "/modules/" + module.id,
    "PATCH",
    { status: "disabled" },
    403,
  );
  const specialAt = now + 3600000;
  const special = (
    route: string,
    offset: number,
    user: string | null = "isolated-hmac-special",
  ) => ({
    ...values[1]!,
    event_id: randomUUID(),
    env: "prod",
    page_route: route,
    timestamp: stamp(specialAt + offset),
    user_id: user,
  });
  await ch.insert({
    table: "raw_events",
    format: "JSONEachRow",
    values: [
      special("/r4a", 100),
      special("/r4a-second", 100),
      special("/unclassified", 100),
      special("/r4a", 100, null),
    ],
  });
  const specialQuery = new URLSearchParams({
    range: "custom",
    env: "prod",
    moduleId: module.id,
    from: new Date(specialAt).toISOString(),
    to: new Date(specialAt + 1000).toISOString(),
  });
  const classified = await call<Overview>(viewer, path + "?" + specialQuery);
  assert.equal(classified.observation!.pv, 1);
  assert.equal(classified.observation!.uv, 1);
  assert.equal(classified.observation!.unidentified, 1);
  assert.equal(classified.observation!.unclassified, 1);
  assert.equal(classified.observation!.excluded, 2);
  assert(classified.pages.some((p) => p.reason === "PAGE_DISABLED"));
  await call(admin, root + "/page-definitions/" + second.id, "PATCH", {
    moduleId: largeModule.id,
    status: "active",
    effectiveFrom: new Date(specialAt + 1000).toISOString(),
  });
  await ch.insert({
    table: "raw_events",
    format: "JSONEachRow",
    values: [special("/r4a-second", 1100)],
  });
  specialQuery.set("from", new Date(specialAt + 1000).toISOString());
  specialQuery.set("to", new Date(specialAt + 2000).toISOString());
  const movedOut = await call<Overview>(viewer, path + "?" + specialQuery);
  assert.equal(movedOut.observation!.pv, 0);
  specialQuery.set("moduleId", largeModule.id);
  const movedIn = await call<Overview>(viewer, path + "?" + specialQuery);
  assert.equal(movedIn.observation!.pv, 1);
  assert.equal(
    (await call<Overview>(viewer, path + "?" + params)).observation!.pv,
    360,
  );
  await call(admin, root + "/modules/" + largeModule.id, "PATCH", {
    status: "disabled",
    effectiveFrom: new Date(specialAt + 2000).toISOString(),
  });
  await ch.insert({
    table: "raw_events",
    format: "JSONEachRow",
    values: [special("/r4a-second", 2100)],
  });
  specialQuery.set("from", new Date(specialAt + 2000).toISOString());
  specialQuery.set("to", new Date(specialAt + 3000).toISOString());
  const disabled = await call<Overview>(viewer, path + "?" + specialQuery);
  assert.equal(disabled.observation!.pv, 0);
  assert(disabled.pages.every((p) => p.reason === "MODULE_DISABLED"));
  const measurements = [];
  for (const population of [
    { id: module.id, pages: 2 },
    { id: largeModule.id, pages: 24 },
  ]) {
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
      const q = new URLSearchParams({
        range: range === "long-day" ? "7d" : range === "long-week" ? "90d" : range,
        env: "prod",
        moduleId: population.id,
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
        q.set(
          "from",
          projectLocalInstant(start.toISOString().slice(0, -1), "America/New_York"),
        );
        q.set("to", new Date(now).toISOString());
      }
      const calendar = resolveProjectCalendar(
        {
          range: q.get("range") as ProjectRangeKey,
          env: "prod",
          from: q.get("from") ?? undefined,
          to: q.get("to") ?? undefined,
        },
        "America/New_York",
        new Date(now),
      );
      q.set("from", calendar.from);
      q.set("to", calendar.to);
      const durations: number[] = [],
        queries: number[] = [],
        scans: unknown[] = [];
      for (let i = 0; i < 45; i++) {
        const start = performance.now();
        const result = await call<Overview>(viewer, path + "?" + q);
        if (i >= 5) {
          durations.push(performance.now() - start);
          queries.push(result.diagnostics.clickHouseQueries);
          scans.push(result.diagnostics.scans);
        }
        assert.equal(result.penetration.value, null);
      }
      const p95 = [...durations].sort((a, b) => a - b)[
        Math.ceil(durations.length * 0.95) - 1
      ]!;
      measurements.push({
        pages: population.pages,
        range,
        from: calendar.from,
        to: calendar.to,
        buckets: calendar.buckets.length,
        warmups: 5,
        samples: 40,
        method: "nearest-rank",
        durations,
        p95,
        queries,
        scans,
      });
      assert(queries.every((n) => n === 5));
      assert(p95 <= 2000, `${range}: ${p95}`);
    }
  }
  Object.assign(evidence, {
    project,
    moduleId: module.id,
    versions,
    query: Object.fromEntries(params),
    measurements,
    alternateModuleId: largeModule.id,
    events: values.length * 2 + 6,
    physicalRetentionDays: 90,
    coverage: "90 synthetic event dates, not production capacity",
    environment: {
      platform: os.platform(),
      arch: os.arch(),
      node: process.version,
      cpus: os.cpus().length,
      cpu: os.cpus()[0]?.model,
      memory: os.totalmem(),
    },
    automation: "passed",
    dataDependency: "PENETRATION_SOURCE_MISSING",
  });
} finally {
  const directory = process.env.FI_EVIDENCE_DIR ?? "artifacts";
  mkdirSync(directory, { recursive: true });
  writeFileSync(directory + "/r4a-integration.json", JSON.stringify(evidence, null, 2));
  await Promise.all([mysql.close(), ch.close()]);
}
