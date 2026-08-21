import { createNoopTracker } from "./noop.js";
import { normalizeObservabilityConfig } from "./observability.js";
import { normalizePayload } from "./privacy.js";
import { browserRuntime } from "./runtime.js";
import { BrowserTracker } from "./tracker.js";
import type { Tracker, TrackerConfig } from "./types.js";

const activeTrackers = new Map<string, Tracker>();

function trackerKey(
  config: Pick<TrackerConfig, "appId" | "env" | "release" | "endpoint">,
): string {
  return `${config.appId}\u0000${config.env}\u0000${config.release}\u0000${config.endpoint}`;
}

export function createTracker(config: TrackerConfig): Tracker {
  const development = config.development ?? false;
  try {
    if (!/^[a-z][a-z0-9_-]{2,63}$/.test(config.appId)) {
      return createNoopTracker("APP_ID_INVALID", development);
    }
    if (!["prod", "staging", "dev"].includes(config.env)) {
      return createNoopTracker("ENV_INVALID", development);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.release)) {
      return createNoopTracker("RELEASE_INVALID", development);
    }
    const endpoint = new URL(config.endpoint);
    if (!/^https?:$/.test(endpoint.protocol)) {
      return createNoopTracker("ENDPOINT_INVALID", development);
    }
    const staticPayload = normalizePayload(config.staticPayload);
    if (!staticPayload) {
      return createNoopTracker("STATIC_PAYLOAD_INVALID", development);
    }
    const key = trackerKey(config);
    const existing = activeTrackers.get(key);
    if (existing?.getDiagnostics().state === "active") return existing;
    const tracker = new BrowserTracker(
      {
        appId: config.appId,
        env: config.env,
        release: config.release,
        endpoint: endpoint.toString(),
        deptId: config.deptId ?? null,
        roleId: config.roleId ?? null,
        flushIntervalMs: config.flushIntervalMs ?? 10_000,
        maximumQueueSize: Math.min(config.maximumQueueSize ?? 100, 100),
        sessionTimeoutMs: config.sessionTimeoutMs ?? 30 * 60 * 1000,
        longViewSuccessAfterMs: config.longViewSuccessAfterMs ?? 30_000,
        longViewHeartbeatMs: config.longViewHeartbeatMs ?? 60_000,
        staticPayload,
        development,
        normalizePageRoute: config.normalizePageRoute,
        beforeSend: config.beforeSend,
        observability: normalizeObservabilityConfig(config.observability),
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
