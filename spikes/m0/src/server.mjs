import http from "node:http";
import { createHmac } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { corsHeadersFor } from "./cors.mjs";
import { validateEventBatch } from "./event.mjs";
import { loadConfig } from "./config.mjs";
import { findCredentialLeak } from "./security.mjs";

const config = loadConfig();
const maximumBodyBytes = 64 * 1024;
const stats = {
  acceptedBatches: 0,
  acceptedEvents: 0,
  lastEventIds: [],
};
let kafkaProducer;

function hashAccountRef(accountRef) {
  return createHmac("sha256", config.ingestion.accountHmacKey)
    .update(accountRef)
    .digest("hex");
}

async function initializePublisher() {
  if (!config.kafka.publisherEnabled) return;

  const kafka = new Kafka({
    clientId: "frontend-insight-m0-ingestion",
    brokers: config.kafka.brokers,
    logLevel: logLevel.ERROR,
  });
  const admin = kafka.admin();
  kafkaProducer = kafka.producer({ allowAutoTopicCreation: false });

  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic: config.kafka.topic,
          numPartitions: 1,
          replicationFactor: 1,
        },
      ],
    });
  } finally {
    await admin.disconnect();
  }
  await kafkaProducer.connect();
}

async function publishEvents(events) {
  if (!kafkaProducer) return;

  await kafkaProducer.send({
    topic: config.kafka.topic,
    messages: events.map(({ accountRef, ...event }) => ({
      key: event.eventId,
      value: JSON.stringify({
        ...event,
        accountHash: hashAccountRef(accountRef),
        ingestedAt: new Date().toISOString(),
      }),
    })),
  });
}

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBodyBytes) {
      const error = new Error("request body exceeds 64 KiB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function handleApi(request, response) {
  const url = new URL(request.url ?? "/", config.api.publicUrl);

  if (request.method === "GET" && url.pathname === "/health/live") {
    sendJson(response, 200, { status: "live" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/health/ready") {
    sendJson(response, 200, { status: "ready" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/stats") {
    sendJson(response, 200, { ...stats });
    return;
  }

  if (url.pathname !== "/v1/events") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const corsHeaders = corsHeadersFor(
    request.headers.origin,
    config.api.allowedOrigin,
  );
  if (!corsHeaders) {
    sendJson(response, 403, { error: "origin_not_allowed" });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders);
    response.end();
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" }, corsHeaders);
    return;
  }

  const contentType = request.headers["content-type"] ?? "";
  if (
    !contentType.startsWith("text/plain") &&
    !contentType.startsWith("application/json")
  ) {
    sendJson(
      response,
      415,
      { error: "unsupported_media_type" },
      corsHeaders,
    );
    return;
  }

  try {
    const rawBody = await readBody(request);
    const payload = JSON.parse(rawBody);
    const credentialLeak = findCredentialLeak(payload);
    if (credentialLeak) {
      sendJson(
        response,
        400,
        { error: "credential_data_rejected", detail: credentialLeak },
        corsHeaders,
      );
      return;
    }

    const validationError = validateEventBatch(payload);
    if (validationError) {
      sendJson(
        response,
        400,
        { error: "invalid_event_batch", detail: validationError },
        corsHeaders,
      );
      return;
    }

    try {
      await publishEvents(payload.events);
    } catch (error) {
      console.error("failed to publish accepted events", error);
      sendJson(
        response,
        503,
        { error: "event_pipeline_unavailable" },
        corsHeaders,
      );
      return;
    }

    stats.acceptedBatches += 1;
    stats.acceptedEvents += payload.events.length;
    stats.lastEventIds = payload.events
      .slice(-10)
      .map((event) => event.eventId);

    sendJson(
      response,
      202,
      { accepted: payload.events.length },
      corsHeaders,
    );
  } catch (error) {
    const statusCode = error.statusCode ?? 400;
    sendJson(
      response,
      statusCode,
      {
        error: statusCode === 413 ? "payload_too_large" : "invalid_json",
      },
      corsHeaders,
    );
  }
}

function demoHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Frontend Insight M0 Beacon 验证</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 64px auto; padding: 0 24px; color: #172033; }
      button { font: inherit; padding: 10px 18px; cursor: pointer; }
      code { background: #f3f5f8; padding: 2px 5px; }
      #status { margin-top: 20px; min-height: 24px; }
    </style>
  </head>
  <body>
    <h1>M0 Browser Beacon 验证</h1>
    <p>点击按钮会向 <code>${config.api.publicUrl}/v1/events</code> 发送一条不含登录凭证的合成事件。</p>
    <button id="send" type="button">发送测试事件</button>
    <p id="status" role="status" aria-live="polite"></p>
    <script src="/demo.js" defer></script>
  </body>
</html>`;
}

function demoJavaScript() {
  return `
const endpoint = ${JSON.stringify(`${config.api.publicUrl}/v1/events`)};
const button = document.querySelector("#send");
const status = document.querySelector("#status");

button.addEventListener("click", async () => {
  const payload = JSON.stringify({
    events: [{
      eventId: crypto.randomUUID(),
      eventType: "m0_beacon_test",
      projectKey: "m0-local",
      featureKey: "browser-beacon",
      accountRef: "demo-account-opaque-001",
      sessionId: crypto.randomUUID(),
      occurredAt: new Date().toISOString()
    }]
  });
  const body = new Blob([payload], { type: "text/plain;charset=UTF-8" });

  if (navigator.sendBeacon(endpoint, body)) {
    status.textContent = "事件已由 sendBeacon 排队。运行 ./scripts/dev m0-verify 可复核接收统计。";
    return;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: payload,
      headers: { "content-type": "text/plain;charset=UTF-8" },
      keepalive: true
    });
    status.textContent = response.ok ? "事件已由 fetch keepalive 接收。" : "上报被拒绝：HTTP " + response.status;
  } catch (error) {
    status.textContent = "上报失败：" + error.message;
  }
});
`;
}

function handleDemo(request, response) {
  const url = new URL(request.url ?? "/", config.api.allowedOrigin);
  const commonHeaders = {
    "cache-control": "no-store",
    "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${config.api.publicUrl}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      ...commonHeaders,
      "content-type": "text/html; charset=utf-8",
    });
    response.end(demoHtml());
    return;
  }

  if (request.method === "GET" && url.pathname === "/demo.js") {
    response.writeHead(200, {
      ...commonHeaders,
      "content-type": "text/javascript; charset=utf-8",
    });
    response.end(demoJavaScript());
    return;
  }

  sendJson(response, 404, { error: "not_found" }, commonHeaders);
}

const apiServer = http.createServer((request, response) => {
  handleApi(request, response).catch((error) => {
    console.error("unhandled API error", error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "internal_error" });
    } else {
      response.destroy();
    }
  });
});
const demoServer = http.createServer(handleDemo);

await initializePublisher();
await Promise.all([
  new Promise((resolve) =>
    apiServer.listen(config.api.port, config.api.host, resolve),
  ),
  new Promise((resolve) =>
    demoServer.listen(config.demo.port, config.demo.host, resolve),
  ),
]);

console.log(
  JSON.stringify({
    message: "M0 spike app ready",
    apiPort: config.api.port,
    demoPort: config.demo.port,
    allowedOrigin: config.api.allowedOrigin,
  }),
);

async function shutdown(signal) {
  console.log(JSON.stringify({ message: "shutting down", signal }));
  await Promise.all([
    new Promise((resolve) => apiServer.close(resolve)),
    new Promise((resolve) => demoServer.close(resolve)),
  ]);
  if (kafkaProducer) await kafkaProducer.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
