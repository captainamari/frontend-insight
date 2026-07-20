import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const apiPort = 31_000 + (process.pid % 10_000);
const demoPort = 42_000 + (process.pid % 10_000);
const origin = `http://127.0.0.1:${demoPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;

function event(overrides = {}) {
  return {
    eventId: randomUUID(),
    eventType: "m0_beacon_test",
    projectKey: "m0-local",
    featureKey: "browser-beacon",
    accountRef: "integration-account-opaque",
    sessionId: randomUUID(),
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

async function waitUntilReady(child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before readiness: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${apiUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // The process is still binding the local test ports.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server was not ready within five seconds");
}

test("HTTP spike enforces CORS, accepts safe events and serves strict CSP", async (t) => {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      M0_API_HOST: "127.0.0.1",
      M0_API_PORT: String(apiPort),
      M0_DEMO_HOST: "127.0.0.1",
      M0_DEMO_PORT: String(demoPort),
      M0_PUBLIC_API_URL: apiUrl,
      M0_ALLOWED_ORIGIN: origin,
    },
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  await waitUntilReady(child);

  const preflight = await fetch(`${apiUrl}/v1/events`, {
    method: "OPTIONS",
    headers: { origin },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);

  const acceptedEvent = event();
  const accepted = await fetch(`${apiUrl}/v1/events`, {
    method: "POST",
    headers: { origin, "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ events: [acceptedEvent] }),
  });
  assert.equal(accepted.status, 202);

  const rejected = await fetch(`${apiUrl}/v1/events`, {
    method: "POST",
    headers: { origin, "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({
      events: [{ ...event(), metadata: { token: "must-not-pass" } }],
    }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, "credential_data_rejected");

  const stats = await (await fetch(`${apiUrl}/stats`)).json();
  assert.equal(stats.acceptedEvents, 1);
  assert.deepEqual(stats.lastEventIds, [acceptedEvent.eventId]);

  const demo = await fetch(origin);
  assert.equal(demo.status, 200);
  assert.match(
    demo.headers.get("content-security-policy"),
    new RegExp(`connect-src 'self' ${apiUrl}`),
  );
  assert.match(await demo.text(), /src="\/demo\.js"/);
});
