import type { FrontendInsightEventBatchV3 } from "@frontend-insight/event-contract";

export type PropertyValue = string | number | boolean | null;
export type EventProperties = Record<string, PropertyValue>;
export type InteractionType =
  "click" | "submit" | "keyboard" | "programmatic" | "automatic";
export type OperationState = "started" | "succeeded" | "failed" | "canceled";
export type DeploymentEnvironment = "production" | "staging" | "test" | "development";
export type ResourceType =
  "script" | "stylesheet" | "image" | "font" | "media" | "other";
export type RequestMethod =
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "OTHER";
export type WebVitalName = "LCP" | "CLS" | "INP" | "FCP" | "TTFB";
export type WebVitalRating = "good" | "needs_improvement" | "poor";
export type NavigationType =
  "navigate" | "reload" | "back_forward" | "prerender" | "unknown";

export interface ObservabilityConfig {
  enabled: boolean;
  captureJsErrors?: boolean;
  captureResourceErrors?: boolean;
  captureApiErrors?: boolean;
  captureWebVitals?: boolean;
}

export interface CollectorToggle {
  enabled?: boolean;
  sampleRate?: number;
}

export interface P1CollectorConfig {
  api?: CollectorToggle & {
    slowThresholdMs?: number;
    globalFetch?: boolean;
  };
  resources?: CollectorToggle;
  firstScreen?: CollectorToggle;
  listRender?: CollectorToggle;
  longTasks?: CollectorToggle;
  blankScreen?: CollectorToggle;
  breadcrumbs?: CollectorToggle & {
    allowedActionKeys?: readonly string[];
  };
}

export interface ApiRequestDetails {
  method: string;
  url: string | URL;
  statusCode: number;
  durationMs: number;
}

export interface ResourceRequestDetails {
  resourceType: ResourceType;
  url: string | URL;
  succeeded: boolean;
  durationMs?: number;
}

export interface PageReadinessDetails {
  templateKey: "monitoring_dashboard" | "analysis_view" | "task_operation";
  blankCandidate?: boolean;
}

export interface Breadcrumb {
  kind: "route" | "action" | "api" | "error";
  occurredAt: string;
  key: string;
  method?: RequestMethod;
  path?: string;
  statusCode?: number;
}

export interface ApiErrorDetails {
  method: string;
  url: string | URL;
  statusCode: number;
  durationMs: number;
}

export interface ResourceErrorDetails {
  resourceType: ResourceType;
  url: string | URL;
}

export interface WebVitalDetails {
  name: WebVitalName;
  value: number;
  rating?: WebVitalRating;
  navigationType?: NavigationType;
}

export interface TrackerEvent {
  eventId: string;
  eventName: string;
  occurredAt: string;
  deploymentEnvironment: Exclude<DeploymentEnvironment, "test">;
  releaseVersion: string;
  visitorId: string;
  sessionId: string;
  pageViewId: string;
  accountRef?: string;
  route: string;
  title?: string;
  timezoneOffsetMinutes: number;
  featureKey?: string;
  reasonCode?: string;
  operationInstanceId?: string;
  interactionType?: InteractionType;
  properties: EventProperties;
  breadcrumbs?: Breadcrumb[];
}

export interface TrackerDiagnostics {
  state: "active" | "noop" | "destroyed";
  queueSize: number;
  sentEvents: number;
  droppedEvents: number;
  failedBatches: number;
  retries: number;
  beaconFallbacks: number;
  duplicateOperationTerminals: number;
  lastErrorCode?: string;
  warnings: string[];
}

export interface BeforeSendContext {
  event: Readonly<TrackerEvent>;
}

export interface TrackerConfig {
  projectKey: string;
  endpoint: string;
  releaseVersion: string;
  deploymentEnvironment?: Exclude<DeploymentEnvironment, "test">;
  projectTimezone?: string;
  registeredFeatures?: readonly string[];
  staticProperties?: EventProperties;
  normalizeRoute?: (url: URL) => string;
  beforeSend?: (context: BeforeSendContext) => TrackerEvent | null;
  flushIntervalMs?: number;
  maximumQueueSize?: number;
  sessionTimeoutMs?: number;
  longViewSuccessAfterMs?: number;
  longViewHeartbeatMs?: number;
  observability?: ObservabilityConfig;
  collectors?: P1CollectorConfig;
  development?: boolean;
  runtime?: TrackerRuntime;
}

export interface TrackerRuntime {
  window: Window;
  document: Document;
  navigator: Pick<Navigator, "sendBeacon">;
  storage?: Pick<Storage, "getItem" | "setItem">;
  fetch: typeof fetch;
  crypto: Pick<Crypto, "randomUUID">;
  now: () => number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
}

export interface Tracker {
  setAccount(accountRef: string | null): void;
  track(eventName: string, properties?: EventProperties): void;
  featureExposed(featureKey: string, properties?: EventProperties): void;
  featureStarted(featureKey: string, properties?: EventProperties): void;
  featureSucceeded(featureKey: string, properties?: EventProperties): void;
  featureFailed(
    featureKey: string,
    reasonCode: string,
    properties?: EventProperties,
  ): void;
  startOperation(
    featureKey: string,
    properties?: EventProperties,
    interactionType?: InteractionType,
  ): OperationHandle;
  startLongView(featureKey: string): () => void;
  captureException(error: unknown): void;
  captureApiError(details: ApiErrorDetails): void;
  captureResourceError(details: ResourceErrorDetails): void;
  captureWebVital(details: WebVitalDetails): void;
  captureApiRequest(details: ApiRequestDetails): void;
  captureResourceRequest(details: ResourceRequestDetails): void;
  markPageReady(details: PageReadinessDetails): void;
  startListRender(listKey: string, rowCount: number): () => void;
  recordBreadcrumbAction(actionKey: string): void;
  flush(reason?: "normal" | "lifecycle"): Promise<void>;
  destroy(): void;
  getDiagnostics(): Readonly<TrackerDiagnostics>;
}

export interface OperationHandle {
  succeed(properties?: EventProperties): void;
  fail(reasonCode: string, properties?: EventProperties): void;
  cancel(properties?: EventProperties): void;
  getState(): OperationState;
}

export interface PendingBatch {
  batch: FrontendInsightEventBatchV3;
  attempts: number;
}
