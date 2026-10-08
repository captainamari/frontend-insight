import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const base = process.env.M5_WEB_URL ?? "http://127.0.0.1:4173",
  origin = "http://127.0.0.1:4174";
async function json(path, options = {}) {
  const r = await fetch(base + path, options);
  assert(r.ok, `HTTP ${r.status}`);
  return r.json();
}
const login = await json("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "admin@example.invalid", password: "LocalAdmin-1234" }),
});
const headers = {
  authorization: `Bearer ${login.accessToken}`,
  "content-type": "application/json",
};
const project = await json("/api/projects", {
  method: "POST",
  headers,
  body: JSON.stringify({
    name: `R5-A load ${randomUUID()}`,
    timezone: "UTC",
    origins: [origin],
  }),
});
const mod = await json(`/api/projects/${project.id}/modules`, {
  method: "POST",
  headers,
  body: JSON.stringify({ moduleKey: "quality_load", name: "Quality load" }),
});
await json(`/api/projects/${project.id}/page-definitions`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    moduleId: mod.id,
    name: "Quality load",
    pageRoute: "/r5a-load",
    templateKey: "task_operation",
    isCore: true,
    criticalityWeight: 1,
    expectedFrequency: "daily",
  }),
});
const start = Date.now(),
  prefix = randomUUID().replaceAll("-", "");
let sequence = 0,
  accepted = 0;
const latencies = [],
  sentAt = [];
const meta = { qualityVersion: "r5a-1", qualityMask: 255, qualitySampleRate: 1 };
function cohort() {
  const id = prefix + "_" + sequence++,
    at = Date.now();
  const common = {
    appId: project.appId,
    env: "dev",
    release: "r5a-load",
    timestamp: at,
    pageUrl: origin + "/r5a-load",
    pageRoute: "/r5a-load",
    userId: "u_quality_load",
    deptId: null,
    roleId: null,
    sessionId: "ses_" + id,
    deviceId: "dev_" + id,
    pageViewId: "pv_" + id,
    ua: "R5A",
    os: "Other",
    browser: "Other",
  };
  return [
    { event: "page_view", payload: meta },
    {
      event: "api",
      payload: {
        qualityVersion: "r5a-1",
        qualitySampleRate: 1,
        apiRequestId: id,
        success: true,
        requestMethod: "GET",
        requestPath: "/controlled",
        statusCode: 200,
        durationMs: 10,
        failureType: "none",
      },
    },
    {
      event: "performance",
      payload: {
        qualityVersion: "r5a-1",
        qualitySampleRate: 1,
        metric: "first_screen_time",
        value: 100,
        rating: "good",
        navigationType: "unknown",
      },
    },
    {
      event: "error",
      payload: {
        qualityVersion: "r5a-1",
        qualitySampleRate: 1,
        errorType: "js",
        errorCategory: "js",
        errorName: "Error",
        errorMessage: "JavaScript exception",
        stackTopFrame: "[unavailable]",
        breadcrumb: { b0: "navigation", b1: "api_success" },
      },
    },
    {
      event: "page_leave",
      payload: {
        ...meta,
        visibleDurationMs: 100,
        qualitySequence: 1,
        qualityClosed: true,
        qualityDropped: 0,
        qualityFailed: 0,
        qualitySuppressed: 0,
        apiStarted: 1,
        apiCompleted: 1,
        resourceStarted: 2,
        resourceCompleted: 2,
        resourceFailed: 0,
        longtaskCount: 0,
        longtaskTotal: 0,
        blankScreen: false,
        blankRule: "root-empty-3s-v1",
      },
    },
  ].map((e, i) => ({ ...common, ...e, eventId: "evt_" + id + "_" + i }));
}
const profiles = [];
for (const [eps, seconds] of [
  [20, 60],
  [200, 10],
]) {
  const begin = performance.now();
  const firstSample = latencies.length;
  for (let second = 0; second < seconds; second++) {
    const due = begin + second * 1000;
    if (performance.now() < due)
      await new Promise((r) => setTimeout(r, due - performance.now()));
    const events = Array.from({ length: eps / 5 }, cohort).flat();
    const sends = [];
    while (events.length) {
      const batch = events.splice(0, 50);
      sends.push(
        (async () => {
          const t = performance.now();
          sentAt.push(...batch.map(() => Date.now()));
          const r = await json("/v1/events", {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({
              schemaVersion: 3,
              sentAt: Date.now(),
              sdk: { name: "r5a-load", version: "0.8.0" },
              events: batch,
            }),
          });
          latencies.push(performance.now() - t);
          accepted += r.acceptedEvents;
        })(),
      );
    }
    await Promise.all(sends);
  }
  const profileSamples = latencies.slice(firstSample).sort((a, b) => a - b);
  const profileP95Ms = profileSamples[Math.ceil(profileSamples.length * 0.95) - 1];
  assert(
    profileP95Ms <= 100,
    `${eps} events/s HTTP p95 exceeds 100ms: ${profileP95Ms}`,
  );
  profiles.push({
    httpSampleCount: profileSamples.length,
    httpP95Ms: profileP95Ms,
    eventsPerSecond: eps,
    seconds,
    sentEvents: eps * seconds,
    elapsedMs: performance.now() - begin,
  });
}
assert.equal(accepted, 3200);
const q = new URLSearchParams({
  env: "dev",
  from: new Date(start - 1000).toISOString(),
  to: new Date(Date.now() + 1).toISOString(),
});
let result;
const catchup = Date.now();
while (Date.now() - catchup < 90000) {
  result = await json(`/api/projects/${project.id}/observability/quality?${q}`, {
    headers,
  });
  if (result.metrics.api_error_rate.denominator === 640) break;
  await new Promise((r) => setTimeout(r, 500));
}
assert.equal(result.metrics.api_error_rate.denominator, 640);
assert.equal(result.metrics.resource_error_rate.denominator, 1280);
assert.equal(result.metrics.api_error_rate.observedValue, 0);
const visibilityDeadline = Date.now() + 300000;
let visibleCount = 0;
while (Date.now() < visibilityDeadline) {
  const observed = await json(
    `/api/projects/${project.id}/settings/probe-versions?env=dev&range=7d`,
    { headers },
  );
  visibleCount = observed.denominator;
  if (visibleCount === accepted) break;
  await new Promise((r) => setTimeout(r, 250));
}
assert.equal(visibleCount, accepted);
const allVisibleAt = Date.now();
const visibilityUpperBounds = sentAt
  .map((at) => allVisibleAt - at)
  .sort((a, b) => a - b);
const visibilityP95UpperBoundMs =
  visibilityUpperBounds[Math.ceil(visibilityUpperBounds.length * 0.95) - 1];
assert(visibilityP95UpperBoundMs <= 300000);
const queryTimes = [];
for (let i = 0; i < 23; i++) {
  const t = performance.now();
  result = await json(`/api/projects/${project.id}/observability/quality?${q}`, {
    headers,
  });
  if (i >= 3) queryTimes.push(performance.now() - t);
}
latencies.sort((a, b) => a - b);
queryTimes.sort((a, b) => a - b);
const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1],
  queryP95 = queryTimes[Math.ceil(queryTimes.length * 0.95) - 1];
assert(p95 <= 100, `Ingestion HTTP p95 exceeds 100ms: ${p95}`);
assert(queryP95 <= 2000);
assert.equal(result.statistics.clickHouseQueries, 1);
assert(result.statistics.rowsRead <= 1000000);
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/r5a-load.json",
  JSON.stringify(
    {
      testedCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      profiles,
      warmups: 0,
      sampleCount: latencies.length,
      queryWarmups: 3,
      querySampleCount: 20,
      measurement: "HTTP validation/enqueue response; not asynchronous storage latency",
      visibility: {
        method:
          "conservative event-weighted upper bound: batch request start until all 3200 unique events are queryable in the dedicated project",
        p95UpperBoundMs: visibilityP95UpperBoundMs,
        eventSampleCount: sentAt.length,
        allVisibleCount: visibleCount,
        pollIntervalMs: 250,
      },
      accepted,
      apiRequests: 640,
      resourceRequests: 1280,
      ingestionP95Ms: p95,
      queryP95Ms: queryP95,
      statistics: result.statistics,
      catchupMs: Date.now() - catchup,
    },
    null,
    2,
  ),
);
