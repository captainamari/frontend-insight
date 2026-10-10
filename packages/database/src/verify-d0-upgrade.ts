import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  createMySqlPool,
  runMySqlMigrations,
  runClickHouseMigrations,
  createClickHouseClient,
} from "./migrations.js";
const mysqlUrl = process.env.MYSQL_UPGRADE_URL;
if (!mysqlUrl || !new URL(mysqlUrl).pathname.endsWith("_r2_upgrade"))
  throw new Error("DEDICATED_UPGRADE_DATABASE_REQUIRED");
const pool = createMySqlPool(mysqlUrl);
const opts = {
  url: process.env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
  username: process.env.CLICKHOUSE_USERNAME ?? "frontend_insight",
  password: process.env.CLICKHOUSE_PASSWORD ?? "m24-clickhouse-local-only",
  database: "frontend_insight_d0_upgrade",
};
const admin = createClickHouseClient({ ...opts, database: "frontend_insight" });
await admin.command({ query: "CREATE DATABASE frontend_insight_d0_upgrade" });
const ch = createClickHouseClient(opts);
try {
  assert.deepEqual(
    (await runMySqlMigrations({ mysqlUrl, upToVersion: 7 })).applied,
    [1, 2, 3, 4, 5, 6, 7],
  );
  const user = "99999999-9999-4999-8999-999999999991",
    project = "99999999-9999-4999-8999-999999999992";
  await pool.execute(
    "INSERT INTO users(id,display_name,global_role) VALUES(?,'D0 sentinel','admin')",
    [user],
  );
  await pool.execute(
    "INSERT INTO projects(id,app_id,name,timezone,created_by_user_id) VALUES(?,'d0_upgrade_sentinel','D0 sentinel','UTC',?)",
    [project, user],
  );
  const before = JSON.stringify((await pool.query("SELECT * FROM projects"))[0]);
  const oldChecksums = JSON.stringify(
    (
      await pool.query(
        "SELECT version,checksum FROM schema_migrations ORDER BY version",
      )
    )[0],
  );
  assert.deepEqual((await runMySqlMigrations({ mysqlUrl })).applied, [8, 9]);
  assert.equal(JSON.stringify((await pool.query("SELECT * FROM projects"))[0]), before);
  assert.equal(
    JSON.stringify(
      (
        await pool.query(
          "SELECT version,checksum FROM schema_migrations WHERE version<=7 ORDER BY version",
        )
      )[0],
    ),
    oldChecksums,
  );
  assert.deepEqual((await runMySqlMigrations({ mysqlUrl })).applied, []);
  await runClickHouseMigrations({ ...opts, upToVersion: 4 });
  // Old facts retain all columns and values; D0 only adds a separate table.
  await ch.command({
    query:
      "INSERT INTO raw_events(event_id,project_id,request_id,event,app_id,timestamp,received_at) SELECT 'evt_d0_sentinel','99999999-9999-4999-8999-999999999992','99999999-9999-4999-8999-999999999993','error','d0_upgrade_sentinel',now64(3),now64(3)",
  });
  const snapshot = async () => {
    const r = await ch.query({
      query: "SELECT * FROM raw_events",
      format: "JSONEachRow",
    });
    return r.text();
  };
  const beforeCh = await snapshot();
  assert(beforeCh.includes("evt_d0_sentinel"));
  assert.deepEqual((await runClickHouseMigrations(opts)).applied, [5]);
  assert.equal(await snapshot(), beforeCh);
  assert.deepEqual((await runClickHouseMigrations(opts)).applied, []);
  const evidence = {
    testedCommit: process.env.GITHUB_SHA,
    mysql: "7→8→9",
    clickhouse: "4→5",
    existingData: "preserved",
    checksums: "unchanged",
    repeat: "idempotent",
  };
  const dir = process.env.FI_EVIDENCE_DIR ?? "artifacts";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/d0-upgrade.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await Promise.all([pool.end(), ch.close(), admin.close()]);
}
