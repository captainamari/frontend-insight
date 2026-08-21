import type {
  FrontendInsightEventBatchV3,
  FrontendInsightEventName,
} from "@frontend-insight/event-contract";
import {
  CONTRACT_LIMITS,
  CURRENT_SCHEMA_VERSION,
  STANDARD_CUSTOM_EVENT_NAMES,
} from "@frontend-insight/event-contract/constants";
import { findCredentialLeak } from "@frontend-insight/event-contract/security";
import {
  BrowserObservability,
  type NormalizedObservabilityConfig,
} from "./observability.js";
import {
  applyRestrictedBeforeSend,
  isSafeUserReference,
  normalizeAndValidatePageRoute,
  normalizePayload,
} from "./privacy.js";
import type {
  ApiErrorDetails,
  EventPayload,
  InteractionType,
  OperationHandle,
  OperationState,
  PendingBatch,
  ResourceErrorDetails,
  Tracker,
  TrackerConfig,
  TrackerDiagnostics,
  TrackerEvent,
  TrackerRuntime,
  WebVitalDetails,
} from "./types.js";

const SDK_NAME = "web-tracker";
const SDK_VERSION = "0.4.0";
const deviceStorageKey = "frontend-insight.device-id.v2";
const canonicalCustomNames = new Set<string>(STANDARD_CUSTOM_EVENT_NAMES);

function id(
  runtime: TrackerRuntime,
  prefix: "evt" | "dev" | "ses" | "pv" | "op",
): string {
  return `${prefix}_${runtime.crypto.randomUUID().replaceAll("-", "")}`;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function currentUrl(runtime: TrackerRuntime): URL {
  return new URL(runtime.window.location.href);
}

function pageUrl(runtime: TrackerRuntime): string {
  const current = currentUrl(runtime);
  return `${current.origin}${current.pathname}`;
}

function browserName(userAgent: string): string {
  if (/Edg\//i.test(userAgent)) return "Edge";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  if (/(?:Chrome|CriOS)\//i.test(userAgent)) return "Chrome";
  if (/Safari\//i.test(userAgent) && /Version\//i.test(userAgent)) return "Safari";
  return "Other";
}

function operatingSystem(userAgent: string): string {
  if (/Android/i.test(userAgent)) return "Android";
  if (/(?:iPhone|iPad|iPod)/i.test(userAgent)) return "iOS";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "Other";
}

export class BrowserTracker implements Tracker {
  private readonly diagnostics: TrackerDiagnostics = {
    state: "active",
    queueSize: 0,
    sentEvents: 0,
    droppedEvents: 0,
    failedBatches: 0,
    retries: 0,
    beaconFallbacks: 0,
    duplicateOperationTerminals: 0,
    warnings: [],
  };
  private readonly registeredFeatures: ReadonlySet<string> | null;
  private readonly queue: TrackerEvent[] = [];
  private readonly activeLongViews = new Set<() => void>();
  private readonly observability: BrowserObservability | null;
  private readonly originalPushState: History["pushState"];
  private readonly originalReplaceState: History["replaceState"];
  private deviceId: string;
  private sessionId: string;
  private pageViewId: string;
  private userId: string | null = null;
  private pageRoute: string;
  private lastActivityAt: number;
  private visibleStartedAt: number | null;
  private flushTimer: ReturnType<typeof setInterval>;
  private destroyed = false;
  private flushing = false;

  constructor(
    private readonly config: Required<
      Pick<
        TrackerConfig,
        | "appId"
        | "env"
        | "release"
        | "endpoint"
        | "deptId"
        | "roleId"
        | "flushIntervalMs"
        | "maximumQueueSize"
        | "sessionTimeoutMs"
        | "longViewSuccessAfterMs"
        | "longViewHeartbeatMs"
        | "staticPayload"
        | "development"
      >
    > & {
      normalizePageRoute: TrackerConfig["normalizePageRoute"] | undefined;
      beforeSend: TrackerConfig["beforeSend"] | undefined;
      observability: NormalizedObservabilityConfig | null;
    },
    private readonly runtime: TrackerRuntime,
    registeredFeatures?: readonly string[],
  ) {
    this.registeredFeatures = registeredFeatures ? new Set(registeredFeatures) : null;
    this.deviceId = this.loadOrCreateDevice();
    this.sessionId = id(runtime, "ses");
    this.pageViewId = id(runtime, "pv");
    this.lastActivityAt = runtime.now();
    this.visibleStartedAt = this.isVisible() ? this.lastActivityAt : null;
    this.pageRoute = this.resolvePageRoute();
    this.originalPushState = runtime.window.history.pushState.bind(
      runtime.window.history,
    );
    this.originalReplaceState = runtime.window.history.replaceState.bind(
      runtime.window.history,
    );
    this.observability = config.observability
      ? new BrowserObservability(
          runtime,
          config.observability,
          config.endpoint,
          (event, payload) => this.emit(event, payload),
        )
      : null;
    this.emit("page_view", {});
    this.observability?.start();
    this.installLifecycle();
    this.flushTimer = runtime.setInterval(
      () => void this.flush("normal"),
      config.flushIntervalMs,
    );
  }

  private loadOrCreateDevice(): string {
    try {
      const existing = this.runtime.storage?.getItem(deviceStorageKey);
      if (existing?.startsWith("dev_") && existing.length <= 68) return existing;
      const created = id(this.runtime, "dev");
      this.runtime.storage?.setItem(deviceStorageKey, created);
      return created;
    } catch {
      this.warn("DEVICE_STORAGE_UNAVAILABLE");
      return id(this.runtime, "dev");
    }
  }

  private installLifecycle(): void {
    const history = this.runtime.window.history;
    history.pushState = (...args: Parameters<History["pushState"]>) => {
      this.originalPushState(...args);
      this.handlePageRouteChange();
    };
    history.replaceState = (...args: Parameters<History["replaceState"]>) => {
      this.originalReplaceState(...args);
      this.handlePageRouteChange();
    };
    this.runtime.window.addEventListener("popstate", this.handlePageRouteChange);
    this.runtime.window.addEventListener("hashchange", this.handlePageRouteChange);
    this.runtime.window.addEventListener("pagehide", this.handlePageHide);
    this.runtime.document.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  private uninstallLifecycle(): void {
    this.runtime.window.history.pushState = this.originalPushState;
    this.runtime.window.history.replaceState = this.originalReplaceState;
    this.runtime.window.removeEventListener("popstate", this.handlePageRouteChange);
    this.runtime.window.removeEventListener("hashchange", this.handlePageRouteChange);
    this.runtime.window.removeEventListener("pagehide", this.handlePageHide);
    this.runtime.document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  private readonly handlePageRouteChange = (): void => {
    this.safe(() => {
      const nextPageRoute = this.resolvePageRoute();
      const now = this.runtime.now();
      if (nextPageRoute === this.pageRoute) return;
      this.stopLongViews();
      this.settleVisiblePage();
      this.pageRoute = nextPageRoute;
      this.pageViewId = id(this.runtime, "pv");
      this.visibleStartedAt = this.isVisible() ? now : null;
      this.emit("page_view", {});
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
      this.stopLongViews();
      this.settleVisiblePage();
      void this.flush("lifecycle");
    });
  };

  private isVisible(): boolean {
    return this.runtime.document.visibilityState === "visible";
  }

  private resolvePageRoute(): string {
    const normalized = normalizeAndValidatePageRoute(
      currentUrl(this.runtime),
      this.config.normalizePageRoute,
    );
    if (!normalized) throw new Error("PAGE_ROUTE_INVALID");
    return normalized;
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
    canonicalEvent: FrontendInsightEventName,
    payload: TrackerEvent["payload"],
  ): void {
    if (this.destroyed) return;
    this.refreshSession();
    const userAgent = this.runtime.navigator.userAgent
      .replace(/[^A-Za-z0-9 .()/_;:-]/g, "")
      .slice(0, 256);
    const event: TrackerEvent = {
      eventId: id(this.runtime, "evt"),
      event: canonicalEvent,
      appId: this.config.appId,
      env: this.config.env,
      release: this.config.release,
      pageUrl: pageUrl(this.runtime),
      pageRoute: this.pageRoute,
      userId: this.userId,
      deptId: this.config.deptId,
      roleId: this.config.roleId,
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      pageViewId: this.pageViewId,
      ua: userAgent || "Other",
      os: operatingSystem(userAgent),
      browser: browserName(userAgent),
      timestamp: this.runtime.now(),
      payload,
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

  private custom(
    name: string,
    payload: EventPayload = {},
    control: EventPayload = {},
  ): void {
    if (!canonicalCustomNames.has(name)) return this.drop("CUSTOM_NAME_INVALID");
    const labels = normalizePayload({
      ...payload,
      ...this.config.staticPayload,
    });
    if (!labels) return this.drop("PAYLOAD_INVALID");
    this.emit("custom", {
      name,
      ...control,
      ...(Object.keys(labels).length ? { labels } : {}),
    });
  }

  private feature(
    name: string,
    featureKey: string,
    payload: EventPayload = {},
    control: EventPayload = {},
  ): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(featureKey)) {
      return this.drop("FEATURE_KEY_INVALID");
    }
    if (this.registeredFeatures && !this.registeredFeatures.has(featureKey)) {
      return this.drop("FEATURE_NOT_REGISTERED");
    }
    this.custom(name, payload, { featureKey, ...control });
  }

  setUser(userId: string | null): void {
    this.safe(() => {
      if (userId === null) {
        this.userId = null;
        return;
      }
      if (!isSafeUserReference(userId)) {
        this.drop("USER_ID_REJECTED");
        return;
      }
      this.userId = userId;
    });
  }

  track(name: string, payload: EventPayload = {}): void {
    this.safe(() => this.custom(name, payload));
  }

  featureExposed(featureKey: string, payload: EventPayload = {}): void {
    this.safe(() => this.feature("feature_exposed", featureKey, payload));
  }

  featureStarted(featureKey: string, payload: EventPayload = {}): void {
    this.safe(() => this.feature("feature_started", featureKey, payload));
  }

  featureSucceeded(featureKey: string, payload: EventPayload = {}): void {
    this.safe(() => this.feature("feature_succeeded", featureKey, payload));
  }

  featureFailed(
    featureKey: string,
    reasonCode: string,
    payload: EventPayload = {},
  ): void {
    this.safe(() => {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode)) {
        return this.drop("REASON_CODE_INVALID");
      }
      this.feature("feature_failed", featureKey, payload, { reasonCode });
    });
  }

  startOperation(
    featureKey: string,
    payload: EventPayload = {},
    interactionType: InteractionType = "programmatic",
  ): OperationHandle {
    if (this.destroyed) {
      return {
        succeed() {},
        fail() {},
        cancel() {},
        getState: () => "started",
      };
    }
    const operationInstanceId = id(this.runtime, "op");
    let state: OperationState = "started";
    this.safe(() =>
      this.feature("feature_started", featureKey, payload, {
        operationInstanceId,
        interactionType,
      }),
    );
    const terminal = (
      next: Exclude<OperationState, "started">,
      terminalPayload: EventPayload = {},
      reasonCode?: string,
    ): void => {
      this.safe(() => {
        if (state !== "started") {
          this.diagnostics.duplicateOperationTerminals += 1;
          this.warn("OPERATION_ALREADY_TERMINAL");
          return;
        }
        if (
          next === "failed" &&
          (!reasonCode || !/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode))
        ) {
          this.drop("REASON_CODE_INVALID");
          return;
        }
        state = next;
        this.feature(`feature_${next}`, featureKey, terminalPayload, {
          operationInstanceId,
          interactionType,
          ...(reasonCode ? { reasonCode } : {}),
        });
      });
    };
    return Object.freeze({
      succeed: (terminalPayload: EventPayload = {}) =>
        terminal("succeeded", terminalPayload),
      fail: (reasonCode: string, terminalPayload: EventPayload = {}) =>
        terminal("failed", terminalPayload, reasonCode),
      cancel: (terminalPayload: EventPayload = {}) =>
        terminal("canceled", terminalPayload),
      getState: () => state,
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

  captureException(error: unknown): void {
    this.safe(() => this.observability?.captureException(error));
  }

  captureApiError(details: ApiErrorDetails): void {
    this.safe(() => this.observability?.captureApiError(details));
  }

  captureResourceError(details: ResourceErrorDetails): void {
    this.safe(() => this.observability?.captureResourceError(details));
  }

  captureWebVital(details: WebVitalDetails): void {
    this.safe(() => this.observability?.captureWebVital(details));
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

  private makeBatch(events: TrackerEvent[]): FrontendInsightEventBatchV3 {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sentAt: this.runtime.now(),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      events,
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
        // Retry without allowing collector failures to escape into the host.
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
    this.observability?.stop();
    this.stopLongViews();
    this.runtime.clearInterval(this.flushTimer);
    this.settleVisiblePage();
    void this.flush("lifecycle");
    this.uninstallLifecycle();
    this.destroyed = true;
    this.diagnostics.state = "destroyed";
  }

  private stopLongViews(): void {
    for (const stop of [...this.activeLongViews]) stop();
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
