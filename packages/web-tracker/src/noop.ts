import type { Tracker, TrackerDiagnostics } from "./types.js";

export function createNoopTracker(code: string, development = false): Tracker {
  const diagnostics: TrackerDiagnostics = {
    state: "noop",
    queueSize: 0,
    sentEvents: 0,
    droppedEvents: 0,
    failedBatches: 0,
    retries: 0,
    beaconFallbacks: 0,
    lastErrorCode: code,
    warnings: [code],
  };
  if (development) console.warn(`[frontend-insight] tracker disabled: ${code}`);
  return {
    setAccount() {},
    track() {},
    featureExposed() {},
    featureStarted() {},
    featureSucceeded() {},
    featureFailed() {},
    startLongView: () => () => {},
    flush: async () => {},
    destroy() {
      diagnostics.state = "destroyed";
    },
    getDiagnostics: () => Object.freeze({ ...diagnostics }),
  };
}
