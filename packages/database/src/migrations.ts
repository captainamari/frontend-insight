import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";

export type MigrationEngine = "mysql" | "clickhouse";

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  checksum: string;
  sql: string;
}

export interface MigrationRunResult {
  engine: MigrationEngine;
  applied: number[];
  alreadyApplied: number[];
}

export interface MySqlMigrationOptions {
  mysqlUrl: string;
  upToVersion?: number;
}

export interface ClickHouseMigrationOptions {
  url: string;
  username: string;
  password: string;
  database: string;
  upToVersion?: number;
}

const migrationName = /^(\d{3})_([a-z0-9_]+)\.sql$/;

function migrationsDirectory(engine: MigrationEngine): string {
  return fileURLToPath(
    new URL(`../../../infra/${engine}/migrations/`, import.meta.url),
  );
}

export async function discoverMigrations(
  engine: MigrationEngine,
): Promise<MigrationFile[]> {
  const directory = migrationsDirectory(engine);
  const filenames = (await readdir(directory)).filter((filename) =>
    migrationName.test(filename),
  );
  const migrations = await Promise.all(
    filenames.map(async (filename) => {
      const match = migrationName.exec(filename);
      if (!match) throw new Error(`invalid migration filename: ${filename}`);
      const sql = await readFile(`${directory}/${filename}`, "utf8");
      return {
        version: Number(match[1]),
        name: match[2]!,
        filename,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }),
  );
  migrations.sort((left, right) => left.version - right.version);

  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`${engine} has duplicate migration ${migration.version}`);
    }
    versions.add(migration.version);
  }
  return migrations;
}

export function splitClickHouseStatements(sql: string): string[] {
  return sql
    .split(/^\s*-- statement-breakpoint\s*$/mu)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function createMySqlPool(mysqlUrl: string): Pool {
  const url = new URL(mysqlUrl);
  if (url.protocol !== "mysql:") throw new Error("MYSQL_URL must use mysql://");
  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new Error("MYSQL_URL must include a database name");

  return mysql.createPool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    multipleStatements: true,
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 16,
    timezone: "Z",
  });
}

interface MySqlMigrationRow extends RowDataPacket {
  version: number;
  checksum: string;
}

export async function runMySqlMigrations(
  options: MySqlMigrationOptions,
): Promise<MigrationRunResult> {
  const pool = createMySqlPool(options.mysqlUrl);
  let lockAcquired = false;
  try {
    const [lockRows] = await pool.query<RowDataPacket[]>(
      "SELECT GET_LOCK('frontend_insight_schema_migrations', 30) AS acquired",
    );
    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) throw new Error("could not acquire MySQL migration lock");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT UNSIGNED PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        execution_ms INT UNSIGNED NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    const [rows] = await pool.query<MySqlMigrationRow[]>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    const existing = new Map(rows.map((row) => [row.version, row.checksum]));
    const migrations = (await discoverMigrations("mysql")).filter(
      (migration) =>
        options.upToVersion === undefined || migration.version <= options.upToVersion,
    );
    const result: MigrationRunResult = {
      engine: "mysql",
      applied: [],
      alreadyApplied: [],
    };

    for (const migration of migrations) {
      const existingChecksum = existing.get(migration.version);
      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `MySQL migration ${migration.filename} checksum changed after apply`,
          );
        }
        result.alreadyApplied.push(migration.version);
        continue;
      }

      const startedAt = performance.now();
      await pool.query(migration.sql);
      const executionMs = Math.max(0, Math.round(performance.now() - startedAt));
      await pool.execute(
        "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (?, ?, ?, ?)",
        [migration.version, migration.name, migration.checksum, executionMs],
      );
      result.applied.push(migration.version);
    }
    return result;
  } finally {
    if (lockAcquired) {
      await pool.query("SELECT RELEASE_LOCK('frontend_insight_schema_migrations')");
    }
    await pool.end();
  }
}

interface ClickHouseMigrationRow {
  version: number;
  checksum: string;
}

export function createClickHouseClient(
  options: Omit<ClickHouseMigrationOptions, "upToVersion">,
): ClickHouseClient {
  return createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    clickhouse_settings: { date_time_input_format: "best_effort" },
  });
}

export async function runClickHouseMigrations(
  options: ClickHouseMigrationOptions,
): Promise<MigrationRunResult> {
  const client = createClickHouseClient(options);
  try {
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version UInt32,
          name String,
          checksum FixedString(64),
          applied_at DateTime64(3, 'UTC'),
          execution_ms UInt32
        ) ENGINE = MergeTree
        ORDER BY version
      `,
    });
    const response = await client.query({
      query: "SELECT version, checksum FROM schema_migrations ORDER BY version",
      format: "JSONEachRow",
    });
    const rows = await response.json<ClickHouseMigrationRow>();
    const existing = new Map(
      rows.map((row) => [Number(row.version), String(row.checksum)]),
    );
    const migrations = (await discoverMigrations("clickhouse")).filter(
      (migration) =>
        options.upToVersion === undefined || migration.version <= options.upToVersion,
    );
    const result: MigrationRunResult = {
      engine: "clickhouse",
      applied: [],
      alreadyApplied: [],
    };

    for (const migration of migrations) {
      const existingChecksum = existing.get(migration.version);
      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `ClickHouse migration ${migration.filename} checksum changed after apply`,
          );
        }
        result.alreadyApplied.push(migration.version);
        continue;
      }

      const startedAt = performance.now();
      for (const statement of splitClickHouseStatements(migration.sql)) {
        await client.command({ query: statement });
      }
      const executionMs = Math.max(0, Math.round(performance.now() - startedAt));
      await client.insert({
        table: "schema_migrations",
        values: [
          {
            version: migration.version,
            name: migration.name,
            checksum: migration.checksum,
            applied_at: new Date().toISOString(),
            execution_ms: executionMs,
          },
        ],
        format: "JSONEachRow",
      });
      result.applied.push(migration.version);
    }
    return result;
  } finally {
    await client.close();
  }
}
