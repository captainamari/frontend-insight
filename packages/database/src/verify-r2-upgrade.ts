import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createMySqlPool, runMySqlMigrations } from "./migrations.js";
import type { RowDataPacket } from "mysql2/promise";
const mysqlUrl = process.env.MYSQL_UPGRADE_URL;
if (!mysqlUrl || !new URL(mysqlUrl).pathname.endsWith("_r2_upgrade"))
  throw new Error("DEDICATED_UPGRADE_DATABASE_REQUIRED");
const pool = createMySqlPool(mysqlUrl);
try {
  const initial = await runMySqlMigrations({ mysqlUrl, upToVersion: 2 });
  assert.deepEqual(
    initial.applied,
    [1, 2],
    "dedicated upgrade database must be empty for this proof",
  );
  const user = "99999999-9999-4999-8999-999999999991",
    project = "99999999-9999-4999-8999-999999999992",
    version = "99999999-9999-4999-8999-999999999993";
  await pool.execute(
    "INSERT INTO users (id,display_name,global_role) VALUES (?,'Upgrade owner','admin')",
    [user],
  );
  await pool.execute(
    "INSERT INTO projects (id,app_id,name,timezone,created_by_user_id) VALUES (?,'r2_upgrade_sentinel','保留已有数据','Asia/Shanghai',?)",
    [project, user],
  );
  await pool.execute(
    "INSERT INTO metric_library_versions (id,project_id,library_type,version,status,manifest_version,created_by_user_id) VALUES (?,?,'quality',1,'draft','1.8.0',?)",
    [version, project, user],
  );
  const snapshot = async () => {
    const [p] = await pool.query<RowDataPacket[]>("SELECT * FROM projects");
    const [v] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM metric_library_versions",
    );
    const [m] = await pool.query<RowDataPacket[]>(
      "SELECT version,checksum FROM schema_migrations WHERE version<=2 ORDER BY version",
    );
    return JSON.stringify({ p, v, m });
  };
  const before = await snapshot();
  const upgrade = await runMySqlMigrations({ mysqlUrl });
  assert.deepEqual(upgrade.applied, [3]);
  assert.equal(await snapshot(), before);
  assert.deepEqual((await runMySqlMigrations({ mysqlUrl })).applied, []);
  const [tables] = await pool.query<RowDataPacket[]>(
    "SHOW TABLES LIKE 'project_creation_requests'",
  );
  assert.equal(tables.length, 1);
  const evidence = {
    testedCommit: process.env.GITHUB_SHA,
    engine: "MySQL",
    baseline: initial.applied,
    upgrade: upgrade.applied,
    existingProjectAndVersion: "byte-for-byte preserved",
    baselineChecksums: "unchanged",
    repeat: "idempotent",
  };
  const dir = process.env.FI_EVIDENCE_DIR ?? "artifacts";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/r2-upgrade.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await pool.end();
}
