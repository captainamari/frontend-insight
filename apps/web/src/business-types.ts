import type { OverviewResponse } from "./overview-types";
export interface BusinessObservation {
  events: number;
  pv: number | null;
  uv: number | null;
  unidentified: number;
  unclassified: number;
  excluded: number;
  lastDataAt: string | null;
  firstDataAt: string | null;
}
export interface BusinessResponse {
  project: OverviewResponse["project"];
  query: OverviewResponse["query"];
  identity: string;
  modules: {
    id: string;
    moduleKey: string;
    name: string;
    status: string;
    revision: number;
    archived: boolean;
  }[];
  moduleId: string | null;
  moduleRevisions: unknown[];
  metrics: Omit<OverviewResponse["metrics"], "trends"> & {
    trends: (OverviewResponse["metrics"]["trends"][number] & {
      penetration?: { observationWindow: { from: string; to: string }; reason: string };
    })[];
  };
  observation: BusinessObservation | null;
  pages: {
    pageId: string;
    pageRoute: string;
    name: string;
    moduleId: string;
    pageRevisionId: string;
    moduleRevisionId: string;
    from: string;
    to: string;
    included: boolean;
    reason: string;
    observation?: BusinessObservation;
  }[];
  data: { state: string; reason: string };
  availableFrom: string | null;
  lastDataAt: string | null;
  identityPolicy: {
    version: string;
    rule: string;
    observationScope: string;
    complete: boolean;
  };
  penetration: {
    observationWindow?: { from: string; to: string };
    value: number | null;
    numerator: number | null;
    denominator: number | null;
    reason: string;
    explanation: string;
    [key: string]: unknown;
  };
  workflows: {
    id: string;
    workflowKey: string;
    name: string;
    versionId: string;
    version: number;
    status: string;
    stepKey: string | null;
    stepName: string | null;
    stepOrder: number;
  }[];
  workflowAnalysis?: WorkflowAnalysis | null;
  workflowFacts: { status: string; reason: string };
  diagnostics: OverviewResponse["diagnostics"];
}

export interface WorkflowAnalysis {
  collector: string;
  configurationStatus: string;
  context: { asOf: string; cohort: string; terminalWindow: string; completion: string };
  status: string;
  reason: string;
  availableFrom: string | null;
  coverage: string;
  page: number;
  pageSize: number;
  totalDefinitions: number;
  definitions: {
    id: string;
    versionId: string;
    workflowKey: string;
    name: string;
    version: number;
    sampleState: string;
    started: number;
    completed: number;
    failed: number;
    canceled: number;
    approximate_abandoned: number;
    inProgress: number;
    unresolved: number;
    unidentified: number;
    successRate: number | null;
    task_duration: {
      p50: number | null;
      p90: number | null;
      p75: number | null;
      p99: number | null;
      sample: number;
      algorithm: string;
    };
    stages: {
      stepKey: string;
      name: string;
      stepOrder: number;
      reached: number;
      rate: number | null;
      adjacentDropoff: number | null;
      adjacentDuration: { p50: number | null; p90: number | null; sample: number };
    }[];
    trends: {
      from: string;
      to: string;
      started: number;
      completed: number;
      successRate: number | null;
    }[];
  }[];
  evidence: {
    workflowInstanceId: string;
    workflowKey: string;
    versionId: string;
    startedAt: string;
    terminalAt: string | null;
    state: string;
    durationMs: number | null;
    identified: boolean;
    reasons: string[];
    path_steps: unknown;
  }[];
  evidencePage: number;
  evidenceTotal: number;
  evidenceLimit: number;
  evidenceTruncated: boolean;
}
