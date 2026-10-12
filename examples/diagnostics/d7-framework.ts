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
