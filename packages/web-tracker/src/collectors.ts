import { normalizeRequestPath } from "./observability.js";
import type {
  ApiRequestDetails,
  Breadcrumb,
  EventProperties,
  P1CollectorConfig,
  PageReadinessDetails,
  RequestMethod,
  ResourceRequestDetails,
  ResourceType,
  TrackerEvent,
  TrackerRuntime,
} from "./types.js";

interface NormalizedToggle {
  enabled: boolean;
  sampleRate: number;
}

export interface NormalizedP1CollectorConfig {
  api: NormalizedToggle & { slowThresholdMs: number; globalFetch: boolean };
  resources: NormalizedToggle;
  firstScreen: NormalizedToggle;
  listRender: NormalizedToggle;
  longTasks: NormalizedToggle;
  blankScreen: NormalizedToggle;
  breadcrumbs: NormalizedToggle & {
    allowedActionKeys: ReadonlySet<string>;
  };
}

type Emit = (
  eventName: string,
  properties: EventProperties,
  extra?: Partial<TrackerEvent>,
) => void;

const actionKeyPattern = /^[a-z][a-z0-9_.:-]{0,63}$/;

function toggle(input: { enabled?: boolean; sampleRate?: number } | undefined) {
  const sampleRate = input?.sampleRate ?? 1;
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new Error("COLLECTOR_SAMPLE_RATE_INVALID");
  }
  return { enabled: input?.enabled ?? false, sampleRate };
}

export function normalizeP1CollectorConfig(
  input: P1CollectorConfig | undefined,
): NormalizedP1CollectorConfig {
  const allowedActionKeys = new Set(
    input?.breadcrumbs?.allowedActionKeys ?? [],
  );
  if ([...allowedActionKeys].some((key) => !actionKeyPattern.test(key))) {
    throw new Error("BREADCRUMB_ACTION_KEY_INVALID");
  }
  const slowThresholdMs = input?.api?.slowThresholdMs ?? 2_000;
  if (
    !Number.isFinite(slowThresholdMs) ||
    slowThresholdMs < 1 ||
    slowThresholdMs > 60_000
  ) {
    throw new Error("API_SLOW_THRESHOLD_INVALID");
  }
  return {
    api: {
      ...toggle(input?.api),
      slowThresholdMs: Math.round(slowThresholdMs),
      globalFetch: input?.api?.globalFetch ?? false,
    },
    resources: toggle(input?.resources),
    firstScreen: toggle(input?.firstScreen),
    listRender: toggle(input?.listRender),
    longTasks: toggle(input?.longTasks),
    blankScreen: toggle(input?.blankScreen),
    breadcrumbs: {
      ...toggle(input?.breadcrumbs),
      allowedActionKeys,
    },
  };
}

function method(value: string): RequestMethod {
  const normalized = value.toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
    normalized,
  )
    ? (normalized as RequestMethod)
    : "OTHER";
}

function duration(value: number): number {
  return Math.max(0, Math.min(86_400_000, Math.round(value)));
}

function status(value: number): number {
  return Math.max(0, Math.min(599, Math.trunc(value)));
}

function rowBucket(rowCount: number): "<100" | "100-1000" | ">1000" {
  if (rowCount < 100) return "<100";
  if (rowCount <= 1_000) return "100-1000";
  return ">1000";
}

export class P1Collectors {
  private readonly observers: PerformanceObserver[] = [];
  private readonly breadcrumbs: Breadcrumb[] = [];
  private readonly resources = new Map<
    ResourceType,
    { total: number; failed: number; durationMs: number }
  >();
  private originalFetch: typeof window.fetch | null = null;
  private instrumentedFetch: typeof window.fetch | null = null;
  private pageStartedAt: number;
  private longTaskCount = 0;
  private longTaskDurationMs = 0;
  private longTaskMaximumMs = 0;
  private readinessMarked = false;
  private settled = false;

  constructor(
    private readonly runtime: TrackerRuntime,
    private readonly config: NormalizedP1CollectorConfig,
    private readonly collectorEndpoint: string,
    private readonly emit: Emit,
    private readonly sampled: (rate: number) => boolean,
  ) {
    this.pageStartedAt = runtime.now();
  }

  start(): void {
    if (this.config.longTasks.enabled) this.installLongTaskObserver();
    if (this.config.resources.enabled) this.installResourceObserver();
    if (this.config.api.enabled && this.config.api.globalFetch) {
      this.installFetchInstrumentation();
    }
  }

  stop(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers.length = 0;
    if (
      this.originalFetch &&
      this.instrumentedFetch &&
      this.runtime.window.fetch === this.instrumentedFetch
    ) {
      this.runtime.window.fetch = this.originalFetch;
    }
    this.originalFetch = null;
    this.instrumentedFetch = null;
  }

  pageStarted(route: string): void {
    this.pageStartedAt = this.runtime.now();
    this.longTaskCount = 0;
    this.longTaskDurationMs = 0;
    this.longTaskMaximumMs = 0;
    this.resources.clear();
    this.readinessMarked = false;
    this.settled = false;
    this.recordBreadcrumb({
      kind: "route",
      occurredAt: new Date(this.runtime.now()).toISOString(),
      key: "route_changed",
      path: route,
    });
  }

  settlePage(): void {
    if (this.settled) return;
    this.settled = true;
    if (
      this.config.longTasks.enabled &&
      this.sampled(this.config.longTasks.sampleRate)
    ) {
      this.emit("long_task_summary", {
        longTaskCount: this.longTaskCount,
        longTaskDurationMs: duration(this.longTaskDurationMs),
        longTaskMaximumMs: duration(this.longTaskMaximumMs),
        observedPageViews: 1,
        sampleRate: this.config.longTasks.sampleRate,
      });
    }
    if (
      this.config.resources.enabled &&
      this.sampled(this.config.resources.sampleRate)
    ) {
      let totalCount = 0;
      let failedCount = 0;
      let totalDurationMs = 0;
      for (const item of this.resources.values()) {
        totalCount += item.total;
        failedCount += item.failed;
        totalDurationMs += item.durationMs;
      }
      this.emit("resource_summary", {
        totalCount,
        failedCount,
        totalDurationMs: duration(totalDurationMs),
        observedPageViews: 1,
        sampleRate: this.config.resources.sampleRate,
      });
    }
  }

  captureApiRequest(details: ApiRequestDetails): void {
    if (!this.config.api.enabled || !this.sampled(this.config.api.sampleRate))
      return;
    const requestMethod = method(details.method);
    const requestPath = normalizeRequestPath(
      details.url,
      this.runtime.window.location.href,
    );
    const statusCode = status(details.statusCode);
    const durationMs = duration(details.durationMs);
    const error = statusCode === 0 || statusCode >= 400;
    this.emit("api_request_summary", {
      requestMethod,
      requestPath,
      statusCode,
      durationMs,
      requestCount: 1,
      errorCount: error ? 1 : 0,
      successCount: error ? 0 : 1,
      slowCount: durationMs > this.config.api.slowThresholdMs ? 1 : 0,
      slowThresholdMs: this.config.api.slowThresholdMs,
      sampleRate: this.config.api.sampleRate,
    });
    this.recordBreadcrumb({
      kind: "api",
      occurredAt: new Date(this.runtime.now()).toISOString(),
      key: error ? "api_failed" : "api_completed",
      method: requestMethod,
      path: requestPath,
      statusCode,
    });
  }

  captureResourceRequest(details: ResourceRequestDetails): void {
    if (
      !this.config.resources.enabled ||
      !this.sampled(this.config.resources.sampleRate)
    ) {
      return;
    }
    const current = this.resources.get(details.resourceType) ?? {
      total: 0,
      failed: 0,
      durationMs: 0,
    };
    current.total += 1;
    if (!details.succeeded) current.failed += 1;
    current.durationMs += duration(details.durationMs ?? 0);
    this.resources.set(details.resourceType, current);
  }

  captureResourceFailure(resourceType: ResourceType): void {
    this.captureResourceRequest({
      resourceType,
      url: "/resource-failure",
      succeeded: false,
    });
  }

  markPageReady(details: PageReadinessDetails): void {
    if (this.readinessMarked) return;
    const firstScreen =
      this.config.firstScreen.enabled &&
      this.sampled(this.config.firstScreen.sampleRate);
    const blank =
      this.config.blankScreen.enabled &&
      this.sampled(this.config.blankScreen.sampleRate);
    if (!firstScreen && !blank) return;
    this.readinessMarked = true;
    this.emit("page_readiness", {
      templateKey: details.templateKey,
      readinessDurationMs: duration(this.runtime.now() - this.pageStartedAt),
      readinessState: details.blankCandidate ? "blank_candidate" : "ready",
      firstScreenCollected: firstScreen,
      blankDetectionCollected: blank,
      firstScreenSampleRate: this.config.firstScreen.sampleRate,
      blankDetectionSampleRate: this.config.blankScreen.sampleRate,
    });
  }

  startListRender(_listKey: string, rowCount: number): () => void {
    if (
      !this.config.listRender.enabled ||
      !this.sampled(this.config.listRender.sampleRate)
    ) {
      return () => {};
    }
    const startedAt = this.runtime.now();
    let completed = false;
    return () => {
      if (completed) return;
      completed = true;
      this.emit("list_render", {
        rowCountBucket: rowBucket(Math.max(0, Math.trunc(rowCount))),
        durationMs: duration(this.runtime.now() - startedAt),
        sampleRate: this.config.listRender.sampleRate,
      });
    };
  }

  recordBreadcrumbAction(actionKey: string): void {
    if (
      !this.config.breadcrumbs.enabled ||
      !this.sampled(this.config.breadcrumbs.sampleRate) ||
      !this.config.breadcrumbs.allowedActionKeys.has(actionKey)
    ) {
      return;
    }
    this.recordBreadcrumb({
      kind: "action",
      occurredAt: new Date(this.runtime.now()).toISOString(),
      key: actionKey,
    });
  }

  errorBreadcrumbs(): { items: Breadcrumb[]; sampleRate: number } | undefined {
    if (
      !this.config.breadcrumbs.enabled ||
      !this.sampled(this.config.breadcrumbs.sampleRate) ||
      !this.breadcrumbs.length
    ) {
      return undefined;
    }
    return {
      items: this.breadcrumbs.map((item) => ({ ...item })),
      sampleRate: this.config.breadcrumbs.sampleRate,
    };
  }

  private recordBreadcrumb(item: Breadcrumb): void {
    if (!this.config.breadcrumbs.enabled) return;
    this.breadcrumbs.push(item);
    while (this.breadcrumbs.length > 50) this.breadcrumbs.shift();
  }

  private observe(
    type: string,
    callback: (entries: PerformanceEntryList) => void,
  ): void {
    const Observer = (
      this.runtime.window as Window & {
        PerformanceObserver?: typeof PerformanceObserver;
      }
    ).PerformanceObserver;
    if (!Observer) return;
    try {
      const observer = new Observer((list) => callback(list.getEntries()));
      observer.observe({ type, buffered: true });
      this.observers.push(observer);
    } catch {
      // Unsupported collectors remain isolated from the host application.
    }
  }

  private installLongTaskObserver(): void {
    this.observe("longtask", (entries) => {
      if (!this.sampled(this.config.longTasks.sampleRate)) return;
      for (const entry of entries) {
        this.longTaskCount += 1;
        this.longTaskDurationMs += entry.duration;
        this.longTaskMaximumMs = Math.max(
          this.longTaskMaximumMs,
          entry.duration,
        );
      }
    });
  }

  private installResourceObserver(): void {
    this.observe("resource", (entries) => {
      if (!this.sampled(this.config.resources.sampleRate)) return;
      for (const entry of entries as PerformanceResourceTiming[]) {
        const initiator = String(entry.initiatorType);
        const resourceType: ResourceType = [
          "script",
          "link",
          "img",
          "font",
        ].includes(initiator)
          ? initiator === "link"
            ? "stylesheet"
            : initiator === "img"
              ? "image"
              : (initiator as ResourceType)
          : "other";
        this.captureResourceRequest({
          resourceType,
          url: entry.name,
          succeeded: true,
          durationMs: entry.duration,
        });
      }
    });
  }

  private installFetchInstrumentation(): void {
    const original = this.runtime.window.fetch;
    if (typeof original !== "function") return;
    this.originalFetch = original;
    const collector = new URL(
      this.collectorEndpoint,
      this.runtime.window.location.href,
    );
    const instrumented = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const requestUrl =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      const absolute = new URL(
        String(requestUrl),
        this.runtime.window.location.href,
      );
      if (
        absolute.origin === collector.origin &&
        absolute.pathname === collector.pathname
      ) {
        return original.call(this.runtime.window, input, init);
      }
      const requestMethod =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      const startedAt = this.runtime.now();
      try {
        const response = await original.call(this.runtime.window, input, init);
        this.captureApiRequest({
          method: requestMethod,
          url: absolute,
          statusCode: response.status,
          durationMs: this.runtime.now() - startedAt,
        });
        return response;
      } catch (cause) {
        this.captureApiRequest({
          method: requestMethod,
          url: absolute,
          statusCode: 0,
          durationMs: this.runtime.now() - startedAt,
        });
        throw cause;
      }
    };
    this.instrumentedFetch = instrumented as typeof window.fetch;
    this.runtime.window.fetch = this.instrumentedFetch;
  }
}
