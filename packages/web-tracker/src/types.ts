import type { FrontendInsightEventBatchV2 } from "@frontend-insight/event-contract";

export type PropertyValue = string | number | boolean | null;
export type EventProperties = Record<string, PropertyValue>;
export type InteractionType =
  "click" | "submit" | "keyboard" | "programmatic" | "automatic";
export type OperationState = "started" | "succeeded" | "failed" | "canceled";

export interface TrackerEvent {
  eventId: string;
  eventName: string;
  eventTime: string;
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
  projectTimezone?: string;
  registeredFeatures?: readonly string[];
  normalizeRoute?: (url: URL) => string;
  beforeSend?: (context: BeforeSendContext) => TrackerEvent | null;
  flushIntervalMs?: number;
  maximumQueueSize?: number;
  sessionTimeoutMs?: number;
  longViewSuccessAfterMs?: number;
  longViewHeartbeatMs?: number;
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
  batch: FrontendInsightEventBatchV2;
  attempts: number;
}
