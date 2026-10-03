import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { MySqlStore } from "./mysql-store.js";
import { MetricLibraryError } from "./metric-library.js";

export interface UsageSourceInput {
  env: "dev" | "staging" | "prod";
  sourceKey: string;
  coverage: "complete" | "interrupted";
  sdkVersion: "0.8.0";
  releases: string[];
  validUntil: string;
  attested: true;
}
export interface UsageSourceVersion {
  id: string;
  projectId: string;
  env: string;
  sourceKey: string;
  status: string;
  coverage: string;
  sdkVersion: string;
  releases: string[];
  scopeChangedAt?: string | null;
  from: string | null;
  until: string;
  scope: {
    pages: { pageRevisionId: string; moduleRevisionId: string }[];
    features: string[];
    featureRevisions?: Record<string, string>;
  };
}
export function usageSourceAt(
  versions: UsageSourceVersion[],
  project: string,
  env: string,
  at: number,
  asOf: number,
) {
  const v = versions
    .filter(
      (v) =>
        v.projectId === project &&
        v.env === env &&
        v.status === "published" &&
        v.from &&
        Date.parse(v.from) <= at &&
        Date.parse(v.from) <= asOf,
    )
    .sort((a, b) => Date.parse(b.from!) - Date.parse(a.from!))[0];
  return v && at < Date.parse(v.until) ? v : null;
}
export async function readUsageSources(
  db: Pick<Pool | PoolConnection, "query">,
  projectId: string,
): Promise<UsageSourceVersion[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT s.*,(SELECT MIN(a.created_at) FROM audit_logs a WHERE a.project_id=s.project_id AND a.entity_type='feature' AND a.created_at>s.published_at) AS scope_changed_at FROM usage_source_versions s WHERE s.project_id=? ORDER BY s.published_at,s.id LIMIT 101",
    [projectId],
  );
  if (rows.length > 100)
    throw new MetricLibraryError("USAGE_SOURCE_VERSION_LIMIT", 400);
  const json = (value: unknown) =>
    typeof value === "string" ? JSON.parse(value) : value;
  return rows.map((r) => ({
    id: String(r.id),
    projectId: String(r.project_id),
    env: String(r.env),
    sourceKey: String(r.source_key),
    status: String(r.status),
    coverage: String(r.coverage),
    sdkVersion: String(r.sdk_version),
    releases: json(r.releases_json),
    scope: json(r.scope_json),
    scopeChangedAt: r.scope_changed_at
      ? new Date(r.scope_changed_at).toISOString()
      : null,
    from: r.published_at ? new Date(r.published_at).toISOString() : null,
    until: new Date(r.valid_until).toISOString(),
  }));
}
export class UsageSourceService {
  constructor(private readonly mysql: MySqlStore) {}
  async list(project: string) {
    return (await readUsageSources(this.mysql.pool, project)).map(
      ({ scope, ...version }) => ({
        ...version,
        scope: { pageCount: scope.pages.length, featureCount: scope.features.length },
      }),
    );
  }
  private async scope(c: PoolConnection, project: string) {
    const [pages] = await c.query<RowDataPacket[]>(
      `SELECT r.id AS pageRevisionId,mr.id AS moduleRevisionId FROM page_definitions p JOIN page_definition_revisions r ON r.page_definition_id=p.id AND r.effective_from<=CURRENT_TIMESTAMP(3) AND (r.effective_to IS NULL OR r.effective_to>CURRENT_TIMESTAMP(3)) JOIN module_revisions mr ON mr.module_id=r.module_id AND mr.effective_from<=CURRENT_TIMESTAMP(3) AND (mr.effective_to IS NULL OR mr.effective_to>CURRENT_TIMESTAMP(3)) WHERE p.project_id=? AND r.status='active' AND mr.status='active' ORDER BY r.id LIMIT 1001`,
      [project],
    );
    const [features] = await c.query<RowDataPacket[]>(
      "SELECT feature_key,configuration_effective_from FROM features WHERE project_id=? AND status='active' ORDER BY feature_key LIMIT 1001",
      [project],
    );
    if (!pages.length || pages.length > 1000 || features.length > 1000)
      throw new MetricLibraryError("USAGE_SOURCE_SCOPE_LIMIT", 400);
    return {
      pages: pages.map((p) => ({
        pageRevisionId: String(p.pageRevisionId),
        moduleRevisionId: String(p.moduleRevisionId),
      })),
      features: features.map((f) => String(f.feature_key)),
      featureRevisions: Object.fromEntries(
        features.map((f) => [
          String(f.feature_key),
          new Date(f.configuration_effective_from).toISOString(),
        ]),
      ),
    };
  }
  async create(project: string, actor: string, input: UsageSourceInput) {
    if (
      !input.attested ||
      Date.parse(input.validUntil) <= Date.now() ||
      Date.parse(input.validUntil) > Date.now() + 366 * 86400000
    )
      throw new MetricLibraryError("USAGE_SOURCE_INVALID", 400);
    const c = await this.mysql.pool.getConnection(),
      id = randomUUID();
    try {
      await c.beginTransaction();
      await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [project]);
      const versions = await readUsageSources(c, project);
      if (versions.length >= 100)
        throw new MetricLibraryError("USAGE_SOURCE_VERSION_LIMIT", 400);
      const scope = await this.scope(c, project);
      await c.execute(
        "INSERT INTO usage_source_versions(id,project_id,env,source_key,coverage,sdk_version,releases_json,scope_json,valid_until) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          id,
          project,
          input.env,
          input.sourceKey,
          input.coverage,
          input.sdkVersion,
          JSON.stringify([...new Set(input.releases)].sort()),
          JSON.stringify(scope),
          new Date(input.validUntil),
        ],
      );
      await this.audit(c, project, actor, id, "usage_source.created");
      await c.commit();
      return { id, status: "draft" };
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }
  async publish(project: string, actor: string, id: string) {
    const c = await this.mysql.pool.getConnection();
    try {
      await c.beginTransaction();
      await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [project]);
      const v = (await readUsageSources(c, project)).find((v) => v.id === id);
      if (!v) throw new MetricLibraryError("USAGE_SOURCE_NOT_FOUND", 404);
      if (v.status !== "draft")
        throw new MetricLibraryError("USAGE_SOURCE_IMMUTABLE", 409);
      if (Date.parse(v.until) <= Date.now())
        throw new MetricLibraryError("USAGE_SOURCE_EXPIRED", 409);
      if (scopeSignature(v.scope) !== scopeSignature(await this.scope(c, project)))
        throw new MetricLibraryError("USAGE_SOURCE_SCOPE_CHANGED", 409);
      await c.execute(
        "UPDATE usage_source_versions SET status='published',published_at=CURRENT_TIMESTAMP(3) WHERE id=?",
        [id],
      );
      await this.audit(c, project, actor, id, "usage_source.published");
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
    project: string,
    actor: string,
    id: string,
    action: string,
  ) {
    await c.execute(
      "INSERT INTO audit_logs(project_id,actor_user_id,action,entity_type,entity_id,metadata,request_id) VALUES (?,?,?,?,?,?,?)",
      [
        project,
        actor,
        action,
        "usage_source",
        id,
        '{"policy":"c07-admin-attestation-v1"}',
        randomUUID(),
      ],
    );
  }
}

function scopeSignature(scope: UsageSourceVersion["scope"]) {
  return JSON.stringify({
    pages: scope.pages.map((p) => [p.pageRevisionId, p.moduleRevisionId]).sort(),
    features: [...scope.features].sort(),
    featureRevisions: Object.entries(scope.featureRevisions ?? {}).sort(),
  });
}
