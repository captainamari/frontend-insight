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
  metrics: OverviewResponse["metrics"];
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
  workflowFacts: { status: string; reason: string };
  diagnostics: OverviewResponse["diagnostics"];
}
