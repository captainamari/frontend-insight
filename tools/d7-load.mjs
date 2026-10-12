// Synthetic isolated local Compose stack only. No target override or production credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { cpus, totalmem, platform, release, arch } from "node:os";
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
const run = (a) =>
  execFileSync("docker", [...compose, ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const sql = (q) =>
  run([
    "exec",
    "-T",
    "mysql",
    "sh",
    "-c",
    'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" frontend_insight -N -B -e "$1"',
    "--",
    q,
  ]);
const ch = (q) =>
  run([
    "exec",
    "-T",
    "clickhouse",
    "sh",
    "-c",
    'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database frontend_insight --query "$1"',
    "--",
    q,
  ]);
const p95 = (v) => {
  assert(v.length);
  const s = [...v].sort((a, b) => a - b);
  return s[Math.ceil(s.length * 0.95) - 1];
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let headers = { "content-type": "application/json" };
async function request(path, data) {
  const r = await fetch(base + path, {
    method: data === undefined ? "GET" : "POST",
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(30000),
  });
  assert(r.ok, `HTTP_${r.status}`);
  return r;
}
async function json(path, data) {
  return (await request(path, data)).json();
}
const auth = await json("/api/auth/login", {
  email: "admin@example.invalid",
  password: "LocalAdmin-1234",
});
headers = {
  authorization: `Bearer ${auth.accessToken}`,
  "content-type": "application/json",
};
const report = {
  testedCommit: process.env.GITHUB_SHA,
  method:
    "nearest rank; unique clients with one page lifetime per second, no disabled admission; all synthetic; samples exclude warmups",
  thresholds: { ingestionP95Ms: 100, visibilityP95Ms: 300000, queryP95Ms: 2000 },
  environment: {
    node: process.version,
    cpu: cpus().length,
    cpuModel: cpus()[0]?.model,
    os: { platform: platform(), release: release(), architecture: arch() },
    docker: execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
    }).trim(),
    compose: execFileSync("docker", ["compose", "version", "--short"], {
      encoding: "utf8",
    }).trim(),
    memoryBytes: totalmem(),
    containers: run(["ps", "--format", "json"]),
  },
  profiles: [],
};
report.environment.containerLimits = execFileSync(
  "docker",
  [
    "inspect",
    "--format",
    "{{.Name}}|{{.Config.Image}}|{{.Image}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}",
    ...run(["ps", "--quiet"]).split("\n"),
  ],
  { encoding: "utf8" },
).trim();
const failures = [];
let verificationError;
try {
  for (const kind of ["normal", "error"])
    for (const [eps, seconds] of [
      [20, 60],
      [200, 10],
    ]) {
      const project = await json("/api/projects", {
        name: `D7 ${kind} ${eps} ${randomUUID()}`,
        timezone: "UTC",
        origins: [origin],
      });
      const prefix = randomUUID().replaceAll("-", ""),
        startedAt = Date.now(),
        samples = [],
        sizes = [],
        ids = [];
      const event = (n) => {
        const key = prefix + "_" + n;
        const rawSize = [256, 2048, 16384, 60000][n % 4];
        const e = {
          eventId: "evt_" + key,
          event: kind === "error" ? "error" : "page_view",
          appId: project.appId,
          env: "dev",
          release: "d7-load-" + (Math.abs(n) % 10),
          timestamp: Date.now(),
          pageUrl: origin + "/d7-load",
          pageRoute: "/d7-load",
          userId: "synthetic_load",
          deptId: null,
          roleId: null,
          sessionId: "ses_" + prefix + "_" + (Math.abs(n) % (eps * 3)),
          deviceId: "dev_" + prefix + "_" + (Math.abs(n) % (eps * 3)),
          pageViewId: "pv_" + prefix + "_" + (Math.abs(n) % (eps * 3)),
          ua: "D7 synthetic",
          os: "Other",
          browser: "Other",
          payload:
            kind === "error"
              ? {
                  errorType: "js",
                  errorCategory: "js",
                  errorName: "TypeError",
                  errorMessage: "D7 synthetic",
                  stackTopFrame: "[unavailable]",
                  breadcrumb: { b0: "navigation" },
                }
              : {},
        };
        if (kind === "error")
          e.diagnostic = {
            diagnosticVersion: 1,
            contentType: "application/json",
            source: "explicit",
            policyVersion: "d0-1",
            status: "complete",
            correlation: {},
            omittedBytes: 0,
            suppressed: 0,
            raw: { message: "FI_D7_SYNTHETIC " + key, padding: "a".repeat(rawSize) },
          };
        sizes.push(Buffer.byteLength(JSON.stringify(e)));
        ids.push(e.eventId);
        return e;
      };
      const send = async (events) => {
        const start = performance.now();
        const r = await fetch(base + "/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            schemaVersion: 3,
            sentAt: Date.now(),
            sdk: { name: "d7-load", version: "0.8.0" },
            events,
          }),
          signal: AbortSignal.timeout(30000),
        });
        samples.push(performance.now() - start);
        assert.equal(r.status, 202);
        assert.equal((await r.json()).acceptedEvents, events.length);
      };
      // Three warm-up batches use separate pages and are excluded from measured count.
      for (let i = 0; i < 3; i++)
        await send([{ ...event(-i - 1), pageViewId: "pv_warm_" + prefix + "_" + i }]);
      samples.length = 0;
      sizes.length = 0;
      ids.length = 0;
      const begin = performance.now();
      let requests = 0;
      for (let second = 0; second < seconds; second++) {
        await wait(Math.max(0, begin + second * 1000 - performance.now()));
        const events = Array.from({ length: eps }, (_, i) => event(second * eps + i));
        let batch = [],
          bytes = 0;
        const sends = [];
        for (const e of events) {
          const size = Buffer.byteLength(JSON.stringify(e));
          if (batch.length && (bytes + size > 100000 || batch.length >= 50)) {
            sends.push(send(batch));
            requests++;
            batch = [];
            bytes = 0;
          }
          batch.push(e);
          bytes += size;
        }
        if (batch.length) {
          sends.push(send(batch));
          requests++;
        }
        await Promise.all(sends);
      }
      const completedMs = performance.now() - begin;
      await wait(Math.max(0, begin + seconds * 1000 - performance.now()));
      const scheduledMs = performance.now() - begin,
        expected = eps * seconds;
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        const count = Number(
          ch(
            `SELECT uniqExact(event_id) FROM raw_events WHERE project_id='${project.id}' AND event_id IN (${ids.map((id) => `'${id}'`).join(",")}) FORMAT TabSeparated`,
          ),
        );
        if (count >= expected) break;
        await wait(250);
      }
      // Exact ID set, excludes warmups, detects loss and duplicate base facts.
      const idsSql = ids.map((id) => `'${id}'`).join(",");
      const baseCounts = ch(
        `SELECT count(),uniqExact(event_id) FROM raw_events WHERE project_id='${project.id}' AND event_id IN (${idsSql}) FORMAT TabSeparated`,
      )
        .split("\t")
        .map(Number);
      assert.deepEqual(baseCounts, [expected, expected]);
      const rows =
        kind === "error"
          ? sql(
              `SELECT state,COUNT(*),MAX(TIMESTAMPDIFF(MICROSECOND,created_at,persisted_at)/1000) FROM diagnostic_receipts WHERE project_id='${project.id}' AND event_id IN (${idsSql}) GROUP BY state`,
            )
          : null;
      if (kind === "error") {
        assert.equal(rows.split("\t")[0], "ready");
        assert.equal(Number(rows.split("\t")[1]), expected);
      }
      const storage = JSON.parse(
        ch(
          `SELECT sum(length(JSONExtractRaw(envelope_json,'raw'))) AS logicalRawBytes,sum(length(envelope_json)) AS envelopeBytes,sum(length(envelope_json)-length(JSONExtractRaw(envelope_json,'raw'))) AS envelopeMetadataBytes,count() AS rows FROM diagnostic_details FINAL WHERE project_id='${project.id}' FORMAT JSONEachRow`,
        ) || "{}",
      );
      const receiptMetadataTextBytes = Number(
        sql(
          `SELECT COALESCE(SUM(OCTET_LENGTH(COALESCE(capture_metadata,''))+OCTET_LENGTH(input_digest)+OCTET_LENGTH(storage_digest)+OCTET_LENGTH(state)),0) FROM diagnostic_receipts WHERE project_id='${project.id}'`,
        ),
      );
      const storageLatencies =
        kind === "error"
          ? sql(
              `SELECT TIMESTAMPDIFF(MICROSECOND,created_at,persisted_at)/1000 FROM diagnostic_receipts WHERE project_id='${project.id}' AND event_id IN (${idsSql})`,
            )
              .split("\n")
              .map(Number)
          : [];
      const persistenceP95Ms = storageLatencies.length ? p95(storageLatencies) : null;
      const visibilityUpperBoundMs = Date.now() - startedAt;
      const timings = {};
      if (kind === "error") {
        const root = `/api/projects/${project.id}/diagnostics`,
          id = ids[0];
        for (const [name, path, data] of [
          ["detail", root + "/instances/" + id],
          ["export", root + "/instances/" + id + "/export", { format: "json" }],
          ["maintenance", root + "/maintenance"],
          [
            "search",
            root + "/search",
            {
              env: "dev",
              from: new Date(startedAt - 1000).toISOString(),
              to: new Date(Date.now() + 1000).toISOString(),
              term: "FI_D7_SYNTHETIC " + prefix + "_0",
              field: "raw",
              category: "all",
              release: "d7-load-0",
            },
          ],
        ]) {
          const durations = [];
          for (let i = 0; i < 23; i++) {
            const t = performance.now();
            await (await request(path, data)).arrayBuffer();
            if (i >= 3) durations.push(performance.now() - t);
          }
          timings[name] = { samples: 20, warmups: 3, p95Ms: p95(durations) };
        }
      }
      const measurement = {
        kind,
        targetEventsPerSecond: eps,
        seconds,
        clientCount: eps * 3,
        maxEventsPerClientPerMinute: Math.ceil(seconds / 3),
        eventSizeDistributionBytes: [256, 2048, 16384, 60000],
        actualMeanEventBytes: sizes.reduce((a, b) => a + b, 0) / sizes.length,
        sent: expected,
        accepted: expected,
        rejectedEvents: 0,
        diagnosticSuppressed: kind === "error" ? 0 : null,
        persisted: baseCounts[1],
        requests,
        requestsPerSecond: (requests * 1000) / scheduledMs,
        achievedEventsPerSecond: (expected * 1000) / scheduledMs,
        completedMs,
        scheduledMs,
        ingestionP95Ms: p95(samples),
        ingestionSamples: samples.length,
        visibilityUpperBoundMs,
        receiptStates: rows,
        persistenceP95Ms,
        persistenceSamples: storageLatencies.length,
        storage,
        receiptMetadataTextBytes,
        capacityMethod:
          "raw=serialized raw JSON; envelope metadata=remaining JSON bytes; receipt text excludes fixed columns/indexes; isolated project includes 3 warmup events; none is physical per-project disk",
        timings,
      };
      report.profiles.push(measurement);
      if (completedMs > seconds * 1000)
        failures.push(`${kind}_${eps}_load_generator_missed_rate`);
      if (measurement.ingestionP95Ms > 100)
        failures.push(`${kind}_${eps}_ingestion_p95`);
      if (persistenceP95Ms !== null && persistenceP95Ms > 300000)
        failures.push(`${kind}_${eps}_persistence_p95`);
      if (visibilityUpperBoundMs > 300000) failures.push(`${kind}_${eps}_visibility`);
      for (const [name, m] of Object.entries(timings))
        if (m.p95Ms > 2000) failures.push(`${kind}_${eps}_${name}_p95`);
    }
  const proof = JSON.parse(readFileSync("artifacts/d5-chromium.json", "utf8"));
  const mapSamples = [];
  for (let i = 0; i < 23; i++) {
    const start = performance.now();
    const d = await json(
      `/api/projects/${proof.projectId}/diagnostics/instances/${proof.eventId}`,
    );
    assert(d.sourceMapping.frames.some((f) => f.state === "mapped"));
    if (i >= 3) mapSamples.push(performance.now() - start);
  }
  report.sourceMapping = {
    samples: 20,
    warmups: 3,
    p95Ms: p95(mapSamples),
    method: "authorized detail including actual worker mapping",
  };
  if (report.sourceMapping.p95Ms > 2000) failures.push("source_mapping_p95");
  report.sharedPhysicalStorage = {
    scope: "all projects on isolated shared disk; not exact per-project usage",
    activeParts: ch(
      "SELECT table,sum(bytes_on_disk) AS bytes FROM system.parts WHERE database='frontend_insight' AND active GROUP BY table FORMAT JSONEachRow",
    ),
    unfinishedMutations: ch(
      "SELECT table,sum(parts_to_do) AS parts FROM system.mutations WHERE database='frontend_insight' AND is_done=0 GROUP BY table FORMAT JSONEachRow",
    ),
    sourceMapAllocatedKiB: run([
      "exec",
      "-T",
      "api",
      "du",
      "-sk",
      "/var/lib/frontend-insight/sourcemaps",
    ]).split(/\s/)[0],
  };
  report.capacityAssumptions = {
    retentionDays: 14,
    compressionRatio: null,
    backupCopiesExcluded: true,
    projection:
      "logical envelope bytes per received event × accepted events/s × 86400 × retentionDays; physical overhead/compression/replication and pending cleanup separately measured; no production capacity guarantee",
  };
} catch (error) {
  verificationError = error;
  failures.push("verification_exception");
  report.failure = { name: error.name, exitStatus: error.status ?? null };
}
report.failures = failures;
report.status = failures.length ? "failed" : "passed";
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/d7-load.json", JSON.stringify(report, null, 2));
if (verificationError) throw verificationError;
assert.equal(failures.length, 0, "D7 load gate failed; retained numeric evidence");
