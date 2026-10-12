// Only the disposable frontend-insight-m5 stack. Never takes production targets.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
const run = (args, input) =>
  execFileSync("docker", [...compose, ...args], {
    input,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
const sql = (query) =>
  run([
    "exec",
    "-T",
    "mysql",
    "sh",
    "-c",
    'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" frontend_insight -N -B -e "$1"',
    "--",
    query,
  ])
    .toString()
    .trim();
const ch = (query, input) =>
  run(
    [
      "exec",
      "-T",
      "clickhouse",
      "sh",
      "-c",
      'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database frontend_insight --query "$1"',
      "--",
      query,
    ],
    input,
  );
const dir = mkdtempSync(join(tmpdir(), "fi-d5-"));
const archive = (command) =>
  execFileSync(
    "bash",
    [
      "-c",
      `set -euo pipefail; compose() { docker compose --project-name frontend-insight-m5 --env-file .env.m5 --file infra/compose/m2-m4.compose.yml --file infra/compose/m5.compose.yml "$@"; }; source scripts/lib/sourcemap-backup.sh; sourcemap_${command} "$1"`,
      "--",
      dir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
let phase = "setup";
async function main() {
  const proof = JSON.parse(readFileSync("artifacts/d5-chromium.json", "utf8"));
  const root = `http://127.0.0.1:3000/api/projects/${proof.projectId}`;
  const auth = await (
    await fetch("http://127.0.0.1:3000/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.invalid",
        password: "LocalAdmin-1234",
      }),
    })
  ).json();
  const headers = {
    authorization: `Bearer ${auth.accessToken}`,
    "content-type": "application/json",
  };
  const detail = async () => {
    const r = await fetch(root + `/diagnostics/instances/${proof.eventId}`, {
      headers,
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  const mapped = async () => {
    const d = await detail();
    assert(
      d.sourceMapping.frames.some(
        (f) =>
          f.original?.line === 4 &&
          f.original?.column === 9 &&
          f.snippet?.some((l) => l.text.includes("throw new TypeError(label)")),
      ),
      "FIXED_SOURCE_RESTORED",
    );
    return d;
  };
  await mapped();
  phase = "restart";
  run(["restart", "api"]);
  run(["up", "--detach", "--no-build", "--wait", "api"]);
  await mapped();
  // Coherent snapshot after completed browser receipts: stop writers; save MySQL,
  // source files, raw facts and original diagnostic envelopes, including grants/revocations.
  run(["stop", "api", "consumer"]);
  phase = "backup";
  const mysql = run([
    "exec",
    "-T",
    "mysql",
    "sh",
    "-c",
    'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --add-drop-database --databases frontend_insight --skip-comments --set-gtid-purged=OFF',
  ]);
  const tables = ["raw_events", "diagnostic_details", "repeated_operation_proofs"];
  const snapshots = Object.fromEntries(
    tables.map((t) => [
      t,
      ch(
        `SELECT * FROM ${t}${t === "diagnostic_details" ? " FINAL" : ""} FORMAT Native`,
      ),
    ]),
  );
  archive("backup");
  phase = "destructive-proof";
  // Destructively remove file + metadata + raw detail, prove restore is necessary.
  run([
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "--entrypoint",
    "sh",
    "api",
    "-c",
    "find /var/lib/frontend-insight/sourcemaps -type f -delete",
  ]);
  sql("DELETE FROM diagnostic_sourcemaps");
  sql("DELETE FROM diagnostic_upload_credentials");
  sql("DELETE FROM diagnostic_grants");
  ch("TRUNCATE TABLE diagnostic_details");
  run(["up", "--detach", "--no-build", "--wait", "api"]);
  assert.equal((await detail()).state, "unavailable");
  run(["stop", "api"]);
  run(
    ["exec", "-T", "mysql", "sh", "-c", 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'],
    mysql,
  );
  for (const t of tables) {
    ch(`TRUNCATE TABLE ${t}`);
    ch(`INSERT INTO ${t} FORMAT Native`, snapshots[t]);
  }
  archive("restore");
  run(["up", "--detach", "--no-build", "--wait", "api", "consumer"]);
  await mapped();
  assert.equal(
    sql(
      `SELECT revoked FROM diagnostic_upload_credentials WHERE id='${proof.revokedCredentialId}'`,
    ),
    "1",
  );
  assert.equal(
    sql(
      `SELECT COUNT(*) FROM project_members WHERE project_id='${proof.projectId}' AND user_id='${proof.removedMemberId}'`,
    ),
    "0",
  );
  const viewer = await (
    await fetch("http://127.0.0.1:3000/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "viewer@example.invalid",
        password: "LocalViewer-1234",
      }),
    })
  ).json();
  assert.equal(
    (
      await fetch(root + `/diagnostics/instances/${proof.eventId}`, {
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      })
    ).status,
    403,
  );
  phase = "missing-corrupt";
  const file = "/var/lib/frontend-insight/sourcemaps/" + proof.artifactId + ".map";
  const saved = run(["exec", "-T", "api", "cat", file]);
  run(["exec", "-T", "api", "rm", file]);
  assert.equal((await detail()).sourceMapping.frames[0].state, "storage_missing");
  run(
    ["exec", "-T", "api", "sh", "-c", 'cat > "$1"', "--", file],
    Buffer.from("corrupt"),
  );
  assert.equal((await detail()).sourceMapping.frames[0].state, "storage_corrupt");
  run(["exec", "-T", "api", "sh", "-c", 'cat > "$1"', "--", file], saved);
  await mapped();
  phase = "failed-write-recovery";
  const issued = await (
    await fetch(root + "/diagnostics/sourcemaps/credentials", {
      method: "POST",
      headers,
      body: '{"days":1}',
    })
  ).json();
  const manifest = JSON.parse(readFileSync("artifacts/d5-build/manifest.json", "utf8"));
  const compiled = readFileSync("artifacts/d5-build/fixture.js");
  const digestBytes = (b) => createHash("sha256").update(b).digest("hex");
  const uploadBody = {
    release: manifest.release,
    build: "failed-write",
    asset: "http://127.0.0.1:4174/d5/fixture.js",
    assetSha256: digestBytes(compiled),
    mapSha256: digestBytes(saved),
    javascript: compiled.toString("base64"),
    map: saved.toString("base64"),
    retentionDays: 1,
  };
  const send = () =>
    fetch(root + "/diagnostics/sourcemaps/upload", {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${issued.token}` },
      body: JSON.stringify(uploadBody),
    });
  sql(
    "CREATE TRIGGER d5_fail_map BEFORE INSERT ON diagnostic_sourcemaps FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5_SYNTHETIC_WRITE_FAILURE'",
  );
  try {
    assert.equal((await send()).status, 503);
  } finally {
    sql("DROP TRIGGER d5_fail_map");
  }
  const failedId = digestBytes(
    JSON.stringify([
      proof.projectId,
      manifest.release,
      "failed-write",
      uploadBody.asset,
    ]),
  );
  assert.equal(
    sql(`SELECT COUNT(*) FROM diagnostic_sourcemaps WHERE id='${failedId}'`),
    "0",
  );
  assert.equal(
    run([
      "exec",
      "-T",
      "api",
      "sh",
      "-c",
      'test ! -f "$1" && printf removed',
      "--",
      "/var/lib/frontend-insight/sourcemaps/" + failedId + ".map",
    ]).toString(),
    "removed",
  );
  assert.equal((await send()).status, 201);
  phase = "project-capacity";
  const retainedBytes = sql(
    `SELECT byte_size FROM diagnostic_sourcemaps WHERE id='${failedId}'`,
  );
  sql(`UPDATE diagnostic_sourcemaps SET byte_size=104857600 WHERE id='${failedId}'`);
  uploadBody.build = "over-project-budget";
  try {
    const rejected = await send();
    assert.equal(rejected.status, 422);
    assert((await rejected.text()).includes("SOURCEMAP_PROJECT_BUDGET"));
  } finally {
    sql(
      `UPDATE diagnostic_sourcemaps SET byte_size=${Number(retainedBytes)} WHERE id='${failedId}'`,
    );
  }
  // Simulate interrupted .tmp and pre-transaction crash orphans; real cleaner reclaims both.
  const orphan = "0".repeat(64) + ".map",
    temporary = "1".repeat(64) + ".map.11111111-1111-4111-8111-111111111111.tmp";
  run([
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    `import {writeFile,utimes} from 'node:fs/promises'; for(const name of process.argv.slice(1)){const path='/var/lib/frontend-insight/sourcemaps/'+name;await writeFile(path,'synthetic interrupted write');await utimes(path,new Date(0),new Date(0));}`,
    orphan,
    temporary,
  ]);
  phase = "credential-expiry";
  const cred = await (
    await fetch(root + "/diagnostics/sourcemaps/credentials", {
      method: "POST",
      headers,
      body: '{"days":1}',
    })
  ).json();
  sql(
    `UPDATE diagnostic_upload_credentials SET expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id='${cred.id}'`,
  );
  assert.equal(
    (
      await fetch(root + "/diagnostics/sourcemaps/upload", {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${cred.token}` },
        body: "{}",
      })
    ).status,
    403,
  );
  phase = "retention-cleanup";
  sql(
    `UPDATE diagnostic_sourcemaps SET expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id='${proof.artifactId}'`,
  );
  assert.equal((await detail()).sourceMapping.frames[0].state, "expired");
  run([
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    `import {MySqlStore,RuntimeDiagnostics,SourceMaps} from './packages/server-core/dist/src/index.js';const db=new MySqlStore(process.env.MYSQL_URL);try{await new SourceMaps(db,new RuntimeDiagnostics(db)).cleanup();}finally{await db.close();}`,
  ]);
  assert.equal(
    sql(`SELECT state FROM diagnostic_sourcemaps WHERE id='${proof.artifactId}'`),
    "expired",
  );
  assert.equal(
    run([
      "exec",
      "-T",
      "api",
      "sh",
      "-c",
      'test ! -f "$1" && printf removed',
      "--",
      file,
    ]).toString(),
    "removed",
  );
  phase = "final-restore";
  for (const name of [orphan, temporary])
    assert.equal(
      run([
        "exec",
        "-T",
        "api",
        "sh",
        "-c",
        'test ! -f "$1" && printf removed',
        "--",
        "/var/lib/frontend-insight/sourcemaps/" + name,
      ]).toString(),
      "removed",
    );
  // Restore the consistent snapshot a second time, including credential revocation.
  run(["stop", "api", "consumer"]);
  run(
    ["exec", "-T", "mysql", "sh", "-c", 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'],
    mysql,
  );
  archive("restore");
  run(["up", "--detach", "--no-build", "--wait", "api", "consumer"]);
  await mapped();
  const digest = createHash("sha256").update(saved).digest("hex");
  assert.equal(digest, proof.mapSha256);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/d5-storage.json",
    JSON.stringify({
      testedCommit: process.env.GITHUB_SHA,
      restart: true,
      actualBackupRestore: true,
      mysqlAndPermissions: true,
      rawEnvelopes: true,
      privateFiles: true,
      missingAndCorrupt: true,
      metadataWriteFailureRecovery: true,
      interruptedOrphanCleanup: true,
      expiry: true,
      projectCapacity: true,
      credentialExpiry: true,
      mapSha256: digest,
    }),
  );
  console.log("D5_STORAGE_RESTORE_PASSED");
}
main()
  .catch((error) => {
    console.error(
      `D5_STORAGE_RESTORE_FAILED phase=${phase} type=${error.name} code=${error.code ?? error.status ?? "unknown"} (isolated stack only)`,
    );
    process.exitCode = 1;
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }));
