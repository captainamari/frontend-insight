import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  DEFAULT_DIAGNOSTIC_POLICY,
  validDiagnosticPolicy,
  type DiagnosticPolicy,
  type PublishedDiagnosticPolicy,
} from "@frontend-insight/event-contract/diagnostic-policy";
import type { MySqlStore } from "./mysql-store.js";
import type { Principal } from "./model.js";
import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";
export class DiagnosticOperationsError extends Error {}
export class DiagnosticOperations {
  constructor(
    private readonly mysql: MySqlStore,
    private readonly access: RuntimeDiagnostics,
  ) {}
  async published(project: string): Promise<PublishedDiagnosticPolicy> {
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT version,revision,config,retention_days,updated_at FROM diagnostic_policies WHERE project_id=?",
      [project],
    );
    const r = rows[0];
    return {
      revision: Number(r?.revision ?? 0),
      version: String(r?.version ?? "d0-1"),
      updatedAt: r?.updated_at ? new Date(r.updated_at).toISOString() : null,
      policy: r?.config
        ? typeof r.config === "string"
          ? JSON.parse(r.config)
          : r.config
        : {
            ...DEFAULT_DIAGNOSTIC_POLICY,
            retentionDays: Number(r?.retention_days ?? 14),
          },
    };
  }
  async publish(
    p: Principal,
    project: string,
    revision: number,
    policy: DiagnosticPolicy,
  ) {
    await this.access.manage(p, project, project);
    if (!validDiagnosticPolicy(policy) || !Number.isInteger(revision) || revision < 0)
      throw new DiagnosticOperationsError("DIAGNOSTICS_POLICY_INVALID");
    const c = await this.mysql.pool.getConnection();
    try {
      await c.beginTransaction();
      await c.execute("INSERT IGNORE INTO diagnostic_policies(project_id) VALUES(?)", [
        project,
      ]);
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT revision FROM diagnostic_policies WHERE project_id=? FOR UPDATE",
        [project],
      );
      if (Number(rows[0]!.revision) !== revision)
        throw new DiagnosticOperationsError("DIAGNOSTICS_POLICY_CONFLICT");
      await c.execute(
        "UPDATE diagnostic_policies SET revision=?,version=?,config=?,retention_days=?,updated_at=NOW(3) WHERE project_id=?",
        [
          revision + 1,
          `d6-${revision + 1}`,
          JSON.stringify(policy),
          policy.retentionDays,
          project,
        ],
      );
      await c.execute(
        "INSERT INTO diagnostic_audit(actor_user_id,project_id,object_id,action,result) VALUES(?,?,?,'diagnostics.policy','success')",
        [p.userId, project, project],
      );
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
    return this.published(project);
  }
  async settings(p: Principal, project: string) {
    await this.access.manage(p, project, project);
    const [grants] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT m.user_id AS userId,u.display_name AS displayName,COALESCE(g.can_read,0) AS canRead,COALESCE(g.can_export,0) AS canExport FROM project_members m JOIN users u ON u.id=m.user_id LEFT JOIN diagnostic_grants g ON g.project_id=m.project_id AND g.user_id=m.user_id WHERE m.project_id=? LIMIT 201",
      [project],
    );
    return {
      ...(await this.published(project)),
      grants,
      compatibility:
        "仅D6可选策略模块同步；旧SDK仍受服务端准入约束。发布不代表客户端全部应用。",
    };
  }
  async remove(p: Principal, project: string, event: string) {
    await this.access.manage(p, project, event);
    if (!/^evt_[A-Za-z0-9_-]{8,64}$/.test(event))
      throw new DiagnosticOperationsError("DIAGNOSTICS_DELETE_SCOPE_INVALID");
    const c = await this.mysql.pool.getConnection();
    try {
      await c.beginTransaction();
      // Same project lock as admission: deletion cannot race a first receipt into existence.
      await c.execute("INSERT IGNORE INTO diagnostic_policies(project_id) VALUES(?)", [
        project,
      ]);
      await c.query(
        "SELECT project_id FROM diagnostic_policies WHERE project_id=? FOR UPDATE",
        [project],
      );
      await c.execute(
        "INSERT IGNORE INTO diagnostic_deletions(id,project_id,event_id,created_at) VALUES(?,?,?,NOW(3))",
        [randomUUID(), project, event],
      );
      await c.execute(
        "UPDATE diagnostic_receipts SET state='deleted',deleted_at=NOW(3) WHERE project_id=? AND event_id=?",
        [project, event],
      );
      await c.execute(
        "INSERT INTO diagnostic_audit(actor_user_id,project_id,object_id,action,result) VALUES(?,?,?,'diagnostics.delete','success')",
        [p.userId, project, event],
      );
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT id,event_id AS eventId,created_at AS createdAt,cleaned_at AS cleanedAt FROM diagnostic_deletions WHERE project_id=? AND event_id=?",
        [project, event],
      );
      await c.commit();
      return {
        ...rows[0],
        state: "deleted",
        physicalCleanup: "pending_or_async",
        baseFacts: "unchanged",
      };
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }
  async isDeleted(project: string, event: string) {
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT id FROM diagnostic_deletions WHERE project_id=? AND event_id=?",
      [project, event],
    );
    return rows.length > 0;
  }
  async status(p: Principal, project: string) {
    await this.access.manage(p, project, project);
    // Bounded newest 10,000 receipts, explicitly a sample/window and not disk usage.
    const [counts] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT state,COUNT(*) AS count,SUM(byte_size) AS bytes,SUM(expires_at<=NOW(3)) AS expired,AVG(TIMESTAMPDIFF(MICROSECOND,created_at,persisted_at)/1000) AS persistDelayMs FROM (SELECT state,byte_size,expires_at,created_at,persisted_at FROM diagnostic_receipts WHERE project_id=? AND created_at>=DATE_SUB(NOW(3),INTERVAL 7 DAY) ORDER BY created_at DESC LIMIT 10000) r GROUP BY state`,
      [project],
    );
    const [health] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT client_id AS clientId,observed_at AS observedAt,metadata FROM diagnostic_health WHERE project_id=? AND observed_at>=DATE_SUB(NOW(3),INTERVAL 1 DAY) ORDER BY observed_at DESC LIMIT 100",
      [project],
    );
    const [maps] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT state,COUNT(*) AS count,SUM(byte_size) AS bytes,MIN(expires_at) AS firstExpiry FROM diagnostic_sourcemaps WHERE project_id=? GROUP BY state",
      [project],
    );
    const [cleanup] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT component,success_at AS successAt,failure_at AS failureAt,error_code AS errorCode FROM diagnostic_maintenance LIMIT 2",
    );
    const [deletions] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT id,event_id AS eventId,created_at AS createdAt,cleaned_at AS cleanedAt FROM diagnostic_deletions WHERE project_id=? ORDER BY created_at DESC LIMIT 50",
      [project],
    );
    return {
      at: new Date().toISOString(),
      counts,
      health,
      maps,
      cleanup,
      deletions,
      diskBytes: null,
      scope:
        "最近7天最多10000条接收记录；bytes为准入信封逻辑字节，非磁盘占用；SourceMap为元数据配额账面值（含待清理项）；共享磁盘无法精确归属项目。健康为最近24小时最多100客户端最新累计快照，不代表全量客户端。无观测=null/空列表，不解释为零。",
    };
  }
  async observe(
    project: string,
    client: string,
    seq: number,
    metadata: Record<string, unknown>,
  ) {
    const c = await this.mysql.pool.getConnection();
    try {
      await c.beginTransaction();
      await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [project]);
      const [count] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM diagnostic_health WHERE project_id=?",
        [project],
      );
      const [existing] = await c.query<RowDataPacket[]>(
        "SELECT sequence_no,observed_at FROM diagnostic_health WHERE project_id=? AND client_id=? FOR UPDATE",
        [project, client],
      );
      if (!existing.length && Number(count[0]!.n) >= 1000)
        throw new DiagnosticOperationsError("DIAGNOSTICS_HEALTH_CAPACITY");
      if (
        existing[0] &&
        (Number(existing[0].sequence_no) >= seq ||
          Date.now() - new Date(existing[0].observed_at).getTime() < 60000)
      ) {
        await c.commit();
        return { accepted: false };
      }
      await c.execute(
        "INSERT INTO diagnostic_health(project_id,client_id,sequence_no,observed_at,metadata) VALUES(?,?,?,NOW(3),?) ON DUPLICATE KEY UPDATE sequence_no=VALUES(sequence_no),observed_at=VALUES(observed_at),metadata=VALUES(metadata)",
        [project, client, seq, JSON.stringify(metadata)],
      );
      await c.commit();
      return { accepted: true };
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }
  async recordCleanup(component: string, success: boolean) {
    await this.mysql.pool.execute(
      success
        ? "INSERT INTO diagnostic_maintenance(component,success_at) VALUES(?,NOW(3)) ON DUPLICATE KEY UPDATE success_at=NOW(3),error_code=NULL"
        : "INSERT INTO diagnostic_maintenance(component,failure_at,error_code) VALUES(?,NOW(3),'CLEANUP_FAILED') ON DUPLICATE KEY UPDATE failure_at=NOW(3),error_code='CLEANUP_FAILED'",
      [component],
    );
  }
  async cleanup(ch: ClickHouseClient) {
    try {
      // Revisit tombstones: a late writer after a previous sweep must still be physically reclaimed.
      const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
        "SELECT id,project_id,event_id FROM diagnostic_deletions ORDER BY COALESCE(cleaned_at,created_at) LIMIT 100",
      );
      for (const r of rows) {
        await ch.command({
          query:
            "ALTER TABLE diagnostic_details DELETE WHERE project_id={project:UUID} AND event_id={event:String}",
          query_params: { project: String(r.project_id), event: String(r.event_id) },
          clickhouse_settings: { mutations_sync: "1", max_execution_time: 5 },
        });
        await this.mysql.pool.execute(
          "UPDATE diagnostic_deletions SET cleaned_at=NOW(3) WHERE id=?",
          [r.id],
        );
      }
      await this.mysql.pool.execute(
        "DELETE FROM diagnostic_health WHERE observed_at<DATE_SUB(NOW(3),INTERVAL 1 DAY) LIMIT 1000",
      );
      await this.recordCleanup("evidence", true);
    } catch {
      await this.recordCleanup("evidence", false);
    }
  }
}
