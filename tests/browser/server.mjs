import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const sdkUrl = new URL("../../packages/web-tracker/dist/index.js", import.meta.url);

const page = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Browser contract</title></head>
  <body>
    <main id="app">Frontend Insight browser contract</main>
    <script type="module">
      import { createTracker } from "/sdk.js";
      window.__batches = [];
      const runtime = {
        window,
        document,
        navigator: { sendBeacon: () => false },
        storage: window.localStorage,
        fetch: async (_url, options) => {
          window.__batches.push(JSON.parse(String(options.body)));
          return new Response(null, { status: 202 });
        },
        crypto: window.crypto,
        now: Date.now,
        setTimeout: window.setTimeout.bind(window),
        clearTimeout: window.clearTimeout.bind(window),
        setInterval: window.setInterval.bind(window),
        clearInterval: window.clearInterval.bind(window),
      };
      window.__tracker = createTracker({
        projectKey: "fi_public_browsercontract01",
        endpoint: "http://127.0.0.1:4318/v1/events",
        registeredFeatures: ["sales_dashboard", "report_export", "operations_wallboard"],
        normalizeRoute: (url) => url.pathname.replace(/\\/orders\\/[^/]+/, "/orders/:id"),
        flushIntervalMs: 60000,
        observability: {
          enabled: true,
          releaseVersion: "browser-contract-1",
          deploymentEnvironment: "test",
          captureJsErrors: false,
          captureResourceErrors: false,
          captureApiErrors: false,
          captureWebVitals: false,
        },
        runtime,
      });
      window.__ready = true;
    </script>
  </body>
</html>`;

const server = createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200).end("ok");
    return;
  }
  if (request.url === "/sdk.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(await readFile(sdkUrl));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});

server.listen(4318, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
