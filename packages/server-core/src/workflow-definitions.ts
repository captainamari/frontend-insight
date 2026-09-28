import type { Pool, RowDataPacket } from "mysql2/promise";
import type { FrontendInsightEventV3 } from "@frontend-insight/event-contract";
import { jsonValue } from "./score-storage.js";
import type { WorkflowStepInput, WorkflowTerminalPolicy } from "./model.js";
export interface WorkflowFactDefinition {
  id: string;
  versionId: string;
  workflowKey: string;
  version: number;
  moduleId: string;
  name: string;
  status: string;
  objectStatus: string;
  archived: boolean;
  startPolicy: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  timeoutSeconds: number;
  terminalPolicy: WorkflowTerminalPolicy;
  steps: WorkflowStepInput[];
}
export async function readWorkflowFactDefinitions(
  pool: Pick<Pool, "query">,
  projectId: string,
): Promise<WorkflowFactDefinition[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT w.id,w.workflow_key,w.status AS object_status,w.archived_at,v.id AS version_id,v.version,v.module_id,v.name,v.status,v.start_policy,v.activated_at,v.effective_to,v.timeout_seconds,v.terminal_policy,s.step_key,s.step_order,s.name AS step_name,s.trigger_kind,s.trigger_config FROM workflow_definitions w JOIN workflow_definition_versions v ON v.workflow_definition_id=w.id LEFT JOIN workflow_steps s ON s.workflow_definition_version_id=v.id WHERE w.project_id=? AND v.activated_at IS NOT NULL ORDER BY w.id,v.version,s.step_order LIMIT 40001`,
    [projectId],
  );
  if (rows.length > 40000) throw new Error("WORKFLOW_DEFINITION_LIMIT");
  const definitions = new Map<string, WorkflowFactDefinition>();
  for (const r of rows) {
    const key = String(r.version_id);
    let d = definitions.get(key);
    if (!d) {
      d = {
        id: String(r.id),
        versionId: key,
        workflowKey: String(r.workflow_key),
        version: Number(r.version),
        moduleId: String(r.module_id),
        name: String(r.name),
        status: String(r.status),
        objectStatus: String(r.object_status),
        archived: Boolean(r.archived_at),
        startPolicy: String(r.start_policy),
        effectiveFrom: r.activated_at
          ? new Date(r.activated_at as string).toISOString()
          : null,
        effectiveTo: r.effective_to
          ? new Date(r.effective_to as string).toISOString()
          : null,
        timeoutSeconds: Number(r.timeout_seconds),
        terminalPolicy: jsonValue<WorkflowTerminalPolicy>(r.terminal_policy),
        steps: [],
      };
      definitions.set(key, d);
    }
    if (r.step_key)
      d.steps.push({
        stepKey: String(r.step_key),
        stepOrder: Number(r.step_order),
        name: String(r.step_name),
        triggerKind: r.trigger_kind as WorkflowStepInput["triggerKind"],
        triggerConfig: jsonValue<WorkflowStepInput["triggerConfig"]>(r.trigger_config),
      });
  }
  return [...definitions.values()];
}
/** Definition validation is stateless; instance consistency is additionally checked by the reducer. */
export function workflowEventDefinitionError(
  event: FrontendInsightEventV3,
  definitions: readonly WorkflowFactDefinition[],
): string | null {
  const p = event.payload;
  if (event.event !== "custom") return null;
  const name = String(p.name ?? "");
  if (!name.startsWith("workflow_") && !p.workflowInstanceId) return null;
  const d = definitions.find(
    (d) => d.workflowKey === p.workflowKey && d.version === p.workflowDefinitionVersion,
  );
  if (!d || !d.effectiveFrom) return "WORKFLOW_VERSION_NOT_FOUND";
  if (event.timestamp < Date.parse(d.effectiveFrom))
    return "WORKFLOW_VERSION_NOT_EFFECTIVE";
  if (
    name === "workflow_started" &&
    (d.status !== "active" ||
      d.objectStatus !== "active" ||
      d.archived ||
      (d.effectiveTo && event.timestamp >= Date.parse(d.effectiveTo)))
  )
    return "WORKFLOW_START_VERSION_INACTIVE";
  if (
    !name.startsWith("workflow_") &&
    (!p.operationInstanceId ||
      ![
        "feature_started",
        "feature_succeeded",
        "feature_failed",
        "feature_canceled",
      ].includes(name))
  )
    return "WORKFLOW_OPERATION_ASSOCIATION_INVALID";
  if (name === "workflow_step_reached" || p.workflowStepKey) {
    const step = d.steps.find(
      (s) => s.stepKey === p.workflowStepKey && s.stepOrder === p.workflowStepOrder,
    );
    if (!step) return "WORKFLOW_STEP_DEFINITION_MISMATCH";
    if (step.triggerKind === "operation_terminal" && !p.operationInstanceId)
      return "WORKFLOW_STEP_OPERATION_REQUIRED";
  }
  return null;
}
