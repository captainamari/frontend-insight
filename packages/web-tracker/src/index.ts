import { createNoopTracker } from "./noop.js";
import { normalizeObservabilityConfig } from "./observability.js";
import { normalizeP1CollectorConfig } from "./collectors.js";
import { normalizeProperties } from "./privacy.js";
import { browserRuntime } from "./runtime.js";
import { BrowserTracker } from "./tracker.js";
import type { P1CollectorConfig, Tracker, TrackerConfig } from "./types.js";

const activeTrackers = new Map<string, Tracker>();
const observabilityPropertyBudget = 9;
const p1PropertyBudget = 10;
const telemetryReservedProperties = new Set([
  "releaseVersion",
  "deploymentEnvironment",
  "browserFamily",
  "osFamily",
  "viewportBucket",
  "errorName",
  "errorMessage",
  "stackTopFrame",
  "resourceType",
  "requestMethod",
  "requestPath",
  "statusCode",
  "durationMs",
  "vitalName",
  "vitalValue",
  "vitalRating",
  "navigationType",
  "templateKey",
  "readinessDurationMs",
  "readinessState",
  "firstScreenCollected",
  "blankDetectionCollected",
  "firstScreenSampleRate",
  "blankDetectionSampleRate",
  "requestCount",
  "errorCount",
  "successCount",
  "slowCount",
  "slowThresholdMs",
  "sampleRate",
  "totalCount",
  "failedCount",
  "totalDurationMs",
  "observedPageViews",
  "rowCountBucket",
  "longTaskCount",
  "longTaskDurationMs",
  "longTaskMaximumMs",
]);

function trackerKey(
  config: Pick<TrackerConfig, "projectKey" | "endpoint" | "releaseVersion">,
): string {
  return `${config.projectKey}\u0000${config.endpoint}\u0000${config.releaseVersion}`;
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
    const staticProperties = normalizeProperties(config.staticProperties);
    if (!staticProperties) {
      return createNoopTracker("STATIC_PROPERTIES_INVALID", development);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.releaseVersion)) {
      return createNoopTracker("RELEASE_VERSION_INVALID", development);
    }
    const deploymentEnvironment = config.deploymentEnvironment ?? "production";
    const observability = normalizeObservabilityConfig(
      config.observability,
      config.releaseVersion,
      deploymentEnvironment,
    );
    const collectors = normalizeP1CollectorConfig(config.collectors);
    const p1Enabled = [
      collectors.api,
      collectors.resources,
      collectors.firstScreen,
      collectors.listRender,
      collectors.longTasks,
      collectors.blankScreen,
      collectors.breadcrumbs,
    ].some((collector) => collector.enabled);
    const propertyBudget = Math.max(
      observability ? observabilityPropertyBudget : 0,
      p1Enabled ? p1PropertyBudget : 0,
    );
    if (
      propertyBudget > 0 &&
      Object.keys(staticProperties).length > 20 - propertyBudget
    ) {
      return createNoopTracker("OBSERVABILITY_PROPERTY_BUDGET_EXCEEDED", development);
    }
    if (
      propertyBudget > 0 &&
      Object.keys(staticProperties).some((key) => telemetryReservedProperties.has(key))
    ) {
      return createNoopTracker("OBSERVABILITY_STATIC_PROPERTY_CONFLICT", development);
    }
    const key = trackerKey(config);
    const existing = activeTrackers.get(key);
    if (existing?.getDiagnostics().state === "active") return existing;

    const tracker = new BrowserTracker(
      {
        projectKey: config.projectKey,
        endpoint: endpoint.toString(),
        releaseVersion: config.releaseVersion,
        deploymentEnvironment,
        flushIntervalMs: config.flushIntervalMs ?? 10_000,
        maximumQueueSize: Math.min(config.maximumQueueSize ?? 100, 100),
        sessionTimeoutMs: config.sessionTimeoutMs ?? 30 * 60 * 1000,
        longViewSuccessAfterMs: config.longViewSuccessAfterMs ?? 30_000,
        longViewHeartbeatMs: config.longViewHeartbeatMs ?? 60_000,
        staticProperties,
        development,
        normalizeRoute: config.normalizeRoute,
        beforeSend: config.beforeSend,
        observability,
        collectors,
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

/**
 * Loads the project-authoritative collector switches before starting the SDK.
 * A missing, rejected, or malformed config fails closed for P1 collectors while
 * preserving the base page/feature tracker.
 */
export async function createTrackerWithRemoteConfig(
  config: Omit<TrackerConfig, "collectors"> & { collectorConfigUrl?: string },
): Promise<Tracker> {
  const { collectorConfigUrl, ...trackerConfig } = config;
  let collectors: P1CollectorConfig | undefined;
  try {
    const url = collectorConfigUrl
      ? new URL(collectorConfigUrl, config.endpoint)
      : new URL(
          `./collector-config/${encodeURIComponent(config.projectKey)}`,
          config.endpoint,
        );
    const runtime = config.runtime ?? browserRuntime();
    const response = await runtime.fetch(url, {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (response.ok) {
      const payload = (await response.json()) as { collectors?: unknown };
      normalizeP1CollectorConfig(payload.collectors as P1CollectorConfig | undefined);
      collectors = payload.collectors as P1CollectorConfig | undefined;
    }
  } catch {
    collectors = undefined;
  }
  return createTracker({
    ...trackerConfig,
    ...(collectors ? { collectors } : {}),
  });
}

export type * from "./types.js";
