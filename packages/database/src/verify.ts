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
    const error = cause instanceof Error ? cause.message : String(cause);
    results.push({
      name,
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      error,
    });
    throw cause;
  }
}

async function verifyIdempotentBaselines() {
  const clickhouse = {
    url: environment.CLICKHOUSE_URL,
    username: environment.CLICKHOUSE_USERNAME,
    password: environment.CLICKHOUSE_PASSWORD,
    database: environment.CLICKHOUSE_DATABASE,
  };
  const firstMySql = await runMySqlMigrations({ mysqlUrl: environment.MYSQL_URL });
  const firstClickHouse = await runClickHouseMigrations(clickhouse);
  const repeatMySql = await runMySqlMigrations({ mysqlUrl: environment.MYSQL_URL });
  const repeatClickHouse = await runClickHouseMigrations(clickhouse);
  if (repeatMySql.applied.length || repeatClickHouse.applied.length) {
    throw new Error("R0_BASELINE_NOT_IDEMPOTENT");
  }
  return { firstMySql, firstClickHouse, repeatMySql, repeatClickHouse };
}

async function verifyMySqlSchema() {
  const expectedTables = [
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
    "schema_migrations",
  ];
  const pool = createMySqlPool(environment.MYSQL_URL);
  try {
    const [tableRows] = await pool.query<RowDataPacket[]>(`
      SELECT TABLE_NAME AS table_name
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
      ORDER BY table_name
    `);
    const tables = new Set(tableRows.map((row) => String(row.table_name)));
    for (const table of expectedTables) {
      if (!tables.has(table)) throw new Error(`MYSQL_TABLE_MISSING:${table}`);
    }
    const [migrationRows] = await pool.query<RowDataPacket[]>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    if (
      migrationRows.length !== 1 ||
      Number(migrationRows[0]?.version) !== 1 ||
      String(migrationRows[0]?.checksum).length !== 64
    ) {
      throw new Error("MYSQL_BASELINE_LEDGER_INVALID");
    }
    return { tables: expectedTables.length, migrationVersions: [1] };
  } finally {
    await pool.end();
  }
}

function timestamp(value: string | number): string {
  return new Date(value).toISOString().replace("T", " ").replace("Z", "");
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === "string" ? String(payload[key]) : null;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  return typeof payload[key] === "number" ? Number(payload[key]) : null;
}

function protectedUserId(value: string | null): string | null {
  if (value === null) return null;
  return createHmac("sha256", "r0-verification-user-hmac-key")
    .update(value)
    .digest("hex");
}

async function verifyClickHouseV3Smoke() {
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
      const payload = event.payload as Record<string, unknown>;
      const customName =
        event.event === "custom" ? payloadString(payload, "name") : null;
      return {
        event_id: event.eventId,
        schema_version: 3,
        sdk_name: scenario.valid.sdk.name,
        sdk_version: scenario.valid.sdk.version,
        project_id: projectId,
        app_id: event.appId,
        env: event.env,
        release: event.release,
        event: event.event,
        timestamp: timestamp(event.timestamp),
        received_at: timestamp(scenario.valid.sentAt),
        page_url: event.pageUrl,
        page_route: event.pageRoute,
        user_id: protectedUserId(event.userId),
        dept_id: event.deptId,
        role_id: event.roleId,
        session_id: event.sessionId,
        device_id: event.deviceId,
        page_view_id: event.pageViewId,
        ua: event.ua,
        os: event.os,
        browser: event.browser,
        payload_json: JSON.stringify(event.payload),
        feature_id: null,
        feature_key: payloadString(payload, "featureKey"),
        feature_stage: customName?.startsWith("feature_")
          ? customName.slice("feature_".length)
          : null,
        operation_instance_id: payloadString(payload, "operationInstanceId"),
        interaction_type: payloadString(payload, "interactionType"),
        workflow_instance_id: payloadString(payload, "workflowInstanceId"),
        workflow_key: payloadString(payload, "workflowKey"),
        workflow_definition_version: payloadNumber(
          payload,
          "workflowDefinitionVersion",
        ),
        workflow_step_key: payloadString(payload, "workflowStepKey"),
        workflow_step_order: payloadNumber(payload, "workflowStepOrder"),
        error_category: payloadString(payload, "errorType"),
        error_type: payloadString(payload, "errorName"),
        error_name: payloadString(payload, "errorName"),
        error_message: payloadString(payload, "errorMessage"),
        error_stack_frame: payloadString(payload, "stackTopFrame"),
        request_method: payloadString(payload, "requestMethod"),
        request_path: payloadString(payload, "requestPath"),
        http_status: payloadNumber(payload, "statusCode"),
        resource_type: payloadString(payload, "resourceType"),
        vital_name: payloadString(payload, "metric"),
        vital_value: payloadNumber(payload, "value"),
        vital_rating: payloadString(payload, "rating"),
        navigation_type: payloadString(payload, "navigationType"),
        duration_ms: payloadNumber(payload, "durationMs"),
        visible_duration_ms: payloadNumber(payload, "visibleDurationMs"),
        request_id: requestId,
        origin: "http://localhost:4173",
      };
    }),
  );

  try {
    await client.insert({ table: "raw_events", values: rows, format: "JSONEachRow" });
    const response = await client.query({
      query: `
        SELECT
          count() AS count,
          countIf(schema_version != 3) AS non_v3,
          countIf(user_id IS NOT NULL AND length(user_id) != 64) AS invalid_user_hash
        FROM raw_events
        WHERE request_id = {requestId:UUID}
      `,
      query_params: { requestId },
      format: "JSONEachRow",
    });
    const result = (
      await response.json<{
        count: string;
        non_v3: string;
        invalid_user_hash: string;
      }>()
    )[0];
    if (
      Number(result?.count) !== rows.length ||
      Number(result?.non_v3) !== 0 ||
      Number(result?.invalid_user_hash) !== 0
    ) {
      throw new Error("CLICKHOUSE_V3_SMOKE_FAILED");
    }
    return { requestId, insertedEvents: rows.length, schemaVersion: 3 };
  } finally {
    await client.close();
  }
}

let exitCode = 0;
try {
  await step("empty-baseline-and-repeat-bootstrap", verifyIdempotentBaselines);
  await step("mysql-v1.8-schema", verifyMySqlSchema);
  await step("clickhouse-v3-smoke", verifyClickHouseV3Smoke);
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
