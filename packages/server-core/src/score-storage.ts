import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type {
  MetricLibraryDefinition,
  MetricLibraryVersion,
} from "./metric-library.js";
import { MetricLibraryError } from "./metric-library.js";
import {
  validateScoreConfiguration,
  type ScoreConfiguration,
} from "./score-evaluation.js";
import { scoreBinding } from "./score-preflight.js";
export function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function scoreDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function snapshotDigest(
  versionId: string,
  configuration: unknown,
  dependencies: unknown,
  definitions: readonly MetricLibraryDefinition[],
) {
  return scoreDigest({ versionId, configuration, dependencies, definitions });
}
export async function writeScoreItems(
  connection: PoolConnection,
  scoreId: string,
  versionId: string,
  configuration: ScoreConfiguration,
) {
  await connection.execute(
    `DELETE item FROM score_items item JOIN score_dimensions dim ON dim.id=item.score_dimension_id WHERE dim.score_definition_id=?`,
    [scoreId],
  );
  await connection.execute(`DELETE FROM score_dimensions WHERE score_definition_id=?`, [
    scoreId,
  ]);
  const [metrics] = await connection.query<RowDataPacket[]>(
    `SELECT id,metric_key FROM metric_definitions WHERE library_version_id=?`,
    [versionId],
  );
  for (const dim of configuration.dimensions) {
    const dimId = randomUUID();
    await connection.execute(
      `INSERT INTO score_dimensions (id,score_definition_id,dimension_key,display_name,weight) VALUES (?,?,?,?,?)`,
      [dimId, scoreId, dim.key, dim.displayName, dim.weight],
    );
    for (const leaf of dim.leaves) {
      const metric = metrics.find((m) => m.metric_key === leaf.metricKey);
      if (!metric) throw new MetricLibraryError("FORMULA_DEPENDENCY_MISSING", 400);
      await connection.execute(
        `INSERT INTO score_items (id,score_dimension_id,metric_definition_id,weight,target_config,required) VALUES (?,?,?,?,?,?)`,
        [
          randomUUID(),
          dimId,
          metric.id,
          leaf.weight,
          JSON.stringify(leaf),
          leaf.enabled,
        ],
      );
    }
  }
}
export async function copyStoredScore(
  connection: PoolConnection,
  sourceVersionId: string,
  versionId: string,
  version: number,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT * FROM score_definitions WHERE library_version_id=? AND configuration IS NOT NULL`,
    [sourceVersionId],
  );
  if (!rows[0]) return;
  const row = rows[0],
    id = randomUUID(),
    configuration = jsonValue<ScoreConfiguration>(row.configuration);
  await connection.execute(
    `INSERT INTO score_definitions (id,library_version_id,score_key,display_name,version,gate_ast,color_bands,status,configuration,dependency_snapshot) VALUES (?,?,?,?,?,?,?,'draft',?,?)`,
    [
      id,
      versionId,
      row.score_key,
      row.display_name,
      version,
      JSON.stringify(jsonValue(row.gate_ast)),
      JSON.stringify(jsonValue(row.color_bands)),
      JSON.stringify(configuration),
      JSON.stringify(jsonValue(row.dependency_snapshot)),
    ],
  );
  await writeScoreItems(connection, id, versionId, configuration);
}
export async function validateStoredScore(
  connection: PoolConnection,
  version: MetricLibraryVersion,
  definitions: readonly MetricLibraryDefinition[],
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT * FROM score_definitions WHERE library_version_id=? AND configuration IS NOT NULL`,
    [version.id],
  );
  if (!rows[0]) return;
  const row = rows[0],
    configuration = jsonValue<ScoreConfiguration>(row.configuration),
    dependencies = jsonValue<{
      confirmed: boolean;
      projectId: string;
      scopeId: string;
    }>(row.dependency_snapshot);
  const validation = validateScoreConfiguration(
    configuration,
    scoreBinding({ version, definitions }),
  );
  if (
    !dependencies.confirmed ||
    dependencies.projectId !== version.projectId ||
    validation.readiness.some((r) => !["partial", "not_collected"].includes(r.reason))
  )
    throw new MetricLibraryError("SCORE_CONFIGURATION_INCOMPLETE", 400);
  if (
    row.reviewed_digest !==
    snapshotDigest(version.id, configuration, dependencies, definitions)
  )
    throw new MetricLibraryError("SCORE_ACTIVATION_REVIEW_REQUIRED", 409);
}
export async function recordMetricActivation(
  connection: PoolConnection,
  version: MetricLibraryVersion,
) {
  const [clock] = await connection.query<RowDataPacket[]>(
    `SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  const now = clock[0]!.now;
  await connection.execute(
    `UPDATE metric_activation_periods SET effective_to=? WHERE project_id=? AND library_type=? AND effective_to IS NULL`,
    [now, version.projectId, version.libraryType],
  );
  await connection.execute(
    `INSERT INTO metric_activation_periods (id,project_id,library_type,library_version_id,effective_from) VALUES (?,?,?,?,?)`,
    [randomUUID(), version.projectId, version.libraryType, version.id, now],
  );
  await connection.execute(
    `UPDATE score_definitions score JOIN metric_library_versions v ON v.id=score.library_version_id SET score.status='retired' WHERE v.project_id=? AND v.library_type=? AND score.status='active'`,
    [version.projectId, version.libraryType],
  );
  await connection.execute(
    `UPDATE score_definitions SET status='active',activated_at=? WHERE library_version_id=?`,
    [now, version.id],
  );
}
