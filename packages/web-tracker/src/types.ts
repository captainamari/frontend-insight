import type {
  FrontendInsightEnvironment,
  FrontendInsightEventBatchV3,
  FrontendInsightEventV3,
  PayloadValue,
} from "@frontend-insight/event-contract";

export type EventPayload = Record<string, PayloadValue>;
export type InteractionType =
  "click" | "submit" | "keyboard" | "programmatic" | "automatic";
export type OperationState = "started" | "succeeded" | "failed" | "canceled";
export type ResourceType =
  "script" | "stylesheet" | "image" | "font" | "media" | "other";
export type RequestMethod =
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "OTHER";
export type WebVitalName = "lcp" | "cls" | "inp" | "fcp" | "ttfb";
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

export interface ApiErrorDetails {
  method: string;
  url: string | URL;
  statusCode: number;
  durationMs: number;
  failureType?: "http" | "network" | "timeout" | "aborted" | "business";
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

export type TrackerEvent = FrontendInsightEventV3;

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
  appId: string;
  env: FrontendInsightEnvironment;
  release: string;
  endpoint: string;
  deptId?: string | null;
  roleId?: string | null;
  registeredFeatures?: readonly string[];
  staticPayload?: EventPayload;
  normalizePageRoute?: (url: URL) => string;
  beforeSend?: (context: BeforeSendContext) => TrackerEvent | null;
  flushIntervalMs?: number;
  maximumQueueSize?: number;
  sessionTimeoutMs?: number;
  longViewSuccessAfterMs?: number;
  longViewHeartbeatMs?: number;
  observability?: ObservabilityConfig;
  development?: boolean;
  runtime?: TrackerRuntime;
}

export interface TrackerRuntime {
  window: Window;
  document: Document;
  navigator: Pick<Navigator, "sendBeacon" | "userAgent">;
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
  setUser(userId: string | null): void;
  track(name: string, payload?: EventPayload): void;
  featureExposed(featureKey: string, payload?: EventPayload): void;
  featureStarted(featureKey: string, payload?: EventPayload): void;
  featureSucceeded(featureKey: string, payload?: EventPayload): void;
  featureFailed(featureKey: string, reasonCode: string, payload?: EventPayload): void;
  startOperation(
    featureKey: string,
    payload?: EventPayload,
    interactionType?: InteractionType,
  ): OperationHandle;
  startLongView(featureKey: string): () => void;
  captureException(error: unknown): void;
  captureApiError(details: ApiErrorDetails): void;
  captureResourceError(details: ResourceErrorDetails): void;
  captureWebVital(details: WebVitalDetails): void;
  flush(reason?: "normal" | "lifecycle"): Promise<void>;
  destroy(): void;
  getDiagnostics(): Readonly<TrackerDiagnostics>;
}

export interface OperationHandle {
  succeed(payload?: EventPayload): void;
  fail(reasonCode: string, payload?: EventPayload): void;
  cancel(payload?: EventPayload): void;
  getState(): OperationState;
}

export interface PendingBatch {
  batch: FrontendInsightEventBatchV3;
  attempts: number;
}
