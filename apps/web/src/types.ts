export type GlobalRole = "admin" | "viewer";
export type ProjectRole = "owner" | "admin" | "viewer";
export type DataState = "healthy" | "delayed" | "no_data" | "broken";
export type PageTemplate = "monitoring_dashboard" | "analysis_view" | "task_operation";
export type ExpectedFrequency = "daily" | "weekly" | "monthly" | "ad_hoc";
export type WorkflowStartPolicy = "explicit_sdk" | "first_step";
export type WorkflowTriggerKind =
  | "explicit_sdk"
  | "selector"
  | "network_request"
  | "page_lifecycle"
  | "operation_terminal";
export interface User {
  userId: string;
  globalRole: GlobalRole;
  displayName: string;
  email: string | null;
}

export interface Project {
  id: string;
  appId: string;
  name: string;
  timezone: string;
  status: "active" | "disabled";
  retentionDays: number;
  origins: string[];
  role?: ProjectRole;
}

export interface ProjectModule {
  id: string;
  projectId: string;
  moduleKey: string;
  name: string;
  displayOrder: number;
  pageCount: number;
  status: "active" | "disabled";
  archivedAt: string | null;
  revisionId: string;
  revision: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface PageDefinition {
  id: string;
  projectId: string;
  moduleId: string;
  pageRoute: string;
  name: string;
  templateKey: PageTemplate;
  isCore: boolean;
  criticalityWeight: number;
  expectedFrequency: ExpectedFrequency;
  status: "active" | "disabled";
  archivedAt: string | null;
  revisionId: string;
  revision: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface WorkflowTerminalPolicy {
  completedStepKey: string;
  failedStepKey: string | null;
  canceledStepKey: string | null;
  timeoutState: "approximate_abandoned";
}

export interface WorkflowStep {
  id: string;
  workflowDefinitionVersionId: string;
  stepKey: string;
  name: string;
  stepOrder: number;
  triggerKind: WorkflowTriggerKind;
  triggerConfig: Record<string, string | boolean>;
}

export interface WorkflowDefinitionVersion {
  id: string;
  workflowDefinitionId: string;
  version: number;
  moduleId: string;
  name: string;
  startPolicy: WorkflowStartPolicy;
  terminalPolicy: WorkflowTerminalPolicy;
  timeoutSeconds: number;
  status: "draft" | "active" | "retired";
  activatedAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowStep[];
}

export interface WorkflowDefinition {
  id: string;
  projectId: string;
  moduleId: string;
  workflowKey: string;
  name: string;
  status: "active" | "disabled";
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestVersion: WorkflowDefinitionVersion | null;
}

export interface DataStatus {
  projectId: string;
  state: DataState;
  reason: string;
  lastReceivedAt: string | null;
  lastIngestedAt: string | null;
  lastQueryableAt: string | null;
  lastRequestId: string | null;
  lastSdkVersion: string | null;
  lastRejectionCode: string | null;
  acceptedEvents: number;
  rejectedEvents: number;
  deadLetterEvents: number;
}
