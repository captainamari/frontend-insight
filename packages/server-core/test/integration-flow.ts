import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import type { FrontendInsightEventBatch } from "@frontend-insight/event-contract";
import { contractScenarios } from "@frontend-insight/test-fixtures";
import p1CollectorsFixture from "../../test-fixtures/fixtures/valid/p1-collectors.json" with { type: "json" };
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { m5Fixture } from "../scripts/m5-fixture.js";
import { seedM6Fixture } from "../scripts/m6-fixture.js";

const apiUrl = process.env.M24_API_URL ?? "http://127.0.0.1:3000";
const mysqlUrl = process.env.MYSQL_URL;
const clickhouseUrl = process.env.CLICKHOUSE_URL;
if (!mysqlUrl || !clickhouseUrl) throw new Error("INTEGRATION_ENVIRONMENT_MISSING");

const projectId = m5Fixture.projectId;
const viewerId = m5Fixture.viewer.id;
const adminPassword = m5Fixture.admin.password;
const viewerPassword = m5Fixture.viewer.password;
const origin = "http://localhost:4173";
const featureIds = m5Fixture.featureIds;

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
  source: FrontendInsightEventBatch,
  sentAtMs: number,
): FrontendInsightEventBatch {
  const sourceSentAt = Date.parse(source.sentAt);
  const batch = structuredClone(source);
  batch.sentAt = new Date(sentAtMs).toISOString();
  batch.events = batch.events.map((event) => ({
    ...event,
    occurredAt: new Date(
      sentAtMs + Date.parse(event.occurredAt) - sourceSentAt,
    ).toISOString(),
  })) as FrontendInsightEventBatch["events"];
  return batch;
}

function uniqueOperationBatch(
  source: FrontendInsightEventBatch,
  index: number,
): FrontendInsightEventBatch {
  const batch = structuredClone(source);
  const suffix = String(index).padStart(2, "0");
  batch.events = batch.events.map((event) => {
    const operationNumber =
      "operationInstanceId" in event && event.operationInstanceId?.endsWith("2")
        ? index * 2 + 2
        : index * 2 + 1;
    return {
      ...event,
      eventId: `${event.eventId}_${suffix}`,
      visitorId: `vis_m6_fixture_${suffix}`,
      sessionId: `ses_m6_fixture_${suffix}`,
      pageViewId: `pv_m6_fixture_${suffix}`,
      accountRef: `opaque-account-m6-${suffix}`,
      ...("operationInstanceId" in event && event.operationInstanceId
        ? {
            operationInstanceId: `op_${String(operationNumber).padStart(32, "0")}`,
          }
        : {}),
    };
  }) as FrontendInsightEventBatch["events"];
  return batch;
}

function uniqueObservabilityBatch(
  source: FrontendInsightEventBatch,
  index: number,
): FrontendInsightEventBatch {
  const batch = structuredClone(source);
  const suffix = String(index).padStart(3, "0");
  batch.projectKey = m5Fixture.projectKey;
  batch.events = batch.events.map((event) => ({
    ...event,
    eventId: `${event.eventId}_${suffix}`,
    visitorId: `vis_m8_integration_${suffix}`,
    sessionId: `ses_m8_integration_${suffix}`,
    pageViewId: `pv_m8_integration_${suffix}`,
    ...("accountRef" in event && event.accountRef
      ? { accountRef: `opaque-account-m8-${suffix}` }
      : {}),
  })) as FrontendInsightEventBatch["events"];
  return batch;
}

function uniqueP1Batch(index: number): FrontendInsightEventBatch {
  const batch = structuredClone(
    p1CollectorsFixture as unknown as FrontendInsightEventBatch,
  );
  const suffix = String(index).padStart(3, "0");
  batch.projectKey = m5Fixture.projectKey;
  batch.events = batch.events.map((event) => ({
    ...event,
    eventId: `${event.eventId}_${suffix}`,
    visitorId: `vis_p1_integration_${suffix}`,
    sessionId: `ses_p1_integration_${suffix}`,
    pageViewId: `pv_p1_integration_${suffix}`,
  })) as FrontendInsightEventBatch["events"];
  return batch;
}

async function seed(): Promise<void> {
  await seedM6Fixture(mysqlUrl!, {
    origins: [
      origin,
      "http://127.0.0.1:4173",
      "http://localhost:4174",
      "http://127.0.0.1:4174",
    ],
  });
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
    const baseBatches = contractScenarios
      .filter((scenario) => scenario.name !== "observability_v1")
      .map((scenario, index) => {
        const batch = shiftBatch(scenario.valid, startedAt - 5_000 - index * 1_000);
        batch.projectKey = m5Fixture.projectKey;
        return batch;
      });
    const operationSource = contractScenarios.find(
      (scenario) => scenario.name === "operation_v2",
    )!.valid;
    const operationSamples = Array.from({ length: 4 }, (_, index) =>
      shiftBatch(
        uniqueOperationBatch(operationSource, index + 1),
        startedAt - 10_000 - index * 1_000,
      ),
    );
    const observabilitySource = contractScenarios.find(
      (scenario) => scenario.name === "observability_v1",
    )!.valid;
    const observabilitySamples = Array.from({ length: 20 }, (_, index) =>
      shiftBatch(
        uniqueObservabilityBatch(observabilitySource, index + 1),
        startedAt - 35_000 - index * 1_000,
      ),
    );
    const p1Samples = Array.from({ length: 20 }, (_, index) =>
      shiftBatch(uniqueP1Batch(index + 1), startedAt - 60_000 - index * 1_000),
    );
    const batches = [
      ...baseBatches,
      ...operationSamples,
      ...observabilitySamples,
      ...p1Samples,
    ];
    const logicalEvents = batches.flatMap((batch) => batch.events);
    const expectedVisitors = new Set(logicalEvents.map((event) => event.visitorId))
      .size;
    const expectedAccounts = new Set(
      logicalEvents
        .map((event) => event.accountRef)
        .filter((accountRef): accountRef is string => typeof accountRef === "string"),
    ).size;
    const expectedSessions = new Set(logicalEvents.map((event) => event.sessionId))
      .size;
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

    const admin = await login(m5Fixture.admin.email, adminPassword);
    const viewer = await login(m5Fixture.viewer.email, viewerPassword);
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
      current.pv === 8,
      `query-side eventId dedupe expected 8 PV, got ${current.pv}`,
    );
    assert(
      current.visitors === expectedVisitors,
      `overview expected ${expectedVisitors} browsers, got ${current.visitors}`,
    );
    assert(
      current.accounts === expectedAccounts,
      `overview expected ${expectedAccounts} HMAC accounts, got ${current.accounts}`,
    );
    assert(
      current.sessions === expectedSessions,
      `overview expected ${expectedSessions} sessions, got ${current.sessions}`,
    );

    const features = await jsonRequest(
      `/api/projects/${projectId}/analytics/features?${query}`,
      { headers: adminHeaders },
    );
    assert(
      features.response.status === 200,
      `features failed: ${JSON.stringify(features.body)}`,
    );
    const featureItems = features.body.items as Array<Record<string, unknown>>;
    assert(
      Array.isArray(features.body.trend),
      "feature adoption overview must include trend points",
    );
    assert(
      Array.isArray(features.body.sdkVersions),
      "feature adoption overview must include SDK version distribution",
    );
    const expectedSuccesses = new Map([
      ["sales_dashboard", 1],
      ["report_export", 6],
      ["operations_wallboard", 1],
    ]);
    for (const [featureKey, expectedSuccess] of expectedSuccesses) {
      const item = featureItems.find(
        (candidate) => candidate.featureKey === featureKey,
      );
      assert(item, `feature result missing ${featureKey}`);
      assert(
        item.success_count === expectedSuccess,
        `${featureKey} success count must dedupe across duplicate batches`,
      );
    }

    const operationalOverview = await jsonRequest(
      `/api/projects/${projectId}/analytics/operational-overview?${query}`,
      { headers: adminHeaders },
    );
    assert(
      operationalOverview.response.status === 200,
      `operational overview failed: ${JSON.stringify(operationalOverview.body)}`,
    );
    const operationalSummary = operationalOverview.body.summary as Record<
      string,
      number
    >;
    assert(
      operationalSummary.pageViews === 8 && operationalSummary.activeAccounts === 8,
      "operational overview must preserve raw PV and registered valid-account semantics",
    );
    const operationalTasks = operationalOverview.body.keyTasks as Array<
      Record<string, unknown>
    >;
    const reportExportTask = operationalTasks.find(
      (item) => item.featureKey === "report_export",
    );
    assert(
      reportExportTask?.started === 10 &&
        reportExportTask.succeeded === 5 &&
        reportExportTask.failed === 5,
      "v2 operation instances must pair independently and dedupe duplicate events",
    );
    const pageDetail = await jsonRequest(
      `/api/projects/${projectId}/analytics/page-detail?${query}&route=%2Freports`,
      { headers: adminHeaders },
    );
    assert(
      pageDetail.response.status === 200 &&
        (pageDetail.body.classification as Record<string, unknown>)?.status ===
          "classified" &&
        Array.isArray(pageDetail.body.trend),
      "page detail must expose classification and route-scoped trend evidence",
    );
    const taskDetail = await jsonRequest(
      `/api/projects/${projectId}/analytics/tasks/${featureIds.report_export}?${query}`,
      { headers: adminHeaders },
    );
    assert(
      taskDetail.response.status === 200 &&
        (taskDetail.body.metrics as Record<string, unknown>)?.started === 10 &&
        typeof taskDetail.body.availableFrom === "string",
      "task detail must expose v2 availability and operation metrics",
    );
    const operationalIndex = await jsonRequest(
      `/api/projects/${projectId}/operational-index?${query}`,
      { headers: adminHeaders },
    );
    assert(
      operationalIndex.response.status === 200,
      `operational index failed: ${JSON.stringify(operationalIndex.body)}`,
    );
    assert(
      (operationalIndex.body.profile as Record<string, unknown>)?.version === 1,
      "operational index must expose the active profile version",
    );
    assert(
      (operationalIndex.body.index as Record<string, unknown>)?.status === "available",
      "fixed M6 fixture must satisfy the index eligibility gates",
    );
    assert(
      Array.isArray(operationalIndex.body.rawMetrics) &&
        operationalIndex.body.rawMetrics.length === 10,
      "operational index must retain all raw metric results",
    );
    const lineage = await jsonRequest(
      `/api/projects/${projectId}/metrics/project_operational_index/lineage`,
      { headers: viewerHeaders },
    );
    assert(
      lineage.response.status === 200 &&
        Array.isArray(lineage.body.nodes) &&
        Array.isArray(lineage.body.edges),
      "viewer can inspect metric lineage JSON",
    );
    const viewerSettingsWrite = await jsonRequest(
      `/api/projects/${projectId}/operational-settings/versions`,
      {
        method: "POST",
        headers: viewerHeaders,
        body: JSON.stringify({
          targetAccounts: 20,
          expectedActiveWeekdays: [1, 2, 3, 4, 5],
        }),
      },
    );
    assert(
      viewerSettingsWrite.response.status === 403,
      "viewer cannot change operational targets",
    );

    const observabilityOverview = await jsonRequest(
      `/api/projects/${projectId}/observability/overview?${query}`,
      { headers: viewerHeaders },
    );
    assert(
      observabilityOverview.response.status === 200,
      `observability overview failed: ${JSON.stringify(observabilityOverview.body)}`,
    );
    const observabilitySummary = observabilityOverview.body.summary as Record<
      string,
      number
    >;
    assert(
      observabilitySummary.errorOccurrences === 60 &&
        observabilitySummary.errorGroups === 3 &&
        observabilitySummary.vitalSamples === 20,
      "M8 read model must aggregate three stable error groups and Web Vitals",
    );
    assert(
      Array.isArray(observabilityOverview.body.alerts) &&
        observabilityOverview.body.alerts.length >= 4,
      "M8 fixed alerts must expose threshold evidence",
    );
    assert(
      (observabilityOverview.body.boundaries as Record<string, unknown>)
        ?.operationalIndexVersion === "operational_v1_unchanged",
      "M8 must not silently change the operational index v1 formula",
    );
    const firstError = (
      observabilityOverview.body.errors as Array<Record<string, unknown>>
    )[0];
    assert(typeof firstError?.groupId === "string", "M8 must expose an error group");
    const errorDetail = await jsonRequest(
      `/api/projects/${projectId}/observability/errors/${firstError.groupId}?${query}`,
      { headers: viewerHeaders },
    );
    assert(
      errorDetail.response.status === 200 &&
        Array.isArray(errorDetail.body.impact) &&
        typeof errorDetail.body.privacy === "string",
      "error detail must retain release/page impact and privacy boundaries",
    );

    const pagePerformance = await jsonRequest(
      `/api/projects/${projectId}/observability/page-performance?${query}`,
      { headers: viewerHeaders },
    );
    assert(
      pagePerformance.response.status === 200,
      `P1 page performance failed: ${JSON.stringify(pagePerformance.body)}`,
    );
    const apiEvidence = pagePerformance.body.api as Record<string, unknown>;
    const resourceEvidence = pagePerformance.body.resources as Record<string, unknown>;
    const readinessEvidence = pagePerformance.body.readiness as Record<string, unknown>;
    assert(
      apiEvidence.status === "available" &&
        Array.isArray(apiEvidence.items) &&
        (apiEvidence.items[0] as Record<string, unknown>)?.denominator === 20,
      "P1 API evidence must retain the request denominator and pass the P90 sample gate",
    );
    assert(
      resourceEvidence.denominator === 240 && resourceEvidence.numerator === 20,
      "P1 resource evidence must aggregate request and failure denominators",
    );
    assert(
      readinessEvidence.status === "available" &&
        Array.isArray(readinessEvidence.items),
      "P1 explicit readiness must be queryable by template",
    );

    const publicCollectorConfig = await jsonRequest(
      `/v1/collector-config/${m5Fixture.projectKey}`,
      { headers: { origin } },
    );
    assert(
      publicCollectorConfig.response.status === 200 &&
        publicCollectorConfig.body.version === 1,
      "registered origins must receive the active project collector version",
    );
    const blockedCollectorConfig = await jsonRequest(
      `/v1/collector-config/${m5Fixture.projectKey}`,
      { headers: { origin: "https://evil.example.test" } },
    );
    assert(
      blockedCollectorConfig.response.status === 403,
      "unregistered origins must not receive collector configuration",
    );

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
        operationalProfileVersion: (
          operationalIndex.body.profile as Record<string, unknown>
        )?.version,
        observability: observabilitySummary,
        p1ApiStatus: apiEvidence.status,
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
