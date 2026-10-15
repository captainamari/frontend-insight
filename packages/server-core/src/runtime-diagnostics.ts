import { DiagnosticOperations } from "./diagnostic-operations.js";
import {
  DEFAULT_DIAGNOSTIC_POLICY,
  type DiagnosticPolicy,
  diagnosticRouteMatches,
} from "@frontend-insight/event-contract/diagnostic-policy";
import type { SourceMaps } from "./sourcemaps.js";
import { projectOccurrence } from "./page-quality.js";
import {
  searchDiagnostics,
  DiagnosticQueryError,
  DIAGNOSTIC_QUERY_LIMITS,
  type DiagnosticSearchQuery,
} from "./diagnostic-search.js";
import { diagnosticErrorView } from "./error-stack.js";
import { createHash } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type {
  DiagnosticEnvelope,
  FrontendInsightEventV3,
} from "@frontend-insight/event-contract";
import { DIAGNOSTIC_LIMITS } from "@frontend-insight/event-contract/constants";
import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import type { MySqlStore } from "./mysql-store.js";
import type { KafkaEventEnvelope, Principal } from "./model.js";

export type DiagnosticCapability = "diagnostics.read" | "diagnostics.export";
export class DiagnosticAccessError extends Error {}
const digestJson = (json: string) => createHash("sha256").update(json).digest("hex");
const digest = (value: unknown) => digestJson(JSON.stringify(value));
// Admission only ever replaces event.diagnostic; it never mutates raw or other nested
// evidence. Keep the large raw strings shared so 50 concurrent requests do not copy
// every envelope on the Node event loop. A fresh shell per retry still prevents an
// aborted transaction's suppression decision from leaking into the next attempt.
const cloneAdmissionEvents = (events: FrontendInsightEventV3[]) =>
  events.map((event) =>
    event.diagnostic ? { ...event, diagnostic: { ...event.diagnostic } } : { ...event },
  );
const FAST_ADMISSION_COLLISION = "DIAGNOSTICS_FAST_ADMISSION_COLLISION";
const absent = (
  d: DiagnosticEnvelope,
  status: "rate_limited" | "unavailable" | "too_large",
) => ({
  ...d,
  status,
  raw: {},
  suppressed: Math.max(1, d.suppressed),
});

/** Both the legacy explicit request and D3 records obey the same admission rules. */
export function diagnosticRequestsSuppressed(
  raw: Record<string, unknown>,
  policy: DiagnosticPolicy,
) {
  const requests = Array.isArray(raw.requests) ? [...raw.requests] : [];
  if (raw.request !== undefined) requests.push(raw.request);
  return requests.some((value: unknown) => {
    if (!value || typeof value !== "object") return true;
    const r = value as {
      url?: string | { value?: string };
      result?: string;
      requestBody?: unknown;
      responseBody?: unknown;
      status?: number;
    };
    try {
      const path = new URL(typeof r.url === "string" ? r.url : (r.url?.value ?? ""))
        .pathname;
      return (
        !diagnosticRouteMatches(path, policy.requestRoutes) ||
        ((r.result === "success" ||
          (typeof r.status === "number" && r.status >= 200 && r.status < 400)) &&
          (r.requestBody !== undefined || r.responseBody !== undefined) &&
          !diagnosticRouteMatches(path, policy.successBodyRoutes))
      );
    } catch {
      return true;
    }
  });
}

export class RuntimeDiagnostics {
  sourceMaps?: SourceMaps;
  readonly operations: DiagnosticOperations;
  private readonly knownPolicyRows = new Set<string>();
  constructor(private readonly mysql: MySqlStore) {
    this.operations = new DiagnosticOperations(mysql, this);
  }

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
    const current = await this.operations.published(project);
    return this.operations.publish(p, project, current.revision, {
      ...current.policy,
      retentionDays,
    });
  }

  /** Durable rate admission and receipt. Retried IDs retain first expiry/admission.
   * No raw content is stored in MySQL, logs, or receipt metadata. */
  async admit(project: string, events: FrontendInsightEventV3[], now: number) {
    // Retry only MySQL deadlocks, with fresh envelopes after full transaction rollback.
    // Never carry a suppressed envelope from an aborted transaction into a retry.
    let forceSequentialReceipts = false;
    for (let attempt = 0; ; attempt++) {
      const candidate = cloneAdmissionEvents(events);
      try {
        await this.admitTransaction(project, candidate, now, forceSequentialReceipts);
        for (let i = 0; i < events.length; i++) {
          const diagnostic = candidate[i]!.diagnostic;
          if (diagnostic) events[i]!.diagnostic = diagnostic;
        }
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === FAST_ADMISSION_COLLISION &&
          !forceSequentialReceipts
        ) {
          forceSequentialReceipts = true;
          attempt -= 1;
          continue;
        }
        if ((error as { code?: string })?.code !== "ER_LOCK_DEADLOCK" || attempt >= 2)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
  }

  private async admitTransaction(
    project: string,
    events: FrontendInsightEventV3[],
    now: number,
    forceSequentialReceipts: boolean,
  ) {
    const c = await this.mysql.pool.getConnection();
    try {
      // Avoid a duplicate-key write on the same project for every ingestion request.
      // Only the first request initializes the row; the transaction below still
      // takes a shared policy lock against concurrent publish/delete operations.
      if (!this.knownPolicyRows.has(project)) {
        const [knownPolicies] = await c.query<RowDataPacket[]>(
          "SELECT project_id FROM diagnostic_policies WHERE project_id=?",
          [project],
        );
        if (!knownPolicies.length)
          await c.execute(
            "INSERT IGNORE INTO diagnostic_policies(project_id) VALUES(?)",
            [project],
          );
        if (this.knownPolicyRows.size >= 10_000) this.knownPolicyRows.clear();
        this.knownPolicyRows.add(project);
      }
      await c.beginTransaction();
      const [policies] = await c.query<RowDataPacket[]>(
        "SELECT retention_days,config FROM diagnostic_policies WHERE project_id=? FOR SHARE",
        [project],
      );
      const config = policies[0]?.config;
      const policy = config
        ? typeof config === "string"
          ? JSON.parse(config)
          : config
        : DEFAULT_DIAGNOSTIC_POLICY;
      const ids = events
        .filter((event) => event.diagnostic)
        .map((event) => event.eventId);
      const [deletedRows] = await c.query<RowDataPacket[]>(
        `SELECT event_id FROM diagnostic_deletions WHERE project_id=? AND event_id IN (${ids.map(() => "?").join(",")})`,
        [project, ...ids],
      );
      const deletedIds = new Set(deletedRows.map((row) => String(row.event_id)));
      const admissionCandidates: FrontendInsightEventV3[] = [];
      const diagnosticEvents = events.filter(
        (event): event is FrontendInsightEventV3 & { diagnostic: DiagnosticEnvelope } =>
          Boolean(event.diagnostic),
      );
      const prepared = new Map(
        diagnosticEvents.map((event) => {
          const diagnosticJson = JSON.stringify(event.diagnostic);
          const { raw: originalRaw, ...initialMetadata } = event.diagnostic;
          void originalRaw;
          return [
            event,
            {
              inputDigest: digestJson(JSON.stringify(event)),
              initialStorageDigest: digestJson(diagnosticJson),
              initialByteSize: Buffer.byteLength(diagnosticJson),
              initialMetadata,
            },
          ] as const;
        }),
      );
      const fastAdmission =
        !forceSequentialReceipts &&
        new Set(diagnosticEvents.map((event) => event.eventId)).size ===
          diagnosticEvents.length &&
        diagnosticEvents.every((event) => {
          const item = prepared.get(event)!;
          return (
            !deletedIds.has(event.eventId) &&
            policy.enabled &&
            item.initialByteSize <= policy.envelopeBytes &&
            !(
              policy.level === "errors" &&
              (event.diagnostic.raw.console ||
                event.diagnostic.raw.requests ||
                event.diagnostic.raw.request)
            ) &&
            !(
              Array.isArray(event.diagnostic.raw.console) &&
              event.diagnostic.raw.console.some(
                (row: unknown) =>
                  !policy.consoleLevels.includes((row as { level?: string })?.level),
              )
            ) &&
            !diagnosticRequestsSuppressed(event.diagnostic.raw, policy) &&
            !["rate_limited", "too_large", "unavailable"].includes(
              event.diagnostic.status,
            )
          );
        });
      if (fastAdmission && diagnosticEvents.length) {
        const [reservation] = await c.execute<ResultSetHeader>(
          `INSERT IGNORE INTO diagnostic_receipts(project_id,event_id,input_digest,storage_digest,state,expires_at,created_at,capture_metadata,byte_size) VALUES ${diagnosticEvents.map(() => "(?,?,?,?,'pending',?,?,?,?)").join(",")}`,
          diagnosticEvents.flatMap((event) => {
            const item = prepared.get(event)!;
            return [
              project,
              event.eventId,
              item.inputDigest,
              item.initialStorageDigest,
              new Date(now + Number(policies[0]!.retention_days) * 86400000),
              new Date(now),
              JSON.stringify(item.initialMetadata),
              item.initialByteSize,
            ];
          }),
        );
        // The common high-throughput path owns every new receipt. Any retry or
        // concurrent duplicate rolls this transaction back and re-enters the exact
        // per-event path below, which preserves conflict and first-result semantics.
        if (reservation.affectedRows !== diagnosticEvents.length)
          throw new Error(FAST_ADMISSION_COLLISION);
        admissionCandidates.push(...diagnosticEvents);
      }
      for (const event of fastAdmission ? [] : diagnosticEvents) {
        const { inputDigest, initialStorageDigest, initialByteSize, initialMetadata } =
          prepared.get(event)!;
        // The unique receipt reserves this event before spending the page budget.
        // Concurrent identical retries wait for commit and reuse its final result.
        const [reservation] = await c.execute<ResultSetHeader>(
          "INSERT IGNORE INTO diagnostic_receipts(project_id,event_id,input_digest,storage_digest,state,expires_at,created_at,capture_metadata,byte_size) VALUES(?,?,?,?,'pending',?,?,?,?)",
          [
            project,
            event.eventId,
            inputDigest,
            initialStorageDigest,
            new Date(now + Number(policies[0]!.retention_days) * 86400000),
            new Date(now),
            JSON.stringify(initialMetadata),
            initialByteSize,
          ],
        );
        const existing = reservation.affectedRows
          ? []
          : (
              await c.query<RowDataPacket[]>(
                "SELECT input_digest,storage_digest,state FROM diagnostic_receipts WHERE project_id=? AND event_id=? FOR SHARE",
                [project, event.eventId],
              )
            )[0];
        if (!reservation.affectedRows && existing[0]) {
          if (existing[0].input_digest !== inputDigest)
            throw new Error("DIAGNOSTICS_EVENT_CONFLICT");
          if (
            [
              "rate_limited",
              "too_large",
              "disabled",
              "deleted",
              "policy_suppressed",
            ].includes(existing[0].state) &&
            existing[0].storage_digest !== initialStorageDigest
          )
            event.diagnostic = absent(
              event.diagnostic,
              existing[0].state === "rate_limited"
                ? "rate_limited"
                : existing[0].state === "too_large"
                  ? "too_large"
                  : "unavailable",
            );
          continue;
        }
        let state = "pending";
        if (deletedIds.has(event.eventId) || !policy.enabled) {
          state = deletedIds.has(event.eventId) ? "deleted" : "disabled";
          event.diagnostic = absent(event.diagnostic, "unavailable");
        } else if (initialByteSize > policy.envelopeBytes) {
          state = "too_large";
          event.diagnostic = absent(event.diagnostic, "too_large");
        } else if (
          policy.level === "errors" &&
          (event.diagnostic.raw.console ||
            event.diagnostic.raw.requests ||
            event.diagnostic.raw.request)
        ) {
          state = "policy_suppressed";
          event.diagnostic = absent(event.diagnostic, "unavailable");
        } else if (
          (Array.isArray(event.diagnostic.raw.console) &&
            event.diagnostic.raw.console.some(
              (r: unknown) =>
                !policy.consoleLevels.includes((r as { level?: string })?.level),
            )) ||
          diagnosticRequestsSuppressed(event.diagnostic.raw, policy)
        ) {
          state = "policy_suppressed";
          event.diagnostic = absent(event.diagnostic, "unavailable");
        }

        if (state !== "pending") {
          /* server policy already decided; keep its precise receipt reason */
        } else if (
          ["rate_limited", "too_large", "unavailable"].includes(event.diagnostic.status)
        )
          state = event.diagnostic.status;
        else {
          admissionCandidates.push(event);
          continue;
        }
        if (state === "pending") continue;
        const { raw: _raw, ...captureMetadata } = event.diagnostic;
        void _raw;
        await c.execute(
          "UPDATE diagnostic_receipts SET storage_digest=?,state=?,capture_metadata=?,byte_size=? WHERE project_id=? AND event_id=?",
          [
            digest(event.diagnostic),
            state,
            JSON.stringify(captureMetadata),
            Buffer.byteLength(JSON.stringify(event.diagnostic)),
            project,
            event.eventId,
          ],
        );
      }
      if (admissionCandidates.length) {
        const window = Math.floor(now / 60000);
        const pages = [
          ...new Set(admissionCandidates.map((event) => event.pageViewId)),
        ].sort();
        await c.execute(
          `INSERT INTO diagnostic_rate_windows(project_id,page_view_id,window_start) VALUES ${pages.map(() => "(?,?,?)").join(",")} ON DUPLICATE KEY UPDATE admitted=admitted`,
          pages.flatMap((page) => [project, page, window]),
        );
        const [rateRows] = await c.query<RowDataPacket[]>(
          `SELECT page_view_id,admitted FROM diagnostic_rate_windows WHERE project_id=? AND window_start=? AND page_view_id IN (${pages.map(() => "?").join(",")}) ORDER BY page_view_id FOR UPDATE`,
          [project, window, ...pages],
        );
        const admitted = new Map(
          rateRows.map((row) => [String(row.page_view_id), Number(row.admitted)]),
        );
        const increments = new Map<string, number>();
        const limited: FrontendInsightEventV3[] = [];
        const limit = Math.min(
          policy.envelopesPerMinute,
          DIAGNOSTIC_LIMITS.envelopesPerMinute,
        );
        for (const event of admissionCandidates) {
          const used =
            (admitted.get(event.pageViewId) ?? 0) +
            (increments.get(event.pageViewId) ?? 0);
          if (used >= limit) limited.push(event);
          else
            increments.set(
              event.pageViewId,
              (increments.get(event.pageViewId) ?? 0) + 1,
            );
        }
        const changed = [...increments].filter(([, count]) => count > 0);
        if (changed.length)
          await c.execute(
            `UPDATE diagnostic_rate_windows SET admitted=admitted+CASE page_view_id ${changed.map(() => "WHEN ? THEN ?").join(" ")} ELSE 0 END WHERE project_id=? AND window_start=? AND page_view_id IN (${changed.map(() => "?").join(",")})`,
            [
              ...changed.flatMap(([page, count]) => [page, count]),
              project,
              window,
              ...changed.map(([page]) => page),
            ],
          );
        for (const event of limited) {
          event.diagnostic = absent(event.diagnostic!, "rate_limited");
          const { raw: _raw, ...captureMetadata } = event.diagnostic;
          void _raw;
          await c.execute(
            "UPDATE diagnostic_receipts SET storage_digest=?,state='rate_limited',capture_metadata=?,byte_size=? WHERE project_id=? AND event_id=?",
            [
              digest(event.diagnostic),
              JSON.stringify(captureMetadata),
              Buffer.byteLength(JSON.stringify(event.diagnostic)),
              project,
              event.eventId,
            ],
          );
        }
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
      if (await this.operations.isDeleted(envelope.projectId, event.eventId)) continue;
      if (!r || r.storage_digest !== digest(event.diagnostic))
        throw new Error("DIAGNOSTICS_RECEIPT_MISMATCH");
      if (
        [
          "ready",
          "rate_limited",
          "too_large",
          "unavailable",
          "disabled",
          "deleted",
          "policy_suppressed",
        ].includes(String(r.state)) ||
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
          "UPDATE diagnostic_receipts SET state='ready',persisted_at=NOW(3) WHERE project_id=? AND event_id=? AND state IN ('pending','write_failed')",
          [envelope.projectId, event.eventId],
        );
      } catch {
        await this.mysql.pool.execute(
          "UPDATE diagnostic_receipts SET state='write_failed' WHERE project_id=? AND event_id=? AND state IN ('pending','write_failed')",
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
        "SELECT state,expires_at,capture_metadata FROM diagnostic_receipts WHERE project_id=? AND event_id=?",
        [project, event],
      );
      const r = rows[0];
      const baseResponse = await ch.query({
        query: `SELECT event_id, error_group_id, error_type, error_category,
          toUnixTimestamp64Milli(timestamp) AS at, page_route, release, env,
          payload_json, error_stack_frame, browser, os, viewport_bucket,
          request_method, request_path, http_status, sdk_version, schema_version
          FROM raw_events WHERE project_id={project:UUID} AND event_id={event:String}
          AND (event='error' OR (event='api' AND error_type='api'))
          ORDER BY received_at DESC LIMIT 1`,
        format: "JSONEachRow",
        query_params: { project, event },
        clickhouse_settings: {
          max_execution_time: 5,
          max_rows_to_read: "1000000",
          max_bytes_to_read: "67108864",
          read_overflow_mode: "throw",
        },
      });
      const base = (await baseResponse.json<Record<string, unknown>>())[0];
      let state = !r
        ? base
          ? "unknown"
          : "not_found"
        : new Date(r.expires_at).getTime() <= Date.now()
          ? "expired"
          : String(r.state);
      if (await this.operations.isDeleted(project, event)) state = "deleted";
      let diagnostic: DiagnosticEnvelope | undefined;
      let storedEnvelopeJson: string | undefined;
      if (state === "ready") {
        const response = await ch.query({
          query:
            "SELECT envelope_json FROM diagnostic_details FINAL WHERE project_id={project:UUID} AND event_id={event:String} AND expires_at>now() LIMIT 1",
          format: "JSONEachRow",
          query_params: { project, event },
        });
        const details = await response.json<{ envelope_json: string }>();
        if (details[0]) {
          storedEnvelopeJson = details[0].envelope_json;
          diagnostic = JSON.parse(storedEnvelopeJson) as DiagnosticEnvelope;
        } else state = "unavailable";
      }
      let legacy: Record<string, unknown> | undefined;
      if (!r && base && state !== "deleted") {
        const payload = JSON.parse(String(base.payload_json ?? "{}"));
        legacy = {
          name: payload.errorName,
          message: payload.errorMessage,
          stack: payload.stackTopFrame,
          ...(payload.errorType === "resource"
            ? { resourceUrl: payload.requestPath }
            : {}),
        };
      }
      const sourceMapping =
        this.sourceMaps && (diagnostic || legacy)
          ? await this.sourceMaps.map(
              p,
              project,
              event,
              diagnostic?.raw ?? legacy!,
              typeof base?.release === "string" ? base.release : null,
            )
          : undefined;
      await this.authorize(p, project, event, "diagnostics.read");
      const deletedNow = await this.operations.isDeleted(project, event);
      if (deletedNow || (r && new Date(r.expires_at).getTime() <= Date.now())) {
        state = deletedNow ? "deleted" : "expired";
        legacy = undefined;
        diagnostic = undefined;
        storedEnvelopeJson = undefined;
      }
      await this.audit(p.userId, project, event, "diagnostics.read", state);
      return {
        eventId: event,
        projectId: project,
        ...(sourceMapping && !["expired", "deleted"].includes(state)
          ? { sourceMapping }
          : {}),
        occurrence: base ? projectOccurrence(base) : null,
        state,
        expiresAt: r ? new Date(r.expires_at).toISOString() : null,
        ...(r?.capture_metadata
          ? {
              capture:
                typeof r.capture_metadata === "string"
                  ? JSON.parse(r.capture_metadata)
                  : r.capture_metadata,
            }
          : {}),
        ...(diagnostic
          ? {
              diagnostic,
              storedEnvelopeJson,
              view: diagnosticErrorView(diagnostic.raw),
            }
          : {}),
        ...(legacy ? { legacy: true, view: diagnosticErrorView(legacy) } : {}),
      };
    } catch (e) {
      if (e instanceof DiagnosticAccessError) throw e;
      await this.audit(p.userId, project, event, "diagnostics.read", "failed");
      // Raw storage exceptions must never escape to ordinary service logs.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("DIAGNOSTICS_READ_FAILED");
    }
  }

  async search(
    ch: ClickHouseClient,
    p: Principal,
    project: string,
    q: DiagnosticSearchQuery,
  ) {
    const action = "diagnostics.search";
    try {
      await this.authorize(p, project, "search", "diagnostics.read");
      const result = await searchDiagnostics(ch, project, q, async (ids) => {
        if (!ids.length) return [];
        const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
          `SELECT event_id FROM diagnostic_receipts WHERE project_id=? AND state='ready' AND expires_at>NOW(3) AND event_id IN (${ids.map(() => "?").join(",")})`,
          [project, ...ids],
        );
        return rows.map((r) => String(r.event_id));
      });
      await this.authorize(p, project, "search", "diagnostics.read");
      await this.audit(p.userId, project, "search", action, "success");
      return result;
    } catch (e) {
      await this.audit(
        p.userId,
        project,
        "search",
        action,
        e instanceof DiagnosticAccessError ? "forbidden" : "failed",
      );
      throw e;
    }
  }

  async exportEvidence(
    ch: ClickHouseClient,
    p: Principal,
    project: string,
    event: string,
    format: "json" | "text",
  ) {
    const action = `diagnostics.export.${format}`;
    try {
      await this.authorize(p, project, event, "diagnostics.export");
      const evidence = await this.read(ch, p, project, event);
      if (evidence.state === "not_found")
        throw new DiagnosticQueryError("DIAGNOSTICS_INSTANCE_NOT_FOUND");
      if (
        evidence.state === "deleted" ||
        (await this.operations.isDeleted(project, event))
      )
        throw new DiagnosticQueryError("DIAGNOSTICS_DELETED");
      if (evidence.state === "expired")
        throw new DiagnosticQueryError("DIAGNOSTICS_EXPIRED");
      const document = {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        note: "storedEnvelopeJson 是已存信封原文；diagnostic 为解析值；view 和 sourceMapping 为派生展示，sourceMapping.artifacts 标明制品身份。关联仅依显式证据，否则为时间邻近。已下载文件无法远程收回。",
        evidence,
      };
      const body =
        format === "json"
          ? JSON.stringify(document, null, 2)
          : `Frontend Insight 诊断证据\n项目: ${project}\n实例: ${event}\n状态: ${evidence.state}\n${document.note}\n\n已存信封原文\n${evidence.storedEnvelopeJson ?? "未保存原文，见采集与缺失状态"}\n\n诊断上下文与派生解析（JSON）\n${JSON.stringify({ ...document, evidence: { ...evidence, storedEnvelopeJson: undefined } }, null, 2)}\n`;
      if (Buffer.byteLength(body) > DIAGNOSTIC_QUERY_LIMITS.exportBytes)
        throw new DiagnosticQueryError("DIAGNOSTICS_EXPORT_BYTE_BUDGET");
      await this.authorize(p, project, event, "diagnostics.export");
      if (await this.operations.isDeleted(project, event))
        throw new DiagnosticQueryError("DIAGNOSTICS_DELETED");
      if (evidence.expiresAt && Date.parse(evidence.expiresAt) <= Date.now())
        throw new DiagnosticQueryError("DIAGNOSTICS_EXPIRED");
      await this.audit(p.userId, project, event, action, "success");
      return body;
    } catch (e) {
      await this.audit(
        p.userId,
        project,
        event,
        action,
        e instanceof DiagnosticAccessError ? "forbidden" : "failed",
      );
      throw e;
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
