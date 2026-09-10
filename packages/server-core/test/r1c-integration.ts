import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql, { type RowDataPacket } from "mysql2/promise";
import type { MetricLibraryVersion } from "../src/metric-library.js";
import type { ScoreManagementService } from "../src/score-management.js";
import type { defaultScoreTemplate } from "../src/score-templates.js";
const apiUrl = process.env.FI_API_URL ?? "http://127.0.0.1:3000",
  projectId = "11111111-1111-4111-8111-111111111111";
if (!process.env.MYSQL_URL) throw new Error("MYSQL_URL_REQUIRED");
const pool = mysql.createPool(process.env.MYSQL_URL);
type Snapshot = Awaited<ReturnType<ScoreManagementService["get"]>>;
type Preview = Awaited<ReturnType<ScoreManagementService["preview"]>>;
type Result = Awaited<ReturnType<ScoreManagementService["query"]>>;
type Options = Awaited<ReturnType<ScoreManagementService["businessOptions"]>>;
async function login(email: string, password: string) {
  const r = await fetch(apiUrl + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
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
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  assert.equal(r.status, status, `${method} ${path}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}
const root = `/api/projects/${projectId}`,
  base = root + "/score-management",
  metrics = root + "/metrics";
const query = {
  env: "prod",
  from: "2026-08-01T00:00:00Z",
  to: "2026-08-08T00:00:00Z",
  granularity: "day",
};
const evidence: Record<string, unknown>[] = [];
try {
  const admin = await login("admin@example.invalid", "LocalAdmin-1234"),
    viewer = await login("viewer@example.invalid", "LocalViewer-1234");
  await call(admin, root + "/operational-index", "GET", undefined, 404);
  await call(admin, root + "/metric-profiles", "POST", {}, 404);
  const other = await call<{ id: string }>(
    admin,
    "/api/projects",
    "POST",
    {
      name: "R1-C isolation integration",
      timezone: "UTC",
      origins: ["http://localhost:4173"],
    },
    201,
  );
  for (const type of ["operational", "quality"] as const) {
    let versions = await call<MetricLibraryVersion[]>(
      admin,
      metrics + "/versions?type=" + type,
    );
    for (const draft of versions.filter((v) => v.status === "draft"))
      await call(admin, metrics + "/versions/" + draft.id, "DELETE", undefined, 204);
    versions = await call<MetricLibraryVersion[]>(
      admin,
      metrics + "/versions?type=" + type,
    );
    const active = versions.find((v) => v.status === "active");
    assert(active);
    const [draft, reused] = await Promise.all([
      call<MetricLibraryVersion>(
        admin,
        metrics + "/versions",
        "POST",
        { type, sourceVersionId: active.id },
        201,
      ),
      call<MetricLibraryVersion>(
        admin,
        metrics + "/versions",
        "POST",
        { type, sourceVersionId: active.id },
        201,
      ),
    ]);
    assert.equal(draft.id, reused.id);
    const template = await call<ReturnType<typeof defaultScoreTemplate>>(
      admin,
      base + "/templates?type=" + type,
    );
    assert.equal(template.approval.owner, "Jesse");
    const options = await call<Options>(admin, base + "/business-options");
    const business = {
      confirmed: true,
      scopeId: projectId,
      optionsDigest: options.optionsDigest,
      workflowWeights: Object.fromEntries(options.workflows.map((w) => [w.id, 1])),
      durationMinimumSample: 5,
    };
    const configuration = template.configuration;
    const saved = await call<Snapshot>(admin, base + "/versions/" + draft.id, "PUT", {
      configuration,
      business,
    });
    assert.equal(saved.score?.configuration.owner, "Jesse");
    assert.equal(saved.score?.dependencies.projectId, projectId);
    for (const path of [
      "/versions/" + draft.id,
      "/versions/" + draft.id + "/trials",
      "/versions/" + draft.id + "/result?" + new URLSearchParams(query),
    ])
      await call(viewer, base + path);
    for (const [path, method, body] of [
      [base + "/versions/" + draft.id, "PUT", { configuration, business }],
      [base + "/versions/" + draft.id + "/trials", "POST", query],
      [base + "/versions/" + draft.id + "/review", "POST", query],
      [metrics + "/versions/" + draft.id + "/activate", "POST", undefined],
      [metrics + "/versions/" + draft.id, "DELETE", undefined],
    ] as const)
      await call(viewer, path, method, body, 403);
    await call(
      admin,
      `/api/projects/${other.id}/score-management/versions/${draft.id}`,
      "GET",
      undefined,
      404,
    );
    await call(
      admin,
      metrics + "/versions",
      "POST",
      {
        type: type === "operational" ? "quality" : "operational",
        sourceVersionId: draft.id,
      },
      400,
    );
    await call(
      admin,
      base + "/versions/" + draft.id,
      "PUT",
      { configuration: { ...configuration, facts: { value: 100 } }, business },
      400,
    );
    await call(
      admin,
      base + "/versions/" + draft.id,
      "PUT",
      { configuration, business: { ...business, scopeId: other.id } },
      400,
    );
    await call(
      admin,
      metrics + "/versions/" + draft.id + "/activate",
      "POST",
      undefined,
      409,
    );
    const preview = await call<Preview>(
      admin,
      base + "/versions/" + draft.id + "/preview",
      "POST",
      configuration,
    );
    assert(preview.configurationReady);
    assert.equal(preview.factStatus, "unavailable");
    assert(
      Math.abs(
        preview.fixtures.normal!.value! -
          (type === "operational" ? 76.15 : 72.9532163743),
      ) < 1e-8,
    );
    const actual = await call<Result>(
      admin,
      base + "/versions/" + draft.id + "/result?" + new URLSearchParams(query),
    );
    assert.equal(actual.value, null);
    assert.equal(actual.source, "project_query");
    assert.equal(actual.trend, null);
    assert(actual.definitionLineage.length > 0);
    assert.equal(actual.samples.total, null);
    assert(
      actual.definitionLineage.every((d) =>
        saved.definitions.some((m) => m.id === d.id),
      ),
    );
    const stage = await call<Result>(
      admin,
      base +
        "/versions/" +
        draft.id +
        "/result?" +
        new URLSearchParams({ ...query, env: "staging" }),
    );
    assert.equal(stage.context.env, "staging");
    assert.notDeepEqual(actual.context, stage.context);
    await call(admin, base + "/versions/" + draft.id + "/review", "POST", query, 201);
    // Review invalidation is checked at the common metric-library activation endpoint.
    await call(admin, base + "/versions/" + draft.id, "PUT", {
      configuration: {
        ...configuration,
        displayName: configuration.displayName + " 已审阅",
      },
      business,
    });
    await call(
      admin,
      metrics + "/versions/" + draft.id + "/activate",
      "POST",
      undefined,
      409,
    );
    await call(admin, base + "/versions/" + draft.id + "/review", "POST", query, 201);
    const activationResponses = await Promise.all(
      [0, 1].map(() =>
        fetch(apiUrl + metrics + "/versions/" + draft.id + "/activate", {
          method: "POST",
          headers: { authorization: "Bearer " + admin },
        }),
      ),
    );
    assert.deepEqual(activationResponses.map((r) => r.status).sort(), [201, 409]);
    await Promise.all(activationResponses.map((r) => r.text()));
    const publicRead = await call<Result>(
      viewer,
      root + "/scores/" + configuration.scoreKey + "?" + new URLSearchParams(query),
    );
    assert.equal(publicRead.context.metricSetVersion, draft.id);
    assert.equal(publicRead.value, null);
    const immutable = await call<Snapshot>(admin, base + "/versions/" + draft.id);
    const before = JSON.stringify(immutable.score);
    const copied = await call<MetricLibraryVersion>(
      admin,
      metrics + "/versions",
      "POST",
      { type, sourceVersionId: draft.id },
      201,
    );
    const copiedScore = await call<Snapshot>(admin, base + "/versions/" + copied.id);
    assert.deepEqual(copiedScore.score!.configuration, immutable.score!.configuration);
    assert.notEqual(copiedScore.score!.id, immutable.score!.id);
    const changed = {
      ...immutable.score!.configuration,
      displayName: "复制复用 " + type,
      displayUnit: "percent",
    };
    await call(admin, base + "/versions/" + copied.id, "PUT", {
      configuration: changed,
      business,
    });
    assert.equal(
      JSON.stringify(
        (await call<Snapshot>(admin, base + "/versions/" + draft.id)).score,
      ),
      before,
    );
    const diff = await call<Preview>(
      admin,
      base + "/versions/" + copied.id + "/preview",
      "POST",
      changed,
    );
    assert(diff.diff.some((d) => d.field === "displayName"));
    assert(diff.impact.scoreReferences.length > 0);
    await call(admin, base + "/versions/" + copied.id + "/review", "POST", query, 201);
    await call(
      admin,
      metrics + "/versions/" + copied.id + "/activate",
      "POST",
      undefined,
      201,
    );
    await call(admin, base + "/versions/" + draft.id + "/review", "POST", query, 201);
    await call(
      admin,
      metrics + "/versions/" + draft.id + "/activate",
      "POST",
      undefined,
      201,
    );
    assert.equal(
      JSON.stringify(
        (await call<Snapshot>(admin, base + "/versions/" + draft.id)).score,
      ),
      before,
    );
    const history = await call<Awaited<ReturnType<ScoreManagementService["history"]>>>(
      viewer,
      base + "/versions/" + draft.id + "/trials",
    );
    assert(history.length >= 3);
    assert(
      history.every(
        (t) =>
          t.result.mode === "historical_trial" &&
          t.result.value === null &&
          t.result.source === "project_query",
      ),
    );
    assert(new Set(history.map((h) => h.result.context.definitionVersion)).size >= 2);
    const finalDraft = await call<MetricLibraryVersion>(
      admin,
      metrics + "/versions",
      "POST",
      { type, sourceVersionId: draft.id },
      201,
    );
    await call(admin, metrics + "/versions/" + finalDraft.id, "DELETE", undefined, 204);
    await call(
      admin,
      metrics + "/versions/" + finalDraft.id + "/activate",
      "POST",
      undefined,
      409,
    );
    const [activeRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM metric_library_versions WHERE project_id=? AND library_type=? AND status='active'`,
      [projectId, type],
    );
    assert.equal(Number(activeRows[0]!.count), 1);
    const [periods] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM metric_activation_periods WHERE library_version_id=? ORDER BY effective_from`,
      [draft.id],
    );
    assert.equal(periods.length, 2);
    assert(periods[0]!.effective_to);
    assert.equal(periods[1]!.effective_to, null);
    const [brokenRefs] = await pool.query<RowDataPacket[]>(
      `SELECT item.id FROM score_items item JOIN score_dimensions dim ON dim.id=item.score_dimension_id JOIN score_definitions score ON score.id=dim.score_definition_id JOIN metric_definitions metric ON metric.id=item.metric_definition_id WHERE score.library_version_id=? AND metric.library_version_id<>score.library_version_id`,
      [copied.id],
    );
    assert.equal(brokenRefs.length, 0);
    evidence.push({
      type,
      activeVersion: draft.id,
      copiedVersion: copied.id,
      immutableSnapshot: true,
      historyTrials: history.length,
      configurationLifecycle: "passed",
      actualFacts: "unavailable",
      fixtureValue: preview.fixtures.normal!.value,
    });
  }
  const [audits] = await pool.query<RowDataPacket[]>(
    `SELECT action,metadata FROM audit_logs WHERE project_id=? AND action LIKE 'score.%'`,
    [projectId],
  );
  assert(audits.some((r) => r.action === "score.saved"));
  assert(audits.some((r) => r.action === "score.historical_trial"));
  assert(
    !audits.some((r) =>
      /password|authorization|raw_events|select\s/i.test(JSON.stringify(r.metadata)),
    ),
  );
  const evidenceDir = process.env.FI_EVIDENCE_DIR ?? "artifacts";
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    evidenceDir + "/r1c-integration.json",
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA ?? null,
        source: "real MySQL and authenticated API",
        evidence,
        manualAcceptance: "pending Jesse",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "passed", types: 2, evidence }));
} finally {
  await pool.end();
}
