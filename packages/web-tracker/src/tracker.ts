import type { FrontendInsightEventBatchV1 } from "@frontend-insight/event-contract";
import {
  CONTRACT_LIMITS,
  CURRENT_SCHEMA_VERSION,
} from "@frontend-insight/event-contract/constants";
import { findCredentialLeak } from "@frontend-insight/event-contract/security";
import {
  applyRestrictedBeforeSend,
  isSafeAccountReference,
  isValidCustomEventName,
  normalizeAndValidateRoute,
  normalizeProperties,
} from "./privacy.js";
import type {
  EventProperties,
  PendingBatch,
  Tracker,
  TrackerConfig,
  TrackerDiagnostics,
  TrackerEvent,
  TrackerRuntime,
} from "./types.js";

const SDK_NAME = "web-tracker";
const SDK_VERSION = "0.1.0";
const visitorStorageKey = "frontend-insight.visitor-id.v1";

function id(runtime: TrackerRuntime, prefix: "evt" | "vis" | "ses" | "pv"): string {
  return `${prefix}_${runtime.crypto.randomUUID().replaceAll("-", "")}`;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function currentUrl(runtime: TrackerRuntime): URL {
  return new URL(runtime.window.location.href);
}

export class BrowserTracker implements Tracker {
  private readonly runtime: TrackerRuntime;
  private readonly registeredFeatures: ReadonlySet<string> | null;
  private readonly diagnostics: TrackerDiagnostics = {
    state: "active",
    queueSize: 0,
    sentEvents: 0,
    droppedEvents: 0,
    failedBatches: 0,
    retries: 0,
    beaconFallbacks: 0,
    warnings: [],
  };
  private readonly queue: TrackerEvent[] = [];
  private readonly activeLongViews = new Set<() => void>();
  private readonly originalPushState: History["pushState"];
  private readonly originalReplaceState: History["replaceState"];
  private visitorId: string;
  private sessionId: string;
  private pageViewId: string;
  private accountRef: string | undefined;
  private route: string;
  private lastRouteAt: number;
  private lastActivityAt: number;
  private visibleStartedAt: number | null;
  private flushTimer: ReturnType<typeof setInterval>;
  private destroyed = false;
  private flushing = false;

  constructor(
    private readonly config: Required<
      Pick<
        TrackerConfig,
        | "projectKey"
        | "endpoint"
        | "flushIntervalMs"
        | "maximumQueueSize"
        | "sessionTimeoutMs"
        | "longViewSuccessAfterMs"
        | "longViewHeartbeatMs"
        | "routeDedupeMs"
        | "development"
      >
    > & {
      normalizeRoute: TrackerConfig["normalizeRoute"] | undefined;
      beforeSend: TrackerConfig["beforeSend"] | undefined;
    },
    runtime: TrackerRuntime,
    registeredFeatures?: readonly string[],
  ) {
    this.runtime = runtime;
    this.registeredFeatures = registeredFeatures ? new Set(registeredFeatures) : null;
    this.visitorId = this.loadOrCreateVisitor();
    this.sessionId = id(runtime, "ses");
    this.pageViewId = id(runtime, "pv");
    this.lastActivityAt = runtime.now();
    this.lastRouteAt = this.lastActivityAt;
    this.visibleStartedAt = this.isVisible() ? this.lastActivityAt : null;
    this.route = this.resolveRoute();
    this.originalPushState = runtime.window.history.pushState.bind(
      runtime.window.history,
    );
    this.originalReplaceState = runtime.window.history.replaceState.bind(
      runtime.window.history,
    );
    this.installLifecycle();
    this.flushTimer = runtime.setInterval(
      () => void this.flush("normal"),
      config.flushIntervalMs,
    );
    this.emit("page_view", {}, { title: runtime.document.title.slice(0, 256) });
  }

  private loadOrCreateVisitor(): string {
    try {
      const existing = this.runtime.storage?.getItem(visitorStorageKey);
      if (existing?.startsWith("vis_") && existing.length <= 68) return existing;
      const created = id(this.runtime, "vis");
      this.runtime.storage?.setItem(visitorStorageKey, created);
      return created;
    } catch {
      this.warn("VISITOR_STORAGE_UNAVAILABLE");
      return id(this.runtime, "vis");
    }
  }

  private installLifecycle(): void {
    const history = this.runtime.window.history;
    history.pushState = (...args: Parameters<History["pushState"]>) => {
      this.originalPushState(...args);
      this.handleRouteChange();
    };
    history.replaceState = (...args: Parameters<History["replaceState"]>) => {
      this.originalReplaceState(...args);
      this.handleRouteChange();
    };
    this.runtime.window.addEventListener("popstate", this.handleRouteChange);
    this.runtime.window.addEventListener("hashchange", this.handleRouteChange);
    this.runtime.window.addEventListener("pagehide", this.handlePageHide);
    this.runtime.document.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  private uninstallLifecycle(): void {
    this.runtime.window.history.pushState = this.originalPushState;
    this.runtime.window.history.replaceState = this.originalReplaceState;
    this.runtime.window.removeEventListener("popstate", this.handleRouteChange);
    this.runtime.window.removeEventListener("hashchange", this.handleRouteChange);
    this.runtime.window.removeEventListener("pagehide", this.handlePageHide);
    this.runtime.document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  private readonly handleRouteChange = (): void => {
    this.safe(() => {
      const route = this.resolveRoute();
      const now = this.runtime.now();
      if (route === this.route && now - this.lastRouteAt <= this.config.routeDedupeMs) {
        return;
      }
      this.settleVisiblePage();
      this.route = route;
      this.lastRouteAt = now;
      this.pageViewId = id(this.runtime, "pv");
      this.visibleStartedAt = this.isVisible() ? now : null;
      this.emit("page_view", {}, { title: this.runtime.document.title.slice(0, 256) });
    });
  };

  private readonly handleVisibilityChange = (): void => {
    this.safe(() => {
      if (this.isVisible()) {
        this.visibleStartedAt = this.runtime.now();
      } else {
        this.settleVisiblePage();
        void this.flush("lifecycle");
      }
    });
  };

  private readonly handlePageHide = (): void => {
    this.safe(() => {
      this.settleVisiblePage();
      void this.flush("lifecycle");
    });
  };

  private isVisible(): boolean {
    return this.runtime.document.visibilityState === "visible";
  }

  private resolveRoute(): string {
    const route = normalizeAndValidateRoute(
      currentUrl(this.runtime),
      this.config.normalizeRoute,
    );
    if (!route) throw new Error("ROUTE_INVALID");
    return route;
  }

  private settleVisiblePage(): void {
    if (this.visibleStartedAt === null) return;
    const visibleDurationMs = Math.max(0, this.runtime.now() - this.visibleStartedAt);
    this.visibleStartedAt = null;
    this.emit("page_leave", { visibleDurationMs });
  }

  private refreshSession(): void {
    const now = this.runtime.now();
    if (now - this.lastActivityAt > this.config.sessionTimeoutMs) {
      this.sessionId = id(this.runtime, "ses");
    }
    this.lastActivityAt = now;
  }

  private emit(
    eventName: string,
    inputProperties: EventProperties,
    extra: Partial<TrackerEvent> = {},
  ): void {
    if (this.destroyed) return;
    const properties = normalizeProperties(inputProperties);
    if (!properties) return this.drop("PROPERTIES_INVALID");
    this.refreshSession();
    const event: TrackerEvent = {
      eventId: id(this.runtime, "evt"),
      eventName,
      eventTime: new Date(this.runtime.now()).toISOString(),
      visitorId: this.visitorId,
      sessionId: this.sessionId,
      pageViewId: this.pageViewId,
      ...(this.accountRef ? { accountRef: this.accountRef } : {}),
      route: this.route,
      timezoneOffsetMinutes: new Date(this.runtime.now()).getTimezoneOffset(),
      properties,
      ...extra,
    };
    let candidate = event;
    if (this.config.beforeSend) {
      const result = this.config.beforeSend({ event: structuredClone(event) });
      const restricted = applyRestrictedBeforeSend(event, result);
      if (!restricted) return this.drop("BEFORE_SEND_REJECTED");
      candidate = restricted;
    }
    if (findCredentialLeak(candidate)) return this.drop("CREDENTIAL_DATA_REJECTED");
    if (byteLength(candidate) > CONTRACT_LIMITS.maximumEventBytes) {
      return this.drop("EVENT_TOO_LARGE");
    }
    if (this.queue.length >= this.config.maximumQueueSize) {
      this.queue.shift();
      this.drop("QUEUE_OVERFLOW");
    }
    this.queue.push(candidate);
    this.diagnostics.queueSize = this.queue.length;
    if (this.queue.length >= CONTRACT_LIMITS.maximumEventsPerBatch) {
      void this.flush("normal");
    }
  }

  private feature(
    eventName: string,
    featureKey: string,
    properties: EventProperties = {},
    extra: Partial<TrackerEvent> = {},
  ): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(featureKey)) {
      return this.drop("FEATURE_KEY_INVALID");
    }
    if (this.registeredFeatures && !this.registeredFeatures.has(featureKey)) {
      return this.drop("FEATURE_NOT_REGISTERED");
    }
    this.emit(eventName, properties, { featureKey, ...extra });
  }

  setAccount(accountRef: string | null): void {
    this.safe(() => {
      if (accountRef === null) {
        this.accountRef = undefined;
        return;
      }
      if (!isSafeAccountReference(accountRef)) {
        this.drop("ACCOUNT_REF_REJECTED");
        return;
      }
      this.accountRef = accountRef;
    });
  }

  track(eventName: string, properties: EventProperties = {}): void {
    this.safe(() => {
      if (!isValidCustomEventName(eventName)) return this.drop("EVENT_NAME_INVALID");
      this.emit(eventName, properties);
    });
  }

  featureExposed(featureKey: string, properties: EventProperties = {}): void {
    this.safe(() => this.feature("feature_exposed", featureKey, properties));
  }

  featureStarted(featureKey: string, properties: EventProperties = {}): void {
    this.safe(() => this.feature("feature_started", featureKey, properties));
  }

  featureSucceeded(featureKey: string, properties: EventProperties = {}): void {
    this.safe(() => this.feature("feature_succeeded", featureKey, properties));
  }

  featureFailed(
    featureKey: string,
    reasonCode: string,
    properties: EventProperties = {},
  ): void {
    this.safe(() => {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode)) {
        return this.drop("REASON_CODE_INVALID");
      }
      this.feature("feature_failed", featureKey, properties, { reasonCode });
    });
  }

  startLongView(featureKey: string): () => void {
    if (this.destroyed) return () => {};
    if (this.registeredFeatures && !this.registeredFeatures.has(featureKey)) {
      this.drop("FEATURE_NOT_REGISTERED");
      return () => {};
    }
    this.feature("feature_long_view_started", featureKey);
    let visibleSince = this.isVisible() ? this.runtime.now() : null;
    let visibleDurationMs = 0;
    let succeeded = false;
    let stopped = false;
    let lastHeartbeatAt = 0;

    const accumulate = (): number => {
      const now = this.runtime.now();
      if (visibleSince !== null) {
        visibleDurationMs += Math.max(0, now - visibleSince);
        visibleSince = now;
      }
      return visibleDurationMs;
    };
    const onVisibility = (): void => {
      if (this.isVisible()) visibleSince = this.runtime.now();
      else {
        accumulate();
        visibleSince = null;
      }
    };
    this.runtime.document.addEventListener("visibilitychange", onVisibility);
    const timer = this.runtime.setInterval(
      () => {
        if (stopped || !this.isVisible()) return;
        const duration = accumulate();
        if (!succeeded && duration >= this.config.longViewSuccessAfterMs) {
          succeeded = true;
          this.feature("feature_succeeded", featureKey, {
            visibleDurationMs: duration,
          });
        }
        if (
          succeeded &&
          duration - lastHeartbeatAt >= this.config.longViewHeartbeatMs
        ) {
          lastHeartbeatAt = duration;
          this.feature("feature_long_view_heartbeat", featureKey, {
            visibleDurationMs: duration,
          });
        }
      },
      Math.min(1000, this.config.longViewSuccessAfterMs),
    );

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      this.runtime.clearInterval(timer);
      this.runtime.document.removeEventListener("visibilitychange", onVisibility);
      this.activeLongViews.delete(stop);
      this.feature("feature_long_view_ended", featureKey, {
        visibleDurationMs: accumulate(),
      });
    };
    this.activeLongViews.add(stop);
    return stop;
  }

  private nextBatch(): PendingBatch | null {
    if (!this.queue.length) return null;
    const events: TrackerEvent[] = [];
    while (this.queue.length && events.length < CONTRACT_LIMITS.maximumEventsPerBatch) {
      const event = this.queue[0]!;
      const candidate = this.makeBatch([...events, event]);
      if (byteLength(candidate) > CONTRACT_LIMITS.maximumBatchBytes) break;
      events.push(this.queue.shift()!);
    }
    if (!events.length) {
      this.queue.shift();
      this.drop("BATCH_SIZE_UNRESOLVABLE");
      return null;
    }
    this.diagnostics.queueSize = this.queue.length;
    return { batch: this.makeBatch(events), attempts: 0 };
  }

  private makeBatch(events: TrackerEvent[]): FrontendInsightEventBatchV1 {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projectKey: this.config.projectKey,
      sentAt: new Date(this.runtime.now()).toISOString(),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      events: events as unknown as FrontendInsightEventBatchV1["events"],
    };
  }

  async flush(reason: "normal" | "lifecycle" = "normal"): Promise<void> {
    if (this.destroyed || this.flushing) return;
    this.flushing = true;
    try {
      let pending = this.nextBatch();
      while (pending) {
        const body = JSON.stringify(pending.batch);
        const sent = await this.send(body, reason);
        if (sent) this.diagnostics.sentEvents += pending.batch.events.length;
        else this.diagnostics.failedBatches += 1;
        pending = this.nextBatch();
      }
    } catch {
      this.diagnostics.failedBatches += 1;
      this.diagnostics.lastErrorCode = "FLUSH_FAILED";
    } finally {
      this.flushing = false;
      this.diagnostics.queueSize = this.queue.length;
    }
  }

  private async send(body: string, reason: "normal" | "lifecycle"): Promise<boolean> {
    if (reason === "lifecycle") {
      const queued = this.runtime.navigator.sendBeacon(
        this.config.endpoint,
        new Blob([body], { type: "application/json" }),
      );
      if (queued) return true;
      this.diagnostics.beaconFallbacks += 1;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.runtime.fetch(this.config.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: reason === "lifecycle",
          credentials: "omit",
        });
        if (response.ok) return true;
        if (response.status >= 400 && response.status < 500) return false;
      } catch {
        // Retry below. No error escapes into the host application.
      }
      if (attempt < 2) {
        this.diagnostics.retries += 1;
        await new Promise<void>((resolve) =>
          this.runtime.setTimeout(resolve, 50 * 2 ** attempt),
        );
      }
    }
    return false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.activeLongViews.forEach((stop) => stop());
    this.runtime.clearInterval(this.flushTimer);
    this.settleVisiblePage();
    void this.flush("lifecycle");
    this.uninstallLifecycle();
    this.destroyed = true;
    this.diagnostics.state = "destroyed";
  }

  getDiagnostics(): Readonly<TrackerDiagnostics> {
    return Object.freeze({
      ...this.diagnostics,
      queueSize: this.queue.length,
      warnings: [...this.diagnostics.warnings],
    });
  }

  private safe(operation: () => void): void {
    try {
      operation();
    } catch {
      this.drop("SDK_INTERNAL_ERROR");
    }
  }

  private drop(code: string): void {
    this.diagnostics.droppedEvents += 1;
    this.diagnostics.lastErrorCode = code;
    this.warn(code);
  }

  private warn(code: string): void {
    if (!this.diagnostics.warnings.includes(code)) this.diagnostics.warnings.push(code);
    if (this.config.development) console.warn(`[frontend-insight] ${code}`);
  }
}
