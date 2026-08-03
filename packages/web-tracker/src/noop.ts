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
    duplicateOperationTerminals: 0,
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
    startOperation: () => ({
      succeed() {},
      fail() {},
      cancel() {},
      getState: () => "started",
    }),
    startLongView: () => () => {},
    captureException() {},
    captureApiError() {},
    captureResourceError() {},
    captureWebVital() {},
    flush: async () => {},
    destroy() {
      diagnostics.state = "destroyed";
    },
    getDiagnostics: () => Object.freeze({ ...diagnostics }),
  };
}
