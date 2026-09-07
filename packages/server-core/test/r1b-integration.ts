import { FORBIDDEN_ALIASES } from "@frontend-insight/event-contract";
import type { RowDataPacket } from "mysql2/promise";
import mysql from "mysql2/promise";

const apiUrl = process.env.FI_API_URL ?? "http://127.0.0.1:3000";
const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("MYSQL_URL_REQUIRED");

const projectId = "11111111-1111-4111-8111-111111111111";

interface ApiResult<T> {
  status: number;
  body: T;
}

interface Version {
  id: string;
  projectId: string;
  libraryType: "operational" | "quality";
  version: number;
  status: "draft" | "active" | "superseded" | "abandoned";
  sourceVersionId: string | null;
}

interface MetricDefinition {
  metricKey: string;
  origin: "system" | "business";
  formulaDescription: string;
  implementationStatus: "implemented" | "partial" | "not_collected";
}

interface VersionSnapshot {
  version: Version;
  definitions: MetricDefinition[];
}

async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${apiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`LOGIN_FAILED:${response.status}`);
  return String(((await response.json()) as { accessToken: string }).accessToken);
}

async function request<T>(
  token: string,
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<ApiResult<T>> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : undefined) as T;
  if (response.status !== expectedStatus) {
    throw new Error(
      `HTTP_STATUS_MISMATCH:${path}:${response.status}:${JSON.stringify(body)}`,
    );
  }
  return { status: response.status, body };
}

function businessMetric(input: {
  metricKey: string;
  displayName: string;
  formulaAst: unknown;
  unit: string;
  minimumSample?: number;
}) {
  return {
    metricKey: input.metricKey,
    displayName: input.displayName,
    businessDescription: `${input.displayName}固定验收口径`,
    category: "usage",
    numeratorDescription: "由受控输入指标产生",
    denominatorDescription: "与公式一致",
    deduplicationKey: "继承输入指标去重键",
    unit: input.unit,
    entityScope: "project",
    timeGranularity: "day",
    minimumSample: input.minimumSample ?? 1,
    missingPolicy: "null、insufficient、delayed 和分母 0 均传播为不可用，不补 0。",
    owner: "product-analytics",
    enabled: true,
    formulaAst: input.formulaAst,
  };
}

const adminToken = await login("admin@example.invalid", "LocalAdmin-1234");
const viewerToken = await login("viewer@example.invalid", "LocalViewer-1234");

const catalog = (
  await request<{
    system: Array<{
      metricKey: string;
      implementationStatus: string;
      availableFrom: string | null;
      unavailableReason: string | null;
    }>;
    business: MetricDefinition[];
    activeVersion: Version;
  }>(adminToken, `/api/projects/${projectId}/metrics/catalog?type=operational`)
).body;
if (catalog.system.length !== 19 || !catalog.activeVersion) {
  throw new Error("OPERATIONAL_SYSTEM_CATALOG_INVALID");
}
if (
  catalog.system.some(
    (item) =>
      !["implemented", "partial", "not_collected"].includes(
        item.implementationStatus,
      ) ||
      (item.implementationStatus === "not_collected" &&
        (item.availableFrom !== null || !item.unavailableReason)),
  )
) {
  throw new Error("SYSTEM_IMPLEMENTATION_STATUS_INVALID");
}

await request(
  viewerToken,
  `/api/projects/${projectId}/metrics/versions`,
  { method: "POST", body: JSON.stringify({ type: "operational" }) },
  403,
);
await request(
  adminToken,
  `/api/projects/22222222-2222-4222-8222-222222222222/metrics/catalog?type=operational`,
  {},
  403,
);

const draft = (
  await request<Version>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "operational",
        sourceVersionId: catalog.activeVersion.id,
      }),
    },
    201,
  )
).body;
if (draft.status !== "draft" || draft.sourceVersionId !== catalog.activeVersion.id) {
  throw new Error("DRAFT_COPY_FAILED");
}

const reusedDraft = (
  await request<Version>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "operational",
        sourceVersionId: catalog.activeVersion.id,
      }),
    },
    201,
  )
).body;
if (reusedDraft.id !== draft.id || reusedDraft.version !== draft.version) {
  throw new Error("DRAFT_WAS_DUPLICATED_INSTEAD_OF_REUSED");
}

const clampPreviewDefinition = {
  ...businessMetric({
    metricKey: "bounded_active_users",
    displayName: "限定活跃用户数",
    formulaAst: {
      type: "call",
      function: "clamp",
      arguments: [
        { type: "metric", metricKey: "uv" },
        { type: "literal", value: 0 },
        { type: "literal", value: 100 },
      ],
    },
    unit: "users",
  }),
  unit: undefined,
};
const clampPreview = (
  await request<{
    valid: boolean;
    inferredUnit: string | null;
    dependencies: string[];
  }>(
    viewerToken,
    `/api/projects/${projectId}/metrics/versions/${draft.id}/definitions/preview`,
    { method: "POST", body: JSON.stringify(clampPreviewDefinition) },
  )
).body;
if (
  !clampPreview.valid ||
  clampPreview.inferredUnit !== "users" ||
  clampPreview.dependencies.join(",") !== "uv"
) {
  throw new Error("FORMULA_PREVIEW_INFERENCE_FAILED");
}

const reservedKey = catalog.system[0]!.metricKey;
const reservedFailure = await request<{ code: string }>(
  adminToken,
  `/api/projects/${projectId}/metrics/versions/${draft.id}/definitions/${reservedKey}`,
  {
    method: "PUT",
    body: JSON.stringify(
      businessMetric({
        metricKey: reservedKey,
        displayName: "禁止覆盖",
        formulaAst: { type: "metric", metricKey: reservedKey },
        unit: "views",
      }),
    ),
  },
  409,
);
if (reservedFailure.body.code !== "SYSTEM_METRIC_KEY_RESERVED") {
  throw new Error("RESERVED_KEY_NOT_PROTECTED");
}

const removedKey = FORBIDDEN_ALIASES.metricKeys[0];
const removedFailure = await request<{ code: string }>(
  adminToken,
  `/api/projects/${projectId}/metrics/${removedKey}/definition`,
  {},
  410,
);
if (removedFailure.body.code !== "METRIC_KEY_REMOVED") {
  throw new Error("REMOVED_KEY_ERROR_UNSTABLE");
}

const unsafeFailure = await request<{ code: string }>(
  adminToken,
  `/api/projects/${projectId}/metrics/versions/${draft.id}/definitions/unsafe_formula`,
  {
    method: "PUT",
    body: JSON.stringify(
      businessMetric({
        metricKey: "unsafe_formula",
        displayName: "不安全公式",
        formulaAst: "SELECT value FROM raw_events",
        unit: "ratio",
      }),
    ),
  },
  400,
);
if (unsafeFailure.body.code !== "FORMULA_NODE_INVALID") {
  throw new Error("UNSAFE_FORMULA_NOT_REJECTED");
}

const fixtures = [
  businessMetric({
    metricKey: "pages_per_visit",
    displayName: "单会话浏览页数",
    formulaAst: {
      type: "binary",
      operator: "/",
      left: { type: "metric", metricKey: "pv" },
      right: { type: "metric", metricKey: "vv" },
    },
    unit: "views_per_session",
  }),
  businessMetric({
    metricKey: "active_user_blend",
    displayName: "活跃用户组合值",
    formulaAst: {
      type: "weighted_mean",
      items: [
        { value: { type: "metric", metricKey: "uv" }, weight: 3 },
        { value: { type: "metric", metricKey: "dau" }, weight: 2 },
      ],
    },
    unit: "users",
  }),
  businessMetric({
    metricKey: "session_target_score",
    displayName: "会话目标得分",
    formulaAst: {
      type: "normalize",
      direction: "higher_better",
      input: { type: "metric", metricKey: "vv" },
      target: { floor: 0, target: 100 },
    },
    unit: "score",
  }),
];

for (const definition of fixtures) {
  const saved = await request<{
    version: Version;
    definition: MetricDefinition;
    validation: { valid: boolean };
  }>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions/${draft.id}/definitions/${definition.metricKey}`,
    { method: "PUT", body: JSON.stringify(definition) },
  );
  if (saved.body.version.id !== draft.id || !saved.body.validation.valid) {
    throw new Error(`BUSINESS_METRIC_SAVE_FAILED:${definition.metricKey}`);
  }
}

const validation = (
  await request<{
    valid: boolean;
    definitions: Array<{
      metricKey: string;
      implementationStatus: string;
      formulaDescription: string;
    }>;
  }>(adminToken, `/api/projects/${projectId}/metrics/versions/${draft.id}/validate`, {
    method: "POST",
  })
).body;
if (!validation.valid || validation.definitions.length !== 3) {
  throw new Error("VERSION_VALIDATION_FAILED");
}
if (
  validation.definitions.find((item) => item.metricKey === "active_user_blend")
    ?.implementationStatus !== "not_collected"
) {
  throw new Error("DEPENDENCY_STATUS_NOT_DERIVED");
}

const activated = (
  await request<Version>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions/${draft.id}/activate`,
    { method: "POST" },
    201,
  )
).body;
if (activated.status !== "active") throw new Error("VERSION_ACTIVATION_FAILED");

const activeBeforeEdit = (
  await request<VersionSnapshot>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions/${activated.id}`,
  )
).body;
const originalFormula = activeBeforeEdit.definitions.find(
  (item) => item.metricKey === "pages_per_visit",
)?.formulaDescription;

const editedMetric = {
  ...fixtures[0]!,
  displayName: "单会话浏览页数（草稿修改）",
};
const autoDraftResult = (
  await request<{
    version: Version;
    definition: MetricDefinition;
    validation: { valid: boolean };
  }>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions/${activated.id}/definitions/${editedMetric.metricKey}`,
    { method: "PUT", body: JSON.stringify(editedMetric) },
  )
).body;
if (
  autoDraftResult.version.id === activated.id ||
  autoDraftResult.version.status !== "draft"
) {
  throw new Error("ACTIVE_EDIT_DID_NOT_COPY_DRAFT");
}
const activeAfterEdit = (
  await request<VersionSnapshot>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions/${activated.id}`,
  )
).body;
if (
  activeAfterEdit.definitions.find((item) => item.metricKey === "pages_per_visit")
    ?.formulaDescription !== originalFormula
) {
  throw new Error("ACTIVE_VERSION_MUTATED_IN_PLACE");
}

const difference = (
  await request<{ changed: Array<{ metricKey: string; fields: string[] }> }>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions/${autoDraftResult.version.id}/diff`,
  )
).body;
if (
  !difference.changed.some(
    (item) =>
      item.metricKey === "pages_per_visit" && item.fields.includes("displayName"),
  )
) {
  throw new Error("VERSION_DIFF_MISSING");
}
await request(
  adminToken,
  `/api/projects/${projectId}/metrics/versions/${autoDraftResult.version.id}/impact?metricKey=pages_per_visit`,
);
await request(
  viewerToken,
  `/api/projects/${projectId}/metrics/versions/${autoDraftResult.version.id}/lineage/pages_per_visit`,
);

await request<Version>(
  adminToken,
  `/api/projects/${projectId}/metrics/versions/${autoDraftResult.version.id}/activate`,
  { method: "POST" },
  201,
);
const reactivated = (
  await request<Version>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions/${activated.id}/activate`,
    { method: "POST" },
    201,
  )
).body;
if (reactivated.status !== "active")
  throw new Error("OLD_SNAPSHOT_REACTIVATION_FAILED");

const disposableDraft = (
  await request<Version>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "operational",
        sourceVersionId: reactivated.id,
      }),
    },
    201,
  )
).body;
await request(
  adminToken,
  `/api/projects/${projectId}/metrics/versions/${disposableDraft.id}`,
  { method: "DELETE" },
  204,
);
const abandoned = (
  await request<VersionSnapshot>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions/${disposableDraft.id}`,
  )
).body.version;
if (abandoned.status !== "abandoned") throw new Error("DRAFT_ABANDON_FAILED");

// Saving a quality metric from its active snapshot must create a quality draft,
// leave the operational library untouched, and survive a fresh API read.
const operationalBeforeQuality = (
  await request<Version[]>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions?type=operational`,
  )
).body;
const qualityCatalog = (
  await request<{ activeVersion: Version }>(
    adminToken,
    `/api/projects/${projectId}/metrics/catalog?type=quality`,
  )
).body;
const qualitySaved = (
  await request<{ version: Version }>(
    adminToken,
    `/api/projects/${projectId}/metrics/versions/${qualityCatalog.activeVersion.id}/definitions/quality_lcp_fixture`,
    {
      method: "PUT",
      body: JSON.stringify({
        ...businessMetric({
          metricKey: "quality_lcp_fixture",
          displayName: "两倍绘制耗时",
          unit: "milliseconds",
          minimumSample: 5,
          formulaAst: {
            type: "binary",
            operator: "*",
            left: { type: "metric", metricKey: "lcp" },
            right: { type: "literal", value: 2 },
          },
        }),
        category: "performance",
      }),
    },
  )
).body.version;
if (
  qualitySaved.libraryType !== "quality" ||
  qualitySaved.status !== "draft" ||
  qualitySaved.sourceVersionId !== qualityCatalog.activeVersion.id
) {
  throw new Error("QUALITY_SAVE_WRONG_LIBRARY");
}
const qualitySnapshot = (
  await request<VersionSnapshot>(
    viewerToken,
    `/api/projects/${projectId}/metrics/versions/${qualitySaved.id}`,
  )
).body;
if (
  !qualitySnapshot.definitions.some(
    (item) =>
      item.metricKey === "quality_lcp_fixture" &&
      item.formulaDescription === "(lcp * 2)",
  )
) {
  throw new Error("QUALITY_DEFINITION_NOT_PERSISTED");
}
const qualityVersions = (
  await request<Version[]>(
    viewerToken,
    `/api/projects/${projectId}/metrics/versions?type=quality`,
  )
).body;
const operationalAfterQuality = (
  await request<Version[]>(
    viewerToken,
    `/api/projects/${projectId}/metrics/versions?type=operational`,
  )
).body;
if (
  !qualityVersions.some((item) => item.id === qualitySaved.id) ||
  qualityVersions.some((item) => item.libraryType !== "quality") ||
  JSON.stringify(operationalBeforeQuality) !== JSON.stringify(operationalAfterQuality)
) {
  throw new Error("QUALITY_VERSION_LIST_OR_TYPE_ISOLATION_FAILED");
}

const pool = mysql.createPool(mysqlUrl);
try {
  const [activeRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM metric_library_versions
     WHERE project_id = ? AND library_type = 'operational' AND status = 'active'`,
    [projectId],
  );
  if (Number(activeRows[0]?.count) !== 1) throw new Error("MULTIPLE_ACTIVE_VERSIONS");

  const [auditRows] = await pool.query<RowDataPacket[]>(
    `SELECT action, metadata FROM audit_logs
     WHERE project_id = ? AND action LIKE 'metric_%' ORDER BY created_at DESC`,
    [projectId],
  );
  const actions = new Set(auditRows.map((row) => String(row.action)));
  for (const action of [
    "metric_library.draft_created",
    "metric_definition.saved",
    "metric_library.activated",
    "metric_library.abandoned",
  ]) {
    if (!actions.has(action)) throw new Error(`AUDIT_ACTION_MISSING:${action}`);
  }
  if (
    auditRows.some((row) =>
      JSON.stringify(row.metadata).match(/SELECT|raw_events|authorization|password/i),
    )
  ) {
    throw new Error("AUDIT_PRIVACY_LEAK");
  }

  const [invalidScoreRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count
     FROM score_items si
     JOIN score_dimensions dim ON dim.id = si.score_dimension_id
     JOIN score_definitions score ON score.id = dim.score_definition_id
     JOIN metric_definitions metric ON metric.id = si.metric_definition_id
     WHERE score.status = 'active' AND metric.implementation_status = 'not_collected'`,
  );
  if (Number(invalidScoreRows[0]?.count) !== 0) {
    throw new Error("NOT_COLLECTED_METRIC_BOUND_TO_ACTIVE_SCORE");
  }
} finally {
  await pool.end();
}

console.log(
  JSON.stringify({
    status: "passed",
    milestone: "R1-B",
    systemMetrics: catalog.system.length,
    businessFixtures: fixtures.map((item) => item.metricKey),
    activeVersion: reactivated.id,
    verified: [
      "reserved-and-removed-keys",
      "formula-authority",
      "formula-preview-unit-inference",
      "single-working-draft-reuse",
      "quality-save-persistence-and-type-isolation",
      "immutable-snapshots",
      "draft-diff-impact-lineage",
      "old-snapshot-reactivation",
      "admin-viewer-project-isolation",
      "audit-privacy",
    ],
  }),
);
