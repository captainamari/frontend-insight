import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { discoverMigrations, splitClickHouseStatements } from "../src/migrations.js";

describe("v1.8 empty-database migration inventory", () => {
  it("has one checksummed baseline for each engine", async () => {
    for (const engine of ["mysql", "clickhouse"] as const) {
      const migrations = await discoverMigrations(engine);
      expect(migrations.map((migration) => migration.version)).toEqual([1]);
      expect(migrations[0]?.name).toBe("v18_baseline");
      expect(migrations[0]?.checksum).toHaveLength(64);
    }
  });

  it("creates the target MySQL metadata and version snapshot tables", async () => {
    const migration = (await discoverMigrations("mysql"))[0]!;
    for (const table of [
      "users",
      "identities",
      "projects",
      "modules",
      "page_definitions",
      "workflow_definitions",
      "workflow_definition_versions",
      "workflow_steps",
      "metric_library_versions",
      "metric_definitions",
      "metric_display_bindings",
      "score_definitions",
      "score_dimensions",
      "score_items",
      "probe_policies",
      "export_interfaces",
      "export_credentials",
      "audit_logs",
      "project_data_status",
      "auth_sessions",
    ]) {
      expect(migration.sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration.sql).toContain("app_id");
    expect(migration.sql).not.toContain("ALTER TABLE");
  });

  it("defines the canonical, 90-day ClickHouse raw facts table", async () => {
    const migration = (await discoverMigrations("clickhouse"))[0]!;
    expect(migration.sql).toContain("ENGINE = MergeTree");
    expect(migration.sql).toContain("PARTITION BY toYYYYMM(received_at)");
    expect(migration.sql).toContain("TTL received_at + INTERVAL 90 DAY DELETE");
    expect(migration.sql).toContain(
      "ORDER BY (app_id, env, toDate(received_at), event, page_route, timestamp, event_id)",
    );
    for (const column of [
      "app_id",
      "env",
      "release",
      "page_url",
      "page_route",
      "user_id",
      "dept_id",
      "role_id",
      "device_id",
      "payload_json",
      "workflow_instance_id",
      "error_category",
    ]) {
      expect(migration.sql).toContain(column);
    }
    expect(splitClickHouseStatements(migration.sql)).toHaveLength(1);
    expect(migration.sql).not.toContain("ALTER TABLE");
  });

  it("keeps migration files readable from source and compiled locations", async () => {
    await expect(
      readFile(
        new URL(
          "../../../infra/mysql/migrations/001_v18_baseline.sql",
          import.meta.url,
        ),
      ),
    ).resolves.toBeDefined();
  });
});
