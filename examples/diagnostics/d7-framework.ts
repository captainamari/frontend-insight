import { createApp, h } from "vue";
import { createTracker } from "../../packages/web-tracker/src/index.js";
import { createConsoleDiagnostics } from "../../packages/web-tracker/src/console.js";
import { installVueErrorHandler } from "../../packages/web-tracker/src/errors.js";
const appId = new URLSearchParams(location.search).get("appId")!;
const collector = createConsoleDiagnostics({
  scope: { appId },
  levels: ["info", "warn", "error"],
});
const tracker = createTracker({
  appId,
  env: "dev",
  release: "d7-framework",
  endpoint: location.origin + "/v1/events",
  errorDiagnostics: collector,
  observability: { enabled: true, captureWebVitals: false },
});
const app = createApp({
  render() {
    return h(
      "button",
      {
        onClick() {
          console.info("FI_D7_SYNTHETIC Vue action", { nested: { token: "original" } });
          throw new TypeError("FI_D7_SYNTHETIC mounted Vue handler\n原文框架异常");
        },
      },
      "触发真实 Vue 组件异常",
    );
  },
});
const restore = installVueErrorHandler(app, (e, source) =>
  tracker.captureException(e, source),
);
app.mount("#app");
Object.assign(window, {
  d7: {
    tracker,
    collector,
    stop() {
      app.unmount();
      restore();
      tracker.destroy();
    },
  },
});

function benchmark() {
  const result: Record<string, { p95Ms: number; samples: number; warmups: number }> =
    {};
  const runtime = {
    window,
    document,
    navigator: { userAgent: navigator.userAgent, sendBeacon: () => true },
    crypto: globalThis.crypto,
    now: Date.now,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    fetch: async () => new Response(null, { status: 202 }),
  };
  const error = new TypeError("FI_D7_SYNTHETIC benchmark");
  const envelope = {
    diagnosticVersion: 1 as const,
    contentType: "application/json" as const,
    source: "explicit" as const,
    policyVersion: "d0-1",
    status: "complete" as const,
    omittedBytes: 0,
    suppressed: 0,
    raw: { padding: "" },
  };
  envelope.raw.padding = "a".repeat(
    65536 - new TextEncoder().encode(JSON.stringify(envelope)).length,
  );
  for (const kind of ["disabled", "enabled", "maximumEnvelope"] as const) {
    const samples: number[] = [];
    for (let i = 0; i < 220; i++) {
      // Fresh page lifetime avoids measuring already-suppressed evidence after its 20/min budget.
      const instance = createTracker({
        appId: "fi_d7_benchmark",
        env: "dev",
        release: "d7-benchmark",
        endpoint: location.origin + "/v1/events",
        runtime,
        ...(kind === "enabled"
          ? {
              errorDiagnostics: createConsoleDiagnostics({
                scope: { appId: "fi_d7_benchmark" },
                levels: [],
              }),
            }
          : {}),
      });
      const start = performance.now();
      if (kind === "maximumEnvelope") instance.captureDiagnostic(envelope);
      else instance.captureException(error);
      const elapsed = performance.now() - start;
      if (i >= 20) samples.push(elapsed);
      instance.destroy();
    }
    samples.sort((a, b) => a - b);
    result[kind] = {
      p95Ms: samples[Math.ceil(samples.length * 0.95) - 1]!,
      samples: samples.length,
      warmups: 20,
    };
  }
  return {
    result,
    envelopeBytes: new TextEncoder().encode(JSON.stringify(envelope)).length,
    method:
      "nearest rank; synchronous capture only, transport stub excluded; timer zero is below resolution; fresh SDK page lifetimes",
  };
}
Object.assign(window, { d7Benchmark: benchmark });
