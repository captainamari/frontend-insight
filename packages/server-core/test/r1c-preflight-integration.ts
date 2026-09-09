import assert from "node:assert/strict";
import mysql, { type RowDataPacket } from "mysql2/promise";

const apiUrl = process.env.FI_API_URL ?? "http://127.0.0.1:3000";
const projectId = "11111111-1111-4111-8111-111111111111";
if (!process.env.MYSQL_URL) throw new Error("MYSQL_URL_REQUIRED");
const pool = mysql.createPool(process.env.MYSQL_URL);
async function login(email: string, password: string) {
  const response = await fetch(`${apiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return String(((await response.json()) as { accessToken: string }).accessToken);
}
async function request(token: string, path: string, body?: unknown, expected = 200) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = (await response.json()) as Record<string, unknown>;
  assert.equal(
    response.status,
    expected,
    `Unexpected status for ${path}: ${String(result.code)}`,
  );
  return result;
}
async function counts() {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT
    (SELECT COUNT(*) FROM metric_library_versions) AS versions,
    (SELECT COUNT(*) FROM score_definitions) AS scores,
    (SELECT COUNT(*) FROM audit_logs) AS audits`);
  return rows[0];
}
try {
  const admin = await login("admin@example.invalid", "LocalAdmin-1234");
  const viewer = await login("viewer@example.invalid", "LocalViewer-1234");
  const before = await counts();
  for (const type of ["operational", "quality"] as const) {
    const catalog = await request(
      admin,
      `/api/projects/${projectId}/metrics/catalog?type=${type}`,
    );
    const versionId = (catalog.activeVersion as { id: string }).id;
    const metricKeys =
      type === "operational" ? ["pv", "uv", "vv"] : ["lcp", "inp", "cls"];
    const configuration = {
      scoreKey: `${type}_preflight_check`,
      displayName: "配置校验，未保存，非正式模板",
      libraryType: type,
      owner: null,
      displayUnit: "points",
      scope: "project",
      granularity: "day",
      dimensions: metricKeys.map((metricKey, index) => ({
        key: `dimension_${index}`,
        displayName: metricKey,
        weight: [0.4, 0.35, 0.25][index],
        leaves: [
          {
            key: `leaf_${index}`,
            metricKey,
            weight: 1,
            enabled: true,
            direction: "lower_better",
            target: null,
            minimumSample: 100,
          },
        ],
      })),
      gate: { minimumEligibleDimensions: 3, minimumLeafWeightCoverage: 0.7 },
      colorBands: { greenMinimum: 85, yellowMinimum: 60 },
      radarDimensions: ["dimension_0", "dimension_1", "dimension_2"],
    };
    const path = `/api/projects/${projectId}/metrics/versions/${versionId}/scores/preflight`;
    const result = await request(admin, path, configuration);
    assert.equal(result.valid, true);
    assert.equal(result.saved, false);
    assert.equal(result.value, null);
    assert.equal(result.status, "unavailable");
    assert.equal(result.metricSetVersion, versionId);
    const readiness = result.readiness as { key: string; reason: string }[];
    assert(readiness.some((item) => item.reason === "SCORE_OWNER_MISSING"));
    assert(readiness.some((item) => item.reason === "SCORE_TARGET_REQUIRED"));
    assert(readiness.some((item) => item.reason === "partial"));
    await request(viewer, path, configuration, 403);
    const negative = await request(
      admin,
      path,
      { ...configuration, facts: { value: 100 } },
      400,
    );
    assert.equal(negative.code, "SCORE_FIELD_NOT_ALLOWED");
    await request(
      admin,
      path,
      {
        ...configuration,
        libraryType: type === "operational" ? "quality" : "operational",
      },
      400,
    );
  }
  assert.deepEqual(
    await counts(),
    before,
    "Preflight must not mutate scores, versions or audit history",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      milestone: "R1-C preflight regression",
      verified: [
        "real-mysql-version-snapshot",
        "operational-and-quality-preflight",
        "admin-viewer-authorization",
        "no-caller-fact-injection",
        "no-score-or-version-mutation",
      ],
      productionScoreFlow: "verified-separately-by-r1c-integration-and-browser-gates",
    }),
  );
} finally {
  await pool.end();
}
