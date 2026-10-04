import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from "web-vitals";
// One bounded document-level subscription shared by independently mounted SDK instances.
// No attribution build: DOM targets, selectors and entry objects never enter telemetry.
const listeners = new Set<(metric: Metric) => void>();
const latest = new Map<string, Metric>();
let installed = false;
export function watchQualityVitals(callback: (metric: Metric) => void): () => void {
  if (
    typeof window === "undefined" ||
    typeof PerformanceObserver === "undefined" ||
    listeners.size >= 20
  )
    return () => {};
  listeners.add(callback);
  if (!installed) {
    installed = true;
    const report = (metric: Metric) => {
      latest.set(metric.name, metric);
      for (const listener of listeners) {
        try {
          listener(metric);
        } catch {
          /* host isolation */
        }
      }
    };
    for (const install of [onCLS, onFCP, onINP, onLCP, onTTFB]) {
      try {
        install(report, { reportAllChanges: true });
      } catch {
        /* unsupported */
      }
    }
  }
  for (const value of latest.values()) {
    try {
      callback(value);
    } catch {
      /* host isolation */
    }
  }
  return () => {
    listeners.delete(callback);
  };
}
