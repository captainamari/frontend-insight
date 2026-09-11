import type { FrontendInsightEventBatch } from "@frontend-insight/event-contract";

export type GlobalRole = "admin" | "viewer";
export type ProjectRole = "owner" | "admin" | "viewer";
export type FeatureType = "data_view" | "action" | "long_view";
export type PageTemplate = "monitoring_dashboard" | "analysis_view" | "task_operation";
export type ExpectedFrequency = "daily" | "weekly" | "monthly" | "ad_hoc";
export type WorkflowStartPolicy = "explicit_sdk" | "first_step";
export type WorkflowTriggerKind =
  | "explicit_sdk"
  | "selector"
  | "network_request"
  | "page_lifecycle"
  | "operation_terminal";
export type WorkflowVersionStatus = "draft" | "active" | "retired";
export type OperationTerminalState = "succeeded" | "failed" | "canceled";

export interface Principal {
  userId: string;
  globalRole: GlobalRole;
  displayName: string;
  email: string | null;
}

export interface ProjectRecord {
  id: string;
  appId: string;
  name: string;
  timezone: string;
  status: "active" | "disabled";
  retentionDays: number;
  origins: string[];
  role?: ProjectRole;
}

export interface FeatureRecord {
  id: string;
  projectId: string;
  featureKey: string;
  name: string;
  description: string | null;
  featureType: FeatureType;
  pageDefinitionId: string | null;
  isKeyTask: boolean;
  taskWeight: number;
  taskTimeoutSeconds: number;
  operationLifecycleEnabled: boolean;
  configurationEffectiveFrom: string;
  longViewSuccessAfterMs: number;
  heartbeatIntervalMs: number;
  launchedAt: string | null;
  status: "active" | "disabled";
}

export interface ModuleRecord {
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

export interface PageDefinitionRecord {
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

export interface WorkflowStepInput {
  stepKey: string;
  name: string;
  stepOrder: number;
  triggerKind: WorkflowTriggerKind;
  triggerConfig: Record<string, string | boolean>;
}

export interface WorkflowStepRecord extends WorkflowStepInput {
  id: string;
  workflowDefinitionVersionId: string;
}

export interface WorkflowDefinitionVersionRecord {
  id: string;
  workflowDefinitionId: string;
  version: number;
  moduleId: string;
  name: string;
  startPolicy: WorkflowStartPolicy;
  terminalPolicy: WorkflowTerminalPolicy;
  timeoutSeconds: number;
  status: WorkflowVersionStatus;
  activatedAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowStepRecord[];
}

export interface WorkflowDefinitionRecord {
  id: string;
  projectId: string;
  moduleId: string;
  workflowKey: string;
  name: string;
  status: "active" | "disabled";
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestVersion: WorkflowDefinitionVersionRecord | null;
}

export interface ProjectOperationalSettings {
  id: string;
  projectId: string;
  version: number;
  targetUsers: number | null;
  expectedActiveWeekdays: number[];
  status: "active" | "superseded";
  effectiveFrom: string;
  effectiveTo: string | null;
}

export type MetricDimensionKey =
  "usage_coverage" | "continuity_depth" | "task_completion" | "usage_efficiency";

export interface MetricProfileItem {
  id: string;
  profileId: string;
  metricKey: string;
  dimensionKey: MetricDimensionKey;
  dimensionWeight: number;
  metricWeight: number;
  targetValue: number | null;
  floorValue: number | null;
  ceilingValue: number | null;
  targetMin: number | null;
  targetMax: number | null;
  toleranceMin: number | null;
  toleranceMax: number | null;
  minimumSample: number | null;
  enabled: boolean;
  required: boolean;
}

export interface MetricProfileRecord {
  id: string;
  projectId: string;
  profileKey: string;
  name: string;
  version: number;
  status: "draft" | "active" | "retired";
  effectiveFrom: string | null;
  items: MetricProfileItem[];
}

export interface ProjectIngestionConfig extends ProjectRecord {
  features: FeatureRecord[];
}

export interface EventEnrichment {
  eventId: string;
  userId: string | null;
  featureId: string | null;
}

export interface KafkaEventEnvelope {
  envelopeVersion: 1;
  projectId: string;
  receivedAt: string;
  requestId: string;
  origin: string;
  batch: FrontendInsightEventBatch;
  enrichments: EventEnrichment[];
}

export interface DataStatusRecord {
  projectId: string;
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
