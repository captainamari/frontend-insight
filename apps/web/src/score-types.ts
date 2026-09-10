export type ScoreType = "operational" | "quality";
export interface ScoreLeaf {
  key: string;
  metricKey: string;
  weight: number;
  enabled: boolean;
  direction: "higher_better" | "lower_better" | "target_range";
  target: Record<string, number> | null;
  minimumSample: number;
}
export interface ScoreConfiguration {
  scoreKey: string;
  displayName: string;
  libraryType: ScoreType;
  owner: string | null;
  displayUnit: "points" | "percent";
  scope: "project" | "module";
  granularity: "5m" | "hour" | "day" | "week" | "month";
  dimensions: {
    key: string;
    displayName: string;
    weight: number;
    leaves: ScoreLeaf[];
  }[];
  gate: { minimumEligibleDimensions: number; minimumLeafWeightCoverage: number };
  colorBands: { greenMinimum: number; yellowMinimum: number };
  radarDimensions: string[];
}
export interface ScoreVersion {
  id: string;
  projectId: string;
  version: number;
  libraryType: ScoreType;
  status: "draft" | "active" | "superseded" | "abandoned";
  sourceVersionId: string | null;
  activatedAt: string | null;
}
export interface ScoreMetric {
  id: string;
  metricKey: string;
  displayName: string;
  unit: string;
  minimumSample: number;
  definitionVersion: string;
  formulaDescription: string;
  numeratorDescription: string | null;
  denominatorDescription: string | null;
  implementationStatus: string;
  unavailableReason: string | null;
  milestone: string;
}
export interface ScoreBusiness {
  templateVersion?: string;
  confirmed: boolean;
  scopeId: string;
  optionsDigest: string;
  workflowWeights: Record<string, number>;
  durationMinimumSample: number;
}
export interface ScoreOptions {
  projectId: string;
  timezone: string;
  optionsDigest: string;
  settings: {
    id: string;
    version: number;
    targetUsers: number | null;
    expectedActiveWeekdays: number[];
  } | null;
  modules: { id: string; name: string; status: string; revisionId: string }[];
  pages: {
    id: string;
    name: string;
    moduleId: string;
    isCore: boolean;
    criticalityWeight: number;
    templateKey: string;
    revisionId: string;
    status: string;
  }[];
  workflows: {
    id: string;
    versionId: string;
    name: string;
    moduleId: string;
    version: number;
  }[];
  sessionPolicy: string;
  percentilePolicy: string;
  businessScope: string;
  pageTargets: unknown;
  pageTemplateVersion: string;
}
export interface ScoreTemplate {
  version: string;
  approval: {
    owner: string;
    approvedAt: string;
    source: string;
    parameterVersion: string;
  };
  configuration: ScoreConfiguration;
}
export interface ScoreSnapshot {
  version: ScoreVersion;
  definitions: ScoreMetric[];
  score: {
    id: string;
    configuration: ScoreConfiguration;
    dependencies: ScoreOptions & ScoreBusiness & { template: ScoreTemplate };
  } | null;
}
export interface ScoreResult {
  scoreKey: string;
  displayName: string;
  libraryType: ScoreType;
  displayUnit: "points" | "percent";
  value: number | null;
  status: string;
  reasons: string[];
  coverage: number;
  eligibleDimensions: number;
  color: string;
  context: {
    projectId: string;
    env: string;
    metricSetVersion: string;
    definitionVersion: string;
    scopeId: string;
    timezone: string;
    from: string;
    to: string;
    granularity: string;
  };
  dimensions: {
    key: string;
    displayName: string;
    weight: number;
    score: number | null;
    contribution: number | null;
    leaves: (ScoreLeaf & {
      unit: string;
      definitionVersion: string;
      rawValue: number | null;
      sampleSize: number | null;
      totalSampleSize?: number | null;
      excludedSampleSize?: number | null;
      numerator?: number | null;
      denominator?: number | null;
      status: string;
      reason: string | null;
      score: number | null;
      configuredWeight: number;
      effectiveWeight: number | null;
      contribution: number | null;
    })[];
  }[];
  radar: { key: string; displayName: string; value: number | null }[];
  source?: string;
  mode: string;
  effectiveAt: string | null;
  configurationStatus?: string;
  definitionLineage?: ScoreMetric[];
  dependencySnapshot?: ScoreOptions & ScoreBusiness;
  samples?: {
    total: number | null;
    valid: number | null;
    excluded: number | null;
    unidentified: number | null;
    reason: string;
  };
  observation?: {
    expectedDates: string[];
    activeDates: string[] | null;
    numerator: number | null;
    denominator: number | null;
    reason: string;
  };
  activationPeriods?: {
    versionId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
}
export interface ScorePreview {
  configurationReady: boolean;
  factStatus: string;
  readiness: { key: string; reason: string }[];
  diff: { field: string; before: unknown; after: unknown }[];
  impact: unknown;
  metricDiff: unknown;
  definitionLineage: ScoreMetric[];
  fixtures: {
    reason: string;
    normal: ScoreResult | null;
    partial: ScoreResult | null;
    gateFailure: ScoreResult | null;
    healthyZeroErrors: ScoreResult | null;
    noData: ScoreResult | null;
  };
  template: ScoreTemplate;
  templateChanged: boolean;
  businessConfirmed?: boolean;
  trial?: { id: string; result: ScoreResult };
}
export interface ScoreTrial {
  id: string;
  createdAt: string;
  result: ScoreResult;
}
