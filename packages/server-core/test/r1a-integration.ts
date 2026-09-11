import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";

const apiUrl = process.env.FI_API_URL ?? "http://127.0.0.1:3000";
const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("MYSQL_URL_REQUIRED");

const projectId = "11111111-1111-4111-8111-111111111111";
const adminUserId = "55555555-5555-4555-8555-555555555555";
const revisionOneAt = "2026-01-01T00:00:00.000Z";
const revisionTwoAt = "2026-02-01T00:00:00.000Z";

interface ApiFailure {
  code?: string;
  message?: string;
  details?: Record<string, unknown[]>;
}

interface ModuleDto {
  id: string;
  moduleKey: string;
  name: string;
  displayOrder: number;
  pageCount: number;
  status: "active" | "disabled";
  archivedAt: string | null;
  revision: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  criticalityWeight?: never;
}

interface PageDto {
  id: string;
  moduleId: string;
  pageRoute: string;
  name: string;
  templateKey: string;
  criticalityWeight: number;
  status: "active" | "disabled";
  archivedAt: string | null;
  revision: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

interface WorkflowDto {
  id: string;
  workflowKey: string;
  status: "active" | "disabled";
  archivedAt: string | null;
  latestVersion: {
    id: string;
    version: number;
    status: "draft" | "active" | "retired";
    moduleId: string;
    name: string;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    steps: Array<{
      triggerKind: string;
      triggerConfig: Record<string, string>;
    }>;
  };
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
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status !== expectedStatus) {
    const body = (await response.json().catch(() => ({}))) as ApiFailure;
    throw new Error(
      `HTTP_STATUS_MISMATCH:${path}:${response.status}:${body.code ?? "UNKNOWN"}`,
    );
  }
  if (expectedStatus === 204 || expectedStatus === 404) return undefined as T;
  return response.json() as Promise<T>;
}

function queryAt(at: string, includeArchived = false): string {
  const parameters = new URLSearchParams({ at });
  if (includeArchived) parameters.set("includeArchived", "true");
  return parameters.toString();
}

const adminToken = await login("admin@example.invalid", "LocalAdmin-1234");
const viewerToken = await login("viewer@example.invalid", "LocalViewer-1234");
const suffix = Date.now();
const moduleKey = `r1a_verify_${suffix}`;
const workflowKey = `order_review_${suffix}`;

await request(
  adminToken,
  `/api/projects/${projectId}/modules`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleKey: `rejected_legacy_${suffix}`,
      name: "legacy field must be rejected",
      criticalityWeight: 1,
      displayOrder: 0,
    }),
  },
  400,
);

const module = await request<ModuleDto>(
  adminToken,
  `/api/projects/${projectId}/modules`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleKey,
      name: `R1-A verify ${suffix}`,
      displayOrder: -100,
      effectiveFrom: revisionOneAt,
    }),
  },
  201,
);
if (module.moduleKey !== moduleKey || "criticalityWeight" in module) {
  throw new Error("MODULE_D1_CONTRACT_INVALID");
}

await request(
  adminToken,
  `/api/projects/${projectId}/modules`,
  {
    method: "POST",
    body: JSON.stringify({ moduleKey, name: "duplicate", displayOrder: 0 }),
  },
  409,
);

const page = await request<PageDto>(
  adminToken,
  `/api/projects/${projectId}/page-definitions`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleId: module.id,
      pageRoute: `/orders/${suffix}/550e8400-e29b-41d4-a716-446655440000`,
      name: `订单详情 ${suffix}`,
      templateKey: "task_operation",
      isCore: true,
      criticalityWeight: 1.5,
      expectedFrequency: "daily",
      effectiveFrom: revisionOneAt,
    }),
  },
  201,
);
if (page.pageRoute !== "/orders/:id/:id" || page.criticalityWeight !== 1.5) {
  throw new Error("PAGE_CREATE_INVALID");
}

const revisedModule = await request<ModuleDto>(
  adminToken,
  `/api/projects/${projectId}/modules/${module.id}`,
  {
    method: "PATCH",
    body: JSON.stringify({
      name: `R1-A revised ${suffix}`,
      displayOrder: -90,
      effectiveFrom: revisionTwoAt,
    }),
  },
);
if (revisedModule.revision !== 2 || revisedModule.effectiveFrom !== revisionTwoAt) {
  throw new Error("MODULE_REVISION_NOT_CREATED");
}

const revisedPage = await request<PageDto>(
  adminToken,
  `/api/projects/${projectId}/page-definitions/${page.id}`,
  {
    method: "PATCH",
    body: JSON.stringify({
      name: `订单分析 ${suffix}`,
      templateKey: "analysis_view",
      isCore: false,
      criticalityWeight: 2,
      expectedFrequency: "weekly",
      effectiveFrom: revisionTwoAt,
    }),
  },
);
if (revisedPage.revision !== 2 || revisedPage.templateKey !== "analysis_view") {
  throw new Error("PAGE_REVISION_NOT_CREATED");
}

const historicalModules = await request<ModuleDto[]>(
  adminToken,
  `/api/projects/${projectId}/modules?${queryAt("2026-01-15T00:00:00.000Z")}`,
);
const historicalPages = await request<PageDto[]>(
  adminToken,
  `/api/projects/${projectId}/page-definitions?${queryAt("2026-01-15T00:00:00.000Z")}`,
);
if (
  historicalModules.find((item) => item.id === module.id)?.name !==
    `R1-A verify ${suffix}` ||
  historicalPages.find((item) => item.id === page.id)?.templateKey !== "task_operation"
) {
  throw new Error("HISTORICAL_SEMANTICS_REWRITTEN");
}

const operationRegistry = await request<Array<{ operationKey: string; name: string }>>(
  adminToken,
  `/api/projects/${projectId}/operation-registry`,
);
if (!operationRegistry.some((item) => item.operationKey === "report_export")) {
  throw new Error("OPERATION_REGISTRY_MISSING");
}

for (const invalidTriggerConfig of [
  {
    triggerKind: "selector",
    triggerConfig: { event: "appeared", selector: "#review" },
  },
  {
    triggerKind: "operation_terminal",
    triggerConfig: { operationKey: "report_export", state: "completed" },
  },
  {
    triggerKind: "operation_terminal",
    triggerConfig: { operationKey: `unknown_${suffix}`, state: "succeeded" },
  },
]) {
  await request(
    adminToken,
    `/api/projects/${projectId}/workflow-definitions`,
    {
      method: "POST",
      body: JSON.stringify({
        moduleId: module.id,
        workflowKey: `invalid_${suffix}_${invalidTriggerConfig.triggerKind}_${Math.random().toString(16).slice(2)}`,
        name: "invalid",
        startPolicy: "first_step",
        timeoutSeconds: 600,
        terminalPolicy: {
          completedStepKey: "completed",
          failedStepKey: null,
          canceledStepKey: null,
          timeoutState: "approximate_abandoned",
        },
        steps: [
          {
            stepKey: "started",
            name: "开始",
            stepOrder: 1,
            triggerKind: invalidTriggerConfig.triggerKind,
            triggerConfig: invalidTriggerConfig.triggerConfig,
          },
          {
            stepKey: "completed",
            name: "完成",
            stepOrder: 2,
            triggerKind: "explicit_sdk",
            triggerConfig: {},
          },
        ],
      }),
    },
    invalidTriggerConfig.triggerConfig.operationKey?.startsWith("unknown_") ? 409 : 400,
  );
}

const workflow = await request<WorkflowDto>(
  adminToken,
  `/api/projects/${projectId}/workflow-definitions`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleId: module.id,
      workflowKey,
      name: `订单审核 ${suffix}`,
      startPolicy: "first_step",
      timeoutSeconds: 600,
      terminalPolicy: {
        completedStepKey: "completed",
        failedStepKey: null,
        canceledStepKey: null,
        timeoutState: "approximate_abandoned",
      },
      steps: [
        {
          stepKey: "started",
          name: "开始审核",
          stepOrder: 1,
          triggerKind: "selector",
          triggerConfig: { event: "click", selector: ".review-button" },
        },
        {
          stepKey: "completed",
          name: "审核完成",
          stepOrder: 2,
          triggerKind: "operation_terminal",
          triggerConfig: { operationKey: "report_export", state: "succeeded" },
        },
      ],
    }),
  },
  201,
);
if (
  workflow.latestVersion.version !== 1 ||
  workflow.latestVersion.status !== "draft" ||
  workflow.latestVersion.steps[1]?.triggerConfig.state !== "succeeded"
) {
  throw new Error("WORKFLOW_DRAFT_INVALID");
}

const activeWorkflow = await request<WorkflowDto>(
  adminToken,
  `/api/projects/${projectId}/workflow-definitions/${workflow.id}/activate`,
  {
    method: "POST",
    body: JSON.stringify({ versionId: workflow.latestVersion.id }),
  },
  201,
);
if (activeWorkflow.latestVersion.status !== "active") {
  throw new Error("WORKFLOW_ACTIVATION_FAILED");
}

const nextDraft = await request<WorkflowDto>(
  adminToken,
  `/api/projects/${projectId}/workflow-definitions/${workflow.id}/draft`,
  {
    method: "PUT",
    body: JSON.stringify({
      moduleId: module.id,
      name: `订单审核（新版）${suffix}`,
      startPolicy: "explicit_sdk",
      timeoutSeconds: 900,
      terminalPolicy: {
        completedStepKey: "completed",
        failedStepKey: null,
        canceledStepKey: null,
        timeoutState: "approximate_abandoned",
      },
      steps: [
        {
          stepKey: "started",
          name: "开始审核",
          stepOrder: 1,
          triggerKind: "explicit_sdk",
          triggerConfig: {},
        },
        {
          stepKey: "completed",
          name: "审核完成",
          stepOrder: 2,
          triggerKind: "operation_terminal",
          triggerConfig: { operationKey: "report_export", state: "succeeded" },
        },
      ],
    }),
  },
);
if (
  nextDraft.latestVersion.version !== 2 ||
  nextDraft.latestVersion.status !== "draft"
) {
  throw new Error("ACTIVE_WORKFLOW_MUTATED_IN_PLACE");
}

const pool = mysql.createPool(mysqlUrl);
try {
  const [versionRowsBefore] = await pool.query<RowDataPacket[]>(
    `SELECT version, status, activated_at, effective_to
     FROM workflow_definition_versions
     WHERE workflow_definition_id = ? ORDER BY version`,
    [workflow.id],
  );
  if (
    versionRowsBefore.length !== 2 ||
    versionRowsBefore[0]?.status !== "active" ||
    versionRowsBefore[1]?.status !== "draft"
  ) {
    throw new Error("WORKFLOW_ACTIVE_VERSION_OVERWRITTEN");
  }
} finally {
  await pool.end();
}

const activatedDraft = await request<WorkflowDto>(
  adminToken,
  `/api/projects/${projectId}/workflow-definitions/${workflow.id}/activate`,
  {
    method: "POST",
    body: JSON.stringify({ versionId: nextDraft.latestVersion.id }),
  },
  201,
);
if (
  activatedDraft.latestVersion.version !== 2 ||
  activatedDraft.latestVersion.status !== "active"
) {
  throw new Error("WORKFLOW_NEW_VERSION_NOT_ACTIVATED");
}

const moduleArchiveFailure = await request<ApiFailure>(
  adminToken,
  `/api/projects/${projectId}/modules/${module.id}/archive`,
  { method: "POST" },
  409,
);
if (moduleArchiveFailure.code !== "MODULE_MUST_BE_DISABLED") {
  throw new Error("MODULE_ARCHIVE_DID_NOT_REQUIRE_DISABLE");
}

await request(adminToken, `/api/projects/${projectId}/modules/${module.id}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "disabled" }),
});
const dependencyFailure = await request<ApiFailure>(
  adminToken,
  `/api/projects/${projectId}/modules/${module.id}/archive`,
  { method: "POST" },
  409,
);
if (
  dependencyFailure.code !== "MODULE_ARCHIVE_DEPENDENCIES" ||
  !dependencyFailure.details?.pages?.length ||
  !dependencyFailure.details?.workflows?.length
) {
  throw new Error("MODULE_ARCHIVE_DEPENDENCIES_NOT_REPORTED");
}

await request(adminToken, `/api/projects/${projectId}/page-definitions/${page.id}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "disabled" }),
});
await request(
  adminToken,
  `/api/projects/${projectId}/page-definitions/${page.id}/archive`,
  { method: "POST" },
  204,
);
await request(
  adminToken,
  `/api/projects/${projectId}/workflow-definitions/${workflow.id}`,
  { method: "PATCH", body: JSON.stringify({ status: "disabled" }) },
);
await request(
  adminToken,
  `/api/projects/${projectId}/workflow-definitions/${workflow.id}/archive`,
  { method: "POST" },
  204,
);
await request(
  adminToken,
  `/api/projects/${projectId}/modules/${module.id}/archive`,
  { method: "POST" },
  204,
);

const defaultModules = await request<ModuleDto[]>(
  adminToken,
  `/api/projects/${projectId}/modules`,
);
const defaultPages = await request<PageDto[]>(
  adminToken,
  `/api/projects/${projectId}/page-definitions`,
);
const defaultWorkflows = await request<WorkflowDto[]>(
  adminToken,
  `/api/projects/${projectId}/workflow-definitions`,
);
if (
  defaultModules.some((item) => item.id === module.id) ||
  defaultPages.some((item) => item.id === page.id) ||
  defaultWorkflows.some((item) => item.id === workflow.id)
) {
  throw new Error("ARCHIVE_DEFAULT_FILTER_FAILED");
}

const archivedHistoricalModules = await request<ModuleDto[]>(
  adminToken,
  `/api/projects/${projectId}/modules?${queryAt("2026-01-15T00:00:00.000Z", true)}`,
);
const archivedHistoricalPages = await request<PageDto[]>(
  adminToken,
  `/api/projects/${projectId}/page-definitions?${queryAt("2026-01-15T00:00:00.000Z", true)}`,
);
if (
  archivedHistoricalModules.find((item) => item.id === module.id)?.name !==
    `R1-A verify ${suffix}` ||
  archivedHistoricalPages.find((item) => item.id === page.id)?.name !==
    `订单详情 ${suffix}`
) {
  throw new Error("ARCHIVE_REWROTE_HISTORY");
}

await request(
  adminToken,
  `/api/projects/${projectId}/modules`,
  {
    method: "POST",
    body: JSON.stringify({ moduleKey, name: "key remains occupied", displayOrder: 0 }),
  },
  409,
);
await request(
  adminToken,
  `/api/projects/${projectId}/page-definitions`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleId: "10111111-1111-4111-8111-111111111111",
      pageRoute: page.pageRoute,
      name: "route remains occupied",
      templateKey: "analysis_view",
      isCore: false,
      criticalityWeight: 1,
      expectedFrequency: "weekly",
    }),
  },
  409,
);
await request(
  adminToken,
  `/api/projects/${projectId}/workflow-definitions`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleId: "10111111-1111-4111-8111-111111111111",
      workflowKey,
      name: "key remains occupied",
      startPolicy: "first_step",
      timeoutSeconds: 600,
      terminalPolicy: {
        completedStepKey: "completed",
        failedStepKey: null,
        canceledStepKey: null,
        timeoutState: "approximate_abandoned",
      },
      steps: [
        {
          stepKey: "started",
          name: "开始",
          stepOrder: 1,
          triggerKind: "explicit_sdk",
          triggerConfig: {},
        },
        {
          stepKey: "completed",
          name: "完成",
          stepOrder: 2,
          triggerKind: "explicit_sdk",
          triggerConfig: {},
        },
      ],
    }),
  },
  409,
);

await request(
  adminToken,
  `/api/projects/${projectId}/modules/${module.id}/restore`,
  { method: "POST" },
  201,
);
await request(adminToken, `/api/projects/${projectId}/modules/${module.id}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "active" }),
});
await request(
  adminToken,
  `/api/projects/${projectId}/page-definitions/${page.id}/restore`,
  { method: "POST" },
  201,
);
await request(
  adminToken,
  `/api/projects/${projectId}/workflow-definitions/${workflow.id}/restore`,
  { method: "POST" },
  201,
);

for (const [path, init] of [
  [`/api/projects/${projectId}/modules`, { method: "POST", body: "{}" }],
  [`/api/projects/${projectId}/modules/${module.id}`, { method: "PATCH", body: "{}" }],
  [`/api/projects/${projectId}/modules/${module.id}/archive`, { method: "POST" }],
  [`/api/projects/${projectId}/modules/${module.id}/restore`, { method: "POST" }],
  [
    `/api/projects/${projectId}/page-definitions/${page.id}`,
    { method: "PATCH", body: "{}" },
  ],
  [
    `/api/projects/${projectId}/page-definitions/${page.id}/archive`,
    { method: "POST" },
  ],
  [
    `/api/projects/${projectId}/page-definitions/${page.id}/restore`,
    { method: "POST" },
  ],
  [
    `/api/projects/${projectId}/workflow-definitions/${workflow.id}`,
    { method: "PATCH", body: "{}" },
  ],
  [
    `/api/projects/${projectId}/workflow-definitions/${workflow.id}/draft`,
    { method: "PUT", body: "{}" },
  ],
  [
    `/api/projects/${projectId}/workflow-definitions/${workflow.id}/archive`,
    { method: "POST" },
  ],
  [
    `/api/projects/${projectId}/workflow-definitions/${workflow.id}/restore`,
    { method: "POST" },
  ],
] as const) {
  await request(viewerToken, path, init, 403);
}

await request(
  adminToken,
  `/api/projects/${projectId}/modules/${module.id}`,
  { method: "DELETE" },
  404,
);
await request(
  adminToken,
  `/api/projects/${projectId}/page-definitions/${page.id}`,
  { method: "DELETE" },
  404,
);
await request(
  adminToken,
  `/api/projects/${projectId}/workflow-definitions/${workflow.id}`,
  { method: "DELETE" },
  404,
);

const isolatedProject = await request<{ id: string }>(
  adminToken,
  "/api/projects",
  {
    method: "POST",
    body: JSON.stringify({
      name: `R1-A isolation ${suffix}`,
      timezone: "UTC",
      retentionDays: 90,
      origins: ["http://localhost:4174"],
    }),
  },
  201,
);
const isolatedModule = await request<ModuleDto>(
  adminToken,
  `/api/projects/${isolatedProject.id}/modules`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleKey: `isolated_${suffix}`,
      name: "隔离模块",
      displayOrder: 0,
    }),
  },
  201,
);
await request(
  adminToken,
  `/api/projects/${projectId}/page-definitions`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleId: isolatedModule.id,
      pageRoute: `/isolation/${suffix}`,
      name: "不能跨项目引用",
      templateKey: "analysis_view",
      isCore: false,
      criticalityWeight: 1,
      expectedFrequency: "weekly",
    }),
  },
  404,
);

const verificationPool = mysql.createPool(mysqlUrl);
try {
  const [moduleColumns] = await verificationPool.query<RowDataPacket[]>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'modules'`,
  );
  if (moduleColumns.some((row) => String(row.column_name) === "criticality_weight")) {
    throw new Error("MODULE_CRITICALITY_COLUMN_REMAINS");
  }
  const [moduleRevisions] = await verificationPool.query<RowDataPacket[]>(
    `SELECT revision, name, status, effective_from, effective_to
     FROM module_revisions WHERE module_id = ? ORDER BY revision`,
    [module.id],
  );
  const [pageRevisions] = await verificationPool.query<RowDataPacket[]>(
    `SELECT revision, name, template_key, status, effective_from, effective_to
     FROM page_definition_revisions WHERE page_definition_id = ? ORDER BY revision`,
    [page.id],
  );
  if (
    moduleRevisions.length < 4 ||
    moduleRevisions[0]?.effective_to === null ||
    pageRevisions.length < 3 ||
    pageRevisions[0]?.effective_to === null
  ) {
    throw new Error("REVISION_EFFECTIVE_WINDOWS_INVALID");
  }
  const [workflowVersions] = await verificationPool.query<RowDataPacket[]>(
    `SELECT version, status, activated_at, effective_to
     FROM workflow_definition_versions
     WHERE workflow_definition_id = ? ORDER BY version`,
    [workflow.id],
  );
  if (
    workflowVersions[0]?.status !== "retired" ||
    workflowVersions[0]?.effective_to === null ||
    workflowVersions[1]?.status !== "active" ||
    workflowVersions[1]?.activated_at === null
  ) {
    throw new Error("WORKFLOW_EFFECTIVE_WINDOWS_INVALID");
  }
  const [auditRows] = await verificationPool.query<RowDataPacket[]>(
    `SELECT action, metadata FROM audit_logs
     WHERE project_id = ? AND actor_user_id = ?
       AND entity_id IN (?, ?, ?) ORDER BY id`,
    [projectId, adminUserId, module.id, page.id, workflow.id],
  );
  const actions = new Set(auditRows.map((row) => String(row.action)));
  for (const action of [
    "module.created",
    "module.updated",
    "module.archived",
    "module.restored",
    "page_definition.created",
    "page_definition.updated",
    "page_definition.archived",
    "page_definition.restored",
    "workflow_definition.created",
    "workflow_definition.activated",
    "workflow_definition.draft_saved",
    "workflow_definition.archived",
    "workflow_definition.restored",
  ]) {
    if (!actions.has(action)) throw new Error(`AUDIT_ACTION_MISSING:${action}`);
  }
  const serializedAudit = JSON.stringify(auditRows);
  for (const forbidden of [".review-button", "triggerConfig", "token", "query"]) {
    if (serializedAudit.includes(forbidden)) {
      throw new Error(`AUDIT_SENSITIVE_PAYLOAD:${forbidden}`);
    }
  }
} finally {
  await verificationPool.end();
}

console.log(
  JSON.stringify({
    status: "passed",
    milestone: "R1-A follow-up",
    moduleId: module.id,
    pageId: page.id,
    workflowId: workflow.id,
    moduleRevision: revisedModule.revision,
    pageRevision: revisedPage.revision,
    activeWorkflowVersion: activatedDraft.latestVersion.version,
    viewerWriteEndpoints: 11,
    physicalDelete: "not exposed",
    projectIsolation: "passed",
    auditPrivacy: "passed",
    historicalSemantics: "passed",
  }),
);
