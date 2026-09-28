import type { ScoreResult, ScoreVersion } from "./score-types";
import type {
  CalendarBucket,
  resolveProjectCalendar,
} from "@frontend-insight/event-contract/project-range";
export interface OverviewMetric {
  definition: {
    id: string;
    metricKey: string;
    displayName: string;
    unit: string;
    definitionVersion: string;
    businessDescription: string;
    formulaDescription: string;
    minimumSample: number;
    unavailableReason: string | null;
    implementationStatus: string;
    milestone: string;
    deduplicationKey: string;
    missingPolicy: string;
    availableFrom: string | null;
  };
  value: number | null;
  rawValue: number | null;
  rawScope: string;
  status: string;
  reason: string | null;
  sampleSize: number | null;
  dataAt: string | null;
  upstream: string[];
}
export interface OverviewScore {
  version: ScoreVersion | null;
  result: ScoreResult | null;
  reason: string | null;
  lowest: { key: string; displayName: string; score: number } | null;
}
export interface OverviewResponse {
  project: { id: string; name: string; timezone: string; retentionDays: number };
  query: ReturnType<typeof resolveProjectCalendar>;
  identity: string;
  pipeline: { state: string; scope: string; envVerified: boolean; reasons: string[] };
  state: string;
  reasons: string[];
  data: { state: string; reason: string };
  lastDataAt: string | null;
  lastDataSource: string;
  availableFrom: string | null;
  operational: OverviewScore;
  quality: OverviewScore;
  metrics: {
    version: ScoreVersion | null;
    status: string;
    cards: OverviewMetric[];
    selected: string[];
    boundaries: { at: string; versionId: string }[];
    trends: (CalendarBucket & {
      versionId: string | null;
      segment: string | null;
      reason: string | null;
      metrics: {
        metricKey: string;
        value: number | null;
        rawValue: number | null;
        status: string;
        sampleSize: number | null;
        reason: string | null;
      }[];
    })[];
  };
  alerts: {
    status: string;
    reason: string;
    completeness?: string;
    truncated?: boolean;
    rules?: Record<string, string>;
    scope: Record<string, unknown>;
    items: {
      id: string;
      title: string;
      evidence: string;
      ruleKey: string;
      severity: string;
      sample: number | null;
      definitionVersion: string;
      triggeredAt: string | null;
      scope: Record<string, unknown>;
      detail: unknown;
    }[];
  };
  diagnostics: { physicalRetentionDays: number; elapsedMs: number };
}
