import { createNoopTracker } from "./noop.js";
import { browserRuntime } from "./runtime.js";
import { BrowserTracker } from "./tracker.js";
import type { Tracker, TrackerConfig } from "./types.js";

const activeTrackers = new Map<string, Tracker>();

function trackerKey(config: Pick<TrackerConfig, "projectKey" | "endpoint">): string {
  return `${config.projectKey}\u0000${config.endpoint}`;
}

export function createTracker(config: TrackerConfig): Tracker {
  const development = config.development ?? false;
  try {
    if (!/^fi_public_[A-Za-z0-9_-]{8,64}$/.test(config.projectKey)) {
      return createNoopTracker("PROJECT_KEY_INVALID", development);
    }
    const endpoint = new URL(config.endpoint);
    if (!/^https?:$/.test(endpoint.protocol)) {
      return createNoopTracker("ENDPOINT_INVALID", development);
    }
    const key = trackerKey(config);
    const existing = activeTrackers.get(key);
    if (existing?.getDiagnostics().state === "active") return existing;

    const tracker = new BrowserTracker(
      {
        projectKey: config.projectKey,
        endpoint: endpoint.toString(),
        flushIntervalMs: config.flushIntervalMs ?? 10_000,
        maximumQueueSize: Math.min(config.maximumQueueSize ?? 100, 100),
        sessionTimeoutMs: config.sessionTimeoutMs ?? 30 * 60 * 1000,
        longViewSuccessAfterMs: config.longViewSuccessAfterMs ?? 30_000,
        longViewHeartbeatMs: config.longViewHeartbeatMs ?? 60_000,
        routeDedupeMs: config.routeDedupeMs ?? 100,
        development,
        normalizeRoute: config.normalizeRoute,
        beforeSend: config.beforeSend,
      },
      config.runtime ?? browserRuntime(),
      config.registeredFeatures,
    );
    activeTrackers.set(key, tracker);
    return tracker;
  } catch {
    return createNoopTracker("INITIALIZATION_FAILED", development);
  }
}

export type * from "./types.js";
