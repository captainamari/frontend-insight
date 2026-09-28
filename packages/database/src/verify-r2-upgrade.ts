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
  const module = "99999999-9999-4999-8999-999999999994",
    workflow = "99999999-9999-4999-8999-999999999995",
    workflowVersion = "99999999-9999-4999-8999-999999999996";
  await pool.execute(
    "INSERT INTO modules (id,project_id,module_key,name,status) VALUES (?,?,'upgrade_workflow','Preserved workflow','active')",
    [module, project],
  );
  await pool.execute(
    "INSERT INTO workflow_definitions (id,project_id,module_id,workflow_key,name,status) VALUES (?,?,?,'upgrade_workflow','Preserved workflow','active')",
    [workflow, project, module],
  );
  await pool.execute(
    "INSERT INTO workflow_definition_versions (id,workflow_definition_id,version,module_id,name,start_policy,terminal_policy,timeout_seconds,status,activated_at) VALUES (?,?,1,?,'Preserved workflow','explicit_sdk',?,30,'active','2026-08-01 00:00:00')",
    [
      workflowVersion,
      workflow,
      module,
      JSON.stringify({
        completedStepKey: "done",
        failedStepKey: null,
        canceledStepKey: null,
        timeoutState: "approximate_abandoned",
      }),
    ],
  );
  const snapshot = async () => {
    const [p] = await pool.query<RowDataPacket[]>("SELECT * FROM projects");
    const [v] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM metric_library_versions",
    );
    const [m] = await pool.query<RowDataPacket[]>(
      "SELECT version,checksum FROM schema_migrations WHERE version<=2 ORDER BY version",
    );
    const [w] = await pool.query("SELECT * FROM workflow_definitions");
    const [wv] = await pool.query("SELECT * FROM workflow_definition_versions");
    return JSON.stringify({ p, v, m, w, wv });
  };
  const before = await snapshot();
  const upgrade = await runMySqlMigrations({ mysqlUrl });
  assert.deepEqual(upgrade.applied, [3, 4]);
  assert.equal(await snapshot(), before);
  assert.deepEqual((await runMySqlMigrations({ mysqlUrl })).applied, []);
  const [tables] = await pool.query<RowDataPacket[]>(
    "SHOW TABLES LIKE 'project_creation_requests'",
  );
  assert.equal(tables.length, 1);
  const [admissions] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM workflow_admission_periods WHERE workflow_definition_version_id=?",
    [workflowVersion],
  );
  assert.equal(admissions.length, 1);
  assert(
    new Date(admissions[0]!.effective_from).valueOf() >
      Date.parse("2026-08-01T00:00:00Z"),
  );
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
