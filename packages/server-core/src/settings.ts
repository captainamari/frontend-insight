import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { MySqlStore } from "./mysql-store.js";
import { MetricLibraryError } from "./metric-library.js";
import type { AbnormalConfig } from "./settings-facts.js";
export const R7_SDK_VERSION = "0.8.0";
export const EXPORT_KINDS = [
  "metric_snapshot",
  "metric_trend",
  "quality_summary",
  "prometheus",
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export interface ExportScope {
  env: "dev" | "staging" | "prod";
  from: string;
  to: string;
  maxRangeDays: number;
  expiresAt: string;
  rateLimit: number;
}
export interface ProbeInput {
  version: string;
  status: "recommended" | "supported" | "deprecated" | "blocked";
  contractVersion: 3;
  releaseNotes: string;
  upgradeAdvice: string;
  confirmBlocked?: boolean | undefined;
}
export const exportTokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const settingsJson = (v: unknown): Record<string, unknown> =>
  typeof v === "string" ? JSON.parse(v) : (v as Record<string, unknown>);
function fail(code: string, status = 400): never {
  throw new MetricLibraryError(code, status);
}
export class SettingsService {
  constructor(private readonly mysql: MySqlStore) {}
  async transaction<T>(work: (db: PoolConnection) => Promise<T>): Promise<T> {
    const c = await this.mysql.pool.getConnection();
    try {
      await c.beginTransaction();
      const value = await work(c);
      await c.commit();
      return value;
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }
  async audit(
    c: Pick<PoolConnection, "execute">,
    project: string | null,
    actor: string | null,
    action: string,
    id: string,
    requestId: string,
    metadata: Record<string, unknown> = {},
  ) {
    await c.execute(
      "INSERT INTO audit_logs(project_id,actor_user_id,action,entity_type,entity_id,metadata,request_id) VALUES(?,?,?,?,?,?,?)",
      [project, actor, action, "settings", id, JSON.stringify(metadata), requestId],
    );
  }
  async probes(project: string) {
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT id,policy_key,status,rules,effective_from,updated_at FROM probe_policies WHERE project_id=? ORDER BY policy_key LIMIT 201",
      [project],
    );
    if (rows.length > 200) fail("PROBE_POLICY_LIMIT", 422);
    return rows.map((r) => ({
      id: String(r.id),
      version: String(r.policy_key),
      status: String(r.status),
      ...settingsJson(r.rules),
      updatedAt: r.updated_at,
    }));
  }
  async saveProbe(
    project: string,
    actor: string,
    input: ProbeInput,
    requestId: string,
  ) {
    if (input.status === "blocked" && !input.confirmBlocked)
      fail("BLOCK_CONFIRMATION_REQUIRED");
    if (input.status === "recommended" && input.version !== R7_SDK_VERSION)
      fail("RECOMMENDED_BUNDLE_NOT_AVAILABLE");
    return this.transaction(async (c) => {
      await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [project]);
      if (input.status === "recommended")
        await c.execute(
          "UPDATE probe_policies SET status='supported' WHERE project_id=? AND status='recommended' AND policy_key<>?",
          [project, input.version],
        );
      const [existing] = await c.query<RowDataPacket[]>(
        "SELECT id FROM probe_policies WHERE project_id=? AND policy_key=?",
        [project, input.version],
      );
      const id = existing[0] ? String(existing[0].id) : randomUUID();
      if (!existing.length) {
        const [count] = await c.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM probe_policies WHERE project_id=?",
          [project],
        );
        if (Number(count[0]!.n) >= 200) fail("PROBE_POLICY_LIMIT");
      }
      const rules = JSON.stringify({
        contractVersion: input.contractVersion,
        releaseNotes: input.releaseNotes,
        upgradeAdvice: input.upgradeAdvice,
      });
      await c.execute(
        "INSERT INTO probe_policies(id,project_id,policy_key,status,rules,effective_from) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE status=VALUES(status),rules=VALUES(rules),updated_at=CURRENT_TIMESTAMP(3)",
        [id, project, input.version, input.status, rules],
      );
      await this.audit(c, project, actor, "probe.saved", id, requestId, {
        version: input.version,
        status: input.status,
        confirmBlocked: input.confirmBlocked === true,
      });
      return { id };
    });
  }
  async deleteProbe(
    project: string,
    actor: string,
    version: string,
    requestId: string,
  ) {
    await this.transaction(async (c) => {
      await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [project]);
      await c.execute(
        "DELETE FROM probe_policies WHERE project_id=? AND policy_key=?",
        [project, version],
      );
      await this.audit(c, project, actor, "probe.deleted", version, requestId);
    });
    return { deleted: true };
  }
  async assertProbe(project: string, version: string) {
    // Deliberately bypass ingestion's project cache; block applies on every new request on every instance.
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT status FROM probe_policies WHERE project_id=? AND policy_key=?",
      [project, version],
    );
    if (rows[0]?.status === "blocked") fail("PROBE_VERSION_BLOCKED", 403);
  }
  async interfaces(project: string, page: number) {
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT id,interface_key,enabled,scopes,rate_limit_per_minute,last_called_at,last_status FROM export_interfaces WHERE project_id=? ORDER BY interface_key LIMIT 10 OFFSET ?`,
      [project, (page - 1) * 10],
    );
    return {
      page,
      pageSize: 10,
      items: rows.map((r) => ({
        id: String(r.id),
        kind: r.interface_key,
        enabled: Boolean(r.enabled),
        scope: settingsJson(r.scopes),
        rateLimit: r.rate_limit_per_minute,
        lastCalledAt: r.last_called_at,
        lastStatus: r.last_status,
      })),
    };
  }
  async createInterface(
    project: string,
    actor: string,
    kind: ExportKind,
    scope: ExportScope,
    requestId: string,
  ) {
    if (
      Date.parse(scope.from) >= Date.parse(scope.to) ||
      Date.parse(scope.expiresAt) <= Date.now() ||
      Date.parse(scope.expiresAt) > Date.now() + 90 * 86400000
    )
      fail("EXPORT_SCOPE_INVALID");
    const id = randomUUID();
    await this.transaction(async (c) => {
      await c.execute(
        "INSERT INTO export_interfaces(id,project_id,interface_key,enabled,scopes,rate_limit_per_minute) VALUES(?,?,?,FALSE,?,?)",
        [id, project, kind, JSON.stringify(scope), scope.rateLimit],
      );
      await this.audit(c, project, actor, "export.created", id, requestId, {
        kind,
        scope,
      });
    });
    return { id, enabled: false };
  }
  async updateInterface(
    project: string,
    actor: string,
    id: string,
    scope: ExportScope,
    requestId: string,
  ) {
    if (
      Date.parse(scope.from) >= Date.parse(scope.to) ||
      Date.parse(scope.expiresAt) <= Date.now() ||
      Date.parse(scope.expiresAt) > Date.now() + 90 * 86400000
    )
      fail("EXPORT_SCOPE_INVALID");
    return this.transaction(async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT id FROM export_interfaces WHERE id=? AND project_id=? FOR UPDATE",
        [id, project],
      );
      if (!rows.length) fail("EXPORT_NOT_FOUND", 404);
      await c.execute(
        "UPDATE export_interfaces SET scopes=?,rate_limit_per_minute=?,enabled=FALSE WHERE id=?",
        [JSON.stringify(scope), scope.rateLimit, id],
      );
      await c.execute(
        "UPDATE export_credentials SET revoked_at=CURRENT_TIMESTAMP(3) WHERE export_interface_id=? AND revoked_at IS NULL",
        [id],
      );
      await this.audit(c, project, actor, "export.scope_changed", id, requestId, {
        scope,
      });
      return { id, enabled: false };
    });
  }
  async changeInterface(
    project: string,
    actor: string,
    id: string,
    action: "enable" | "disable" | "rotate" | "revoke",
    requestId: string,
  ) {
    return this.transaction(async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT * FROM export_interfaces WHERE id=? AND project_id=? FOR UPDATE",
        [id, project],
      );
      const row = rows[0];
      if (!row) fail("EXPORT_NOT_FOUND", 404);
      const scope = settingsJson(row.scopes) as unknown as ExportScope;
      if (
        (action === "enable" || action === "rotate") &&
        Date.parse(scope.expiresAt) <= Date.now()
      )
        fail("EXPORT_SCOPE_EXPIRED", 409);
      let token: string | undefined;
      if (action === "disable" || action === "revoke")
        await c.execute("UPDATE export_interfaces SET enabled=FALSE WHERE id=?", [id]);
      if (action !== "disable")
        await c.execute(
          "UPDATE export_credentials SET revoked_at=CURRENT_TIMESTAMP(3) WHERE export_interface_id=? AND revoked_at IS NULL",
          [id],
        );
      if (action === "enable" || action === "rotate") {
        if (action === "rotate" && !row.enabled) fail("EXPORT_DISABLED", 409);
        token = "fi_" + randomBytes(32).toString("base64url");
        await c.execute(
          "INSERT INTO export_credentials(id,export_interface_id,token_prefix,token_hash,expires_at) VALUES(?,?,?,?,?)",
          [
            randomUUID(),
            id,
            token.slice(0, 10),
            exportTokenHash(token),
            new Date(scope.expiresAt),
          ],
        );
        await c.execute("UPDATE export_interfaces SET enabled=TRUE WHERE id=?", [id]);
      }
      await this.audit(c, project, actor, "export." + action, id, requestId);
      return {
        id,
        action,
        ...(token ? { token, expiresAt: scope.expiresAt, shownOnce: true } : {}),
      };
    });
  }
  async authorizeExport(
    project: string,
    kind: ExportKind,
    token: string,
    query: { env: string; from: string; to: string },
    requestId: string,
  ) {
    // A shared DB row serializes authorization, lifecycle mutations and per-interface minute buckets.
    const result = await this.transaction(async (c) => {
      const [interfaces] = await c.query<RowDataPacket[]>(
        "SELECT * FROM export_interfaces WHERE project_id=? AND interface_key=? FOR UPDATE",
        [project, kind],
      );
      const target = interfaces[0];
      if (!target) {
        await this.audit(c, null, null, "export.denied", kind, requestId, {
          code: "EXPORT_CREDENTIAL_INVALID",
        });
        return { code: "EXPORT_CREDENTIAL_INVALID", status: 401 };
      }
      const minute = Math.floor(Date.now() / 60000);
      await c.execute(
        "INSERT INTO export_rate_windows(export_interface_id,window_start,calls) VALUES(?,?,1) ON DUPLICATE KEY UPDATE calls=IF(window_start=VALUES(window_start),calls+1,1),window_start=VALUES(window_start)",
        [target.id, minute],
      );
      const [counts] = await c.query<RowDataPacket[]>(
        "SELECT calls FROM export_rate_windows WHERE export_interface_id=?",
        [target.id],
      );
      if (Number(counts[0]!.calls) > Number(target.rate_limit_per_minute)) {
        await c.execute(
          "UPDATE export_interfaces SET last_called_at=CURRENT_TIMESTAMP(3),last_status='EXPORT_RATE_LIMITED' WHERE id=?",
          [target.id],
        );
        await this.audit(
          c,
          project,
          null,
          "export.denied",
          String(target.id),
          requestId,
          { code: "EXPORT_RATE_LIMITED" },
        );
        return { code: "EXPORT_RATE_LIMITED", status: 429 };
      }
      const [credentials] = await c.query<RowDataPacket[]>(
        "SELECT expires_at,revoked_at FROM export_credentials WHERE export_interface_id=? AND token_hash=?",
        [target.id, exportTokenHash(token)],
      );
      const credential = credentials[0];
      if (!credential) {
        await c.execute(
          "UPDATE export_interfaces SET last_called_at=CURRENT_TIMESTAMP(3),last_status='EXPORT_CREDENTIAL_INVALID' WHERE id=?",
          [target.id],
        );
        await this.audit(
          c,
          project,
          null,
          "export.denied",
          String(target.id),
          requestId,
          { code: "EXPORT_CREDENTIAL_INVALID" },
        );
        return { code: "EXPORT_CREDENTIAL_INVALID", status: 401 };
      }
      const r = { ...target, ...credential };
      let code = "";
      const status = 403;
      const scope = settingsJson(r.scopes) as unknown as ExportScope;
      if (!r.enabled) code = "EXPORT_DISABLED";
      else if (r.revoked_at) code = "EXPORT_REVOKED";
      else if (!r.expires_at || new Date(r.expires_at).getTime() <= Date.now())
        code = "EXPORT_EXPIRED";
      else if (
        query.env !== scope.env ||
        Date.parse(query.from) < Date.parse(scope.from) ||
        Date.parse(query.to) > Date.parse(scope.to) ||
        Date.parse(query.to) - Date.parse(query.from) > scope.maxRangeDays * 86400000
      )
        code = "EXPORT_SCOPE_FORBIDDEN";
      await c.execute(
        "UPDATE export_interfaces SET last_called_at=CURRENT_TIMESTAMP(3),last_status=? WHERE id=?",
        [code || "authorized", r.id],
      );
      await this.audit(
        c,
        project,
        null,
        code ? "export.denied" : "export.authorized",
        String(r.id),
        requestId,
        {
          code: code || "AUTHORIZED",
          kind,
          env: query.env,
          from: query.from,
          to: query.to,
        },
      );
      return { code, status, id: String(r.id) };
    });
    if (result.code) fail(result.code, result.status);
    return { id: result.id! };
  }
  async finishExport(project: string, id: string, requestId: string, code: string) {
    await this.transaction(async (c) => {
      await c.execute(
        "UPDATE export_interfaces SET last_called_at=CURRENT_TIMESTAMP(3),last_status=? WHERE id=? AND project_id=?",
        [code, id, project],
      );
      await this.audit(c, project, null, "export.completed", id, requestId, { code });
    });
  }
  async rules(project: string) {
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT * FROM abnormal_rule_versions WHERE project_id=? ORDER BY created_at DESC,id LIMIT 201",
      [project],
    );
    if (rows.length > 200) fail("ABNORMAL_VERSION_LIMIT", 422);
    return rows.map((r) => ({
      id: String(r.id),
      ruleKey: String(r.rule_key),
      config: settingsJson(r.config) as unknown as AbnormalConfig,
      status: String(r.status),
      approval: r.approval ? settingsJson(r.approval) : null,
      createdAt: r.created_at,
    }));
  }
  async createRule(
    project: string,
    actor: string,
    key: string,
    config: AbnormalConfig,
    requestId: string,
  ) {
    if (
      config.workEnd <= config.workStart ||
      config.minimumBaselineDays > config.baselineDays
    )
      fail("ABNORMAL_CONFIG_INVALID");
    const id = randomUUID();
    await this.transaction(async (c) => {
      await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [project]);
      const [n] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM abnormal_rule_versions WHERE project_id=?",
        [project],
      );
      if (Number(n[0]!.n) >= 200) fail("ABNORMAL_VERSION_LIMIT");
      await c.execute(
        "INSERT INTO abnormal_rule_versions(id,project_id,rule_key,config,created_by) VALUES(?,?,?,?,?)",
        [id, project, key, JSON.stringify(config), actor],
      );
      await this.audit(c, project, actor, "abnormal.draft", id, requestId);
    });
    return { id, status: "draft" };
  }
  async ruleAction(
    project: string,
    actor: string,
    id: string,
    action: "approve" | "enable" | "disable",
    approval: Record<string, unknown> | null,
    requestId: string,
  ) {
    return this.transaction(async (c) => {
      await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [project]);
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT * FROM abnormal_rule_versions WHERE project_id=? AND id=? FOR UPDATE",
        [project, id],
      );
      const r = rows[0];
      if (!r) fail("ABNORMAL_NOT_FOUND", 404);
      if (action === "approve") {
        if (r.status !== "draft" || !approval) fail("APPROVAL_INVALID", 409);
        await c.execute(
          "UPDATE abnormal_rule_versions SET status='approved',approval=? WHERE id=?",
          [
            JSON.stringify({
              ...approval,
              recordedBy: actor,
              recordedAt: new Date().toISOString(),
            }),
            id,
          ],
        );
      }
      if (action === "enable") {
        if (!r.approval || r.status === "draft") fail("APPROVAL_REQUIRED", 409);
        const config = settingsJson(r.config);
        await c.execute(
          "UPDATE abnormal_rule_versions SET status='disabled' WHERE project_id=? AND rule_key=? AND status='enabled' AND JSON_UNQUOTE(JSON_EXTRACT(config,'$.env'))=?",
          [project, r.rule_key, config.env],
        );
        await c.execute(
          "UPDATE abnormal_rule_versions SET status='enabled' WHERE id=?",
          [id],
        );
      }
      if (action === "disable")
        await c.execute(
          "UPDATE abnormal_rule_versions SET status='disabled' WHERE id=?",
          [id],
        );
      await this.audit(c, project, actor, "abnormal." + action, id, requestId, {
        approval: approval ?? null,
      });
      return { id, action };
    });
  }
  async auditPage(project: string, page: number) {
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT action,entity_id,metadata,request_id,created_at FROM audit_logs WHERE project_id=? AND entity_type='settings' ORDER BY id DESC LIMIT 20 OFFSET ?",
      [project, (page - 1) * 20],
    );
    return { page, pageSize: 20, items: rows };
  }
}
