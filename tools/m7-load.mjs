import { randomUUID } from "node:crypto";

const apiUrl = process.env.M24_API_URL ?? "http://127.0.0.1:3000";
const origin = process.env.M7_ORIGIN ?? "http://localhost:4173";
const projectKey = process.env.M7_PROJECT_KEY ?? "fi_public_m1demo001";
const projectId = process.env.M7_PROJECT_ID ?? "11111111-1111-4111-8111-111111111111";
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "full";
if (mode !== "quick" && mode !== "full") {
  throw new Error("M7 load mode must be quick or full");
}
const profiles =
  mode === "full"
    ? [
        { name: "sustained", eventsPerSecond: 20, seconds: 60 },
        { name: "peak", eventsPerSecond: 200, seconds: 10 },
      ]
    : [
        { name: "sustained", eventsPerSecond: 20, seconds: 5 },
        { name: "peak", eventsPerSecond: 200, seconds: 2 },
      ];
const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const runStartedAt = Date.now();
const latencies = [];
let acceptedEvents = 0;
const failures = [];

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
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
  if (!response.ok) throw new Error(`M7 load login failed: ${response.status}`);
  return (await response.json()).accessToken;
}

function analyticsQuery() {
  return new URLSearchParams({
    from: new Date(runStartedAt - 60_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
    timezone: "UTC",
    granularity: "hour",
  });
}

async function pageViews(token) {
  const response = await fetch(
    `${apiUrl}/api/projects/${projectId}/analytics/overview?${analyticsQuery()}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`M7 overview failed: ${response.status}`);
  return Number((await response.json()).current?.pv ?? 0);
}

function event(sequence, profileName) {
  const suffix = `${runId}_${String(sequence).padStart(8, "0")}`;
  return {
    eventId: `evt_m7_${suffix}`,
    eventName: "page_view",
    eventTime: new Date().toISOString(),
    visitorId: `vis_m7_${suffix}`,
    sessionId: `ses_m7_${runId}_${String(sequence % 200).padStart(4, "0")}`,
    pageViewId: `pv_m7_${suffix}`,
    accountRef: `m7-load-account-${sequence % 50}`,
    route: "/m7/load",
    timezoneOffsetMinutes: 0,
    properties: { loadProfile: profileName },
  };
}

async function sendBatch(events) {
  const startedAt = performance.now();
  const response = await fetch(`${apiUrl}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      schemaVersion: 2,
      projectKey,
      sentAt: new Date().toISOString(),
      sdk: { name: "m7-load-probe", version: "1.0.0" },
      events,
    }),
  });
  latencies.push(performance.now() - startedAt);
  const text = await response.text();
  if (!response.ok) {
    failures.push({ status: response.status, body: text.slice(0, 160) });
    return;
  }
  const body = JSON.parse(text);
  acceptedEvents += Number(body.acceptedEvents ?? 0);
}

async function runProfile(profile, sequenceStart) {
  const startedAt = performance.now();
  let sequence = sequenceStart;
  for (let second = 0; second < profile.seconds; second += 1) {
    const dueAt = startedAt + second * 1_000;
    if (performance.now() < dueAt) await wait(dueAt - performance.now());
    const events = Array.from({ length: profile.eventsPerSecond }, () =>
      event(sequence++, profile.name),
    );
    const requests = [];
    while (events.length) requests.push(sendBatch(events.splice(0, 50)));
    await Promise.all(requests);
  }
  const elapsedMs = performance.now() - startedAt;
  return {
    name: profile.name,
    targetEventsPerSecond: profile.eventsPerSecond,
    seconds: profile.seconds,
    sentEvents: profile.eventsPerSecond * profile.seconds,
    elapsedMs: Math.round(elapsedMs),
    achievedEventsPerSecond: Number(
      ((profile.eventsPerSecond * profile.seconds * 1_000) / elapsedMs).toFixed(1),
    ),
    nextSequence: sequence,
  };
}

const token = await login();
const baselinePv = await pageViews(token);
const results = [];
let sequence = 1;
for (const profile of profiles) {
  const result = await runProfile(profile, sequence);
  sequence = result.nextSequence;
  results.push(result);
}
const expectedEvents = profiles.reduce(
  (total, profile) => total + profile.eventsPerSecond * profile.seconds,
  0,
);
const catchupStartedAt = Date.now();
let observedPv = baselinePv;
while (Date.now() - catchupStartedAt < 120_000) {
  observedPv = await pageViews(token);
  if (observedPv - baselinePv >= expectedEvents) break;
  await wait(1_000);
}
const metricsResponse = await fetch(`${apiUrl}/api/system/metrics`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!metricsResponse.ok)
  throw new Error(`M7 metrics failed: ${metricsResponse.status}`);
const processMetrics = await metricsResponse.json();
const report = {
  status: "passed",
  mode,
  runId,
  profiles: results.map((result) => {
    const reportResult = { ...result };
    delete reportResult.nextSequence;
    return reportResult;
  }),
  expectedEvents,
  acceptedEvents,
  queryableEvents: observedPv - baselinePv,
  requestCount: latencies.length,
  requestLatencyP50Ms: Math.round(percentile(latencies, 0.5)),
  requestLatencyP95Ms: Math.round(percentile(latencies, 0.95)),
  catchupMs: Date.now() - catchupStartedAt,
  processMetrics,
};
if (failures.length) {
  report.status = "failed";
  report.failures = failures.slice(0, 10);
}
if (acceptedEvents !== expectedEvents) report.status = "failed";
if (observedPv - baselinePv < expectedEvents) report.status = "failed";
if (report.requestLatencyP95Ms > 1_000) report.status = "failed";
console.log(JSON.stringify(report));
if (report.status !== "passed") process.exitCode = 1;
