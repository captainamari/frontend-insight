import type { TrackerRuntime } from "./types.js";

export function browserRuntime(): TrackerRuntime {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("BROWSER_RUNTIME_UNAVAILABLE");
  }
  return {
    window,
    document,
    navigator,
    storage: window.localStorage,
    fetch: globalThis.fetch.bind(globalThis),
    crypto: globalThis.crypto,
    now: Date.now,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
}
