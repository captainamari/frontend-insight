import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import mysql from "mysql2/promise";
import type {
  DataStatusRecord,
  FeatureRecord,
  FeatureType,
  GlobalRole,
  Principal,
  ProjectIngestionConfig,
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
    longViewSuccessAfterMs: Number(row.long_view_success_after_ms),
    heartbeatIntervalMs: Number(row.heartbeat_interval_ms),
    launchedAt: row.launched_at
      ? new Date(row.launched_at as string).toISOString()
      : null,
    status: row.status as "active" | "disabled",
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
    const [rows] = await this.pool.query<UserRow[]>(
      `SELECT u.id, u.display_name, u.email, u.status, u.global_role
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.refresh_token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > CURRENT_TIMESTAMP(3)
       LIMIT 1`,
      [refreshTokenHash],
    );
    const row = rows[0];
    if (!row || row.status !== "active") return null;
    await this.pool.execute(
      `UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP(3)
       WHERE refresh_token_hash = ?`,
      [refreshTokenHash],
    );
    return {
      userId: row.id,
      globalRole: row.global_role,
      displayName: row.display_name,
      email: row.email,
    };
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
    await this.pool.execute(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role)`,
      [input.projectId, input.userId, input.role],
    );
    await this.audit({
      projectId: input.projectId,
      actorUserId: input.actor.userId,
      action: "project.member.updated",
      entityType: "project_member",
      entityId: input.userId,
      metadata: { role: input.role },
    });
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
    actor: Principal;
  }): Promise<FeatureRecord> {
    const id = randomUUID();
    await this.pool.execute(
      `INSERT INTO features
         (id, project_id, feature_key, name, description, feature_type,
          long_view_success_after_ms, heartbeat_interval_ms, launched_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        id,
        input.projectId,
        input.featureKey,
        input.name,
        input.description ?? null,
        input.featureType,
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
      actor: Principal;
    },
  ): Promise<FeatureRecord> {
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
