import { watchQualityVitals } from "./quality-vitals.js";
import type { QualityFactory, QualityPort, QualityEmit } from "./quality-port.js";
import { normalizeRequestPath, rateWebVital } from "./observability.js";
import type { WebVitalName } from "./types.js";

export interface QualityOptions {
  sampleRate?: number;
  vitals?: boolean;
  firstScreen?: boolean;
  lists?: boolean;
  api?: boolean;
  resources?: boolean;
  longtasks?: boolean;
  jsErrors?: boolean;
  breadcrumbs?: boolean;
  /** Local-only selectors; neither selectors nor DOM content leave the browser. */
  blankScreen?: { routes: Readonly<Record<string, string>> };
}
const VERSION = "r5a-1";
const limit = 10000;
const bits = {
  vitals: 1,
  firstScreen: 2,
  lists: 4,
  api: 8,
  resources: 16,
  longtasks: 32,
  jsErrors: 64,
  blankScreen: 128,
};
type State = {
  mask: number;
  vitalMask: number;
  selected: boolean;
  start: number;
  emit: QualityEmit;
  sequence: number;
  apiStarted: number;
  apiCompleted: number;
  resourceStarted: number;
  resourceCompleted: number;
  resourceFailed: number;
  longtaskCount: number;
  longtaskTotal: number;
  suppressed: number;
  first: boolean;
  blank?: boolean;
  closed: boolean;
};
/** Explicit, independently imported extension. Each collector defaults off; fetch is never patched. */
export function createQualityCollectors(options: QualityOptions) {
  let port: QualityPort | undefined, state: State | undefined;
  const rate = Number.isFinite(options.sampleRate)
    ? Math.max(0, Math.min(1, options.sampleRate!))
    : 1;
  const observers: PerformanceObserver[] = [];
  const drains: (() => void)[] = [];
  let crumbs: string[] = [],
    timer: ReturnType<typeof setTimeout> | undefined;
  let fingerprints = new Map<string, number>();
  let dispose = () => {};
  let unwatch = () => {};
  const safe = (f: () => void) => {
    try {
      f();
    } catch {
      if (state) state.suppressed++;
    }
  };
  const meta = () => ({ qualityVersion: VERSION, qualitySampleRate: rate });
  const crumb = (kind: string) => {
    if (options.breadcrumbs) {
      crumbs.push(kind);
      if (crumbs.length > 50) crumbs.shift();
    }
  };
  const bounded = (n: number) => Number.isFinite(n) && n >= 0 && n <= 86400000;
  const performance = (
    metric: string,
    value: number,
    extra: Record<string, string> = {},
  ) =>
    safe(() => {
      if (!state?.selected || state.closed || !bounded(value)) return;
      state.emit("performance", {
        ...meta(),
        metric,
        value,
        qualitySequence: ++state.sequence,
        ...(["lcp", "cls", "inp", "fcp", "ttfb"].includes(metric)
          ? { rating: rateWebVital(metric as WebVitalName, value) }
          : {}),
        navigationType: "unknown",
        ...extra,
      });
    });
  const observe = (
    type: string,
    callback: (entries: PerformanceEntry[]) => void,
    buffered = false,
  ) => {
    try {
      const Observer = (
        port!.runtime.window as Window & {
          PerformanceObserver?: typeof PerformanceObserver;
        }
      ).PerformanceObserver;
      if (!Observer?.supportedEntryTypes?.includes(type)) return false;
      const ob = new Observer((list) => safe(() => callback(list.getEntries())));
      ob.observe({
        type,
        buffered,
        ...(type === "event" ? { durationThreshold: 40 } : {}),
      });
      observers.push(ob);
      drains.push(() => callback(ob.takeRecords()));
      return true;
    } catch {
      return false;
    }
  };
  const factory: QualityFactory = (p) => {
    if (port) throw new Error("QUALITY_ALREADY_INSTALLED");
    port = p;
    const onError = (e: Event) =>
      safe(() => {
        if (!options.jsErrors || !state?.selected || e.target !== p.runtime.window)
          return;
        const v = e as ErrorEvent;
        captureException(v.error ?? new Error(v.message));
      });
    const onRejection = (e: PromiseRejectionEvent) => captureException(e.reason);
    p.runtime.window.addEventListener("error", onError, true);
    p.runtime.window.addEventListener("unhandledrejection", onRejection);
    dispose = () => {
      p.runtime.window.removeEventListener("error", onError, true);
      p.runtime.window.removeEventListener("unhandledrejection", onRejection);
      unwatch();
      observers.splice(0).forEach((o) => o.disconnect());
      drains.length = 0;
      if (timer) p.runtime.clearTimeout(timer);
      port = undefined;
      state = undefined;
      crumbs = [];
    };
    let firstPage = true;
    return {
      enter() {
        unwatch();
        observers.splice(0).forEach((o) => o.disconnect());
        drains.length = 0;
        if (timer) p.runtime.clearTimeout(timer);
        fingerprints = new Map();
        crumbs = [];
        crumb("navigation");
        let mask = Object.entries(bits).reduce(
          (n, [key, value]) => n | (options[key as keyof QualityOptions] ? value : 0),
          0,
        );
        state = {
          mask,
          vitalMask: 0,
          selected: Math.random() < rate,
          start: p.runtime.now() - (firstPage ? p.runtime.window.performance.now() : 0),
          emit: p.capture(),
          sequence: 0,
          apiStarted: 0,
          apiCompleted: 0,
          resourceStarted: 0,
          resourceCompleted: 0,
          resourceFailed: 0,
          longtaskCount: 0,
          longtaskTotal: 0,
          suppressed: 0,
          first: false,
          closed: false,
        };
        const current = state;
        if (
          options.longtasks &&
          !observe("longtask", (entries) => {
            for (const e of entries)
              if (e.duration > 50) {
                if (
                  current.longtaskCount >= limit ||
                  current.longtaskTotal + e.duration > 86400000
                ) {
                  current.suppressed++;
                  continue;
                }
                current.longtaskCount++;
                current.longtaskTotal += Math.round(e.duration);
              }
          })
        )
          mask &= ~bits.longtasks;
        // Navigation metrics belong only to the document's first page view, never a later SPA route.
        if (options.vitals && firstPage) {
          const supported =
            (
              p.runtime.window as Window & {
                PerformanceObserver?: typeof PerformanceObserver;
              }
            ).PerformanceObserver?.supportedEntryTypes ?? [];
          state.vitalMask = [
            "largest-contentful-paint",
            "event",
            "layout-shift",
            "paint",
            "navigation",
          ].reduce((n, key, i) => n | (supported.includes(key) ? 1 << i : 0), 0);
          unwatch = watchQualityVitals((metric) => {
            if (state === current && !current.closed)
              performance(metric.name.toLowerCase(), metric.value, {
                sampleId: metric.id,
              });
          });
        } else mask &= ~bits.vitals;
        firstPage = false;
        const selector =
          options.blankScreen?.routes[p.runtime.window.location.pathname];
        if (selector && state.selected) {
          timer = p.runtime.setTimeout(
            () =>
              safe(() => {
                if (
                  state !== current ||
                  current.closed ||
                  p.runtime.document.visibilityState !== "visible"
                )
                  return;
                const root = p.runtime.document.querySelector(selector);
                current.blank = !root || root.childElementCount === 0;
              }),
            3000,
          );
        } else mask &= ~bits.blankScreen;
        state.mask = mask;
        return { ...meta(), qualityMask: state.selected ? mask : 0 };
      },
      leave(closed) {
        if (!state) return {};
        for (const drain of drains) safe(drain);
        crumb("hidden");
        const d = p.diagnostics();
        state.closed = closed;
        return {
          ...meta(),
          qualityMask: state.selected ? state.mask : 0,
          qualityClosed: closed,
          qualitySequence: ++state.sequence,
          qualityDropped: d.droppedEvents,
          qualityFailed: d.failedBatches,
          qualitySuppressed: state.suppressed,
          apiStarted: state.apiStarted,
          apiCompleted: state.apiCompleted,
          resourceStarted: state.resourceStarted,
          resourceCompleted: state.resourceCompleted,
          resourceFailed: state.resourceFailed,
          longtaskCount: state.longtaskCount,
          longtaskTotal: state.longtaskTotal,
          ...(state.blank === undefined
            ? {}
            : { blankScreen: state.blank, blankRule: "root-empty-3s-v1" }),
        };
      },
      destroy: () => safe(dispose),
    };
  };
  function captureException(error: unknown) {
    safe(() => {
      if (!options.jsErrors || !state?.selected || state.closed) return;
      const e = error instanceof Error ? error : new Error("Unhandled exception");
      const name = [
        "Error",
        "TypeError",
        "RangeError",
        "ReferenceError",
        "SyntaxError",
        "URIError",
        "EvalError",
      ].includes(e.name)
        ? e.name
        : "Error";
      const message = "JavaScript exception";
      const frame = (e.stack ?? "")
        .split("\n")
        .slice(1, 4)
        .join(" ")
        .match(/https?:\/\/[^\s)]+/);
      const stack =
        frame && port
          ? normalizeRequestPath(frame[0], port.runtime.window.location.href)
          : "[unavailable]";
      const key = name + message + stack,
        count = fingerprints.get(key) ?? 0;
      if (count >= 5 || (!fingerprints.has(key) && fingerprints.size >= 100)) {
        state.suppressed++;
        return;
      }
      fingerprints.set(key, count + 1);
      state.emit("error", {
        ...meta(),
        errorType: "js",
        errorCategory: "js",
        errorName: name || "Error",
        errorMessage: message || "Error",
        stackTopFrame: stack,
        ...(options.breadcrumbs
          ? { breadcrumb: Object.fromEntries(crumbs.map((c, i) => [`b${i}`, c])) }
          : {}),
      });
    });
  }
  return {
    factory,
    captureException,
    action() {
      safe(() => crumb("action"));
    },
    firstScreen() {
      safe(() => {
        if (!options.firstScreen || !state || state.first || !port) return;
        state.first = true;
        performance("first_screen_time", port.runtime.now() - state.start);
      });
    },
    startList(rows: number) {
      const s = state,
        started = port?.runtime.now();
      let done = false;
      return () =>
        safe(() => {
          if (
            done ||
            !options.lists ||
            !port ||
            state !== s ||
            !Number.isInteger(rows) ||
            rows < 0 ||
            started === undefined
          )
            return;
          done = true;
          performance("list_render_duration", port.runtime.now() - started, {
            sampleId: port.runtime.crypto.randomUUID(),
            rowBucket: rows < 100 ? "lt100" : rows <= 1000 ? "100to1000" : "gt1000",
          });
        });
    },
    async observeApi<T extends { status: number }>(
      route: string,
      execute: () => Promise<T>,
      method = "GET",
    ): Promise<T> {
      const s = state,
        p = port;
      let started = 0,
        id = "",
        path = "";
      safe(() => {
        if (!options.api || !s?.selected || s.closed || !p || s.apiStarted >= limit)
          return;
        // API templates are explicit paths, with no query, host, credentials or body.
        if (!/^\/[a-zA-Z0-9_/:.-]{0,127}$/.test(route)) return;
        path = normalizeRequestPath(route, p.runtime.window.location.href);
        id = p.runtime.crypto.randomUUID();
        started = p.runtime.now();
        s.apiStarted++;
      });
      const terminal = (status: number, failureType: string) =>
        safe(() => {
          if (!id || !s || !p) return;
          if (
            !Number.isInteger(status) ||
            status < 0 ||
            status > 599 ||
            (status === 0 && failureType === "none")
          ) {
            s.suppressed++;
            return;
          }
          s.apiCompleted++;
          const failed = ["network", "timeout", "http"].includes(failureType);
          s.emit("api", {
            ...meta(),
            apiRequestId: id,
            success: failureType === "none",
            requestMethod: [
              "GET",
              "POST",
              "PUT",
              "PATCH",
              "DELETE",
              "HEAD",
              "OPTIONS",
            ].includes(method)
              ? method
              : "OTHER",
            requestPath: path,
            statusCode: status,
            durationMs: Math.min(
              86400000,
              Math.max(0, Math.round(p.runtime.now() - started)),
            ),
            failureType,
          });
          if (state === s && failureType !== "aborted")
            crumb(failed ? "api_failure" : "api_success");
        });
      try {
        const value = await execute();
        safe(() => terminal(value.status, value.status >= 400 ? "http" : "none"));
        return value;
      } catch (e) {
        safe(() => {
          terminal(
            0,
            e instanceof Error && e.name === "TimeoutError"
              ? "timeout"
              : e instanceof Error && e.name === "AbortError"
                ? "aborted"
                : "network",
          );
        });
        throw e;
      }
    },
    async observeResource<T>(execute: () => Promise<T>): Promise<T> {
      const s = state;
      const requestCrumbs = [...crumbs];
      let tracked = false;
      safe(() => {
        if (
          options.resources &&
          s?.selected &&
          !s.closed &&
          s.resourceStarted < limit
        ) {
          s.resourceStarted++;
          tracked = true;
        } else if (s && s.resourceStarted >= limit) s.suppressed++;
      });
      try {
        const value = await execute();
        if (tracked) s!.resourceCompleted++;
        return value;
      } catch (e) {
        if (tracked) {
          s!.resourceCompleted++;
          s!.resourceFailed++;
          safe(() =>
            s!.emit("error", {
              ...meta(),
              errorType: "resource",
              errorCategory: "resource",
              resourceType: "other",
              requestPath: "/controlled-resource",
              ...(options.breadcrumbs
                ? {
                    breadcrumb: Object.fromEntries(
                      requestCrumbs.map((c, i) => [`b${i}`, c]),
                    ),
                  }
                : {}),
            }),
          );
        }
        throw e;
      }
    },
  };
}
