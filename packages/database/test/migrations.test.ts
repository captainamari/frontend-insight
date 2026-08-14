import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { discoverMigrations, splitClickHouseStatements } from "../src/migrations.js";

describe("database migration inventory", () => {
  it("has ordered, checksummed upgrade paths for both engines", async () => {
    for (const engine of ["mysql", "clickhouse"] as const) {
      const migrations = await discoverMigrations(engine);
      expect(migrations.map((migration) => migration.version)).toEqual(
        engine === "mysql" ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6, 7],
      );
      expect(migrations.every((migration) => migration.checksum.length === 64)).toBe(
        true,
      );
    }
  });

  it("creates all required metadata tables and no deferred datastore tables", async () => {
    const migrations = await discoverMigrations("mysql");
    const sql = migrations.map((migration) => migration.sql).join("\n");
    for (const table of [
      "users",
      "identities",
      "projects",
      "features",
      "project_origins",
      "project_members",
      "audit_logs",
      "auth_sessions",
      "project_data_status",
      "project_modules",
      "page_definitions",
      "project_operational_settings",
      "metric_profiles",
      "metric_profile_items",
      "metric_profile_assignments",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).not.toMatch(/CREATE TABLE[^;]*(redis|elasticsearch|errors)/i);
    expect(sql).toContain("disabled_at");
    expect(sql).toContain("global_role");
  });

  it("defines a 90-day monthly-partitioned MergeTree raw event table", async () => {
    const migration = (await discoverMigrations("clickhouse"))[0]!;
    expect(migration.sql).toContain("ENGINE = MergeTree");
    expect(migration.sql).toContain("PARTITION BY toYYYYMM(received_at)");
    expect(migration.sql).toContain("TTL received_at + INTERVAL 90 DAY DELETE");
    expect(migration.sql).toContain(
      "ORDER BY (project_id, toDate(received_at), event_name, route, event_time, event_id)",
    );
  });

  it("splits multi-statement ClickHouse migrations only at explicit markers", async () => {
    const migration = (await discoverMigrations("clickhouse"))[1]!;
    expect(splitClickHouseStatements(migration.sql)).toHaveLength(2);
  });

  it("adds SDK name through an upgrade-safe ClickHouse migration", async () => {
    const migration = (await discoverMigrations("clickhouse"))[2]!;
    expect(migration.name).toBe("sdk_name");
    expect(migration.sql).toContain("ADD COLUMN IF NOT EXISTS sdk_name");
    expect(migration.sql).toContain("DEFAULT 'unknown'");
  });

  it("adds operation identity without rewriting the raw event table", async () => {
    const migration = (await discoverMigrations("clickhouse"))[3]!;
    expect(migration.name).toBe("operation_instance");
    expect(migration.sql).toContain("operation_instance_id");
    expect(migration.sql).toContain("interaction_type");
  });

  it("adds nullable observability columns and fixed query indices", async () => {
    const migration = (await discoverMigrations("clickhouse"))[4]!;
    expect(migration.name).toBe("observability");
    expect(migration.sql).toContain("error_group_id");
    expect(migration.sql).toContain("vital_value");
    expect(migration.sql).toContain("release_version");
    expect(migration.sql).toContain("browser_family");
    expect(migration.sql).toContain("os_family");
    expect(splitClickHouseStatements(migration.sql)).toHaveLength(3);
  });

  it("keeps readiness and blank-screen sample rates independent", async () => {
    const migration = (await discoverMigrations("clickhouse"))[6]!;
    expect(migration.name).toBe("p1_readiness_sampling");
    expect(migration.sql).toContain("first_screen_sample_rate");
    expect(migration.sql).toContain("blank_detection_sample_rate");
  });

  it("keeps migration files readable from both source and compiled locations", async () => {
    await expect(
      readFile(
        new URL("../../../infra/mysql/migrations/001_foundation.sql", import.meta.url),
      ),
    ).resolves.toBeDefined();
  });
});
