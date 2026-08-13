import { randomUUID } from "node:crypto";

const apiUrl = process.env.M24_API_URL ?? "http://127.0.0.1:3000";
const origin = process.env.M7_ORIGIN ?? "http://localhost:4173";
const projectId = "11111111-1111-4111-8111-111111111111";
const projectKey = "fi_public_m1demo001";
const command = process.argv[2];
const marker = process.argv[3] ?? randomUUID().replaceAll("-", "").slice(0, 16);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function login() {
  const response = await fetch(`${apiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "admin@example.invalid",
      password: "LocalAdmin-1234",
    }),
  });
  if (!response.ok) throw new Error(`probe login failed: ${response.status}`);
  return (await response.json()).accessToken;
}

async function health(expectation) {
  let status;
  try {
    const response = await fetch(`${apiUrl}/health/ready`, {
      signal: AbortSignal.timeout(10_000),
    });
    status = response.status;
  } catch {
    status = 0;
  }
  const ready = status >= 200 && status < 300;
  if ((expectation === "ready" && !ready) || (expectation === "unavailable" && ready)) {
    throw new Error(`health expectation ${expectation} failed with status ${status}`);
  }
  console.log(JSON.stringify({ command, expectation, status, passed: true }));
}

async function enqueue(expectedStatus = 202) {
  const now = new Date();
  const response = await fetch(`${apiUrl}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      schemaVersion: 3,
      projectKey,
      sentAt: now.toISOString(),
      sdk: { name: "m7-resilience-probe", version: "1.0.0" },
      events: [
        {
          eventId: `evt_m7_fault_${marker}`,
          eventName: "page_view",
          occurredAt: now.toISOString(),
          deploymentEnvironment: "production",
          releaseVersion: "m7-resilience-v3",
          visitorId: `vis_m7_fault_${marker}`,
          sessionId: `ses_m7_fault_${marker}`,
          pageViewId: `pv_m7_fault_${marker}`,
          route: `/m7/fault/${marker}`,
          timezoneOffsetMinutes: 0,
          properties: { faultProbe: true },
        },
      ],
    }),
    signal: AbortSignal.timeout(expectedStatus === 503 ? 60_000 : 20_000),
  }).catch(() => ({ status: 0, text: async () => "request failed" }));
  if (response.status !== expectedStatus) {
    throw new Error(
      `enqueue expected ${expectedStatus}, got ${response.status}: ${await response.text()}`,
    );
  }
  console.log(
    JSON.stringify({ command, marker, status: response.status, passed: true }),
  );
}

async function verify() {
  const token = await login();
  const now = Date.now();
  const query = new URLSearchParams({
    from: new Date(now - 15 * 60_000).toISOString(),
    to: new Date(now + 60_000).toISOString(),
    timezone: "UTC",
    granularity: "hour",
    search: `/m7/fault/${marker}`,
    page: "1",
    pageSize: "20",
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${apiUrl}/api/projects/${projectId}/analytics/pages?${query}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (response.ok) {
      const body = await response.json();
      if (body.items?.some((item) => item.route === `/m7/fault/${marker}`)) {
        console.log(JSON.stringify({ command, marker, queryable: true, passed: true }));
        return;
      }
    }
    await wait(1_000);
  }
  throw new Error(`marker did not become queryable: ${marker}`);
}

if (command === "health-ready") await health("ready");
else if (command === "health-unavailable") await health("unavailable");
else if (command === "enqueue") await enqueue(202);
else if (command === "reject") await enqueue(503);
else if (command === "verify") await verify();
else
  throw new Error(
    "Usage: m7-resilience-probe.mjs health-ready|health-unavailable|enqueue|reject|verify [marker]",
  );
