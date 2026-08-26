import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";

const apiUrl = process.env.FI_API_URL ?? "http://127.0.0.1:3000";
const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("MYSQL_URL_REQUIRED");

const configuredProjectId = "11111111-1111-4111-8111-111111111111";
const adminUserId = "55555555-5555-4555-8555-555555555555";

interface ApiFailure {
  code?: string;
  message?: string;
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
  if (expectedStatus === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const adminToken = await login("admin@example.invalid", "LocalAdmin-1234");
const viewerToken = await login("viewer@example.invalid", "LocalViewer-1234");
const suffix = Date.now();
const moduleKey = `r1a_verify_${suffix}`;

const module = await request<{ id: string; moduleKey: string; status: string }>(
  adminToken,
  `/api/projects/${configuredProjectId}/modules`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleKey,
      name: `R1-A verify ${suffix}`,
      criticalityWeight: 1,
      displayOrder: -100,
    }),
  },
  201,
);
if (module.moduleKey !== moduleKey) throw new Error("MODULE_CREATE_MISMATCH");

await request(
  adminToken,
  `/api/projects/${configuredProjectId}/modules`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleKey,
      name: "duplicate",
      criticalityWeight: 1,
      displayOrder: 0,
    }),
  },
  409,
);

const modules = await request<Array<{ id: string; moduleKey: string }>>(
  adminToken,
  `/api/projects/${configuredProjectId}/modules`,
);
if (modules[0]?.id !== module.id) throw new Error("MODULE_SORT_ORDER_INVALID");

const page = await request<{ id: string; pageRoute: string }>(
  adminToken,
  `/api/projects/${configuredProjectId}/page-definitions`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleId: module.id,
      pageRoute: `/orders/${suffix}/550e8400-e29b-41d4-a716-446655440000`,
      name: `订单详情 ${suffix}`,
      templateKey: "task_operation",
      isCore: true,
      criticalityWeight: 1,
      expectedFrequency: "daily",
    }),
  },
  201,
);
if (page.pageRoute !== "/orders/:id/:id") {
  throw new Error(`PAGE_ROUTE_NOT_NORMALIZED:${page.pageRoute}`);
}

await request(
  adminToken,
  `/api/projects/${configuredProjectId}/workflow-definitions`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleId: module.id,
      workflowKey: `invalid_${suffix}`,
      name: "invalid",
      startPolicy: "first_step",
      timeoutSeconds: 600,
      terminalPolicy: {
        completedStepKey: "missing",
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
          triggerConfig: { actionKey: "started" },
        },
        {
          stepKey: "completed",
          name: "完成",
          stepOrder: 2,
          triggerKind: "operation_terminal",
          triggerConfig: { state: "completed" },
        },
      ],
    }),
  },
  400,
);

const workflow = await request<{
  id: string;
  latestVersion: { id: string; version: number; status: string; steps: unknown[] };
}>(
  adminToken,
  `/api/projects/${configuredProjectId}/workflow-definitions`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleId: module.id,
      workflowKey: `order_review_${suffix}`,
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
          triggerConfig: { selector: ".review-button" },
        },
        {
          stepKey: "completed",
          name: "审核完成",
          stepOrder: 2,
          triggerKind: "operation_terminal",
          triggerConfig: { state: "completed" },
        },
      ],
    }),
  },
  201,
);
if (
  workflow.latestVersion.version !== 1 ||
  workflow.latestVersion.status !== "draft" ||
  workflow.latestVersion.steps.length !== 2
) {
  throw new Error("WORKFLOW_DRAFT_INVALID");
}

const activeWorkflow = await request<{
  latestVersion: { version: number; status: string };
}>(
  adminToken,
  `/api/projects/${configuredProjectId}/workflow-definitions/${workflow.id}/activate`,
  {
    method: "POST",
    body: JSON.stringify({ versionId: workflow.latestVersion.id }),
  },
  201,
);
if (activeWorkflow.latestVersion.status !== "active") {
  throw new Error("WORKFLOW_ACTIVATION_FAILED");
}

const nextDraft = await request<{
  latestVersion: { version: number; status: string };
}>(
  adminToken,
  `/api/projects/${configuredProjectId}/workflow-definitions/${workflow.id}/draft`,
  {
    method: "PUT",
    body: JSON.stringify({
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
          triggerConfig: { actionKey: "started" },
        },
        {
          stepKey: "completed",
          name: "审核完成",
          stepOrder: 2,
          triggerKind: "operation_terminal",
          triggerConfig: { state: "completed" },
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

await request(
  viewerToken,
  `/api/projects/${configuredProjectId}/workflow-definitions`,
  { method: "POST", body: JSON.stringify({}) },
  403,
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
const isolatedModule = await request<{ id: string }>(
  adminToken,
  `/api/projects/${isolatedProject.id}/modules`,
  {
    method: "POST",
    body: JSON.stringify({
      moduleKey: `isolated_${suffix}`,
      name: "隔离模块",
      criticalityWeight: 1,
      displayOrder: 0,
    }),
  },
  201,
);
await request(
  adminToken,
  `/api/projects/${configuredProjectId}/page-definitions`,
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

await request(adminToken, `/api/projects/${configuredProjectId}/modules/${module.id}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "disabled" }),
});

const pool = mysql.createPool(mysqlUrl);
try {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT action, metadata
     FROM audit_logs
     WHERE project_id = ? AND actor_user_id = ?
       AND entity_id IN (?, ?, ?)
     ORDER BY id`,
    [configuredProjectId, adminUserId, module.id, page.id, workflow.id],
  );
  const actions = new Set(rows.map((row) => String(row.action)));
  for (const action of [
    "module.created",
    "module.updated",
    "page_definition.created",
    "workflow_definition.created",
    "workflow_definition.activated",
    "workflow_definition.draft_saved",
  ]) {
    if (!actions.has(action)) throw new Error(`AUDIT_ACTION_MISSING:${action}`);
  }
  const serializedAudit = JSON.stringify(rows);
  for (const forbidden of [".review-button", "triggerConfig", "token", "query"]) {
    if (serializedAudit.includes(forbidden)) {
      throw new Error(`AUDIT_SENSITIVE_PAYLOAD:${forbidden}`);
    }
  }
} finally {
  await pool.end();
}

console.log(
  JSON.stringify({
    status: "passed",
    milestone: "R1-A",
    moduleId: module.id,
    pageRoute: page.pageRoute,
    workflowId: workflow.id,
    activeVersion: activeWorkflow.latestVersion.version,
    nextDraftVersion: nextDraft.latestVersion.version,
    viewerWriteStatus: 403,
    projectIsolation: "passed",
    auditPrivacy: "passed",
  }),
);
