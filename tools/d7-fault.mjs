// Only the disposable Compose stack; never accepts a remote target.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
const base = "http://127.0.0.1:4173",
  origin = "http://127.0.0.1:4174";
const compose = [
  "compose",
  "--project-name",
  "frontend-insight-m5",
  "--env-file",
  ".env.m5",
  "--file",
  "infra/compose/m2-m4.compose.yml",
  "--file",
  "infra/compose/m5.compose.yml",
];
const run = (args) =>
  execFileSync("docker", [...compose, ...args], { stdio: ["ignore", "pipe", "pipe"] });
const call = (path, options = {}) =>
  fetch(base + path, { ...options, signal: AbortSignal.timeout(30000) });
const login = await (
  await call("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "admin@example.invalid",
      password: "LocalAdmin-1234",
    }),
  })
).json();
const headers = {
  authorization: `Bearer ${login.accessToken}`,
  "content-type": "application/json",
};
const made = await call("/api/projects", {
  method: "POST",
  headers,
  body: JSON.stringify({
    name: `D7 MySQL fault ${randomUUID()}`,
    timezone: "UTC",
    origins: [origin],
  }),
});
assert.equal(made.status, 201);
const project = await made.json();
const key = randomUUID().replaceAll("-", "");
const event = {
  eventId: "evt_" + key,
  event: "error",
  appId: project.appId,
  env: "dev",
  release: "d7-fault",
  timestamp: Date.now(),
  pageUrl: origin + "/d7-fault",
  pageRoute: "/d7-fault",
  userId: "synthetic",
  deptId: null,
  roleId: null,
  deviceId: "dev_" + key,
  sessionId: "ses_" + key,
  pageViewId: "pv_" + key,
  ua: "D7 synthetic",
  os: "Other",
  browser: "Other",
  payload: {
    errorType: "js",
    errorCategory: "js",
    errorName: "Error",
    errorMessage: "D7 synthetic",
    stackTopFrame: "[unavailable]",
    breadcrumb: { b0: "navigation" },
  },
  diagnostic: {
    diagnosticVersion: 1,
    contentType: "application/json",
    source: "explicit",
    policyVersion: "d0-1",
    status: "complete",
    correlation: {},
    omittedBytes: 0,
    suppressed: 0,
    raw: { message: "FI_D7_SYNTHETIC MYSQL_RECOVERY" },
  },
};
const send = () =>
  call("/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      schemaVersion: 3,
      sentAt: Date.now(),
      sdk: { name: "d7-fault", version: "0.8.0" },
      events: [event],
    }),
  });
const root = `/api/projects/${project.id}/diagnostics`;
let mysqlDown = false;
try {
  run(["stop", "mysql"]);
  mysqlDown = true;
  const failure = await send();
  assert(failure.status >= 500);
  assert(!(await failure.text()).includes("FI_D7_SYNTHETIC"));
  const unknown = await call(root + "/maintenance", { headers });
  assert(unknown.status >= 500);
  assert(!(await unknown.text()).includes("FI_D7_SYNTHETIC"));
  run(["up", "--detach", "--no-build", "--wait", "mysql"]);
  mysqlDown = false;
  assert.equal((await send()).status, 202);
  assert.equal((await send()).status, 202);
  let detail;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    detail = await (
      await call(root + `/instances/${event.eventId}`, { headers })
    ).json();
    if (detail.state === "ready") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(detail.state, "ready");
  assert.deepEqual(detail.diagnostic, event.diagnostic);
  const count = run([
    "exec",
    "-T",
    "clickhouse",
    "sh",
    "-c",
    'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database frontend_insight --query "$1"',
    "--",
    `SELECT count(),uniqExact(event_id) FROM raw_events WHERE project_id='${project.id}' AND event_id='${event.eventId}' FORMAT TabSeparated`,
  ])
    .toString()
    .trim();
  // Raw transport is append-only; separate accepted requests retain two copies.
  // Product facts must still count the one stable eventId exactly once.
  assert.equal(count, "2\t1");
  const occurrences = await (
    await call(
      `/api/projects/${project.id}/observability/occurrences?env=dev&range=7d&mode=all`,
      { headers },
    )
  ).json();
  assert.equal(occurrences.totalOccurrences, 1);
  const health = await call(root + "/maintenance", { headers });
  assert.equal(health.status, 200);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/d7-mysql-fault.json",
    JSON.stringify({
      testedCommit: process.env.GITHUB_SHA,
      actualDependencyStop: true,
      unknownNotZero: true,
      recovered: true,
      rawRoundtrip: true,
      rawTransportCopies: 2,
      baseUniqueFactCount: 1,
      productOccurrenceCount: occurrences.totalOccurrences,
      dedupLayer: "eventId in product fact queries",
      retryDeduplicated: true,
    }),
  );
} finally {
  if (mysqlDown) run(["up", "--detach", "--no-build", "--wait", "mysql"]);
}
