import { createHmac, randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { MySqlStore } from "./mysql-store.js";
import { MetricLibraryError } from "./metric-library.js";
export interface DirectoryEntry {
  userId: string;
  deptId: string;
  roleId: string | null;
  eligible: boolean;
}
export interface DirectoryInput {
  env: "prod" | "staging" | "dev";
  sourceKey: string;
  coverage: "complete" | "unknown";
  validUntil: string;
  entries: DirectoryEntry[];
}
export interface DirectoryVersion {
  projectId?: string;
  id: string;
  env: string;
  sourceKey: string;
  coverage: string;
  status: string;
  from: string | null;
  until: string;
  entries: DirectoryEntry[];
}
const opaque = /^u_[a-zA-Z0-9_-]{16,100}$/;
const controlled = /^(dept|role)_[a-z0-9_]{1,48}$/;
export function validateDirectory(input: DirectoryInput, now: number): void {
  if (
    !["prod", "staging", "dev"].includes(input.env) ||
    !["complete", "unknown"].includes(input.coverage) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(input.sourceKey) ||
    !Number.isFinite(Date.parse(input.validUntil)) ||
    Date.parse(input.validUntil) <= now ||
    Date.parse(input.validUntil) > now + 366 * 86400000 ||
    input.entries.length > 500
  )
    throw new MetricLibraryError("DIRECTORY_INVALID", 400);
  const ids = new Set<string>();
  for (const entry of input.entries) {
    if (
      !opaque.test(entry.userId) ||
      !controlled.test(entry.deptId) ||
      !entry.deptId.startsWith("dept_") ||
      (entry.roleId !== null &&
        (!controlled.test(entry.roleId) || !entry.roleId.startsWith("role_"))) ||
      typeof entry.eligible !== "boolean" ||
      ids.has(entry.userId)
    )
      throw new MetricLibraryError("DIRECTORY_ENTRY_INVALID", 400);
    ids.add(entry.userId);
  }
}
export function directoryAt(
  versions: DirectoryVersion[],
  env: string,
  timestamp: number,
  asOf: number,
): DirectoryVersion | null {
  // The most recent publication supersedes even an expired version: never resurrect an old directory.
  const version = versions
    .filter(
      (v) =>
        v.env === env &&
        v.status === "published" &&
        v.from !== null &&
        Date.parse(v.from) <= timestamp &&
        Date.parse(v.from) <= asOf,
    )
    .sort((a, b) => Date.parse(b.from!) - Date.parse(a.from!))[0];
  return version && timestamp < Date.parse(version.until) ? version : null;
}
export async function readDirectories(
  executor: Pick<Pool | PoolConnection, "query">,
  projectId: string | string[],
): Promise<DirectoryVersion[]> {
  const [rows] = await executor.query<RowDataPacket[]>(
    "SELECT * FROM organization_directory_versions WHERE project_id IN (?) ORDER BY published_at,id LIMIT 1001",
    [projectId],
  );
  if (rows.length > 1000) throw new MetricLibraryError("DIRECTORY_VERSION_LIMIT", 400);
  return rows.map((r) => ({
    projectId: String(r.project_id),
    id: String(r.id),
    env: String(r.env),
    sourceKey: String(r.source_key),
    coverage: String(r.coverage),
    status: String(r.status),
    from: r.published_at ? new Date(r.published_at).toISOString() : null,
    until: new Date(r.valid_until).toISOString(),
    entries:
      typeof r.entries_json === "string"
        ? JSON.parse(r.entries_json)
        : (r.entries_json as DirectoryEntry[]),
  }));
}
export class OrganizationDirectoryService {
  constructor(
    private readonly mysql: MySqlStore,
    private readonly hmacKey: string,
  ) {}
  async list(projectId: string) {
    return (await readDirectories(this.mysql.pool, projectId)).map(
      ({ entries, ...v }) => ({ ...v, entryCount: entries.length }),
    );
  }
  async create(projectId: string, actor: string, input: DirectoryInput) {
    validateDirectory(input, Date.now());
    const entries = input.entries.map((e) => ({
      ...e,
      userId: createHmac("sha256", this.hmacKey)
        .update(`${projectId}:${e.userId}`)
        .digest("hex"),
    }));
    const c = await this.mysql.pool.getConnection(),
      id = randomUUID();
    try {
      await c.beginTransaction();
      await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [projectId]);
      const [count] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM organization_directory_versions WHERE project_id=?",
        [projectId],
      );
      if (Number(count[0]?.n) >= 100)
        throw new MetricLibraryError("DIRECTORY_VERSION_LIMIT", 400);
      await c.execute(
        "INSERT INTO organization_directory_versions (id,project_id,env,source_key,coverage,entries_json,entry_count,valid_until) VALUES (?,?,?,?,?,?,?,?)",
        [
          id,
          projectId,
          input.env,
          input.sourceKey,
          input.coverage,
          JSON.stringify(entries),
          entries.length,
          new Date(input.validUntil),
        ],
      );
      await this.audit(c, projectId, actor, id, "directory.created");
      await c.commit();
      return { id, status: "draft" };
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }
  async publish(projectId: string, actor: string, id: string) {
    const c = await this.mysql.pool.getConnection();
    try {
      await c.beginTransaction();
      await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [projectId]);
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT * FROM organization_directory_versions WHERE project_id=? AND id=? FOR UPDATE",
        [projectId, id],
      );
      const row = rows[0];
      if (!row) throw new MetricLibraryError("DIRECTORY_NOT_FOUND", 404);
      if (row.status !== "draft")
        throw new MetricLibraryError("DIRECTORY_IMMUTABLE", 409);
      if (new Date(row.valid_until).valueOf() <= Date.now())
        throw new MetricLibraryError("DIRECTORY_EXPIRED", 409);
      // Server time only; a publication never rewrites earlier event attribution.
      await c.execute(
        "UPDATE organization_directory_versions SET status='published',published_at=CURRENT_TIMESTAMP(3) WHERE id=?",
        [id],
      );
      await this.audit(c, projectId, actor, id, "directory.published");
      await c.commit();
      return { id, status: "published" };
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }
  private async audit(
    c: PoolConnection,
    projectId: string,
    actor: string,
    id: string,
    action: string,
  ) {
    await c.execute(
      "INSERT INTO audit_logs (project_id,actor_user_id,action,entity_type,entity_id,metadata,request_id) VALUES (?,?,?,?,?,?,?)",
      [projectId, actor, action, "organization_directory", id, "{}", randomUUID()],
    );
  }
}
