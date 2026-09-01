import { randomUUID } from "node:crypto";
import { FORBIDDEN_ALIASES } from "@frontend-insight/event-contract";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import {
  collectFormulaDependencies,
  FormulaValidationError,
  parseFormulaAst,
  topologicalSortFormulaGraph,
  validateFormulaAst,
  type FormulaAst,
  type FormulaMetricReference,
  type FormulaValidationResult,
} from "./formula.js";
import type { Principal } from "./model.js";
import type { MySqlStore } from "./mysql-store.js";
import {
  METRIC_CATALOG,
  RESERVED_SYSTEM_METRIC_KEYS,
  systemMetricDefinition,
  type MetricEntityScope,
  type MetricTimeGranularity,
  type SystemMetricCategory,
  type SystemMetricDefinition,
} from "./system-metric-catalog.js";
import type { SystemMetricImplementationStatus } from "./generated/system-metric-seed.js";

export type MetricLibraryType = "operational" | "quality";
export type MetricLibraryVersionStatus =
  "draft" | "active" | "superseded" | "abandoned";
export type MetricDefinitionOrigin = "system" | "business";

export class MetricLibraryError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
    this.name = "MetricLibraryError";
  }
}

export interface MetricLibraryVersion {
  id: string;
  projectId: string;
  libraryType: MetricLibraryType;
  version: number;
  status: MetricLibraryVersionStatus;
  manifestVersion: string;
  sourceVersionId: string | null;
  createdByUserId: string;
  activatedAt: string | null;
  supersededAt: string | null;
  abandonedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MetricLibraryDefinition {
  id: string;
  libraryVersionId: string;
  metricKey: string;
  origin: MetricDefinitionOrigin;
  category: SystemMetricCategory;
  displayName: string;
  businessDescription: string;
  formulaDescription: string;
  numeratorDescription: string | null;
  denominatorDescription: string | null;
  deduplicationKey: string;
  unit: string;
  percentiles: readonly string[];
  reportingTiming: string;
  entityScopes: readonly MetricEntityScope[];
  timeGranularities: readonly MetricTimeGranularity[];
  minimumSample: number;
  missingPolicy: string;
  owner: string;
  definitionVersion: string;
  implementationStatus: SystemMetricImplementationStatus;
  formulaAst: FormulaAst | null;
  availableFrom: string | null;
  unavailableReason: string | null;
  milestone: string;
  enabled: boolean;
}

export interface BusinessMetricInput {
  metricKey: string;
  displayName: string;
  businessDescription: string;
  category: SystemMetricCategory;
  numeratorDescription: string | null;
  denominatorDescription: string | null;
  deduplicationKey: string;
  unit: string;
  entityScope: MetricEntityScope;
  timeGranularity: MetricTimeGranularity;
  minimumSample: number;
  missingPolicy: string;
  owner: string;
  enabled: boolean;
  formulaAst: unknown;
}

export interface MetricVersionValidationReport {
  valid: boolean;
  versionId: string;
  errors: readonly {
    code: string;
    metricKey: string | null;
    path: string;
    details?: Readonly<Record<string, unknown>>;
  }[];
  order: readonly string[];
  definitions: readonly {
    metricKey: string;
    implementationStatus: SystemMetricImplementationStatus;
    dependencies: readonly string[];
    formulaDescription: string;
  }[];
}

export interface MetricLineageReadModel {
  metricKey: string;
  versionId: string;
  formulaAst: FormulaAst | null;
  formulaDescription: string;
  nodes: readonly {
    metricKey: string;
    displayName: string;
    origin: MetricDefinitionOrigin;
    unit: string;
    minimumSample: number;
    missingPolicy: string;
    implementationStatus: SystemMetricImplementationStatus;
  }[];
  edges: readonly { from: string; to: string }[];
  directUpstream: readonly string[];
  directDownstream: readonly string[];
  validation: { valid: boolean; errors: MetricVersionValidationReport["errors"] };
}

export interface MetricDiffReadModel {
  versionId: string;
  sourceVersionId: string | null;
  added: readonly string[];
  removed: readonly string[];
  changed: readonly { metricKey: string; fields: readonly string[] }[];
}

export interface MetricImpactReadModel {
  versionId: string;
  metricKey: string | null;
  downstreamMetrics: readonly string[];
  displayBindings: readonly {
    metricKey: string;
    routeName: string;
    surfaceKey: string;
  }[];
  scoreReferences: readonly { metricKey: string; scoreKey: string }[];
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
const qualityCategories = new Set<SystemMetricCategory>(["performance", "stability"]);
const removedMetricKeys = new Set<string>(FORBIDDEN_ALIASES.metricKeys);

export function assertMetricKeyCanBeCreated(metricKey: string): void {
  if (removedMetricKeys.has(metricKey)) {
    throw new MetricLibraryError("METRIC_KEY_REMOVED", 410, { metricKey });
  }
  if (RESERVED_SYSTEM_METRIC_KEYS.has(metricKey)) {
    throw new MetricLibraryError("SYSTEM_METRIC_KEY_RESERVED", 409, { metricKey });
  }
  if (!KEY_PATTERN.test(metricKey)) {
    throw new MetricLibraryError("METRIC_KEY_INVALID", 400, { metricKey });
  }
}

export function assertMetricKeyRequest(metricKey: string): void {
  if (removedMetricKeys.has(metricKey)) {
    throw new MetricLibraryError("METRIC_KEY_REMOVED", 410, { metricKey });
  }
}

export function formulaToDescription(ast: FormulaAst): string {
  if (ast.type === "metric") return ast.metricKey;
  if (ast.type === "literal") return String(ast.value);
  if (ast.type === "binary") {
    return `(${formulaToDescription(ast.left)} ${ast.operator} ${formulaToDescription(ast.right)})`;
  }
  if (ast.type === "call") {
    return `${ast.function}(${ast.arguments.map(formulaToDescription).join(", ")})`;
  }
  if (ast.type === "weighted_mean") {
    return `weighted_mean(${ast.items.map((item) => `${formulaToDescription(item.value)} × ${item.weight}`).join(", ")})`;
  }
  return `normalize(${ast.direction}, ${formulaToDescription(ast.input)}, ${JSON.stringify(ast.target)})`;
}

function libraryIncludesCategory(
  type: MetricLibraryType,
  category: SystemMetricCategory,
): boolean {
  return type === "quality"
    ? qualityCategories.has(category)
    : !qualityCategories.has(category);
}

function toIso(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : new Date(value as string).toISOString();
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function versionFromRow(row: RowDataPacket): MetricLibraryVersion {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    libraryType: row.library_type as MetricLibraryType,
    version: Number(row.version),
    status: row.status as MetricLibraryVersionStatus,
    manifestVersion: String(row.manifest_version),
    sourceVersionId: row.source_version_id ? String(row.source_version_id) : null,
    createdByUserId: String(row.created_by_user_id),
    activatedAt: toIso(row.activated_at),
    supersededAt: toIso(row.superseded_at),
    abandonedAt: toIso(row.abandoned_at),
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function definitionFromRow(row: RowDataPacket): MetricLibraryDefinition {
  return {
    id: String(row.id),
    libraryVersionId: String(row.library_version_id),
    metricKey: String(row.metric_key),
    origin: row.origin as MetricDefinitionOrigin,
    category: row.category as SystemMetricCategory,
    displayName: String(row.display_name),
    businessDescription: String(row.business_description),
    formulaDescription: String(row.formula_description),
    numeratorDescription:
      row.numerator_definition === null ? null : String(row.numerator_definition),
    denominatorDescription:
      row.denominator_definition === null ? null : String(row.denominator_definition),
    deduplicationKey: String(row.deduplication_key),
    unit: String(row.unit),
    percentiles: Object.freeze(jsonValue<string[]>(row.percentiles)),
    reportingTiming: String(row.reporting_timing),
    entityScopes: Object.freeze(jsonValue<MetricEntityScope[]>(row.entity_scopes)),
    timeGranularities: Object.freeze(
      jsonValue<MetricTimeGranularity[]>(row.time_granularities),
    ),
    minimumSample: Number(row.minimum_sample),
    missingPolicy: String(row.missing_policy),
    owner: String(row.owner),
    definitionVersion: String(row.definition_version),
    implementationStatus: row.implementation_status as SystemMetricImplementationStatus,
    formulaAst:
      row.formula_ast === null ? null : parseFormulaAst(jsonValue(row.formula_ast)),
    availableFrom: toIso(row.available_from),
    unavailableReason:
      row.unavailable_reason === null ? null : String(row.unavailable_reason),
    milestone: String(row.milestone),
    enabled: Boolean(row.enabled),
  };
}

function referenceFor(
  definition: Pick<
    MetricLibraryDefinition,
    "metricKey" | "unit" | "entityScopes" | "timeGranularities" | "minimumSample"
  >,
  projectId: string,
): FormulaMetricReference {
  return { ...definition, projectId };
}

function systemReference(
  definition: SystemMetricDefinition,
  projectId: string,
): FormulaMetricReference {
  return referenceFor(definition, projectId);
}

export function validateMetricVersionSnapshot(input: {
  version: MetricLibraryVersion;
  definitions: readonly MetricLibraryDefinition[];
}): MetricVersionValidationReport {
  const errors: Array<{
    code: string;
    metricKey: string | null;
    path: string;
    details?: Readonly<Record<string, unknown>>;
  }> = [];
  const expectedSystems = METRIC_CATALOG.filter((item) =>
    libraryIncludesCategory(input.version.libraryType, item.category),
  );
  const byKey = new Map(input.definitions.map((item) => [item.metricKey, item]));
  for (const system of expectedSystems) {
    const snapshot = byKey.get(system.metricKey);
    if (!snapshot)
      errors.push({
        code: "SYSTEM_METRIC_MISSING",
        metricKey: system.metricKey,
        path: system.metricKey,
      });
    else if (
      snapshot.origin !== "system" ||
      snapshot.definitionVersion !== system.definitionVersion
    ) {
      errors.push({
        code: "SYSTEM_METRIC_CHANGED",
        metricKey: system.metricKey,
        path: system.metricKey,
      });
    }
  }
  for (const definition of input.definitions) {
    if (
      definition.origin === "system" &&
      !systemMetricDefinition(definition.metricKey)
    ) {
      errors.push({
        code: "SYSTEM_METRIC_UNKNOWN",
        metricKey: definition.metricKey,
        path: definition.metricKey,
      });
    }
  }

  const validationByKey = new Map<string, FormulaValidationResult>();
  const resolveMetric = (metricKey: string): FormulaMetricReference | null => {
    const local = byKey.get(metricKey);
    if (local) return referenceFor(local, input.version.projectId);
    const system = systemMetricDefinition(metricKey);
    return system ? systemReference(system, input.version.projectId) : null;
  };
  for (const definition of input.definitions.filter(
    (item) => item.origin === "business",
  )) {
    if (!definition.formulaAst) {
      errors.push({
        code: "FORMULA_REQUIRED",
        metricKey: definition.metricKey,
        path: definition.metricKey,
      });
      continue;
    }
    try {
      const result = validateFormulaAst(definition.formulaAst, {
        projectId: input.version.projectId,
        outputUnit: definition.unit,
        outputScope: definition.entityScopes[0]!,
        outputGranularity: definition.timeGranularities[0]!,
        minimumSample: definition.minimumSample,
        resolveMetric,
      });
      validationByKey.set(definition.metricKey, result);
    } catch (cause) {
      if (cause instanceof FormulaValidationError) {
        errors.push({
          code: cause.code,
          metricKey: definition.metricKey,
          path: cause.path,
          ...(cause.details ? { details: cause.details } : {}),
        });
      } else throw cause;
    }
  }
  let order: readonly string[] = [];
  try {
    order = topologicalSortFormulaGraph(
      [
        ...METRIC_CATALOG.map((item) => ({
          metricKey: item.metricKey,
          projectId: input.version.projectId,
          formulaAst: null,
        })),
        ...input.definitions
          .filter((item) => item.origin === "business")
          .map((item) => ({
            metricKey: item.metricKey,
            projectId: input.version.projectId,
            formulaAst: item.formulaAst,
          })),
      ],
      input.version.projectId,
    );
  } catch (cause) {
    if (cause instanceof FormulaValidationError) {
      errors.push({
        code: cause.code,
        metricKey: null,
        path: cause.path,
        ...(cause.details ? { details: cause.details } : {}),
      });
    } else throw cause;
  }

  const statusByKey = new Map(
    METRIC_CATALOG.map((item) => [item.metricKey, item.implementationStatus]),
  );
  const definitions = input.definitions
    .filter((item) => item.origin === "business")
    .sort(
      (left, right) => order.indexOf(left.metricKey) - order.indexOf(right.metricKey),
    )
    .map((item) => {
      const validation = validationByKey.get(item.metricKey);
      const dependencyStatuses = (validation?.dependencies ?? []).map(
        (key) => statusByKey.get(key) ?? "not_collected",
      );
      const implementationStatus = deriveImplementationStatus(dependencyStatuses);
      statusByKey.set(item.metricKey, implementationStatus);
      return {
        metricKey: item.metricKey,
        implementationStatus,
        dependencies: validation?.dependencies ?? [],
        formulaDescription: item.formulaAst
          ? formulaToDescription(item.formulaAst)
          : "",
      };
    });
  return Object.freeze({
    valid: errors.length === 0,
    versionId: input.version.id,
    errors: Object.freeze(errors),
    order,
    definitions: Object.freeze(definitions),
  });
}

function deriveImplementationStatus(
  statuses: readonly SystemMetricImplementationStatus[],
): SystemMetricImplementationStatus {
  if (statuses.includes("not_collected")) return "not_collected";
  if (statuses.includes("partial")) return "partial";
  return "implemented";
}

export class MetricLibraryService {
  constructor(private readonly mysql: MySqlStore) {}

  async listVersions(
    projectId: string,
    libraryType: MetricLibraryType,
  ): Promise<readonly MetricLibraryVersion[]> {
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT * FROM metric_library_versions
       WHERE project_id = ? AND library_type = ? ORDER BY version DESC`,
      [projectId, libraryType],
    );
    return rows.map(versionFromRow);
  }

  async getVersion(
    projectId: string,
    versionId: string,
  ): Promise<{
    version: MetricLibraryVersion;
    definitions: readonly MetricLibraryDefinition[];
  }> {
    const version = await this.requireVersion(
      this.mysql.pool,
      projectId,
      versionId,
      false,
    );
    return { version, definitions: await this.listDefinitions(versionId) };
  }

  async catalog(
    projectId: string,
    libraryType: MetricLibraryType,
  ): Promise<{
    system: readonly SystemMetricDefinition[];
    business: readonly MetricLibraryDefinition[];
    activeVersion: MetricLibraryVersion | null;
  }> {
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT * FROM metric_library_versions
       WHERE project_id = ? AND library_type = ? AND status = 'active' LIMIT 1`,
      [projectId, libraryType],
    );
    const activeVersion = rows[0] ? versionFromRow(rows[0]) : null;
    const business = activeVersion
      ? (await this.listDefinitions(activeVersion.id)).filter(
          (item) => item.origin === "business",
        )
      : [];
    return {
      system: METRIC_CATALOG.filter((item) =>
        libraryIncludesCategory(libraryType, item.category),
      ),
      business,
      activeVersion,
    };
  }

  async createDraft(input: {
    projectId: string;
    libraryType: MetricLibraryType;
    sourceVersionId?: string | null;
    actor: Principal;
  }): Promise<MetricLibraryVersion> {
    const connection = await this.mysql.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(`SELECT id FROM projects WHERE id = ? FOR UPDATE`, [
        input.projectId,
      ]);
      const [versionRows] = await connection.query<RowDataPacket[]>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM metric_library_versions WHERE project_id = ? AND library_type = ?`,
        [input.projectId, input.libraryType],
      );
      let sourceVersionId = input.sourceVersionId ?? null;
      if (sourceVersionId) {
        const source = await this.requireVersion(
          connection,
          input.projectId,
          sourceVersionId,
          true,
        );
        if (source.libraryType !== input.libraryType || source.status === "abandoned") {
          throw new MetricLibraryError("METRIC_LIBRARY_SOURCE_INVALID", 400);
        }
      } else {
        const [activeRows] = await connection.query<RowDataPacket[]>(
          `SELECT id FROM metric_library_versions
           WHERE project_id = ? AND library_type = ? AND status = 'active' LIMIT 1`,
          [input.projectId, input.libraryType],
        );
        sourceVersionId = activeRows[0] ? String(activeRows[0].id) : null;
      }
      const id = randomUUID();
      await connection.execute(
        `INSERT INTO metric_library_versions
           (id, project_id, library_type, version, status, manifest_version,
            source_version_id, created_by_user_id)
         VALUES (?, ?, ?, ?, 'draft', '1.8.0', ?, ?)`,
        [
          id,
          input.projectId,
          input.libraryType,
          Number(versionRows[0]!.next_version),
          sourceVersionId,
          input.actor.userId,
        ],
      );
      if (sourceVersionId) {
        await connection.execute(
          `INSERT INTO metric_definitions
             (id, library_version_id, metric_key, origin, category, display_name,
              business_description, formula_description, numerator_definition,
              denominator_definition, deduplication_key, unit, percentiles,
              reporting_timing, entity_scopes, time_granularities, minimum_sample,
              missing_policy, owner, definition_version, implementation_status,
              formula_ast, available_from, unavailable_reason, milestone, enabled)
           SELECT UUID(), ?, metric_key, origin, category, display_name,
              business_description, formula_description, numerator_definition,
              denominator_definition, deduplication_key, unit, percentiles,
              reporting_timing, entity_scopes, time_granularities, minimum_sample,
              missing_policy, owner, definition_version, implementation_status,
              formula_ast, available_from, unavailable_reason, milestone, enabled
           FROM metric_definitions WHERE library_version_id = ?`,
          [id, sourceVersionId],
        );
      } else {
        for (const definition of METRIC_CATALOG.filter((item) =>
          libraryIncludesCategory(input.libraryType, item.category),
        )) {
          await this.insertSystemDefinition(connection, id, definition);
        }
      }
      await this.insertAudit(
        connection,
        input.projectId,
        input.actor.userId,
        "metric_library.draft_created",
        "metric_library_version",
        id,
        { libraryType: input.libraryType, sourceVersionId },
      );
      await connection.commit();
      return (await this.getVersion(input.projectId, id)).version;
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async saveBusinessMetric(input: {
    projectId: string;
    versionId: string;
    definition: BusinessMetricInput;
    actor: Principal;
  }): Promise<{
    version: MetricLibraryVersion;
    definition: MetricLibraryDefinition;
    validation: MetricVersionValidationReport;
  }> {
    assertMetricKeyCanBeCreated(input.definition.metricKey);
    const version = await this.requireVersion(
      this.mysql.pool,
      input.projectId,
      input.versionId,
      false,
    );
    if (version.status !== "draft")
      throw new MetricLibraryError("METRIC_LIBRARY_VERSION_IMMUTABLE", 409);
    if (!libraryIncludesCategory(version.libraryType, input.definition.category)) {
      throw new MetricLibraryError("METRIC_CATEGORY_LIBRARY_MISMATCH", 400);
    }
    const [conflictingRows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT mlv.library_type FROM metric_definitions md
       JOIN metric_library_versions mlv ON mlv.id = md.library_version_id
       WHERE mlv.project_id = ? AND mlv.library_type <> ?
         AND mlv.status <> 'abandoned' AND md.origin = 'business'
         AND md.metric_key = ? LIMIT 1`,
      [input.projectId, version.libraryType, input.definition.metricKey],
    );
    if (conflictingRows[0]) {
      throw new MetricLibraryError("METRIC_KEY_LIBRARY_CONFLICT", 409, {
        metricKey: input.definition.metricKey,
        libraryType: String(conflictingRows[0].library_type),
      });
    }
    const ast = parseFormulaAst(input.definition.formulaAst);
    const existing = await this.listDefinitions(version.id);
    const byKey = new Map(existing.map((item) => [item.metricKey, item]));
    const formulaValidation = validateFormulaAst(ast, {
      projectId: input.projectId,
      outputUnit: input.definition.unit,
      outputScope: input.definition.entityScope,
      outputGranularity: input.definition.timeGranularity,
      minimumSample: input.definition.minimumSample,
      resolveMetric: (metricKey) => {
        const local = byKey.get(metricKey);
        if (local) return referenceFor(local, input.projectId);
        const system = systemMetricDefinition(metricKey);
        return system ? systemReference(system, input.projectId) : null;
      },
    });
    if (formulaValidation.dependencies.includes(input.definition.metricKey)) {
      throw new MetricLibraryError("FORMULA_DEPENDENCY_CYCLE", 400, {
        metricKey: input.definition.metricKey,
      });
    }
    const id = byKey.get(input.definition.metricKey)?.id ?? randomUUID();
    const connection = await this.mysql.pool.getConnection();
    try {
      await connection.beginTransaction();
      const locked = await this.requireVersion(
        connection,
        input.projectId,
        version.id,
        true,
      );
      if (locked.status !== "draft")
        throw new MetricLibraryError("METRIC_LIBRARY_VERSION_IMMUTABLE", 409);
      await connection.execute(
        `INSERT INTO metric_definitions
           (id, library_version_id, metric_key, origin, category, display_name,
            business_description, formula_description, numerator_definition,
            denominator_definition, deduplication_key, unit, percentiles,
            reporting_timing, entity_scopes, time_granularities, minimum_sample,
            missing_policy, owner, definition_version, implementation_status,
            formula_ast, available_from, unavailable_reason, milestone, enabled)
         VALUES (?, ?, ?, 'business', ?, ?, ?, ?, ?, ?, ?, ?, JSON_ARRAY(),
                 '由已注册输入指标按同一时间桶计算。', JSON_ARRAY(?), JSON_ARRAY(?),
                 ?, ?, ?, ?, 'not_collected', ?, NULL,
                 '依赖指标尚未全部 implemented。', 'R1-B', ?)
         ON DUPLICATE KEY UPDATE
           category = VALUES(category), display_name = VALUES(display_name),
           business_description = VALUES(business_description),
           formula_description = VALUES(formula_description),
           numerator_definition = VALUES(numerator_definition),
           denominator_definition = VALUES(denominator_definition),
           deduplication_key = VALUES(deduplication_key), unit = VALUES(unit),
           entity_scopes = VALUES(entity_scopes), time_granularities = VALUES(time_granularities),
           minimum_sample = VALUES(minimum_sample), missing_policy = VALUES(missing_policy),
           owner = VALUES(owner), definition_version = VALUES(definition_version),
           formula_ast = VALUES(formula_ast), enabled = VALUES(enabled)`,
        [
          id,
          version.id,
          input.definition.metricKey,
          input.definition.category,
          input.definition.displayName,
          input.definition.businessDescription,
          formulaToDescription(ast),
          input.definition.numeratorDescription,
          input.definition.denominatorDescription,
          input.definition.deduplicationKey,
          input.definition.unit,
          input.definition.entityScope,
          input.definition.timeGranularity,
          input.definition.minimumSample,
          input.definition.missingPolicy,
          input.definition.owner,
          `business-v${version.version}`,
          JSON.stringify(ast),
          input.definition.enabled,
        ],
      );
      await this.insertAudit(
        connection,
        input.projectId,
        input.actor.userId,
        "metric_definition.saved",
        "metric_definition",
        id,
        { metricKey: input.definition.metricKey, versionId: version.id },
      );
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    const snapshot = await this.getVersion(input.projectId, version.id);
    return {
      version: snapshot.version,
      definition: snapshot.definitions.find(
        (item) => item.metricKey === input.definition.metricKey,
      )!,
      validation: validateMetricVersionSnapshot(snapshot),
    };
  }

  async deleteBusinessMetric(input: {
    projectId: string;
    versionId: string;
    metricKey: string;
    actor: Principal;
  }): Promise<void> {
    assertMetricKeyCanBeCreated(input.metricKey);
    const connection = await this.mysql.pool.getConnection();
    try {
      await connection.beginTransaction();
      const version = await this.requireVersion(
        connection,
        input.projectId,
        input.versionId,
        true,
      );
      if (version.status !== "draft")
        throw new MetricLibraryError("METRIC_LIBRARY_VERSION_IMMUTABLE", 409);
      const [result] = await connection.execute(
        `DELETE FROM metric_definitions
         WHERE library_version_id = ? AND metric_key = ? AND origin = 'business'`,
        [version.id, input.metricKey],
      );
      if (!(result as { affectedRows: number }).affectedRows)
        throw new MetricLibraryError("METRIC_DEFINITION_NOT_FOUND", 404);
      await this.insertAudit(
        connection,
        input.projectId,
        input.actor.userId,
        "metric_definition.deleted",
        "metric_definition",
        null,
        { metricKey: input.metricKey, versionId: version.id },
      );
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async validateVersion(
    projectId: string,
    versionId: string,
  ): Promise<MetricVersionValidationReport> {
    return validateMetricVersionSnapshot(await this.getVersion(projectId, versionId));
  }

  async activateVersion(input: {
    projectId: string;
    versionId: string;
    actor: Principal;
  }): Promise<MetricLibraryVersion> {
    const connection = await this.mysql.pool.getConnection();
    try {
      await connection.beginTransaction();
      const version = await this.requireVersion(
        connection,
        input.projectId,
        input.versionId,
        true,
      );
      if (
        !(["draft", "superseded"] as MetricLibraryVersionStatus[]).includes(
          version.status,
        )
      ) {
        throw new MetricLibraryError("METRIC_LIBRARY_VERSION_NOT_ACTIVATABLE", 409);
      }
      const definitions = await this.listDefinitions(version.id, connection);
      const report = validateMetricVersionSnapshot({ version, definitions });
      if (!report.valid)
        throw new MetricLibraryError("METRIC_LIBRARY_VALIDATION_FAILED", 400, {
          errors: report.errors,
        });
      for (const item of report.definitions) {
        await connection.execute(
          `UPDATE metric_definitions SET implementation_status = ?,
             unavailable_reason = CASE WHEN ? = 'implemented' THEN NULL ELSE '依赖指标尚未全部 implemented。' END
           WHERE library_version_id = ? AND metric_key = ? AND origin = 'business'`,
          [
            item.implementationStatus,
            item.implementationStatus,
            version.id,
            item.metricKey,
          ],
        );
      }
      const [forbiddenBindingRows] = await connection.query<RowDataPacket[]>(
        `SELECT md.metric_key, 'display' AS reference_type
         FROM metric_definitions md
         JOIN metric_display_bindings binding ON binding.metric_definition_id = md.id
         WHERE md.library_version_id = ? AND md.implementation_status = 'not_collected'
         UNION ALL
         SELECT md.metric_key, 'active_score' AS reference_type
         FROM metric_definitions md
         JOIN score_items item ON item.metric_definition_id = md.id
         JOIN score_dimensions dimension ON dimension.id = item.score_dimension_id
         JOIN score_definitions score ON score.id = dimension.score_definition_id
         WHERE md.library_version_id = ? AND md.implementation_status = 'not_collected'
           AND score.status = 'active'`,
        [version.id, version.id],
      );
      if (forbiddenBindingRows.length) {
        throw new MetricLibraryError("NOT_COLLECTED_METRIC_BINDING_FORBIDDEN", 400, {
          references: forbiddenBindingRows.map((row) => ({
            metricKey: String(row.metric_key),
            referenceType: String(row.reference_type),
          })),
        });
      }
      await connection.execute(
        `UPDATE metric_library_versions SET status = 'superseded', superseded_at = CURRENT_TIMESTAMP(3)
         WHERE project_id = ? AND library_type = ? AND status = 'active' AND id <> ?`,
        [input.projectId, version.libraryType, version.id],
      );
      await connection.execute(
        `UPDATE metric_library_versions SET status = 'active', activated_at = CURRENT_TIMESTAMP(3),
           superseded_at = NULL, abandoned_at = NULL WHERE id = ?`,
        [version.id],
      );
      await this.insertAudit(
        connection,
        input.projectId,
        input.actor.userId,
        "metric_library.activated",
        "metric_library_version",
        version.id,
        {
          libraryType: version.libraryType,
          version: version.version,
          reactivated: version.status === "superseded",
        },
      );
      await connection.commit();
      return (await this.getVersion(input.projectId, version.id)).version;
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async abandonDraft(input: {
    projectId: string;
    versionId: string;
    actor: Principal;
  }): Promise<void> {
    const connection = await this.mysql.pool.getConnection();
    try {
      await connection.beginTransaction();
      const version = await this.requireVersion(
        connection,
        input.projectId,
        input.versionId,
        true,
      );
      if (version.status !== "draft")
        throw new MetricLibraryError("METRIC_LIBRARY_VERSION_IMMUTABLE", 409);
      await connection.execute(
        `UPDATE metric_library_versions SET status = 'abandoned', abandoned_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [version.id],
      );
      await this.insertAudit(
        connection,
        input.projectId,
        input.actor.userId,
        "metric_library.abandoned",
        "metric_library_version",
        version.id,
        { libraryType: version.libraryType, version: version.version },
      );
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async definition(
    projectId: string,
    metricKey: string,
    versionId?: string | null,
  ): Promise<MetricLibraryDefinition | SystemMetricDefinition> {
    assertMetricKeyRequest(metricKey);
    const system = systemMetricDefinition(metricKey);
    if (system) return system;
    const params: unknown[] = [projectId, metricKey];
    const versionClause = versionId ? "AND mlv.id = ?" : "AND mlv.status = 'active'";
    if (versionId) params.push(versionId);
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT md.* FROM metric_definitions md
       JOIN metric_library_versions mlv ON mlv.id = md.library_version_id
       WHERE mlv.project_id = ? AND md.metric_key = ? ${versionClause}
       ORDER BY mlv.version DESC LIMIT 1`,
      params,
    );
    if (!rows[0]) throw new MetricLibraryError("METRIC_DEFINITION_NOT_FOUND", 404);
    return definitionFromRow(rows[0]);
  }

  async lineage(
    projectId: string,
    versionId: string,
    metricKey: string,
  ): Promise<MetricLineageReadModel> {
    assertMetricKeyRequest(metricKey);
    const snapshot = await this.getVersion(projectId, versionId);
    const localByKey = new Map(
      snapshot.definitions.map((item) => [item.metricKey, item]),
    );
    const get = (
      key: string,
    ): MetricLibraryDefinition | SystemMetricDefinition | null =>
      localByKey.get(key) ?? systemMetricDefinition(key);
    const root = get(metricKey);
    if (!root) throw new MetricLibraryError("METRIC_DEFINITION_NOT_FOUND", 404);
    const dependencies = (key: string): readonly string[] => {
      const item = get(key);
      return item && "formulaAst" in item && item.formulaAst
        ? collectFormulaDependencies(item.formulaAst)
        : [];
    };
    const reachable = new Set<string>();
    const visit = (key: string): void => {
      if (reachable.has(key)) return;
      reachable.add(key);
      dependencies(key).forEach(visit);
    };
    visit(metricKey);
    const edges = [...reachable].flatMap((key) =>
      dependencies(key)
        .filter((upstream) => reachable.has(upstream))
        .map((upstream) => ({ from: upstream, to: key })),
    );
    const report = validateMetricVersionSnapshot(snapshot);
    return {
      metricKey,
      versionId,
      formulaAst: "formulaAst" in root ? root.formulaAst : null,
      formulaDescription: root.formulaDescription,
      nodes: [...reachable].map((key) => {
        const item = get(key)!;
        return {
          metricKey: key,
          displayName: item.displayName,
          origin: item.origin,
          unit: item.unit,
          minimumSample: item.minimumSample,
          missingPolicy: item.missingPolicy,
          implementationStatus: item.implementationStatus,
        };
      }),
      edges,
      directUpstream: dependencies(metricKey),
      directDownstream: snapshot.definitions
        .filter(
          (item) =>
            item.formulaAst &&
            collectFormulaDependencies(item.formulaAst).includes(metricKey),
        )
        .map((item) => item.metricKey),
      validation: { valid: report.valid, errors: report.errors },
    };
  }

  async diff(projectId: string, versionId: string): Promise<MetricDiffReadModel> {
    const snapshot = await this.getVersion(projectId, versionId);
    if (!snapshot.version.sourceVersionId)
      return {
        versionId,
        sourceVersionId: null,
        added: snapshot.definitions.map((item) => item.metricKey),
        removed: [],
        changed: [],
      };
    const source = await this.getVersion(projectId, snapshot.version.sourceVersionId);
    const current = new Map(snapshot.definitions.map((item) => [item.metricKey, item]));
    const previous = new Map(source.definitions.map((item) => [item.metricKey, item]));
    const added = [...current.keys()].filter((key) => !previous.has(key)).sort();
    const removed = [...previous.keys()].filter((key) => !current.has(key)).sort();
    const compareFields: readonly (keyof MetricLibraryDefinition)[] = [
      "displayName",
      "businessDescription",
      "category",
      "formulaDescription",
      "numeratorDescription",
      "denominatorDescription",
      "deduplicationKey",
      "unit",
      "entityScopes",
      "timeGranularities",
      "minimumSample",
      "missingPolicy",
      "owner",
      "implementationStatus",
      "formulaAst",
      "enabled",
    ];
    const changed = [...current.keys()]
      .filter((key) => previous.has(key))
      .flatMap((key) => {
        const fields = compareFields.filter(
          (field) =>
            JSON.stringify(current.get(key)![field]) !==
            JSON.stringify(previous.get(key)![field]),
        );
        return fields.length ? [{ metricKey: key, fields: fields.map(String) }] : [];
      });
    return { versionId, sourceVersionId: source.version.id, added, removed, changed };
  }

  async impact(
    projectId: string,
    versionId: string,
    metricKey?: string | null,
  ): Promise<MetricImpactReadModel> {
    const snapshot = await this.getVersion(projectId, versionId);
    if (metricKey) assertMetricKeyRequest(metricKey);
    const targets = metricKey
      ? [metricKey]
      : snapshot.definitions.map((item) => item.metricKey);
    const downstream = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of snapshot.definitions) {
        if (
          item.formulaAst &&
          collectFormulaDependencies(item.formulaAst).some(
            (key) => targets.includes(key) || downstream.has(key),
          ) &&
          !downstream.has(item.metricKey)
        ) {
          downstream.add(item.metricKey);
          changed = true;
        }
      }
    }
    const [bindingRows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT md.metric_key, mdb.route_name, mdb.surface_key
       FROM metric_display_bindings mdb JOIN metric_definitions md ON md.id = mdb.metric_definition_id
       WHERE md.library_version_id = ? ${metricKey ? "AND md.metric_key = ?" : ""}`,
      metricKey ? [versionId, metricKey] : [versionId],
    );
    const [scoreRows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT md.metric_key, sd.score_key
       FROM score_items si JOIN metric_definitions md ON md.id = si.metric_definition_id
       JOIN score_dimensions sdim ON sdim.id = si.score_dimension_id
       JOIN score_definitions sd ON sd.id = sdim.score_definition_id
       WHERE md.library_version_id = ? ${metricKey ? "AND md.metric_key = ?" : ""}`,
      metricKey ? [versionId, metricKey] : [versionId],
    );
    return {
      versionId,
      metricKey: metricKey ?? null,
      downstreamMetrics: [...downstream].sort(),
      displayBindings: bindingRows.map((row) => ({
        metricKey: String(row.metric_key),
        routeName: String(row.route_name),
        surfaceKey: String(row.surface_key),
      })),
      scoreReferences: scoreRows.map((row) => ({
        metricKey: String(row.metric_key),
        scoreKey: String(row.score_key),
      })),
    };
  }

  private async listDefinitions(
    versionId: string,
    connection?: PoolConnection,
  ): Promise<readonly MetricLibraryDefinition[]> {
    const executor = connection ?? this.mysql.pool;
    const [rows] = await executor.query<RowDataPacket[]>(
      `SELECT * FROM metric_definitions WHERE library_version_id = ? ORDER BY origin DESC, category, metric_key`,
      [versionId],
    );
    return rows.map(definitionFromRow);
  }

  private async requireVersion(
    executor: Pick<PoolConnection | MySqlStore["pool"], "query">,
    projectId: string,
    versionId: string,
    lock: boolean,
  ): Promise<MetricLibraryVersion> {
    const [rows] = await executor.query<RowDataPacket[]>(
      `SELECT * FROM metric_library_versions WHERE id = ? AND project_id = ?${lock ? " FOR UPDATE" : ""}`,
      [versionId, projectId],
    );
    if (!rows[0]) throw new MetricLibraryError("METRIC_LIBRARY_VERSION_NOT_FOUND", 404);
    return versionFromRow(rows[0]);
  }

  private async insertSystemDefinition(
    connection: PoolConnection,
    versionId: string,
    metric: SystemMetricDefinition,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO metric_definitions
         (id, library_version_id, metric_key, origin, category, display_name,
          business_description, formula_description, numerator_definition,
          denominator_definition, deduplication_key, unit, percentiles,
          reporting_timing, entity_scopes, time_granularities, minimum_sample,
          missing_policy, owner, definition_version, implementation_status,
          formula_ast, available_from, unavailable_reason, milestone, enabled)
       VALUES (?, ?, ?, 'system', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, TRUE)`,
      [
        randomUUID(),
        versionId,
        metric.metricKey,
        metric.category,
        metric.displayName,
        metric.businessDescription,
        metric.formulaDescription,
        metric.numeratorDescription,
        metric.denominatorDescription,
        metric.deduplicationKey,
        metric.unit,
        JSON.stringify(metric.percentiles),
        metric.reportingTiming,
        JSON.stringify(metric.entityScopes),
        JSON.stringify(metric.timeGranularities),
        metric.minimumSample,
        metric.missingPolicy,
        metric.owner,
        metric.definitionVersion,
        metric.implementationStatus,
        metric.availableFrom,
        metric.unavailableReason,
        metric.milestone,
      ],
    );
  }

  private async insertAudit(
    connection: PoolConnection,
    projectId: string,
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string | null,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO audit_logs
         (project_id, actor_user_id, action, entity_type, entity_id, metadata, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        actorUserId,
        action,
        entityType,
        entityId,
        JSON.stringify(metadata),
        randomUUID(),
      ],
    );
  }
}
