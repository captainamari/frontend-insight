import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import mysql from "mysql2/promise";
import { MetricLibraryError } from "./metric-library.js";
import { scoreDigest } from "./score-storage.js";
import { AnalysisObjectLifecycleError } from "./analysis-objects.js";
import type {
  DataStatusRecord,
  ExpectedFrequency,
  FeatureRecord,
  FeatureType,
  GlobalRole,
  ModuleRecord,
  PageDefinitionRecord,
  PageTemplate,
  Principal,
  ProjectIngestionConfig,
  ProjectOperationalSettings,
  ProjectRecord,
  ProjectRole,
  WorkflowDefinitionRecord,
  WorkflowDefinitionVersionRecord,
  WorkflowStartPolicy,
  WorkflowStepInput,
  WorkflowStepRecord,
  WorkflowTerminalPolicy,
  WorkflowTriggerKind,
  WorkflowVersionStatus,
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
    appId: String(row.app_id),
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
    displayOrder: Number(row.display_order),
    status: (row.revision_status ?? row.status) as "active" | "disabled",
    archivedAt: row.archived_at
      ? new Date(row.archived_at as string).toISOString()
      : null,
    revisionId: String(row.revision_id),
    revision: Number(row.revision),
    effectiveFrom: new Date(row.effective_from as string).toISOString(),
    effectiveTo: row.effective_to
      ? new Date(row.effective_to as string).toISOString()
      : null,
    pageCount: Number(row.page_count ?? 0),
  };
}

function pageFromRow(row: RowDataPacket): PageDefinitionRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    moduleId: String(row.module_id),
    pageRoute: String(row.page_route),
    name: String(row.name),
    templateKey: row.template_key as PageTemplate,
    isCore: Boolean(row.is_core),
    criticalityWeight: Number(row.criticality_weight),
    expectedFrequency: row.expected_frequency as ExpectedFrequency,
    status: (row.revision_status ?? row.status) as "active" | "disabled",
    archivedAt: row.archived_at
      ? new Date(row.archived_at as string).toISOString()
      : null,
    revisionId: String(row.revision_id),
    revision: Number(row.revision),
    effectiveFrom: new Date(row.effective_from as string).toISOString(),
    effectiveTo: row.effective_to
      ? new Date(row.effective_to as string).toISOString()
      : null,
  };
}

function jsonObject<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function revisionEffectiveFrom(current: unknown, requested?: string): Date {
  const currentDate = new Date(current as string);
  const candidate = requested ? new Date(requested) : new Date();
  if (!Number.isFinite(candidate.valueOf()) || candidate <= currentDate) {
    if (requested) throw new Error("REVISION_EFFECTIVE_FROM_INVALID");
    return new Date(currentDate.valueOf() + 1);
  }
  return candidate;
}

function workflowStepFromRow(row: RowDataPacket): WorkflowStepRecord {
  return {
    id: String(row.id),
    workflowDefinitionVersionId: String(row.workflow_definition_version_id),
    stepKey: String(row.step_key),
    name: String(row.name),
    stepOrder: Number(row.step_order),
    triggerKind: row.trigger_kind as WorkflowTriggerKind,
    triggerConfig: jsonObject<Record<string, string | boolean>>(row.trigger_config),
  };
}

function workflowVersionFromRow(
  row: RowDataPacket,
  steps: WorkflowStepRecord[],
): WorkflowDefinitionVersionRecord {
  return {
    id: String(row.id),
    workflowDefinitionId: String(row.workflow_definition_id),
    version: Number(row.version),
    moduleId: String(row.module_id),
    name: String(row.name),
    startPolicy: row.start_policy as WorkflowStartPolicy,
    terminalPolicy: jsonObject<WorkflowTerminalPolicy>(row.terminal_policy),
    timeoutSeconds: Number(row.timeout_seconds),
    status: row.status as WorkflowVersionStatus,
    activatedAt: row.activated_at
      ? new Date(row.activated_at as string).toISOString()
      : null,
    effectiveFrom: row.activated_at
      ? new Date(row.activated_at as string).toISOString()
      : null,
    effectiveTo: row.effective_to
      ? new Date(row.effective_to as string).toISOString()
      : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    steps,
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
    targetUsers: row.target_users === null ? null : Number(row.target_users),
    expectedActiveWeekdays: parseWeekdays(row.expected_active_weekdays),
    status: row.status as "active" | "superseded",
    effectiveFrom: new Date(row.effective_from as string).toISOString(),
    effectiveTo: row.effective_to
      ? new Date(row.effective_to as string).toISOString()
      : null,
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
    const ids = rows.map((row) => String(row.id));
    const [origins] = ids.length
      ? await this.pool.query<RowDataPacket[]>(
          `SELECT project_id,origin FROM project_origins WHERE project_id IN (?) AND enabled=TRUE ORDER BY origin`,
          [ids],
        )
      : [[]];
    const projects = rows.map((row) =>
      projectFromRow(
        row,
        origins.filter((o) => o.project_id === row.id).map((o) => String(o.origin)),
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
    creationId?: string | undefined;
    templateVersions?: { operational: string; quality: string } | undefined;
    initialize?:
      ((connection: PoolConnection, projectId: string) => Promise<void>) | undefined;
  }): Promise<ProjectRecord> {
    const id = randomUUID();
    const appId = `fi_public_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (input.creationId) {
        const digest = scoreDigest({
          name: input.name,
          timezone: input.timezone,
          retentionDays: input.retentionDays,
          origins: input.origins,
          templates: input.templateVersions,
        });
        await connection.execute(
          `INSERT INTO project_creation_requests (actor_user_id,request_id,input_digest) VALUES (?,?,?) ON DUPLICATE KEY UPDATE request_id=VALUES(request_id)`,
          [input.actor.userId, input.creationId, digest],
        );
        const [requests] = await connection.query<RowDataPacket[]>(
          `SELECT input_digest,project_id FROM project_creation_requests WHERE actor_user_id=? AND request_id=? FOR UPDATE`,
          [input.actor.userId, input.creationId],
        );
        if (requests[0]?.input_digest !== digest)
          throw new MetricLibraryError("PROJECT_CREATION_REQUEST_CONFLICT", 409);
        if (requests[0]?.project_id) {
          const existingId = String(requests[0].project_id);
          // Reuse this connection: holding a transaction connection while waiting for
          // another pool connection deadlocks when simultaneous retries fill the pool.
          const [existingRows] = await connection.query<RowDataPacket[]>(
            "SELECT * FROM projects WHERE id=?",
            [existingId],
          );
          const [origins] = await connection.query<RowDataPacket[]>(
            "SELECT origin FROM project_origins WHERE project_id=? AND enabled=TRUE ORDER BY origin",
            [existingId],
          );
          if (!existingRows[0]) throw new MetricLibraryError("PROJECT_NOT_FOUND", 404);
          const existing = projectFromRow(
            existingRows[0],
            origins.map((row) => String(row.origin)),
          );
          await connection.commit();
          return { ...existing, role: "owner" };
        }
      }
      await connection.execute(
        `INSERT INTO projects
           (id, app_id, name, timezone, status, retention_days, created_by_user_id)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [
          id,
          appId,
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
      await input.initialize?.(connection, id);
      if (input.creationId)
        await connection.execute(
          `UPDATE project_creation_requests SET project_id=? WHERE actor_user_id=? AND request_id=?`,
          [id, input.actor.userId, input.creationId],
        );
      await connection.commit();
      return {
        id,
        appId,
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

  async listModules(
    projectId: string,
    options: { includeArchived?: boolean; at?: Date } = {},
  ): Promise<ModuleRecord[]> {
    const at = options.at ?? new Date();
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT module.*, revision.id AS revision_id, revision.revision,
              revision.name, revision.display_order, revision.effective_from,
              revision.effective_to, revision.status AS revision_status,
              (SELECT COUNT(*) FROM page_definitions page
               INNER JOIN page_definition_revisions page_revision
                 ON page_revision.page_definition_id = page.id
                AND page_revision.effective_from <= ?
                AND (page_revision.effective_to IS NULL OR page_revision.effective_to > ?)
               WHERE page.project_id = module.project_id
                 AND page_revision.module_id = module.id
                 ${options.includeArchived ? "" : "AND page.archived_at IS NULL"}) AS page_count
       FROM modules module
       INNER JOIN module_revisions revision
         ON revision.module_id = module.id
        AND revision.effective_from <= ?
        AND (revision.effective_to IS NULL OR revision.effective_to > ?)
       WHERE module.project_id = ?
         ${options.includeArchived ? "" : "AND module.archived_at IS NULL"}
       ORDER BY revision.display_order, revision.name, module.id`,
      [at, at, at, at, projectId],
    );
    return rows.map(moduleFromRow);
  }

  async createModule(input: {
    projectId: string;
    moduleKey: string;
    name: string;
    displayOrder: number;
    effectiveFrom?: string | undefined;
    actor: Principal;
  }): Promise<ModuleRecord> {
    const connection = await this.pool.getConnection();
    const moduleId = randomUUID();
    const revisionId = randomUUID();
    const effectiveFrom = input.effectiveFrom
      ? new Date(input.effectiveFrom)
      : new Date();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO modules (id, project_id, module_key, status)
         VALUES (?, ?, ?, 'active')`,
        [moduleId, input.projectId, input.moduleKey],
      );
      await connection.execute(
        `INSERT INTO module_revisions
           (id, module_id, revision, name, display_order, status, effective_from,
            created_by_user_id)
         VALUES (?, ?, 1, ?, ?, 'active', ?, ?)`,
        [
          revisionId,
          moduleId,
          input.name,
          input.displayOrder,
          effectiveFrom,
          input.actor.userId,
        ],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "module.created",
        entityType: "module",
        entityId: moduleId,
        metadata: { moduleKey: input.moduleKey, revision: 1 },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    return (await this.listModules(input.projectId)).find(
      (item) => item.id === moduleId,
    )!;
  }

  async updateModule(
    projectId: string,
    moduleId: string,
    input: {
      name?: string | undefined;
      displayOrder?: number | undefined;
      status?: "active" | "disabled" | undefined;
      effectiveFrom?: string | undefined;
      actor: Principal;
    },
  ): Promise<ModuleRecord> {
    const connection = await this.pool.getConnection();
    let revision: number | null = null;
    try {
      await connection.beginTransaction();
      const [moduleRows] = await connection.query<RowDataPacket[]>(
        `SELECT * FROM modules WHERE id = ? AND project_id = ? FOR UPDATE`,
        [moduleId, projectId],
      );
      const module = moduleRows[0];
      if (!module) throw new Error("MODULE_NOT_FOUND");
      if (module.archived_at)
        throw new AnalysisObjectLifecycleError("MODULE_ARCHIVED", 409);
      if (input.status !== undefined) {
        await connection.execute(
          `UPDATE modules SET status = ?, disabled_at = ?
           WHERE id = ? AND project_id = ?`,
          [
            input.status,
            input.status === "disabled" ? new Date() : null,
            moduleId,
            projectId,
          ],
        );
      }
      if (
        input.name !== undefined ||
        input.displayOrder !== undefined ||
        input.status !== undefined
      ) {
        const [revisionRows] = await connection.query<RowDataPacket[]>(
          `SELECT * FROM module_revisions
           WHERE module_id = ? AND effective_to IS NULL FOR UPDATE`,
          [moduleId],
        );
        const current = revisionRows[0];
        if (!current) throw new Error("MODULE_REVISION_NOT_FOUND");
        const effectiveFrom = revisionEffectiveFrom(
          current.effective_from,
          input.effectiveFrom,
        );
        revision = Number(current.revision) + 1;
        await connection.execute(
          "UPDATE module_revisions SET effective_to = ? WHERE id = ?",
          [effectiveFrom, current.id],
        );
        await connection.execute(
          `INSERT INTO module_revisions
             (id, module_id, revision, name, display_order, status, effective_from,
              created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            moduleId,
            revision,
            input.name ?? String(current.name),
            input.displayOrder ?? Number(current.display_order),
            input.status ?? String(current.status),
            effectiveFrom,
            input.actor.userId,
          ],
        );
      }
      await this.insertAudit(connection, {
        projectId,
        actorUserId: input.actor.userId,
        action: "module.updated",
        entityType: "module",
        entityId: moduleId,
        metadata: {
          changedFields: Object.keys(input).filter((key) => key !== "actor"),
          revision,
        },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    const module = (await this.listModules(projectId)).find(
      (item) => item.id === moduleId,
    );
    if (!module) throw new Error("MODULE_NOT_FOUND");
    return module;
  }

  async archiveModule(input: {
    projectId: string;
    moduleId: string;
    actor: Principal;
  }): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT status, archived_at FROM modules
         WHERE id = ? AND project_id = ? FOR UPDATE`,
        [input.moduleId, input.projectId],
      );
      const module = rows[0];
      if (!module) throw new Error("MODULE_NOT_FOUND");
      if (module.status !== "disabled") {
        throw new AnalysisObjectLifecycleError("MODULE_MUST_BE_DISABLED", 409);
      }
      if (module.archived_at) {
        throw new AnalysisObjectLifecycleError("MODULE_ALREADY_ARCHIVED", 409);
      }
      const [pageRows] = await connection.query<RowDataPacket[]>(
        `SELECT page.id, page.page_route, revision.name
         FROM page_definitions page
         INNER JOIN page_definition_revisions revision
           ON revision.page_definition_id = page.id AND revision.effective_to IS NULL
         WHERE page.project_id = ? AND revision.module_id = ?
           AND page.archived_at IS NULL ORDER BY revision.name`,
        [input.projectId, input.moduleId],
      );
      const [workflowRows] = await connection.query<RowDataPacket[]>(
        `SELECT definition.id, definition.workflow_key,
                COALESCE(latest.name, definition.name) AS name
         FROM workflow_definitions definition
         LEFT JOIN workflow_definition_versions latest
           ON latest.workflow_definition_id = definition.id
         LEFT JOIN workflow_definition_versions newer
           ON newer.workflow_definition_id = latest.workflow_definition_id
          AND newer.version > latest.version
         WHERE definition.project_id = ? AND definition.archived_at IS NULL
           AND newer.id IS NULL
           AND (definition.module_id = ? OR latest.module_id = ?)
         ORDER BY name`,
        [input.projectId, input.moduleId, input.moduleId],
      );
      if (pageRows.length || workflowRows.length) {
        throw new AnalysisObjectLifecycleError("MODULE_ARCHIVE_DEPENDENCIES", 409, {
          pages: pageRows.map((row) => ({
            id: String(row.id),
            pageRoute: String(row.page_route),
            name: String(row.name),
          })),
          workflows: workflowRows.map((row) => ({
            id: String(row.id),
            workflowKey: String(row.workflow_key),
            name: String(row.name),
          })),
        });
      }
      await connection.execute(
        "UPDATE modules SET archived_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [input.moduleId],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "module.archived",
        entityType: "module",
        entityId: input.moduleId,
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

  async restoreModule(input: {
    projectId: string;
    moduleId: string;
    actor: Principal;
  }): Promise<ModuleRecord> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `UPDATE modules SET archived_at = NULL
         WHERE id = ? AND project_id = ? AND archived_at IS NOT NULL`,
        [input.moduleId, input.projectId],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) {
        throw new Error("MODULE_NOT_FOUND");
      }
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "module.restored",
        entityType: "module",
        entityId: input.moduleId,
        metadata: {},
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    return (await this.listModules(input.projectId, { includeArchived: true })).find(
      (item) => item.id === input.moduleId,
    )!;
  }

  async listPageDefinitions(
    projectId: string,
    options: { includeArchived?: boolean; at?: Date; moduleId?: string } = {},
  ): Promise<PageDefinitionRecord[]> {
    const at = options.at ?? new Date();
    const values: Array<string | Date> = [at, at, projectId];
    let moduleFilter = "";
    if (options.moduleId) {
      moduleFilter = "AND revision.module_id = ?";
      values.push(options.moduleId);
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT page.*, revision.id AS revision_id, revision.revision,
              revision.module_id, revision.name, revision.template_key,
              revision.is_core, revision.criticality_weight,
              revision.expected_frequency, revision.effective_from,
              revision.effective_to, revision.status AS revision_status
       FROM page_definitions page
       INNER JOIN page_definition_revisions revision
         ON revision.page_definition_id = page.id
        AND revision.effective_from <= ?
        AND (revision.effective_to IS NULL OR revision.effective_to > ?)
       WHERE page.project_id = ?
         ${options.includeArchived ? "" : "AND page.archived_at IS NULL"}
         ${moduleFilter}
       ORDER BY revision.name, page.page_route, page.id`,
      values,
    );
    return rows.map(pageFromRow);
  }

  async createPageDefinition(input: {
    projectId: string;
    moduleId: string;
    pageRoute: string;
    name: string;
    templateKey: PageTemplate;
    isCore: boolean;
    criticalityWeight: number;
    expectedFrequency: ExpectedFrequency;
    effectiveFrom?: string | undefined;
    actor: Principal;
  }): Promise<PageDefinitionRecord> {
    const connection = await this.pool.getConnection();
    const pageId = randomUUID();
    const effectiveFrom = input.effectiveFrom
      ? new Date(input.effectiveFrom)
      : new Date();
    try {
      await connection.beginTransaction();
      await this.requireProjectModule(connection, input.projectId, input.moduleId);
      await connection.execute(
        `INSERT INTO page_definitions (id, project_id, page_route, status)
         VALUES (?, ?, ?, 'active')`,
        [pageId, input.projectId, input.pageRoute],
      );
      await connection.execute(
        `INSERT INTO page_definition_revisions
           (id, page_definition_id, revision, module_id, name, template_key,
            is_core, criticality_weight, expected_frequency, status, effective_from,
            created_by_user_id)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          randomUUID(),
          pageId,
          input.moduleId,
          input.name,
          input.templateKey,
          input.isCore,
          input.criticalityWeight,
          input.expectedFrequency,
          effectiveFrom,
          input.actor.userId,
        ],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "page_definition.created",
        entityType: "page",
        entityId: pageId,
        metadata: { pageRoute: input.pageRoute, revision: 1 },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    return (await this.listPageDefinitions(input.projectId)).find(
      (item) => item.id === pageId,
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
    const connection = await this.pool.getConnection();
    let revision: number | null = null;
    try {
      await connection.beginTransaction();
      const [pageRows] = await connection.query<RowDataPacket[]>(
        `SELECT * FROM page_definitions
         WHERE id = ? AND project_id = ? FOR UPDATE`,
        [pageId, projectId],
      );
      const page = pageRows[0];
      if (!page) throw new Error("PAGE_DEFINITION_NOT_FOUND");
      if (page.archived_at) {
        throw new AnalysisObjectLifecycleError("PAGE_DEFINITION_ARCHIVED", 409);
      }
      if (input.moduleId) {
        await this.requireProjectModule(connection, projectId, input.moduleId);
      }
      if (input.status !== undefined) {
        await connection.execute(
          `UPDATE page_definitions SET status = ?, disabled_at = ? WHERE id = ?`,
          [input.status, input.status === "disabled" ? new Date() : null, pageId],
        );
      }
      const revisionFields = [
        input.moduleId,
        input.name,
        input.templateKey,
        input.isCore,
        input.criticalityWeight,
        input.expectedFrequency,
        input.status,
      ];
      if (revisionFields.some((value) => value !== undefined)) {
        const [revisionRows] = await connection.query<RowDataPacket[]>(
          `SELECT * FROM page_definition_revisions
           WHERE page_definition_id = ? AND effective_to IS NULL FOR UPDATE`,
          [pageId],
        );
        const current = revisionRows[0];
        if (!current) throw new Error("PAGE_DEFINITION_REVISION_NOT_FOUND");
        const effectiveFrom = revisionEffectiveFrom(
          current.effective_from,
          input.effectiveFrom,
        );
        revision = Number(current.revision) + 1;
        await connection.execute(
          "UPDATE page_definition_revisions SET effective_to = ? WHERE id = ?",
          [effectiveFrom, current.id],
        );
        await connection.execute(
          `INSERT INTO page_definition_revisions
             (id, page_definition_id, revision, module_id, name, template_key,
              is_core, criticality_weight, expected_frequency, status, effective_from,
              created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            pageId,
            revision,
            input.moduleId ?? String(current.module_id),
            input.name ?? String(current.name),
            input.templateKey ?? String(current.template_key),
            input.isCore ?? Boolean(current.is_core),
            input.criticalityWeight ?? Number(current.criticality_weight),
            input.expectedFrequency ?? String(current.expected_frequency),
            input.status ?? String(current.status),
            effectiveFrom,
            input.actor.userId,
          ],
        );
      }
      await this.insertAudit(connection, {
        projectId,
        actorUserId: input.actor.userId,
        action: "page_definition.updated",
        entityType: "page",
        entityId: pageId,
        metadata: {
          changedFields: Object.keys(input).filter((key) => key !== "actor"),
          revision,
        },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    const page = (await this.listPageDefinitions(projectId)).find(
      (item) => item.id === pageId,
    );
    if (!page) throw new Error("PAGE_DEFINITION_NOT_FOUND");
    return page;
  }

  async archivePageDefinition(input: {
    projectId: string;
    pageId: string;
    actor: Principal;
  }): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT status, archived_at FROM page_definitions
         WHERE id = ? AND project_id = ? FOR UPDATE`,
        [input.pageId, input.projectId],
      );
      const page = rows[0];
      if (!page) throw new Error("PAGE_DEFINITION_NOT_FOUND");
      if (page.archived_at) {
        throw new AnalysisObjectLifecycleError("PAGE_ALREADY_ARCHIVED", 409);
      }
      if (page.status !== "disabled") {
        throw new AnalysisObjectLifecycleError("PAGE_MUST_BE_DISABLED", 409);
      }
      const [featureRows] = await connection.query<RowDataPacket[]>(
        `SELECT id, feature_key, name FROM features
         WHERE project_id = ? AND page_definition_id = ? AND status = 'active'
         ORDER BY name`,
        [input.projectId, input.pageId],
      );
      if (featureRows.length) {
        throw new AnalysisObjectLifecycleError("PAGE_ARCHIVE_DEPENDENCIES", 409, {
          features: featureRows.map((row) => ({
            id: String(row.id),
            featureKey: String(row.feature_key),
            name: String(row.name),
          })),
        });
      }
      await connection.execute(
        "UPDATE page_definitions SET archived_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [input.pageId],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "page_definition.archived",
        entityType: "page",
        entityId: input.pageId,
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

  async restorePageDefinition(input: {
    projectId: string;
    pageId: string;
    actor: Principal;
  }): Promise<PageDefinitionRecord> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT revision.module_id
         FROM page_definitions page
         INNER JOIN page_definition_revisions revision
           ON revision.page_definition_id = page.id AND revision.effective_to IS NULL
         WHERE page.id = ? AND page.project_id = ? AND page.archived_at IS NOT NULL
         FOR UPDATE`,
        [input.pageId, input.projectId],
      );
      if (!rows[0]) throw new Error("PAGE_DEFINITION_NOT_FOUND");
      await this.requireProjectModule(
        connection,
        input.projectId,
        String(rows[0].module_id),
      );
      await connection.execute(
        "UPDATE page_definitions SET archived_at = NULL WHERE id = ?",
        [input.pageId],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "page_definition.restored",
        entityType: "page",
        entityId: input.pageId,
        metadata: {},
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    return (
      await this.listPageDefinitions(input.projectId, { includeArchived: true })
    ).find((item) => item.id === input.pageId)!;
  }

  async listWorkflowDefinitions(
    projectId: string,
    options: { includeArchived?: boolean; moduleId?: string } = {},
  ): Promise<WorkflowDefinitionRecord[]> {
    const values: string[] = [projectId];
    let moduleFilter = "";
    if (options.moduleId) {
      moduleFilter = "AND module_id = ?";
      values.push(options.moduleId);
    }
    const [definitionRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM workflow_definitions
       WHERE project_id = ?
         ${options.includeArchived ? "" : "AND archived_at IS NULL"}
         ${moduleFilter}
       ORDER BY name, workflow_key, id`,
      values,
    );
    if (!definitionRows.length) return [];
    const definitionIds = definitionRows.map((row) => String(row.id));
    const placeholders = definitionIds.map(() => "?").join(", ");
    const [versionRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM workflow_definition_versions
       WHERE workflow_definition_id IN (${placeholders})
       ORDER BY workflow_definition_id, version DESC`,
      definitionIds,
    );
    const latestRows = new Map<string, RowDataPacket>();
    for (const row of versionRows) {
      const definitionId = String(row.workflow_definition_id);
      if (!latestRows.has(definitionId)) latestRows.set(definitionId, row);
    }
    const versionIds = [...latestRows.values()].map((row) => String(row.id));
    const stepsByVersion = new Map<string, WorkflowStepRecord[]>();
    if (versionIds.length) {
      const versionPlaceholders = versionIds.map(() => "?").join(", ");
      const [stepRows] = await this.pool.query<RowDataPacket[]>(
        `SELECT * FROM workflow_steps
         WHERE workflow_definition_version_id IN (${versionPlaceholders})
         ORDER BY workflow_definition_version_id, step_order, id`,
        versionIds,
      );
      for (const row of stepRows) {
        const versionId = String(row.workflow_definition_version_id);
        const current = stepsByVersion.get(versionId) ?? [];
        current.push(workflowStepFromRow(row));
        stepsByVersion.set(versionId, current);
      }
    }
    return definitionRows.map((row) => {
      const latest = latestRows.get(String(row.id));
      return {
        id: String(row.id),
        projectId: String(row.project_id),
        moduleId: latest ? String(latest.module_id) : String(row.module_id),
        workflowKey: String(row.workflow_key),
        name: latest ? String(latest.name) : String(row.name),
        status: row.status as "active" | "disabled",
        archivedAt: row.archived_at
          ? new Date(row.archived_at as string).toISOString()
          : null,
        createdAt: new Date(row.created_at as string).toISOString(),
        updatedAt: new Date(row.updated_at as string).toISOString(),
        latestVersion: latest
          ? workflowVersionFromRow(latest, stepsByVersion.get(String(latest.id)) ?? [])
          : null,
      };
    });
  }

  async createWorkflowDefinition(input: {
    projectId: string;
    moduleId: string;
    workflowKey: string;
    name: string;
    startPolicy: WorkflowStartPolicy;
    terminalPolicy: WorkflowTerminalPolicy;
    timeoutSeconds: number;
    steps: WorkflowStepInput[];
    actor: Principal;
  }): Promise<WorkflowDefinitionRecord> {
    const connection = await this.pool.getConnection();
    const workflowId = randomUUID();
    const versionId = randomUUID();
    try {
      await connection.beginTransaction();
      await this.requireProjectModule(connection, input.projectId, input.moduleId);
      await this.requireWorkflowOperationKeys(connection, input.projectId, input.steps);
      await connection.execute(
        `INSERT INTO workflow_definitions
           (id, project_id, module_id, workflow_key, name, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        [workflowId, input.projectId, input.moduleId, input.workflowKey, input.name],
      );
      await connection.execute(
        `INSERT INTO workflow_definition_versions
           (id, workflow_definition_id, version, module_id, name, start_policy,
            terminal_policy, timeout_seconds, status)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'draft')`,
        [
          versionId,
          workflowId,
          input.moduleId,
          input.name,
          input.startPolicy,
          JSON.stringify(input.terminalPolicy),
          input.timeoutSeconds,
        ],
      );
      await this.replaceWorkflowSteps(connection, versionId, input.steps);
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "workflow_definition.created",
        entityType: "workflow",
        entityId: workflowId,
        metadata: {
          workflowKey: input.workflowKey,
          moduleId: input.moduleId,
          version: 1,
          stepCount: input.steps.length,
        },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    const workflow = (await this.listWorkflowDefinitions(input.projectId)).find(
      (item) => item.id === workflowId,
    );
    if (!workflow) throw new Error("WORKFLOW_DEFINITION_NOT_FOUND");
    return workflow;
  }

  async updateWorkflowDefinition(
    projectId: string,
    workflowId: string,
    input: {
      status?: "active" | "disabled" | undefined;
      actor: Principal;
    },
  ): Promise<WorkflowDefinitionRecord> {
    if (input.status === undefined) throw new Error("WORKFLOW_UPDATE_EMPTY");
    if (input.status === "active") {
      const workflow = (
        await this.listWorkflowDefinitions(projectId, { includeArchived: true })
      ).find((item) => item.id === workflowId);
      if (!workflow) throw new Error("WORKFLOW_DEFINITION_NOT_FOUND");
      await this.requireProjectModule(this.pool, projectId, workflow.moduleId);
    }
    const [result] = await this.pool.execute(
      `UPDATE workflow_definitions SET status = ?, disabled_at = ?
       WHERE id = ? AND project_id = ? AND archived_at IS NULL`,
      [
        input.status,
        input.status === "disabled" ? new Date() : null,
        workflowId,
        projectId,
      ],
    );
    if ((result as { affectedRows: number }).affectedRows !== 1) {
      throw new Error("WORKFLOW_DEFINITION_NOT_FOUND");
    }
    await this.audit({
      projectId,
      actorUserId: input.actor.userId,
      action: "workflow_definition.updated",
      entityType: "workflow",
      entityId: workflowId,
      metadata: {
        changedFields: Object.keys(input).filter((key) => key !== "actor"),
      },
    });
    const workflow = (await this.listWorkflowDefinitions(projectId)).find(
      (item) => item.id === workflowId,
    );
    if (!workflow) throw new Error("WORKFLOW_DEFINITION_NOT_FOUND");
    return workflow;
  }

  async saveWorkflowDraft(input: {
    projectId: string;
    workflowId: string;
    moduleId: string;
    name: string;
    startPolicy: WorkflowStartPolicy;
    terminalPolicy: WorkflowTerminalPolicy;
    timeoutSeconds: number;
    steps: WorkflowStepInput[];
    actor: Principal;
  }): Promise<WorkflowDefinitionRecord> {
    const connection = await this.pool.getConnection();
    let version: number;
    let versionId: string;
    try {
      await connection.beginTransaction();
      const [definitionRows] = await connection.query<RowDataPacket[]>(
        `SELECT id, archived_at FROM workflow_definitions
         WHERE id = ? AND project_id = ? FOR UPDATE`,
        [input.workflowId, input.projectId],
      );
      if (!definitionRows.length) throw new Error("WORKFLOW_DEFINITION_NOT_FOUND");
      if (definitionRows[0]!.archived_at) {
        throw new AnalysisObjectLifecycleError("WORKFLOW_ARCHIVED", 409);
      }
      await this.requireProjectModule(connection, input.projectId, input.moduleId);
      await this.requireWorkflowOperationKeys(connection, input.projectId, input.steps);
      const [versionRows] = await connection.query<RowDataPacket[]>(
        `SELECT id, version, status FROM workflow_definition_versions
         WHERE workflow_definition_id = ?
         ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [input.workflowId],
      );
      const latest = versionRows[0];
      if (latest?.status === "draft") {
        version = Number(latest.version);
        versionId = String(latest.id);
        await connection.execute(
          `UPDATE workflow_definition_versions
           SET module_id = ?, name = ?, start_policy = ?, terminal_policy = ?,
               timeout_seconds = ?
           WHERE id = ?`,
          [
            input.moduleId,
            input.name,
            input.startPolicy,
            JSON.stringify(input.terminalPolicy),
            input.timeoutSeconds,
            versionId,
          ],
        );
      } else {
        version = Number(latest?.version ?? 0) + 1;
        versionId = randomUUID();
        await connection.execute(
          `INSERT INTO workflow_definition_versions
             (id, workflow_definition_id, version, module_id, name,
              start_policy, terminal_policy, timeout_seconds, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
          [
            versionId,
            input.workflowId,
            version,
            input.moduleId,
            input.name,
            input.startPolicy,
            JSON.stringify(input.terminalPolicy),
            input.timeoutSeconds,
          ],
        );
      }
      await this.replaceWorkflowSteps(connection, versionId, input.steps);
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "workflow_definition.draft_saved",
        entityType: "workflow",
        entityId: input.workflowId,
        metadata: {
          version,
          stepCount: input.steps.length,
          changedFields: ["moduleId", "name", "configuration"],
        },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    const workflow = (await this.listWorkflowDefinitions(input.projectId)).find(
      (item) => item.id === input.workflowId,
    );
    if (!workflow) throw new Error("WORKFLOW_DEFINITION_NOT_FOUND");
    return workflow;
  }

  async activateWorkflowDefinitionVersion(input: {
    projectId: string;
    workflowId: string;
    versionId: string;
    actor: Principal;
  }): Promise<WorkflowDefinitionRecord> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT version.id, version.module_id, version.name
         FROM workflow_definition_versions version
         INNER JOIN workflow_definitions definition
           ON definition.id = version.workflow_definition_id
         WHERE version.id = ? AND version.workflow_definition_id = ?
           AND definition.project_id = ? AND definition.archived_at IS NULL
           AND version.status = 'draft'
         FOR UPDATE`,
        [input.versionId, input.workflowId, input.projectId],
      );
      if (!rows.length) throw new Error("WORKFLOW_DRAFT_NOT_FOUND");
      await this.requireProjectModule(
        connection,
        input.projectId,
        String(rows[0]!.module_id),
      );
      const [stepRows] = await connection.query<RowDataPacket[]>(
        `SELECT * FROM workflow_steps
         WHERE workflow_definition_version_id = ? ORDER BY step_order`,
        [input.versionId],
      );
      await this.requireWorkflowOperationKeys(
        connection,
        input.projectId,
        stepRows.map((row) => workflowStepFromRow(row)),
      );
      const effectiveFrom = new Date();
      await connection.execute(
        `UPDATE workflow_definition_versions
         SET status = 'retired', effective_to = ?
         WHERE workflow_definition_id = ? AND status = 'active'`,
        [effectiveFrom, input.workflowId],
      );
      await connection.execute(
        `UPDATE workflow_definition_versions
         SET status = 'active', activated_at = ?, effective_to = NULL
         WHERE id = ?`,
        [effectiveFrom, input.versionId],
      );
      await connection.execute(
        `UPDATE workflow_definitions SET module_id = ?, name = ?
         WHERE id = ? AND project_id = ?`,
        [rows[0]!.module_id, rows[0]!.name, input.workflowId, input.projectId],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "workflow_definition.activated",
        entityType: "workflow",
        entityId: input.workflowId,
        metadata: { versionId: input.versionId },
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    const workflow = (await this.listWorkflowDefinitions(input.projectId)).find(
      (item) => item.id === input.workflowId,
    );
    if (!workflow) throw new Error("WORKFLOW_DEFINITION_NOT_FOUND");
    return workflow;
  }

  async archiveWorkflowDefinition(input: {
    projectId: string;
    workflowId: string;
    actor: Principal;
  }): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT status, archived_at FROM workflow_definitions
         WHERE id = ? AND project_id = ? FOR UPDATE`,
        [input.workflowId, input.projectId],
      );
      const workflow = rows[0];
      if (!workflow) throw new Error("WORKFLOW_DEFINITION_NOT_FOUND");
      if (workflow.archived_at) {
        throw new AnalysisObjectLifecycleError("WORKFLOW_ALREADY_ARCHIVED", 409);
      }
      if (workflow.status !== "disabled") {
        throw new AnalysisObjectLifecycleError("WORKFLOW_MUST_BE_DISABLED", 409);
      }
      await connection.execute(
        "UPDATE workflow_definitions SET archived_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [input.workflowId],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "workflow_definition.archived",
        entityType: "workflow",
        entityId: input.workflowId,
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

  async restoreWorkflowDefinition(input: {
    projectId: string;
    workflowId: string;
    actor: Principal;
  }): Promise<WorkflowDefinitionRecord> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT module_id FROM workflow_definitions
         WHERE id = ? AND project_id = ? AND archived_at IS NOT NULL FOR UPDATE`,
        [input.workflowId, input.projectId],
      );
      if (!rows[0]) throw new Error("WORKFLOW_DEFINITION_NOT_FOUND");
      await this.requireProjectModule(
        connection,
        input.projectId,
        String(rows[0].module_id),
      );
      await connection.execute(
        "UPDATE workflow_definitions SET archived_at = NULL WHERE id = ?",
        [input.workflowId],
      );
      await this.insertAudit(connection, {
        projectId: input.projectId,
        actorUserId: input.actor.userId,
        action: "workflow_definition.restored",
        entityType: "workflow",
        entityId: input.workflowId,
        metadata: {},
      });
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
    return (
      await this.listWorkflowDefinitions(input.projectId, { includeArchived: true })
    ).find((item) => item.id === input.workflowId)!;
  }

  private async requireProjectModule(
    executor: Pick<Pool | PoolConnection, "query">,
    projectId: string,
    moduleId: string,
  ): Promise<void> {
    const [rows] = await executor.query<RowDataPacket[]>(
      `SELECT id FROM modules
       WHERE id = ? AND project_id = ? AND status = 'active'
         AND archived_at IS NULL LIMIT 1`,
      [moduleId, projectId],
    );
    if (!rows.length) throw new Error("MODULE_NOT_FOUND");
  }

  private async requireWorkflowOperationKeys(
    executor: Pick<Pool | PoolConnection, "query">,
    projectId: string,
    steps: WorkflowStepInput[],
  ): Promise<void> {
    const operationKeys = [
      ...new Set(
        steps
          .filter((step) => step.triggerKind === "operation_terminal")
          .map((step) => String(step.triggerConfig.operationKey)),
      ),
    ];
    if (!operationKeys.length) return;
    const placeholders = operationKeys.map(() => "?").join(", ");
    const [rows] = await executor.query<RowDataPacket[]>(
      `SELECT feature_key FROM features
       WHERE project_id = ? AND status = 'active'
         AND operation_lifecycle_enabled = TRUE
         AND feature_key IN (${placeholders})`,
      [projectId, ...operationKeys],
    );
    const available = new Set(rows.map((row) => String(row.feature_key)));
    const unavailable = operationKeys.filter((key) => !available.has(key));
    if (unavailable.length) {
      throw new AnalysisObjectLifecycleError("WORKFLOW_OPERATION_NOT_AVAILABLE", 409, {
        operationKeys: unavailable,
      });
    }
  }

  private async replaceWorkflowSteps(
    connection: PoolConnection,
    versionId: string,
    steps: WorkflowStepInput[],
  ): Promise<void> {
    await connection.execute(
      "DELETE FROM workflow_steps WHERE workflow_definition_version_id = ?",
      [versionId],
    );
    for (const step of steps) {
      await connection.execute(
        `INSERT INTO workflow_steps
           (id, workflow_definition_version_id, step_key, name, step_order,
            trigger_kind, trigger_config)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          versionId,
          step.stepKey,
          step.name,
          step.stepOrder,
          step.triggerKind,
          JSON.stringify(step.triggerConfig),
        ],
      );
    }
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
    targetUsers: number | null;
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
           (id, project_id, version, target_users, expected_active_weekdays,
            status, effective_from, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          id,
          input.projectId,
          version,
          input.targetUsers,
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
          targetUsersConfigured: input.targetUsers !== null,
          expectedActiveWeekdays: input.expectedActiveWeekdays,
        },
      });
      await connection.commit();
      return {
        id,
        projectId: input.projectId,
        version,
        targetUsers: input.targetUsers,
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

  async getIngestionProject(appId: string): Promise<ProjectIngestionConfig | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM projects WHERE app_id = ? LIMIT 1",
      [appId],
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
