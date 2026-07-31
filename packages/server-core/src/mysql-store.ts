import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import mysql from "mysql2/promise";
import type {
  DataStatusRecord,
  ExpectedFrequency,
  FeatureRecord,
  FeatureType,
  GlobalRole,
  MetricDimensionKey,
  MetricProfileItem,
  MetricProfileRecord,
  ModuleRecord,
  PageDefinitionRecord,
  PageTemplate,
  Principal,
  ProjectIngestionConfig,
  ProjectOperationalSettings,
  ProjectRecord,
  ProjectRole,
} from "./model.js";

interface UserRow extends RowDataPacket {
  id: string;
  display_name: string;
  email: string | null;
  status: "active" | "disabled";
  global_role: GlobalRole;
  password_hash?: string | null;
}

function createPool(mysqlUrl: string): Pool {
  const url = new URL(mysqlUrl);
  if (url.protocol !== "mysql:") throw new Error("MYSQL_URL_PROTOCOL_INVALID");
  return mysql.createPool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    connectionLimit: 10,
    queueLimit: 100,
    waitForConnections: true,
    timezone: "Z",
  });
}

function projectFromRow(row: RowDataPacket, origins: string[] = []): ProjectRecord {
  return {
    id: String(row.id),
    projectKey: String(row.project_key),
    name: String(row.name),
    timezone: String(row.timezone),
    status: row.status as "active" | "disabled",
    retentionDays: Number(row.retention_days),
    origins,
    ...(row.role ? { role: row.role as ProjectRole } : {}),
  };
}

function featureFromRow(row: RowDataPacket): FeatureRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    featureKey: String(row.feature_key),
    name: String(row.name),
    description: row.description === null ? null : String(row.description),
    featureType: row.feature_type as FeatureType,
    pageDefinitionId: row.page_definition_id ? String(row.page_definition_id) : null,
    isKeyTask: Boolean(row.is_key_task),
    taskWeight: Number(row.task_weight ?? 1),
    taskTimeoutSeconds: Number(row.task_timeout_seconds ?? 900),
    operationLifecycleEnabled: Boolean(row.operation_lifecycle_enabled),
    configurationEffectiveFrom: new Date(
      (row.configuration_effective_from ??
        row.created_at ??
        "1970-01-01T00:00:00.000Z") as string,
    ).toISOString(),
    longViewSuccessAfterMs: Number(row.long_view_success_after_ms),
    heartbeatIntervalMs: Number(row.heartbeat_interval_ms),
    launchedAt: row.launched_at
      ? new Date(row.launched_at as string).toISOString()
      : null,
    status: row.status as "active" | "disabled",
  };
}

function moduleFromRow(row: RowDataPacket): ModuleRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    moduleKey: String(row.module_key),
    name: String(row.name),
    criticalityWeight: Number(row.criticality_weight),
    displayOrder: Number(row.display_order),
    status: row.status as "active" | "disabled",
    effectiveFrom: new Date(row.effective_from as string).toISOString(),
  };
}

function pageFromRow(row: RowDataPacket): PageDefinitionRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    moduleId: String(row.module_id),
    normalizedRoute: String(row.normalized_route),
    name: String(row.name),
    templateKey: row.template_key as PageTemplate,
    isCore: Boolean(row.is_core),
    criticalityWeight: Number(row.criticality_weight),
    expectedFrequency: row.expected_frequency as ExpectedFrequency,
    status: row.status as "active" | "disabled",
    effectiveFrom: new Date(row.effective_from as string).toISOString(),
  };
}

function parseWeekdays(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map(Number);
  }
  return [];
}

function operationalSettingsFromRow(row: RowDataPacket): ProjectOperationalSettings {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    version: Number(row.version),
    targetAccounts: row.target_accounts === null ? null : Number(row.target_accounts),
    expectedActiveWeekdays: parseWeekdays(row.expected_active_weekdays),
    status: row.status as "active" | "superseded",
    effectiveFrom: new Date(row.effective_from as string).toISOString(),
    effectiveTo: row.effective_to
      ? new Date(row.effective_to as string).toISOString()
      : null,
  };
}

function profileItemFromRow(row: RowDataPacket): MetricProfileItem {
  const optionalNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    metricKey: String(row.metric_key),
    dimensionKey: row.dimension_key as MetricDimensionKey,
    dimensionWeight: Number(row.dimension_weight),
    metricWeight: Number(row.metric_weight),
    targetValue: optionalNumber(row.target_value),
    floorValue: optionalNumber(row.floor_value),
    ceilingValue: optionalNumber(row.ceiling_value),
    targetMin: optionalNumber(row.target_min),
    targetMax: optionalNumber(row.target_max),
    toleranceMin: optionalNumber(row.tolerance_min),
    toleranceMax: optionalNumber(row.tolerance_max),
    minimumSample: optionalNumber(row.minimum_sample),
    enabled: Boolean(row.enabled),
    required: Boolean(row.required),
  };
}

export class MySqlStore {
  readonly pool: Pool;

  constructor(mysqlUrl: string) {
    this.pool = createPool(mysqlUrl);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async countUsers(): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM users",
    );
    return Number(rows[0]?.count ?? 0);
  }

  async createLocalUser(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    globalRole: GlobalRole;
  }): Promise<string> {
    const id = randomUUID();
    const identityId = randomUUID();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO users (id, display_name, email, status, global_role)
         VALUES (?, ?, ?, 'active', ?)`,
        [id, input.displayName, input.email, input.globalRole],
      );
      await connection.execute(
        `INSERT INTO identities (id, user_id, provider, subject, password_hash)
         VALUES (?, ?, 'local', ?, ?)`,
        [identityId, id, input.email.toLowerCase(), input.passwordHash],
      );
      await connection.commit();
      return id;
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async findLocalUser(
    email: string,
  ): Promise<(Principal & { passwordHash: string }) | null> {
    const [rows] = await this.pool.query<UserRow[]>(
      `SELECT u.id, u.display_name, u.email, u.status, u.global_role, i.password_hash
       FROM identities i
       JOIN users u ON u.id = i.user_id
       WHERE i.provider = 'local' AND i.subject = ?
       LIMIT 1`,
      [email.toLowerCase()],
    );
    const row = rows[0];
    if (!row || row.status !== "active" || !row.password_hash) return null;
    return {
      userId: row.id,
      globalRole: row.global_role,
      displayName: row.display_name,
      email: row.email,
      passwordHash: row.password_hash,
    };
  }

  async findPrincipal(userId: string): Promise<Principal | null> {
    const [rows] = await this.pool.query<UserRow[]>(
      `SELECT id, display_name, email, status, global_role
       FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );
    const row = rows[0];
    if (!row || row.status !== "active") return null;
    return {
      userId: row.id,
      globalRole: row.global_role,
      displayName: row.display_name,
      email: row.email,
    };
  }

  async listUsers(): Promise<Principal[]> {
    const [rows] = await this.pool.query<UserRow[]>(
      `SELECT id, display_name, email, status, global_role
       FROM users WHERE status = 'active' ORDER BY display_name, id`,
    );
    return rows.map((row) => ({
      userId: row.id,
      globalRole: row.global_role,
      displayName: row.display_name,
      email: row.email,
    }));
  }

  async createSession(input: {
    userId: string;
    refreshTokenHash: string;
    expiresAt: Date;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.execute(
      `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at)
       VALUES (?, ?, ?, ?)`,
      [id, input.userId, input.refreshTokenHash, input.expiresAt],
    );
    return id;
  }

  async consumeSession(refreshTokenHash: string): Promise<Principal | null> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<UserRow[]>(
        `SELECT u.id, u.display_name, u.email, u.status, u.global_role
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.refresh_token_hash = ?
           AND s.revoked_at IS NULL
           AND s.expires_at > CURRENT_TIMESTAMP(3)
         LIMIT 1 FOR UPDATE`,
        [refreshTokenHash],
      );
      const row = rows[0];
      if (!row || row.status !== "active") {
        await connection.rollback();
        return null;
      }
      await connection.execute(
        `UPDATE auth_sessions
         SET last_seen_at = CURRENT_TIMESTAMP(3), revoked_at = CURRENT_TIMESTAMP(3)
         WHERE refresh_token_hash = ? AND revoked_at IS NULL`,
        [refreshTokenHash],
      );
      await connection.commit();
      return {
        userId: row.id,
        globalRole: row.global_role,
        displayName: row.display_name,
        email: row.email,
      };
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async revokeSession(refreshTokenHash: string): Promise<void> {
    await this.pool.execute(
      `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP(3)
       WHERE refresh_token_hash = ? AND revoked_at IS NULL`,
      [refreshTokenHash],
    );
  }

  async listProjects(principal: Principal): Promise<ProjectRecord[]> {
    const admin = principal.globalRole === "admin";
    const [rows] = await this.pool.query<RowDataPacket[]>(
      admin
        ? `SELECT p.*, 'admin' AS role FROM projects p ORDER BY p.created_at DESC`
        : `SELECT p.*, pm.role
           FROM projects p JOIN project_members pm ON pm.project_id = p.id
           WHERE pm.user_id = ? ORDER BY p.created_at DESC`,
      admin ? [] : [principal.userId],
    );
    const projects = await Promise.all(
      rows.map(async (row) =>
        projectFromRow(row, await this.listOrigins(String(row.id))),
      ),
    );
    return projects;
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM projects WHERE id = ? LIMIT 1",
      [projectId],
    );
    const row = rows[0];
    return row ? projectFromRow(row, await this.listOrigins(projectId)) : null;
  }

  async getProjectRole(
    principal: Principal,
    projectId: string,
  ): Promise<ProjectRole | null> {
    if (principal.globalRole === "admin") {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        "SELECT id FROM projects WHERE id = ? LIMIT 1",
        [projectId],
      );
      return rows[0] ? "admin" : null;
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT pm.role FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       WHERE pm.user_id = ? AND pm.project_id = ? AND p.status = 'active'
       LIMIT 1`,
      [principal.userId, projectId],
    );
    return rows[0] ? (rows[0].role as ProjectRole) : null;
  }

  async listProjectMembers(
    projectId: string,
  ): Promise<Array<Principal & { projectRole: ProjectRole }>> {
    const [rows] = await this.pool.query<UserRow[]>(
      `SELECT u.id, u.display_name, u.email, u.status, u.global_role, pm.role
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ? AND u.status = 'active'
       ORDER BY u.display_name, u.id`,
      [projectId],
    );
    return rows.map((row) => ({
      userId: row.id,
      globalRole: row.global_role,
      displayName: row.display_name,
      email: row.email,
      projectRole: row.role as ProjectRole,
    }));
  }

  async setProjectMember(input: {
    projectId: string;
    userId: string;
    role: ProjectRole;
    actor: Principal;
  }): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [members] = await connection.query<RowDataPacket[]>(
        `SELECT role FROM project_members
         WHERE project_id = ? AND user_id = ? FOR UPDATE`,
        [input.projectId, input.userId],
      );
      if (members[0]?.role === "owner" && input.role !== "owner") {
        const [owners] = await connection.query<RowDataPacket[]>(
          `SELECT user_id FROM project_members
           WHERE project_id = ? AND role = 'owner' FOR UPDATE`,
          [input.projectId],
        );
        if (owners.length <= 1) throw new Error("LAST_OWNER_REQUIRED");
      }
      await connection.execute(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
        [input.projectId, input.userId, input.role],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "project.member.updated",
        entityType: "project_member",
        entityId: input.userId,
        metadata: { role: input.role },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async removeProjectMember(input: {
    projectId: string;
    userId: string;
    actor: Principal;
  }): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [members] = await connection.query<RowDataPacket[]>(
        `SELECT role FROM project_members
         WHERE project_id = ? AND user_id = ? FOR UPDATE`,
        [input.projectId, input.userId],
      );
      if (!members[0]) throw new Error("MEMBERSHIP_NOT_FOUND");
      if (members[0].role === "owner") {
        const [owners] = await connection.query<RowDataPacket[]>(
          `SELECT user_id FROM project_members
           WHERE project_id = ? AND role = 'owner' FOR UPDATE`,
          [input.projectId],
        );
        if (owners.length <= 1) {
          throw new Error("LAST_OWNER_REQUIRED");
        }
      }
      await connection.execute(
        "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
        [input.projectId, input.userId],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "project.member.removed",
        entityType: "project_member",
        entityId: input.userId,
        metadata: {},
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async createProject(input: {
    name: string;
    timezone: string;
    retentionDays: number;
    origins: string[];
    actor: Principal;
  }): Promise<ProjectRecord> {
    const id = randomUUID();
    const projectKey = `fi_public_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO projects
           (id, project_key, name, timezone, status, retention_days, created_by_user_id)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [
          id,
          projectKey,
          input.name,
          input.timezone,
          input.retentionDays,
          input.actor.userId,
        ],
      );
      await connection.execute(
        `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')`,
        [id, input.actor.userId],
      );
      await this.replaceOrigins(connection, id, input.origins);
      await connection.execute(
        "INSERT INTO project_data_status (project_id) VALUES (?)",
        [id],
      );
      await this.insertAudit(connection, {
        projectId: id,
        actorUserId: input.actor.userId,
        action: "project.created",
        entityType: "project",
        entityId: id,
        metadata: { origins: input.origins.length },
      });
      await connection.commit();
      return {
        id,
        projectKey,
        name: input.name,
        timezone: input.timezone,
        status: "active",
        retentionDays: input.retentionDays,
        origins: input.origins,
        role: "owner",
      };
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async updateProject(
    projectId: string,
    input: {
      name?: string | undefined;
      timezone?: string | undefined;
      retentionDays?: number | undefined;
      origins?: string[] | undefined;
      status?: "active" | "disabled" | undefined;
      actor: Principal;
    },
  ): Promise<ProjectRecord> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const assignments: string[] = [];
      const values: Array<string | number | Date | null> = [];
      if (input.name !== undefined) {
        assignments.push("name = ?");
        values.push(input.name);
      }
      if (input.timezone !== undefined) {
        assignments.push("timezone = ?");
        values.push(input.timezone);
      }
      if (input.retentionDays !== undefined) {
        assignments.push("retention_days = ?");
        values.push(input.retentionDays);
      }
      if (input.status !== undefined) {
        assignments.push("status = ?", "disabled_at = ?");
        values.push(input.status, input.status === "disabled" ? new Date() : null);
      }
      if (assignments.length) {
        await connection.execute(
          `UPDATE projects SET ${assignments.join(", ")} WHERE id = ?`,
          [...values, projectId],
        );
      }
      if (input.origins !== undefined) {
        await this.replaceOrigins(connection, projectId, input.origins);
      }
      await this.insertAudit(connection, {
        projectId,
        actorUserId: input.actor.userId,
        action: "project.updated",
        entityType: "project",
        entityId: projectId,
        metadata: {
          changedFields: Object.keys(input).filter((key) => key !== "actor"),
        },
      });
      await connection.commit();
      const project = await this.getProject(projectId);
      if (!project) throw new Error("PROJECT_NOT_FOUND");
      return project;
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  private async listOrigins(projectId: string): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT origin FROM project_origins
       WHERE project_id = ? AND enabled = TRUE ORDER BY origin`,
      [projectId],
    );
    return rows.map((row) => String(row.origin));
  }

  private async replaceOrigins(
    connection: PoolConnection,
    projectId: string,
    origins: string[],
  ): Promise<void> {
    await connection.execute(
      "UPDATE project_origins SET enabled = FALSE WHERE project_id = ?",
      [projectId],
    );
    for (const origin of origins) {
      await connection.execute(
        `INSERT INTO project_origins (id, project_id, origin, enabled)
         VALUES (?, ?, ?, TRUE)
         ON DUPLICATE KEY UPDATE enabled = TRUE`,
        [randomUUID(), projectId, origin],
      );
    }
  }

  async listModules(projectId: string): Promise<ModuleRecord[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM project_modules
       WHERE project_id = ?
       ORDER BY display_order, name, id`,
      [projectId],
    );
    return rows.map(moduleFromRow);
  }

  async createModule(input: {
    projectId: string;
    moduleKey: string;
    name: string;
    criticalityWeight: number;
    displayOrder: number;
    effectiveFrom?: string | undefined;
    actor: Principal;
  }): Promise<ModuleRecord> {
    const id = randomUUID();
    await this.pool.execute(
      `INSERT INTO project_modules
         (id, project_id, module_key, name, criticality_weight, display_order,
          status, effective_from)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        id,
        input.projectId,
        input.moduleKey,
        input.name,
        input.criticalityWeight,
        input.displayOrder,
        input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
      ],
    );
    await this.audit({
      projectId: input.projectId,
      actorUserId: input.actor.userId,
      action: "module.created",
      entityType: "module",
      entityId: id,
      metadata: {
        moduleKey: input.moduleKey,
        effectiveFrom: input.effectiveFrom ?? null,
      },
    });
    return (await this.listModules(input.projectId)).find((item) => item.id === id)!;
  }

  async updateModule(
    projectId: string,
    moduleId: string,
    input: {
      name?: string | undefined;
      criticalityWeight?: number | undefined;
      displayOrder?: number | undefined;
      status?: "active" | "disabled" | undefined;
      effectiveFrom?: string | undefined;
      actor: Principal;
    },
  ): Promise<ModuleRecord> {
    const assignments: string[] = [];
    const values: Array<string | number | Date | null> = [];
    const columns: Array<
      [keyof typeof input, string, (value: unknown) => string | number | Date]
    > = [
      ["name", "name", String],
      ["criticalityWeight", "criticality_weight", Number],
      ["displayOrder", "display_order", Number],
      ["status", "status", String],
      ["effectiveFrom", "effective_from", (value) => new Date(String(value))],
    ];
    for (const [key, column, transform] of columns) {
      if (input[key] !== undefined) {
        assignments.push(`${column} = ?`);
        values.push(transform(input[key]));
      }
    }
    if (input.status !== undefined) {
      assignments.push("disabled_at = ?");
      values.push(input.status === "disabled" ? new Date() : null);
    }
    if (assignments.length) {
      const [result] = await this.pool.execute(
        `UPDATE project_modules SET ${assignments.join(", ")}
         WHERE id = ? AND project_id = ?`,
        [...values, moduleId, projectId],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) {
        throw new Error("MODULE_NOT_FOUND");
      }
    }
    await this.audit({
      projectId,
      actorUserId: input.actor.userId,
      action: "module.updated",
      entityType: "module",
      entityId: moduleId,
      metadata: { changedFields: Object.keys(input).filter((key) => key !== "actor") },
    });
    const module = (await this.listModules(projectId)).find(
      (item) => item.id === moduleId,
    );
    if (!module) throw new Error("MODULE_NOT_FOUND");
    return module;
  }

  async listPageDefinitions(projectId: string): Promise<PageDefinitionRecord[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM page_definitions
       WHERE project_id = ?
       ORDER BY name, normalized_route, id`,
      [projectId],
    );
    return rows.map(pageFromRow);
  }

  async createPageDefinition(input: {
    projectId: string;
    moduleId: string;
    normalizedRoute: string;
    name: string;
    templateKey: PageTemplate;
    isCore: boolean;
    criticalityWeight: number;
    expectedFrequency: ExpectedFrequency;
    effectiveFrom?: string | undefined;
    actor: Principal;
  }): Promise<PageDefinitionRecord> {
    const module = (await this.listModules(input.projectId)).find(
      (item) => item.id === input.moduleId,
    );
    if (!module) throw new Error("MODULE_NOT_FOUND");
    const id = randomUUID();
    await this.pool.execute(
      `INSERT INTO page_definitions
         (id, project_id, module_id, normalized_route, name, template_key,
          is_core, criticality_weight, expected_frequency, status, effective_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        id,
        input.projectId,
        input.moduleId,
        input.normalizedRoute,
        input.name,
        input.templateKey,
        input.isCore,
        input.criticalityWeight,
        input.expectedFrequency,
        input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
      ],
    );
    await this.audit({
      projectId: input.projectId,
      actorUserId: input.actor.userId,
      action: "page_definition.created",
      entityType: "page",
      entityId: id,
      metadata: {
        normalizedRoute: input.normalizedRoute,
        templateKey: input.templateKey,
      },
    });
    return (await this.listPageDefinitions(input.projectId)).find(
      (item) => item.id === id,
    )!;
  }

  async updatePageDefinition(
    projectId: string,
    pageId: string,
    input: {
      moduleId?: string | undefined;
      name?: string | undefined;
      templateKey?: PageTemplate | undefined;
      isCore?: boolean | undefined;
      criticalityWeight?: number | undefined;
      expectedFrequency?: ExpectedFrequency | undefined;
      status?: "active" | "disabled" | undefined;
      effectiveFrom?: string | undefined;
      actor: Principal;
    },
  ): Promise<PageDefinitionRecord> {
    if (
      input.moduleId &&
      !(await this.listModules(projectId)).some((item) => item.id === input.moduleId)
    ) {
      throw new Error("MODULE_NOT_FOUND");
    }
    const assignments: string[] = [];
    const values: Array<string | number | boolean | Date | null> = [];
    const columns: Array<
      [keyof typeof input, string, (value: unknown) => string | number | boolean | Date]
    > = [
      ["moduleId", "module_id", String],
      ["name", "name", String],
      ["templateKey", "template_key", String],
      ["isCore", "is_core", Boolean],
      ["criticalityWeight", "criticality_weight", Number],
      ["expectedFrequency", "expected_frequency", String],
      ["status", "status", String],
      ["effectiveFrom", "effective_from", (value) => new Date(String(value))],
    ];
    for (const [key, column, transform] of columns) {
      if (input[key] !== undefined) {
        assignments.push(`${column} = ?`);
        values.push(transform(input[key]));
      }
    }
    if (input.status !== undefined) {
      assignments.push("disabled_at = ?");
      values.push(input.status === "disabled" ? new Date() : null);
    }
    if (assignments.length) {
      const [result] = await this.pool.execute(
        `UPDATE page_definitions SET ${assignments.join(", ")}
         WHERE id = ? AND project_id = ?`,
        [...values, pageId, projectId],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) {
        throw new Error("PAGE_DEFINITION_NOT_FOUND");
      }
    }
    await this.audit({
      projectId,
      actorUserId: input.actor.userId,
      action: "page_definition.updated",
      entityType: "page",
      entityId: pageId,
      metadata: { changedFields: Object.keys(input).filter((key) => key !== "actor") },
    });
    const page = (await this.listPageDefinitions(projectId)).find(
      (item) => item.id === pageId,
    );
    if (!page) throw new Error("PAGE_DEFINITION_NOT_FOUND");
    return page;
  }

  async getOperationalSettings(
    projectId: string,
    at = new Date(),
  ): Promise<ProjectOperationalSettings | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM project_operational_settings
       WHERE project_id = ?
         AND effective_from <= ?
         AND (effective_to IS NULL OR effective_to > ?)
       ORDER BY version DESC LIMIT 1`,
      [projectId, at, at],
    );
    return rows[0] ? operationalSettingsFromRow(rows[0]) : null;
  }

  async listOperationalSettings(
    projectId: string,
  ): Promise<ProjectOperationalSettings[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM project_operational_settings
       WHERE project_id = ? ORDER BY version DESC`,
      [projectId],
    );
    return rows.map(operationalSettingsFromRow);
  }

  async createOperationalSettingsVersion(input: {
    projectId: string;
    targetAccounts: number | null;
    expectedActiveWeekdays: number[];
    effectiveFrom?: string | undefined;
    actor: Principal;
  }): Promise<ProjectOperationalSettings> {
    const id = randomUUID();
    const effectiveFrom = input.effectiveFrom
      ? new Date(input.effectiveFrom)
      : new Date();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("SELECT id FROM projects WHERE id = ? FOR UPDATE", [
        input.projectId,
      ]);
      const [versionRows] = await connection.query<RowDataPacket[]>(
        `SELECT
           COALESCE(MAX(version), 0) + 1 AS next_version,
           MAX(effective_from) AS latest_effective_from
         FROM project_operational_settings
         WHERE project_id = ? FOR UPDATE`,
        [input.projectId],
      );
      const latestEffectiveFrom = versionRows[0]?.latest_effective_from;
      if (
        latestEffectiveFrom &&
        effectiveFrom <= new Date(latestEffectiveFrom as string)
      ) {
        throw new Error("SETTINGS_EFFECTIVE_FROM_NOT_AFTER_LATEST");
      }
      const version = Number(versionRows[0]?.next_version ?? 1);
      await connection.execute(
        `UPDATE project_operational_settings
         SET status = 'superseded', effective_to = ?
         WHERE project_id = ? AND status = 'active' AND effective_from < ?`,
        [effectiveFrom, input.projectId, effectiveFrom],
      );
      await connection.execute(
        `INSERT INTO project_operational_settings
           (id, project_id, version, target_accounts, expected_active_weekdays,
            status, effective_from, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          id,
          input.projectId,
          version,
          input.targetAccounts,
          JSON.stringify(input.expectedActiveWeekdays),
          effectiveFrom,
          input.actor.userId,
        ],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "operational_settings.version_created",
        entityType: "project_operational_settings",
        entityId: id,
        metadata: {
          version,
          effectiveFrom: effectiveFrom.toISOString(),
          targetAccountsConfigured: input.targetAccounts !== null,
          expectedActiveWeekdays: input.expectedActiveWeekdays,
        },
      });
      await connection.commit();
      return {
        id,
        projectId: input.projectId,
        version,
        targetAccounts: input.targetAccounts,
        expectedActiveWeekdays: [...input.expectedActiveWeekdays],
        status: "active",
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveTo: null,
      };
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  private async profileItems(profileId: string): Promise<MetricProfileItem[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM metric_profile_items
       WHERE profile_id = ? ORDER BY dimension_key, metric_key`,
      [profileId],
    );
    return rows.map(profileItemFromRow);
  }

  async listMetricProfiles(projectId: string): Promise<MetricProfileRecord[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM metric_profiles
       WHERE project_id = ? ORDER BY profile_key, version DESC`,
      [projectId],
    );
    return Promise.all(
      rows.map(async (row) => ({
        id: String(row.id),
        projectId: String(row.project_id),
        profileKey: String(row.profile_key),
        name: String(row.name),
        version: Number(row.version),
        status: row.status as "draft" | "active" | "retired",
        effectiveFrom: row.effective_from
          ? new Date(row.effective_from as string).toISOString()
          : null,
        items: await this.profileItems(String(row.id)),
      })),
    );
  }

  async getActiveMetricProfile(
    projectId: string,
    at = new Date(),
  ): Promise<MetricProfileRecord | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT p.*
       FROM metric_profile_assignments a
       JOIN metric_profiles p ON p.id = a.profile_id
       WHERE a.project_id = ?
         AND a.entity_type = 'project'
         AND a.entity_id = ?
         AND a.effective_from <= ?
         AND (a.effective_to IS NULL OR a.effective_to > ?)
       ORDER BY a.effective_from DESC LIMIT 1`,
      [projectId, projectId, at, at],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      profileKey: String(row.profile_key),
      name: String(row.name),
      version: Number(row.version),
      status: "active",
      effectiveFrom: row.effective_from
        ? new Date(row.effective_from as string).toISOString()
        : null,
      items: await this.profileItems(String(row.id)),
    };
  }

  async createMetricProfileVersion(input: {
    projectId: string;
    profileKey: string;
    name: string;
    sourceProfileId?: string | undefined;
    items?: Array<Omit<MetricProfileItem, "id" | "profileId">> | undefined;
    actor: Principal;
  }): Promise<MetricProfileRecord> {
    const id = randomUUID();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("SELECT id FROM projects WHERE id = ? FOR UPDATE", [
        input.projectId,
      ]);
      const [versionRows] = await connection.query<RowDataPacket[]>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM metric_profiles
         WHERE project_id = ? AND profile_key = ? FOR UPDATE`,
        [input.projectId, input.profileKey],
      );
      const version = Number(versionRows[0]?.next_version ?? 1);
      let items = input.items;
      if (!items && input.sourceProfileId) {
        const [sourceRows] = await connection.query<RowDataPacket[]>(
          `SELECT i.* FROM metric_profile_items i
           JOIN metric_profiles p ON p.id = i.profile_id
           WHERE i.profile_id = ? AND p.project_id = ?`,
          [input.sourceProfileId, input.projectId],
        );
        if (!sourceRows.length) throw new Error("METRIC_PROFILE_SOURCE_NOT_FOUND");
        items = sourceRows.map((row) => {
          const item = profileItemFromRow(row);
          const { id: _id, profileId: _profileId, ...copy } = item;
          void _id;
          void _profileId;
          return copy;
        });
      }
      if (!items?.length) throw new Error("METRIC_PROFILE_ITEMS_REQUIRED");
      await connection.execute(
        `INSERT INTO metric_profiles
           (id, project_id, profile_key, name, version, status, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
        [
          id,
          input.projectId,
          input.profileKey,
          input.name,
          version,
          input.actor.userId,
        ],
      );
      for (const item of items) {
        await connection.execute(
          `INSERT INTO metric_profile_items
             (id, profile_id, metric_key, dimension_key, dimension_weight,
              metric_weight, target_value, floor_value, ceiling_value,
              target_min, target_max, tolerance_min, tolerance_max,
              minimum_sample, enabled, required)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            id,
            item.metricKey,
            item.dimensionKey,
            item.dimensionWeight,
            item.metricWeight,
            item.targetValue,
            item.floorValue,
            item.ceilingValue,
            item.targetMin,
            item.targetMax,
            item.toleranceMin,
            item.toleranceMax,
            item.minimumSample,
            item.enabled,
            item.required,
          ],
        );
      }
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "metric_profile.version_created",
        entityType: "metric_profile",
        entityId: id,
        metadata: {
          profileKey: input.profileKey,
          version,
          sourceProfileId: input.sourceProfileId ?? null,
        },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    return (await this.listMetricProfiles(input.projectId)).find(
      (item) => item.id === id,
    )!;
  }

  async activateMetricProfile(input: {
    projectId: string;
    profileId: string;
    effectiveFrom?: string | undefined;
    actor: Principal;
  }): Promise<MetricProfileRecord> {
    const effectiveFrom = input.effectiveFrom
      ? new Date(input.effectiveFrom)
      : new Date();
    const assignmentId = randomUUID();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("SELECT id FROM projects WHERE id = ? FOR UPDATE", [
        input.projectId,
      ]);
      const [profileRows] = await connection.query<RowDataPacket[]>(
        `SELECT * FROM metric_profiles
         WHERE id = ? AND project_id = ? FOR UPDATE`,
        [input.profileId, input.projectId],
      );
      const profile = profileRows[0];
      if (!profile) throw new Error("METRIC_PROFILE_NOT_FOUND");
      if (profile.status !== "draft") {
        throw new Error("METRIC_PROFILE_NOT_DRAFT");
      }
      const [assignmentRows] = await connection.query<RowDataPacket[]>(
        `SELECT MAX(effective_from) AS latest_effective_from
         FROM metric_profile_assignments
         WHERE project_id = ? AND entity_type = 'project' AND entity_id = ?`,
        [input.projectId, input.projectId],
      );
      const latestEffectiveFrom = assignmentRows[0]?.latest_effective_from;
      if (
        latestEffectiveFrom &&
        effectiveFrom <= new Date(latestEffectiveFrom as string)
      ) {
        throw new Error("PROFILE_EFFECTIVE_FROM_NOT_AFTER_LATEST");
      }
      await connection.execute(
        `UPDATE metric_profiles
         SET status = 'retired'
         WHERE project_id = ? AND status = 'active'`,
        [input.projectId],
      );
      await connection.execute(
        `UPDATE metric_profiles
         SET status = 'active', effective_from = ?
         WHERE id = ? AND project_id = ?`,
        [effectiveFrom, input.profileId, input.projectId],
      );
      await connection.execute(
        `UPDATE metric_profile_assignments
         SET effective_to = ?
         WHERE project_id = ? AND entity_type = 'project'
           AND entity_id = ? AND effective_to IS NULL`,
        [effectiveFrom, input.projectId, input.projectId],
      );
      await connection.execute(
        `INSERT INTO metric_profile_assignments
           (id, project_id, entity_type, entity_id, profile_id, effective_from,
            created_by_user_id)
         VALUES (?, ?, 'project', ?, ?, ?, ?)`,
        [
          assignmentId,
          input.projectId,
          input.projectId,
          input.profileId,
          effectiveFrom,
          input.actor.userId,
        ],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "metric_profile.activated",
        entityType: "metric_profile",
        entityId: input.profileId,
        metadata: {
          assignmentId,
          effectiveFrom: effectiveFrom.toISOString(),
        },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    return (await this.listMetricProfiles(input.projectId)).find(
      (item) => item.id === input.profileId,
    )!;
  }

  async retireMetricProfile(input: {
    projectId: string;
    profileId: string;
    actor: Principal;
  }): Promise<void> {
    const retiredAt = new Date();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("SELECT id FROM projects WHERE id = ? FOR UPDATE", [
        input.projectId,
      ]);
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT id, status FROM metric_profiles
         WHERE id = ? AND project_id = ? FOR UPDATE`,
        [input.profileId, input.projectId],
      );
      if (!rows[0]) throw new Error("METRIC_PROFILE_NOT_FOUND");
      if (rows[0].status === "retired") {
        throw new Error("METRIC_PROFILE_ALREADY_RETIRED");
      }
      await connection.execute(
        `UPDATE metric_profile_assignments
         SET effective_to =
           CASE WHEN effective_from > ? THEN effective_from ELSE ? END
         WHERE project_id = ? AND profile_id = ? AND effective_to IS NULL`,
        [retiredAt, retiredAt, input.projectId, input.profileId],
      );
      await connection.execute(
        `UPDATE metric_profiles SET status = 'retired'
         WHERE id = ? AND project_id = ?`,
        [input.profileId, input.projectId],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "metric_profile.retired",
        entityType: "metric_profile",
        entityId: input.profileId,
        metadata: { retiredAt: retiredAt.toISOString() },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async listFeatures(projectId: string): Promise<FeatureRecord[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM features WHERE project_id = ? ORDER BY created_at",
      [projectId],
    );
    return rows.map(featureFromRow);
  }

  async createFeature(input: {
    projectId: string;
    featureKey: string;
    name: string;
    description?: string | undefined;
    featureType: FeatureType;
    longViewSuccessAfterMs: number;
    heartbeatIntervalMs: number;
    launchedAt?: string | undefined;
    pageDefinitionId?: string | null | undefined;
    isKeyTask?: boolean | undefined;
    taskWeight?: number | undefined;
    taskTimeoutSeconds?: number | undefined;
    operationLifecycleEnabled?: boolean | undefined;
    configurationEffectiveFrom?: string | undefined;
    actor: Principal;
  }): Promise<FeatureRecord> {
    if (
      input.pageDefinitionId &&
      !(await this.listPageDefinitions(input.projectId)).some(
        (item) => item.id === input.pageDefinitionId,
      )
    ) {
      throw new Error("PAGE_DEFINITION_NOT_FOUND");
    }
    const id = randomUUID();
    await this.pool.execute(
      `INSERT INTO features
         (id, project_id, feature_key, name, description, feature_type,
          page_definition_id, is_key_task, task_weight, task_timeout_seconds,
          operation_lifecycle_enabled, configuration_effective_from,
          long_view_success_after_ms, heartbeat_interval_ms, launched_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        id,
        input.projectId,
        input.featureKey,
        input.name,
        input.description ?? null,
        input.featureType,
        input.pageDefinitionId ?? null,
        input.isKeyTask ?? false,
        input.taskWeight ?? 1,
        input.taskTimeoutSeconds ?? 900,
        input.operationLifecycleEnabled ?? false,
        input.configurationEffectiveFrom
          ? new Date(input.configurationEffectiveFrom)
          : new Date(),
        input.longViewSuccessAfterMs,
        input.heartbeatIntervalMs,
        input.launchedAt ? new Date(input.launchedAt) : null,
      ],
    );
    await this.audit({
      projectId: input.projectId,
      actorUserId: input.actor.userId,
      action: "feature.created",
      entityType: "feature",
      entityId: id,
      metadata: { featureKey: input.featureKey, featureType: input.featureType },
    });
    return (await this.listFeatures(input.projectId)).find(
      (feature) => feature.id === id,
    )!;
  }

  async updateFeature(
    projectId: string,
    featureId: string,
    input: {
      name?: string | undefined;
      description?: string | null | undefined;
      status?: "active" | "disabled" | undefined;
      longViewSuccessAfterMs?: number | undefined;
      heartbeatIntervalMs?: number | undefined;
      launchedAt?: string | null | undefined;
      pageDefinitionId?: string | null | undefined;
      isKeyTask?: boolean | undefined;
      taskWeight?: number | undefined;
      taskTimeoutSeconds?: number | undefined;
      operationLifecycleEnabled?: boolean | undefined;
      configurationEffectiveFrom?: string | undefined;
      actor: Principal;
    },
  ): Promise<FeatureRecord> {
    if (
      input.pageDefinitionId &&
      !(await this.listPageDefinitions(projectId)).some(
        (item) => item.id === input.pageDefinitionId,
      )
    ) {
      throw new Error("PAGE_DEFINITION_NOT_FOUND");
    }
    const assignments: string[] = [];
    const values: Array<string | number | Date | null> = [];
    const columns: Array<
      [keyof typeof input, string, (value: unknown) => string | number | Date | null]
    > = [
      ["name", "name", (value) => String(value)],
      [
        "description",
        "description",
        (value) => (value === null ? null : String(value)),
      ],
      ["status", "status", (value) => String(value)],
      [
        "longViewSuccessAfterMs",
        "long_view_success_after_ms",
        (value) => Number(value),
      ],
      ["heartbeatIntervalMs", "heartbeat_interval_ms", (value) => Number(value)],
      [
        "pageDefinitionId",
        "page_definition_id",
        (value) => (value === null ? null : String(value)),
      ],
      ["isKeyTask", "is_key_task", (value) => (value ? 1 : 0)],
      ["taskWeight", "task_weight", (value) => Number(value)],
      ["taskTimeoutSeconds", "task_timeout_seconds", (value) => Number(value)],
      [
        "operationLifecycleEnabled",
        "operation_lifecycle_enabled",
        (value) => (value ? 1 : 0),
      ],
      [
        "configurationEffectiveFrom",
        "configuration_effective_from",
        (value) => new Date(String(value)),
      ],
      [
        "launchedAt",
        "launched_at",
        (value) => (value ? new Date(String(value)) : null),
      ],
    ];
    for (const [key, column, transform] of columns) {
      if (input[key] !== undefined) {
        assignments.push(`${column} = ?`);
        values.push(transform(input[key]));
      }
    }
    if (input.status !== undefined) {
      assignments.push("disabled_at = ?");
      values.push(input.status === "disabled" ? new Date() : null);
    }
    if (assignments.length) {
      const [result] = await this.pool.execute(
        `UPDATE features SET ${assignments.join(", ")}
         WHERE id = ? AND project_id = ?`,
        [...values, featureId, projectId],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) {
        throw new Error("FEATURE_NOT_FOUND");
      }
    }
    await this.audit({
      projectId,
      actorUserId: input.actor.userId,
      action: "feature.updated",
      entityType: "feature",
      entityId: featureId,
      metadata: { changedFields: Object.keys(input).filter((key) => key !== "actor") },
    });
    const feature = (await this.listFeatures(projectId)).find(
      (item) => item.id === featureId,
    );
    if (!feature) throw new Error("FEATURE_NOT_FOUND");
    return feature;
  }

  async getIngestionProject(
    projectKey: string,
  ): Promise<ProjectIngestionConfig | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM projects WHERE project_key = ? LIMIT 1",
      [projectKey],
    );
    const row = rows[0];
    if (!row) return null;
    const project = projectFromRow(row, await this.listOrigins(String(row.id)));
    return { ...project, features: await this.listFeatures(project.id) };
  }

  async markReceived(input: {
    projectId: string;
    requestId: string;
    sdkVersion: string;
    eventCount: number;
  }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO project_data_status
         (project_id, last_received_at, last_request_id, last_sdk_version, accepted_events)
       VALUES (?, CURRENT_TIMESTAMP(3), ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         last_received_at = CURRENT_TIMESTAMP(3),
         last_request_id = VALUES(last_request_id),
         last_sdk_version = VALUES(last_sdk_version),
         accepted_events = accepted_events + VALUES(accepted_events),
         last_rejection_code = NULL`,
      [input.projectId, input.requestId, input.sdkVersion, input.eventCount],
    );
  }

  async markRejected(
    projectId: string,
    code: string,
    eventCount: number,
  ): Promise<void> {
    await this.pool.execute(
      `INSERT INTO project_data_status
         (project_id, last_rejection_code, rejected_events)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         last_rejection_code = VALUES(last_rejection_code),
         rejected_events = rejected_events + VALUES(rejected_events)`,
      [projectId, code, eventCount],
    );
  }

  async markIngested(projectId: string, receivedAt: string): Promise<void> {
    await this.pool.execute(
      `INSERT INTO project_data_status
         (project_id, last_ingested_at, last_queryable_at)
       VALUES (?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         last_ingested_at = VALUES(last_ingested_at),
         last_queryable_at = CURRENT_TIMESTAMP(3)`,
      [projectId, new Date(receivedAt)],
    );
  }

  async markDeadLetter(projectId: string): Promise<void> {
    await this.pool.execute(
      `INSERT INTO project_data_status (project_id, dead_letter_events)
       VALUES (?, 1)
       ON DUPLICATE KEY UPDATE dead_letter_events = dead_letter_events + 1`,
      [projectId],
    );
  }

  async getDataStatus(projectId: string): Promise<DataStatusRecord> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM project_data_status WHERE project_id = ? LIMIT 1",
      [projectId],
    );
    const row: RowDataPacket = rows[0] ?? ({} as RowDataPacket);
    const timestamp = (value: unknown): string | null =>
      value ? new Date(value as string).toISOString() : null;
    return {
      projectId,
      lastReceivedAt: timestamp(row.last_received_at),
      lastIngestedAt: timestamp(row.last_ingested_at),
      lastQueryableAt: timestamp(row.last_queryable_at),
      lastRequestId: row.last_request_id ? String(row.last_request_id) : null,
      lastSdkVersion: row.last_sdk_version ? String(row.last_sdk_version) : null,
      lastRejectionCode: row.last_rejection_code
        ? String(row.last_rejection_code)
        : null,
      acceptedEvents: Number(row.accepted_events ?? 0),
      rejectedEvents: Number(row.rejected_events ?? 0),
      deadLetterEvents: Number(row.dead_letter_events ?? 0),
    };
  }

  async onboardingStatus(projectId: string): Promise<DataStatusRecord> {
    return this.getDataStatus(projectId);
  }

  async audit(input: {
    projectId: string | null;
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.insertAudit(this.pool, input);
  }

  private async insertAudit(
    executor: Pick<Pool | PoolConnection, "execute">,
    input: {
      projectId: string | null;
      actorUserId: string | null;
      action: string;
      entityType: string;
      entityId: string | null;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await executor.execute(
      `INSERT INTO audit_logs
         (project_id, actor_user_id, action, entity_type, entity_id, metadata, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.projectId,
        input.actorUserId,
        input.action,
        input.entityType,
        input.entityId,
        JSON.stringify(input.metadata),
        randomUUID(),
      ],
    );
  }
}
