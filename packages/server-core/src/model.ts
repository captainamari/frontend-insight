import type { FrontendInsightEventBatchV1 } from "@frontend-insight/event-contract";

export type GlobalRole = "admin" | "viewer";
export type ProjectRole = "owner" | "admin" | "viewer";
export type FeatureType = "data_view" | "action" | "long_view";

export interface Principal {
  userId: string;
  globalRole: GlobalRole;
  displayName: string;
  email: string | null;
}

export interface ProjectRecord {
  id: string;
  projectKey: string;
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
  longViewSuccessAfterMs: number;
  heartbeatIntervalMs: number;
  launchedAt: string | null;
  status: "active" | "disabled";
}

export interface ProjectIngestionConfig extends ProjectRecord {
  features: FeatureRecord[];
}

export interface EventEnrichment {
  eventId: string;
  accountId: string | null;
  featureId: string | null;
}

export interface KafkaEventEnvelope {
  envelopeVersion: 1;
  projectId: string;
  receivedAt: string;
  requestId: string;
  origin: string;
  batch: FrontendInsightEventBatchV1;
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
