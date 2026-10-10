import { createHash } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type {
  DiagnosticEnvelope,
  FrontendInsightEventV3,
} from "@frontend-insight/event-contract";
import { DIAGNOSTIC_LIMITS } from "@frontend-insight/event-contract/constants";
import type { RowDataPacket } from "mysql2/promise";
import type { MySqlStore } from "./mysql-store.js";
import type { KafkaEventEnvelope, Principal } from "./model.js";

export type DiagnosticCapability = "diagnostics.read" | "diagnostics.export";
export class DiagnosticAccessError extends Error {}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const absent = (d: DiagnosticEnvelope, status: "rate_limited") => ({
  ...d,
  status,
  raw: {},
  suppressed: Math.max(1, d.suppressed),
});

export class RuntimeDiagnostics {
  constructor(private readonly mysql: MySqlStore) {}

  async audit(
    actor: string | null,
    project: string,
    object: string,
    action: string,
    result: string,
  ) {
    await this.mysql.pool.execute(
      "INSERT INTO diagnostic_audit(actor_user_id,project_id,object_id,action,result) VALUES(?,?,?,?,?)",
      [actor, project, object, action, result],
    );
  }

  async allowed(
    p: Principal,
    project: string,
    capability: DiagnosticCapability,
  ): Promise<boolean> {
    // Fresh membership AND fresh account role on every call: no cached capability.
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT u.global_role,p.status,m.user_id,g.can_read,g.can_export
      FROM users u JOIN projects p ON p.id=?
      LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=u.id
      LEFT JOIN diagnostic_grants g ON g.project_id=m.project_id AND g.user_id=m.user_id
      WHERE u.id=? AND u.status='active'`,
      [project, p.userId],
    );
    const r = rows[0];
    return Boolean(
      r &&
      (r.global_role === "admin" ||
        (r.status === "active" &&
          r.user_id &&
          r.can_read &&
          (capability === "diagnostics.read" || r.can_export))),
    );
  }

  async authorize(
    p: Principal,
    project: string,
    object: string,
    capability: DiagnosticCapability,
  ) {
    if (!(await this.allowed(p, project, capability))) {
      await this.audit(p.userId, project, object, capability, "forbidden");
      throw new DiagnosticAccessError("DIAGNOSTICS_FORBIDDEN");
    }
  }

  async manage(p: Principal, project: string, object: string) {
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      "SELECT u.id FROM users u JOIN projects p ON p.id=? WHERE u.id=? AND u.global_role='admin' AND u.status='active'",
      [project, p.userId],
    );
    if (!rows.length) {
      await this.audit(p.userId, project, object, "diagnostics.manage", "forbidden");
      throw new DiagnosticAccessError("DIAGNOSTICS_FORBIDDEN");
    }
  }

  async grant(
    p: Principal,
    project: string,
    user: string,
    read: boolean,
    exportRaw: boolean,
  ) {
    await this.manage(p, project, user);
    if (exportRaw && !read) throw new Error("DIAGNOSTICS_EXPORT_REQUIRES_READ");
    const c = await this.mysql.pool.getConnection();
    try {
      await c.beginTransaction();
      const [members] = await c.query<RowDataPacket[]>(
        "SELECT user_id FROM project_members WHERE project_id=? AND user_id=? FOR UPDATE",
        [project, user],
      );
      if (!members.length) throw new Error("MEMBERSHIP_NOT_FOUND");
      await c.execute(
        "INSERT INTO diagnostic_grants(project_id,user_id,can_read,can_export) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE can_read=VALUES(can_read),can_export=VALUES(can_export)",
        [project, user, read, exportRaw],
      );
      await c.execute(
        "INSERT INTO diagnostic_audit(actor_user_id,project_id,object_id,action,result) VALUES(?,?,?,'diagnostics.grant','success')",
        [p.userId, project, user],
      );
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
    return { read, export: exportRaw };
  }

  async policy(p: Principal, project: string, retentionDays: number) {
    await this.manage(p, project, project);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 90)
      throw new Error("DIAGNOSTICS_RETENTION_INVALID");
    const c = await this.mysql.pool.getConnection();
    try {
      await c.beginTransaction();
      await c.execute(
        "INSERT INTO diagnostic_policies(project_id,version,retention_days) VALUES(?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),retention_days=VALUES(retention_days)",
        [project, `d0-${Date.now()}`, retentionDays],
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
    return { retentionDays };
  }

  /** Durable rate admission and receipt. Retried IDs retain first expiry/admission.
   * No raw content is stored in MySQL, logs, or receipt metadata. */
  async admit(project: string, events: FrontendInsightEventV3[], now: number) {
    const c = await this.mysql.pool.getConnection();
    try {
      await c.beginTransaction();
      await c.execute("INSERT IGNORE INTO diagnostic_policies(project_id) VALUES(?)", [
        project,
      ]);
      const [policies] = await c.query<RowDataPacket[]>(
        "SELECT retention_days FROM diagnostic_policies WHERE project_id=? FOR UPDATE",
        [project],
      );
      for (const event of events) {
        if (!event.diagnostic) continue;
        const inputDigest = digest(event);
        const [existing] = await c.query<RowDataPacket[]>(
          "SELECT input_digest,storage_digest,state FROM diagnostic_receipts WHERE project_id=? AND event_id=?",
          [project, event.eventId],
        );
        if (existing[0]) {
          if (existing[0].input_digest !== inputDigest)
            throw new Error("DIAGNOSTICS_EVENT_CONFLICT");
          if (
            existing[0].state === "rate_limited" &&
            existing[0].storage_digest !== digest(event.diagnostic)
          )
            event.diagnostic = absent(event.diagnostic, "rate_limited");
          continue;
        }
        let state = "pending";
        if (
          ["rate_limited", "too_large", "unavailable"].includes(event.diagnostic.status)
        )
          state = event.diagnostic.status;
        else {
          const window = Math.floor(now / 60000);
          await c.execute(
            "INSERT IGNORE INTO diagnostic_rate_windows(project_id,page_view_id,window_start) VALUES(?,?,?)",
            [project, event.pageViewId, window],
          );
          const [rates] = await c.query<RowDataPacket[]>(
            "SELECT admitted FROM diagnostic_rate_windows WHERE project_id=? AND page_view_id=? AND window_start=? FOR UPDATE",
            [project, event.pageViewId, window],
          );
          if (Number(rates[0]!.admitted) >= DIAGNOSTIC_LIMITS.envelopesPerMinute) {
            event.diagnostic = absent(event.diagnostic, "rate_limited");
            state = "rate_limited";
          } else
            await c.execute(
              "UPDATE diagnostic_rate_windows SET admitted=admitted+1 WHERE project_id=? AND page_view_id=? AND window_start=?",
              [project, event.pageViewId, window],
            );
        }
        await c.execute(
          "INSERT INTO diagnostic_receipts(project_id,event_id,input_digest,storage_digest,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
          [
            project,
            event.eventId,
            inputDigest,
            digest(event.diagnostic),
            state,
            new Date(now + Number(policies[0]!.retention_days) * 86400000),
            new Date(now),
          ],
        );
      }
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }

  async persist(ch: ClickHouseClient, envelope: KafkaEventEnvelope) {
    for (const event of envelope.batch.events) {
      if (!event.diagnostic) continue;
      const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
        "SELECT storage_digest,state,expires_at FROM diagnostic_receipts WHERE project_id=? AND event_id=?",
        [envelope.projectId, event.eventId],
      );
      const r = rows[0];
      if (!r || r.storage_digest !== digest(event.diagnostic))
        throw new Error("DIAGNOSTICS_RECEIPT_MISMATCH");
      if (
        ["ready", "rate_limited", "too_large", "unavailable"].includes(
          String(r.state),
        ) ||
        new Date(r.expires_at).getTime() <= Date.now()
      )
        continue;
      try {
        await ch.insert({
          table: "diagnostic_details",
          format: "JSONEachRow",
          values: [
            {
              project_id: envelope.projectId,
              event_id: event.eventId,
              envelope_json: JSON.stringify(event.diagnostic),
              received_at: envelope.receivedAt,
              expires_at: new Date(r.expires_at)
                .toISOString()
                .slice(0, 19)
                .replace("T", " "),
            },
          ],
        });
        await this.mysql.pool.execute(
          "UPDATE diagnostic_receipts SET state='ready' WHERE project_id=? AND event_id=?",
          [envelope.projectId, event.eventId],
        );
      } catch {
        await this.mysql.pool.execute(
          "UPDATE diagnostic_receipts SET state='write_failed' WHERE project_id=? AND event_id=?",
          [envelope.projectId, event.eventId],
        );
        throw new Error("DIAGNOSTICS_WRITE_FAILED");
      }
    }
  }

  async read(ch: ClickHouseClient, p: Principal, project: string, event: string) {
    await this.authorize(p, project, event, "diagnostics.read");
    try {
      const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
        "SELECT state,expires_at FROM diagnostic_receipts WHERE project_id=? AND event_id=?",
        [project, event],
      );
      const r = rows[0];
      let state = !r
        ? "not_enabled"
        : new Date(r.expires_at).getTime() <= Date.now()
          ? "expired"
          : String(r.state);
      let diagnostic: DiagnosticEnvelope | undefined;
      if (state === "ready") {
        const response = await ch.query({
          query:
            "SELECT envelope_json FROM diagnostic_details FINAL WHERE project_id={project:UUID} AND event_id={event:String} AND expires_at>now() LIMIT 1",
          format: "JSONEachRow",
          query_params: { project, event },
        });
        const details = await response.json<{ envelope_json: string }>();
        if (details[0])
          diagnostic = JSON.parse(details[0].envelope_json) as DiagnosticEnvelope;
        else state = "unavailable";
      }
      await this.audit(p.userId, project, event, "diagnostics.read", state);
      return { eventId: event, state, ...(diagnostic ? { diagnostic } : {}) };
    } catch {
      await this.audit(p.userId, project, event, "diagnostics.read", "failed");
      throw new Error("DIAGNOSTICS_READ_FAILED");
    }
  }

  async cleanup(now = Date.now()) {
    await this.mysql.pool.execute(
      "DELETE FROM diagnostic_rate_windows WHERE window_start<? LIMIT 10000",
      [Math.floor(now / 60000) - 2],
    );
    // Receipt tombstones last as long as base facts, so expired != absent error.
    await this.mysql.pool.execute(
      "DELETE FROM diagnostic_receipts WHERE expires_at<? LIMIT 10000",
      [new Date(now - 90 * 86400000)],
    );
  }
}
