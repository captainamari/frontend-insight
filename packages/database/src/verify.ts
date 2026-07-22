import { createHmac, randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { loadMigrationEnvironment } from "@frontend-insight/shared-config";
import { contractScenarios } from "@frontend-insight/test-fixtures";
import type { RowDataPacket } from "mysql2/promise";
import {
  createMySqlPool,
  runClickHouseMigrations,
  runMySqlMigrations,
} from "./migrations.js";

const environment = loadMigrationEnvironment();
const projectId = "11111111-1111-4111-8111-111111111111";
const userId = "55555555-5555-4555-8555-555555555555";
const featureIds = {
  sales_dashboard: "22222222-2222-4222-8222-222222222222",
  report_export: "33333333-3333-4333-8333-333333333333",
  operations_wallboard: "44444444-4444-4444-8444-444444444444",
} as const;

function resolveFeatureId(featureKey: string | undefined): string | null {
  if (featureKey === undefined) return null;
  if (!(featureKey in featureIds)) {
    throw new Error(`fixture references unknown featureKey: ${featureKey}`);
  }
  return featureIds[featureKey as keyof typeof featureIds];
}
const expectedTables = [
  "audit_logs",
  "features",
  "identities",
  "project_members",
  "project_origins",
  "projects",
  "schema_migrations",
  "users",
];

interface StepResult {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  details?: unknown;
  error?: string;
}

const results: StepResult[] = [];

async function step<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const details = await operation();
    results.push({
      name,
      status: "passed",
      durationMs: Math.round(performance.now() - startedAt),
      details,
    });
    return details;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    results.push({
      name,
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      error: message,
    });
    throw cause;
  }
}

async function verifyUpgradeAndIdempotency() {
  const clickhouseOptions = {
    url: environment.CLICKHOUSE_URL,
    username: environment.CLICKHOUSE_USERNAME,
    password: environment.CLICKHOUSE_PASSWORD,
    database: environment.CLICKHOUSE_DATABASE,
  };
  const mysqlV1 = await runMySqlMigrations({
    mysqlUrl: environment.MYSQL_URL,
    upToVersion: 1,
  });
  const clickhouseV1 = await runClickHouseMigrations({
    ...clickhouseOptions,
    upToVersion: 1,
  });
  const mysqlUpgrade = await runMySqlMigrations({
    mysqlUrl: environment.MYSQL_URL,
  });
  const clickhouseUpgrade = await runClickHouseMigrations(clickhouseOptions);
  const mysqlRepeat = await runMySqlMigrations({
    mysqlUrl: environment.MYSQL_URL,
  });
  const clickhouseRepeat = await runClickHouseMigrations(clickhouseOptions);

  if (mysqlRepeat.applied.length || clickhouseRepeat.applied.length) {
    throw new Error("repeated migrations applied unexpected versions");
  }

  return {
    mysql: { v1: mysqlV1, upgrade: mysqlUpgrade, repeat: mysqlRepeat },
    clickhouse: {
      v1: clickhouseV1,
      upgrade: clickhouseUpgrade,
      repeat: clickhouseRepeat,
    },
    freshUpgradeObserved:
      mysqlV1.applied.includes(1) &&
      mysqlUpgrade.applied.includes(2) &&
      clickhouseV1.applied.includes(1) &&
      clickhouseUpgrade.applied.includes(2),
  };
}

async function verifyMySqlMetadata() {
  const pool = createMySqlPool(environment.MYSQL_URL);
  const requestId = randomUUID();
  try {
    await pool.execute(
      `INSERT INTO users (id, display_name, email, status)
       VALUES (?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), status = 'active'`,
      [userId, "M1 Fixture Owner", "m1-fixture@example.invalid"],
    );
    await pool.execute(
      `INSERT INTO identities (id, user_id, provider, subject, password_hash)
       VALUES (?, ?, 'local', 'm1-fixture-owner', NULL)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
      ["66666666-6666-4666-8666-666666666666", userId],
    );
    await pool.execute(
      `INSERT INTO projects
         (id, project_key, name, timezone, status, retention_days, created_by_user_id)
       VALUES (?, 'fi_public_m1demo001', 'M1 Fixture Project', 'UTC', 'active', 90, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'active'`,
      [projectId, userId],
    );

    const features: ReadonlyArray<
      readonly [string, string, string, "data_view" | "action" | "long_view"]
    > = [
      [featureIds.sales_dashboard, "sales_dashboard", "Sales dashboard", "data_view"],
      [featureIds.report_export, "report_export", "Report export", "action"],
      [
        featureIds.operations_wallboard,
        "operations_wallboard",
        "Operations wallboard",
        "long_view",
      ],
    ];
    for (const [id, key, name, type] of features) {
      await pool.execute(
        `INSERT INTO features
           (id, project_id, feature_key, name, feature_type, launched_at, status)
         VALUES (?, ?, ?, ?, ?, '2026-07-19 00:00:00.000', 'active')
         ON DUPLICATE KEY UPDATE name = VALUES(name), feature_type = VALUES(feature_type), status = 'active'`,
        [id, projectId, key, name, type],
      );
    }
    await pool.execute(
      `INSERT INTO project_origins (id, project_id, origin, enabled)
       VALUES ('77777777-7777-4777-8777-777777777777', ?, 'http://localhost:4173', TRUE)
       ON DUPLICATE KEY UPDATE enabled = TRUE`,
      [projectId],
    );
    await pool.execute(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES (?, ?, 'owner')
       ON DUPLICATE KEY UPDATE role = 'owner'`,
      [projectId, userId],
    );
    await pool.execute(
      `INSERT INTO audit_logs
         (project_id, actor_user_id, action, entity_type, entity_id, metadata, request_id)
       VALUES (?, ?, 'm1.fixture.verify', 'project', ?, JSON_OBJECT('source', 'm1-verify'), ?)`,
      [projectId, userId, projectId, requestId],
    );

    const [tableRows] = await pool.query<RowDataPacket[]>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
      ORDER BY table_name
    `);
    const tables = tableRows.map((row) => String(row.table_name));
    for (const table of expectedTables) {
      if (!tables.includes(table)) throw new Error(`missing MySQL table: ${table}`);
    }

    const [migrationRows] = await pool.query<RowDataPacket[]>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    if (
      migrationRows.length !== 2 ||
      migrationRows.some((row) => String(row.checksum).length !== 64)
    ) {
      throw new Error("MySQL migration ledger is incomplete");
    }

    const [featureRows] = await pool.query<RowDataPacket[]>(
      `SELECT feature_type, COUNT(*) AS count
       FROM features
       WHERE project_id = ? AND status = 'active'
       GROUP BY feature_type`,
      [projectId],
    );
    if (featureRows.length !== 3) {
      throw new Error("MySQL fixture features were not queryable by project");
    }

    return { tables, migrationVersions: [1, 2], featureTypes: 3, requestId };
  } finally {
    await pool.end();
  }
}

function clickHouseTimestamp(value: string): string {
  return new Date(value).toISOString().replace("T", " ").replace("Z", "");
}

function accountId(accountRef: string | undefined): string | null {
  if (!accountRef) return null;
  return createHmac("sha256", "m1-fixture-project-hmac-key")
    .update(accountRef)
    .digest("hex");
}

function featureStage(eventName: string): string | null {
  if (!eventName.startsWith("feature_")) return null;
  return eventName.slice("feature_".length);
}

async function verifyClickHouseRawEvents() {
  const requestId = randomUUID();
  const client = createClient({
    url: environment.CLICKHOUSE_URL,
    username: environment.CLICKHOUSE_USERNAME,
    password: environment.CLICKHOUSE_PASSWORD,
    database: environment.CLICKHOUSE_DATABASE,
    clickhouse_settings: { date_time_input_format: "best_effort" },
  });
  const rows = contractScenarios.flatMap((scenario) =>
    scenario.valid.events.map((event) => {
      const properties = event.properties as Record<string, unknown>;
      return {
        event_id: event.eventId,
        schema_version: scenario.valid.schemaVersion,
        sdk_version: scenario.valid.sdk.version,
        project_id: projectId,
        event_name: event.eventName,
        event_time: clickHouseTimestamp(event.eventTime),
        received_at: clickHouseTimestamp(scenario.valid.sentAt),
        visitor_id: event.visitorId,
        session_id: event.sessionId,
        page_view_id: event.pageViewId,
        account_id: accountId(event.accountRef),
        feature_id: resolveFeatureId(event.featureKey),
        feature_key: event.featureKey ?? null,
        feature_stage: featureStage(event.eventName),
        duration_ms: null,
        route: event.route,
        title: event.title ?? null,
        visible_duration_ms:
          typeof properties.visibleDurationMs === "number"
            ? properties.visibleDurationMs
            : null,
        properties_json: JSON.stringify(event.properties),
        request_id: requestId,
        origin: "http://localhost:4173",
      };
    }),
  );

  try {
    await client.insert({ table: "raw_events", values: rows, format: "JSONEachRow" });

    const countResponse = await client.query({
      query: `
        SELECT count() AS count
        FROM raw_events
        WHERE project_id = {projectId:UUID}
          AND request_id = {requestId:UUID}
          AND event_time >= toDateTime64('2026-07-19 00:00:00', 3, 'UTC')
          AND event_time < toDateTime64('2026-07-20 00:00:00', 3, 'UTC')
      `,
      query_params: { projectId, requestId },
      format: "JSONEachRow",
    });
    const countRows = await countResponse.json<{ count: string }>();
    if (Number(countRows[0]?.count) !== rows.length) {
      throw new Error("ClickHouse raw events were not queryable by project and time");
    }

    const expectedFeatureCounts: Record<string, number> = {
      sales_dashboard: 2,
      report_export: 3,
      operations_wallboard: 5,
    };
    const featureResponse = await client.query({
      query: `
        SELECT feature_key, count() AS count
        FROM raw_events
        WHERE project_id = {projectId:UUID}
          AND request_id = {requestId:UUID}
          AND feature_key IS NOT NULL
        GROUP BY feature_key
        ORDER BY feature_key
      `,
      query_params: { projectId, requestId },
      format: "JSONEachRow",
    });
    const featureRows = await featureResponse.json<{
      feature_key: string;
      count: string;
    }>();
    for (const row of featureRows) {
      if (Number(row.count) !== expectedFeatureCounts[row.feature_key]) {
        throw new Error(`unexpected count for feature ${row.feature_key}`);
      }
      delete expectedFeatureCounts[row.feature_key];
    }
    if (Object.keys(expectedFeatureCounts).length) {
      throw new Error("one or more fixture features were not queryable");
    }

    const privacyResponse = await client.query({
      query: `
        SELECT
          countIf(account_id IS NOT NULL AND length(account_id) != 64) AS invalid_hashes,
          countIf(position(properties_json, 'opaque-account-') > 0) AS raw_refs
        FROM raw_events
        WHERE request_id = {requestId:UUID}
      `,
      query_params: { requestId },
      format: "JSONEachRow",
    });
    const privacyRows = await privacyResponse.json<{
      invalid_hashes: string;
      raw_refs: string;
    }>();
    if (
      Number(privacyRows[0]?.invalid_hashes) !== 0 ||
      Number(privacyRows[0]?.raw_refs) !== 0
    ) {
      throw new Error("raw account references reached ClickHouse");
    }

    const tableResponse = await client.query({
      query: `
        SELECT create_table_query
        FROM system.tables
        WHERE database = currentDatabase() AND name = 'raw_events'
      `,
      format: "JSONEachRow",
    });
    const tableRows = await tableResponse.json<{ create_table_query: string }>();
    const createTable = tableRows[0]?.create_table_query ?? "";
    if (
      !createTable.includes("TTL received_at + toIntervalDay(90)") ||
      !createTable.includes("PARTITION BY toYYYYMM(received_at)")
    ) {
      throw new Error("ClickHouse TTL or monthly partition is missing");
    }

    const indexResponse = await client.query({
      query: `
        SELECT count() AS count
        FROM system.data_skipping_indices
        WHERE database = currentDatabase() AND table = 'raw_events'
      `,
      format: "JSONEachRow",
    });
    const indexRows = await indexResponse.json<{ count: string }>();
    if (Number(indexRows[0]?.count) !== 2) {
      throw new Error("ClickHouse query indices are incomplete");
    }

    const explainResponse = await client.query({
      query: `
        EXPLAIN indexes = 1
        SELECT count()
        FROM raw_events
        WHERE project_id = {projectId:UUID}
          AND feature_key = 'report_export'
          AND received_at >= now() - INTERVAL 30 DAY
      `,
      query_params: { projectId },
      format: "TabSeparatedRaw",
    });
    const explain = await explainResponse.text();
    if (!explain.includes("ReadFromMergeTree")) {
      throw new Error("typical query EXPLAIN did not use MergeTree");
    }

    return {
      requestId,
      insertedEvents: rows.length,
      featureQueries: 3,
      rawAccountReferences: 0,
      dataSkippingIndices: 2,
      ttlDays: 90,
    };
  } finally {
    await client.close();
  }
}

let exitCode = 0;
try {
  await step("migration-upgrade-and-idempotency", verifyUpgradeAndIdempotency);
  await step("mysql-metadata-schema-and-fixtures", verifyMySqlMetadata);
  await step("clickhouse-raw-events-ttl-and-queries", verifyClickHouseRawEvents);
} catch {
  exitCode = 1;
}

console.log(
  JSON.stringify(
    {
      status: exitCode === 0 ? "passed" : "failed",
      platform: `${process.platform}/${process.arch}`,
      results,
    },
    null,
    2,
  ),
);
process.exitCode = exitCode;
