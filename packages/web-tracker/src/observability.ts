import type {
  ApiErrorDetails,
  DeploymentEnvironment,
  EventProperties,
  NavigationType,
  ObservabilityConfig,
  RequestMethod,
  ResourceErrorDetails,
  ResourceType,
  TrackerRuntime,
  WebVitalDetails,
  WebVitalName,
  WebVitalRating,
} from "./types.js";

export interface NormalizedObservabilityConfig {
  releaseVersion: string;
  deploymentEnvironment: DeploymentEnvironment;
  captureJsErrors: boolean;
  captureResourceErrors: boolean;
  captureApiErrors: boolean;
  captureWebVitals: boolean;
}

type Emit = (eventName: string, properties: EventProperties) => void;

const releasePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const credentialAssignment =
  /\b(?:token|password|passwd|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi;
const bearer = /\bbearer\s+[A-Za-z0-9._~+/-]+/gi;
const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const email = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g;
const url = /https?:\/\/[^\s)\]}>'"]+/gi;
const opaqueSegment =
  /^(?:\d{3,}|[0-9a-f]{8,}|[A-Za-z0-9_-]{20,}|[0-9a-f]{8}-[0-9a-f-]{27,})$/i;

export function normalizeObservabilityConfig(
  input: ObservabilityConfig | undefined,
  releaseVersion: string,
  deploymentEnvironment: DeploymentEnvironment,
): NormalizedObservabilityConfig | null {
  if (!input?.enabled) return null;
  if (!releasePattern.test(releaseVersion)) {
    throw new Error("OBSERVABILITY_RELEASE_INVALID");
  }
  return {
    releaseVersion,
    deploymentEnvironment,
    captureJsErrors: input.captureJsErrors ?? true,
    captureResourceErrors: input.captureResourceErrors ?? true,
    captureApiErrors: input.captureApiErrors ?? false,
    captureWebVitals: input.captureWebVitals ?? true,
  };
}

function trim(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

function sanitizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return normalizePath(parsed.pathname);
  } catch {
    return "[redacted-url]";
  }
}

export function sanitizeTelemetryText(value: string, maximum = 256): string {
  return trim(
    value
      .replace(bearer, "[redacted-credential]")
      .replace(jwt, "[redacted-credential]")
      .replace(credentialAssignment, "[redacted-credential]")
      .replace(email, "[redacted-email]")
      .replace(url, (candidate) => sanitizeUrl(candidate)),
    maximum,
  );
}

function normalizePath(pathname: string): string {
  const normalized = pathname
    .split("/")
    .map((segment) => (opaqueSegment.test(segment) ? ":id" : segment))
    .join("/");
  const result = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return result.slice(0, 256) || "/";
}

export function normalizeRequestPath(value: string | URL, baseUrl: string): string {
  try {
    return normalizePath(new URL(value.toString(), baseUrl).pathname);
  } catch {
    return "/invalid-request-path";
  }
}

function requestMethod(value: string): RequestMethod {
  const normalized = value.toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
    normalized,
  )
    ? (normalized as RequestMethod)
    : "OTHER";
}

function navigationType(runtime: TrackerRuntime): NavigationType {
  const entry = runtime.window.performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  return entry &&
    ["navigate", "reload", "back_forward", "prerender"].includes(entry.type)
    ? (entry.type as NavigationType)
    : "unknown";
}

function browserFamily(userAgent: string): string {
  if (/Edg\//i.test(userAgent)) return "Edge";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  if (/(?:Chrome|CriOS)\//i.test(userAgent)) return "Chrome";
  if (/Safari\//i.test(userAgent) && /Version\//i.test(userAgent)) return "Safari";
  return "Other";
}

function osFamily(userAgent: string): string {
  if (/Android/i.test(userAgent)) return "Android";
  if (/(?:iPhone|iPad|iPod)/i.test(userAgent)) return "iOS";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "Other";
}

function viewportBucket(width: number): string {
  if (width < 768) return "compact";
  if (width < 1280) return "standard";
  return "wide";
}

export function rateWebVital(name: WebVitalName, value: number): WebVitalRating {
  const thresholds: Record<WebVitalName, readonly [number, number]> = {
    LCP: [2500, 4000],
    CLS: [0.1, 0.25],
    INP: [200, 500],
    FCP: [1800, 3000],
    TTFB: [800, 1800],
  };
  const [good, poor] = thresholds[name];
  if (value <= good) return "good";
  if (value <= poor) return "needs_improvement";
  return "poor";
}

function resourceType(target: EventTarget | null): ResourceType {
  const tagName = String(
    (target as { tagName?: string } | null)?.tagName ?? "",
  ).toLowerCase();
  if (tagName === "script") return "script";
  if (tagName === "link") return "stylesheet";
  if (tagName === "img") return "image";
  if (["audio", "video", "source"].includes(tagName)) return "media";
  return "other";
}

function resourceUrl(target: EventTarget | null): string {
  const candidate = target as { src?: string; href?: string } | null;
  return candidate?.src ?? candidate?.href ?? "/unknown-resource";
}

function errorDetails(error: unknown): {
  errorName: string;
  errorMessage: string;
  stackTopFrame: string;
} {
  const candidate = error instanceof Error ? error : null;
  const rawMessage = candidate?.message ?? String(error ?? "Unknown error");
  const stackLines = String(candidate?.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const topFrame = stackLines.find((line) => /\bat\b|https?:\/\//i.test(line)) ?? "";
  return {
    errorName: sanitizeTelemetryText(candidate?.name || "Error", 120) || "Error",
    errorMessage:
      sanitizeTelemetryText(rawMessage, 256) || "Sanitized error without message",
    stackTopFrame: sanitizeTelemetryText(topFrame, 256),
  };
}

export class BrowserObservability {
  private readonly observers: PerformanceObserver[] = [];
  private originalFetch: typeof window.fetch | null = null;
  private instrumentedFetch: typeof window.fetch | null = null;
  private lcp = 0;
  private cls = 0;
  private clsSupported = false;
  private inp = 0;
  private vitalFlushed = false;

  constructor(
    private readonly runtime: TrackerRuntime,
    private readonly config: NormalizedObservabilityConfig,
    private readonly collectorEndpoint: string,
    private readonly emit: Emit,
  ) {}

  start(): void {
    if (this.config.captureJsErrors || this.config.captureResourceErrors) {
      this.runtime.window.addEventListener("error", this.handleError, true);
    }
    if (this.config.captureJsErrors) {
      this.runtime.window.addEventListener(
        "unhandledrejection",
        this.handleUnhandledRejection,
      );
    }
    if (this.config.captureApiErrors) this.installFetchInstrumentation();
    if (this.config.captureWebVitals) this.installWebVitals();
  }

  stop(): void {
    if (this.config.captureWebVitals) this.flushVitals();
    this.runtime.window.removeEventListener("error", this.handleError, true);
    this.runtime.window.removeEventListener(
      "unhandledrejection",
      this.handleUnhandledRejection,
    );
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

  captureException(error: unknown): void {
    this.emit("error_js", this.withRelease(errorDetails(error)));
  }

  captureApiError(details: ApiErrorDetails): void {
    this.emit(
      "error_api",
      this.withRelease({
        requestMethod: requestMethod(details.method),
        requestPath: normalizeRequestPath(
          details.url,
          this.runtime.window.location.href,
        ),
        statusCode: Math.max(0, Math.min(599, Math.trunc(details.statusCode))),
        durationMs: Math.max(0, Math.min(86_400_000, Math.round(details.durationMs))),
      }),
    );
  }

  captureResourceError(details: ResourceErrorDetails): void {
    this.emit(
      "error_resource",
      this.withRelease({
        resourceType: details.resourceType,
        requestPath: normalizeRequestPath(
          details.url,
          this.runtime.window.location.href,
        ),
      }),
    );
  }

  captureWebVital(details: WebVitalDetails): void {
    if (!Number.isFinite(details.value) || details.value < 0) return;
    const value = Math.min(86_400_000, details.value);
    this.emit(
      "web_vital",
      this.withRelease({
        vitalName: details.name,
        vitalValue: value,
        vitalRating: details.rating ?? rateWebVital(details.name, value),
        navigationType: details.navigationType ?? navigationType(this.runtime),
      }),
    );
  }

  private readonly handleError = (event: Event): void => {
    const target = event.target;
    if (target && target !== this.runtime.window) {
      if (!this.config.captureResourceErrors) return;
      this.captureResourceError({
        resourceType: resourceType(target),
        url: resourceUrl(target),
      });
      return;
    }
    if (!this.config.captureJsErrors) return;
    const candidate = event as ErrorEvent;
    this.captureException(candidate.error ?? candidate.message ?? "Window error");
  };

  private readonly handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    this.captureException(event.reason ?? "Unhandled promise rejection");
  };

  private withRelease(properties: EventProperties): EventProperties {
    return {
      ...properties,
      browserFamily: browserFamily(this.runtime.window.navigator.userAgent),
      osFamily: osFamily(this.runtime.window.navigator.userAgent),
      viewportBucket: viewportBucket(this.runtime.window.innerWidth),
    };
  }

  private installFetchInstrumentation(): void {
    const original = this.runtime.window.fetch;
    if (typeof original !== "function") return;
    this.originalFetch = original;
    const collector = new URL(
      this.collectorEndpoint,
      this.runtime.window.location.href,
    );
    const instrumented = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      const absolute = new URL(String(requestUrl), this.runtime.window.location.href);
      if (
        absolute.origin === collector.origin &&
        absolute.pathname === collector.pathname
      ) {
        return original.call(this.runtime.window, input, init);
      }
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const startedAt = this.runtime.now();
      try {
        const response = await original.call(this.runtime.window, input, init);
        if (!response.ok) {
          this.captureApiError({
            method,
            url: absolute,
            statusCode: response.status,
            durationMs: this.runtime.now() - startedAt,
          });
        }
        return response;
      } catch (cause) {
        this.captureApiError({
          method,
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

  private observe(
    type: string,
    callback: (entries: PerformanceEntryList) => void,
  ): boolean {
    const Observer = (
      this.runtime.window as Window & {
        PerformanceObserver?: typeof PerformanceObserver;
      }
    ).PerformanceObserver;
    if (!Observer) return false;
    try {
      const observer = new Observer((list: PerformanceObserverEntryList) =>
        callback(list.getEntries()),
      );
      observer.observe({ type, buffered: true });
      this.observers.push(observer);
      return true;
    } catch {
      // Unsupported entry types are ignored without affecting the host page.
      return false;
    }
  }

  private installWebVitals(): void {
    this.observe("paint", (entries) => {
      const fcp = entries.find((entry) => entry.name === "first-contentful-paint");
      if (fcp) this.captureWebVital({ name: "FCP", value: fcp.startTime });
    });
    const navigation = this.runtime.window.performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming | undefined;
    if (navigation?.responseStart !== undefined) {
      this.captureWebVital({ name: "TTFB", value: navigation.responseStart });
    }
    this.observe("largest-contentful-paint", (entries) => {
      const candidate = entries.at(-1);
      if (candidate) this.lcp = Math.max(this.lcp, candidate.startTime);
    });
    this.clsSupported = this.observe("layout-shift", (entries) => {
      for (const entry of entries as Array<
        PerformanceEntry & { value?: number; hadRecentInput?: boolean }
      >) {
        if (!entry.hadRecentInput) this.cls += entry.value ?? 0;
      }
    });
    this.observe("event", (entries) => {
      for (const entry of entries) this.inp = Math.max(this.inp, entry.duration);
    });
    this.runtime.window.addEventListener("pagehide", this.flushVitals, {
      once: true,
    });
    this.runtime.document.addEventListener(
      "visibilitychange",
      this.handleVitalVisibility,
    );
  }

  private readonly handleVitalVisibility = (): void => {
    if (this.runtime.document.visibilityState === "hidden") this.flushVitals();
  };

  private readonly flushVitals = (): void => {
    if (this.vitalFlushed) return;
    this.vitalFlushed = true;
    if (this.lcp > 0) this.captureWebVital({ name: "LCP", value: this.lcp });
    if (this.clsSupported) this.captureWebVital({ name: "CLS", value: this.cls });
    if (this.inp > 0) this.captureWebVital({ name: "INP", value: this.inp });
    this.runtime.window.removeEventListener("pagehide", this.flushVitals);
    this.runtime.document.removeEventListener(
      "visibilitychange",
      this.handleVitalVisibility,
    );
  };
}
