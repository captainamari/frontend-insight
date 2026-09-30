import { readRepeatedRate } from "./repeated-read-model.js";
import type { RepeatedProof } from "./repeated-projection.js";
import { R4C_FACT_DEFINITION_VERSION } from "./system-metric-catalog.js";
import type { CalendarBucket } from "@frontend-insight/event-contract/project-range";
import {
  organizationWindowReason,
  reduceOrganization,
  type OrganizationContext,
  type OrganizationEvent,
} from "./organization-facts.js";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { SafeClickHouseLogger } from "./clickhouse-logger.js";
import { approvedEfficiencyResults } from "./efficiency-policy.js";
import type { BusinessPageWindow } from "./business-facts.js";
export interface EfficiencyEvent {
  id: string;
  at: number;
  received: number;
  user: string | null;
  session: string;
  page: string;
  payload: Record<string, unknown>;
}
export function reduceEfficiency(
  events: EfficiencyEvent[],
  from: number,
  to: number,
  asOf: number,
  pages: BusinessPageWindow[],
  moduleId: string,
) {
  const ids = new Map<string, EfficiencyEvent>(),
    conflicts = new Set<string>();
  let formsCovered = true,
    operationsCovered = true;
  let unidentified = 0,
    excluded = 0;
  for (const e of events) {
    if (e.at > asOf || e.received > asOf) continue;
    const previous = ids.get(e.id);
    if (
      previous &&
      JSON.stringify({ ...previous, received: 0 }) !==
        JSON.stringify({ ...e, received: 0 })
    )
      conflicts.add(e.id);
    else ids.set(e.id, e);
  }
  const pagesByRoute = new Map<string, BusinessPageWindow[]>();
  for (const page of pages) {
    const windows = pagesByRoute.get(page.pageRoute) ?? [];
    windows.push(page);
    pagesByRoute.set(page.pageRoute, windows);
  }
  const selected = [...ids.values()].filter((e) => {
    const classified = (pagesByRoute.get(e.page) ?? []).filter(
      (p) => p.included && Date.parse(p.from) <= e.at && e.at < Date.parse(p.to),
    );
    // Other classified modules are outside this cohort, not missing target facts.
    if (classified.length === 1 && classified[0]!.moduleId !== moduleId) return false;
    if (e.payload.name === "form_summary" && (e.at < from || e.at >= to)) return false;
    if (conflicts.has(e.id)) {
      excluded++;
      return false;
    }
    if (!e.user) {
      unidentified++;
      return false;
    }
    const matches = (pagesByRoute.get(e.page) ?? []).filter(
      (p) =>
        p.included &&
        p.moduleId === moduleId &&
        p.pageRoute === e.page &&
        Date.parse(p.from) <= e.at &&
        e.at < Date.parse(p.to),
    );
    if (matches.length !== 1) {
      excluded++;
      return false;
    }
    return true;
  });
  const summaries = new Map<string, EfficiencyEvent[]>(),
    operations = new Map<string, EfficiencyEvent[]>();
  for (const e of selected) {
    const p = e.payload;
    const map = p.name === "form_summary" ? summaries : operations;
    const key = p.name === "form_summary" ? p.formInstanceId : p.operationInstanceId;
    if (typeof key !== "string") {
      excluded++;
      continue;
    }
    map.set(key, [...(map.get(key) ?? []), e]);
  }
  const forms = new Map<
    string,
    {
      formId: string;
      changes: number;
      resets: number;
      submits: number;
      validationFailures: number;
      lifecycles: number;
      noSubmit: number;
      overflow: number;
      submittedChanges: number;
      submittedResets: number;
      submittedValidationFailures: number;
    }
  >();
  for (const group of summaries.values()) {
    if (group.length !== 1) {
      excluded += group.length;
      continue;
    }
    const e = group[0]!,
      p = e.payload;
    if (e.at < from || e.at >= to) continue;
    if (p.sampleRate !== 1) formsCovered = false;
    const formId = String(p.formId),
      row = forms.get(formId) ?? {
        formId,
        changes: 0,
        resets: 0,
        submits: 0,
        validationFailures: 0,
        lifecycles: 0,
        noSubmit: 0,
        overflow: 0,
        submittedChanges: 0,
        submittedResets: 0,
        submittedValidationFailures: 0,
      };
    row.lifecycles++;
    if (p.counterOverflow) row.overflow++;
    if (!Number(p.submitCount)) row.noSubmit++;
    if (Number(p.submitCount) > 0) {
      row.submittedChanges += Number(p.changeCount);
      row.submittedResets += Number(p.resetCount);
      row.submittedValidationFailures += Number(p.validationFailureCount);
    }
    row.changes += Number(p.changeCount);
    row.resets += Number(p.resetCount);
    row.submits += Number(p.submitCount);
    row.validationFailures += Number(p.validationFailureCount);
    forms.set(formId, row);
  }
  if (forms.size > 50 || operations.size > 10000)
    throw new Error("EFFICIENCY_SERIES_LIMIT");
  const counts = {
    started: 0,
    success: 0,
    rejected: 0,
    technical_failure: 0,
    canceled: 0,
    unknown: 0,
    unresolved: 0,
  };
  for (const group of operations.values()) {
    group.sort((a, b) => a.at - b.at);
    const starts = group.filter(
      (e) => e.payload.name === "feature_started" && e.payload.businessAdapter === true,
    );
    if (starts.length !== 1) {
      counts.unresolved++;
      continue;
    }
    const start = starts[0]!;
    if (start.at < from || start.at >= to) continue;
    counts.started++;
    if (group.some((e) => e.payload.businessSampleRate !== 1))
      operationsCovered = false;
    const consistent = group.every(
      (e) =>
        e.user === start.user &&
        e.session === start.session &&
        e.payload.featureKey === start.payload.featureKey &&
        e.at >= start.at,
    );
    const terminals = group.filter((e) => e.payload.name !== "feature_started");
    if (!consistent || terminals.length > 1) {
      counts.unresolved++;
      continue;
    }
    const result = terminals[0]?.payload.businessResult;
    if (
      typeof result === "string" &&
      ["success", "rejected", "technical_failure", "canceled"].includes(result)
    )
      counts[result as "success" | "rejected" | "technical_failure" | "canceled"]++;
    else counts.unknown++;
  }
  const approved = approvedEfficiencyResults(
    [...forms.values()],
    counts,
    excluded + unidentified,
    {
      forms: formsCovered,
      operations: operationsCovered,
    },
  );
  return {
    ...approved,
    repeated_operation_rate: {
      value: null,
      status: "not_collected",
      reason: "OBJECT_REFERENCE_COLLECTOR_NOT_INSTALLED",
    },
    excluded,
    unidentified,
    coverage: "unknown",
    asOf: new Date(asOf).toISOString(),
    definitionVersion: R4C_FACT_DEFINITION_VERSION,
  };
}
export class EfficiencyFactStore {
  private readonly client: ClickHouseClient;
  constructor(config: {
    url: string;
    username: string;
    password: string;
    database: string;
  }) {
    this.client = createClient({
      ...config,
      log: { LoggerClass: SafeClickHouseLogger },
    });
  }
  close() {
    return this.client.close();
  }
  async readOrganization(context: OrganizationContext) {
    const reason = organizationWindowReason(context);
    if (reason)
      return { ...reduceOrganization([], context), queries: 0, statistics: null };
    const result = await this.client.query({
      query: `SELECT event_id AS id,toUnixTimestamp64Milli(timestamp) AS at,toUnixTimestamp64Milli(received_at) AS received,event,user_id AS user,session_id AS session,page_route AS page,page_view_id AS pageView,directory_version_id AS directory,dept_id AS dept,role_id AS role,payload_json FROM raw_events WHERE project_id={project:UUID} AND env={env:String} AND timestamp>=fromUnixTimestamp64Milli({from:Int64}) AND timestamp<fromUnixTimestamp64Milli({end:Int64}) AND received_at<=fromUnixTimestamp64Milli({asOf:Int64}) AND (event IN ('page_view','page_leave') OR (event='custom' AND JSONExtractBool(payload_json,'businessAdapter'))) LIMIT 50001`,
      query_params: {
        project: context.projectId,
        env: context.env,
        from: Date.parse(context.buckets[0]!.from),
        asOf: context.asOf,
        end: Math.min(
          context.asOf + 1,
          Date.parse(context.buckets.at(-1)!.to) + 86400000,
        ),
      },
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 2,
        max_rows_to_read: "1000000",
        read_overflow_mode: "throw",
      },
    });
    const body = await result.json<
      Omit<OrganizationEvent, "payload"> & { payload_json: string }
    >();
    const rows = body.data;
    if (rows.length > 50000) throw new Error("ORGANIZATION_FACT_LIMIT");
    return {
      ...reduceOrganization(
        rows.map((r) => ({
          ...r,
          at: Number(r.at),
          received: Number(r.received),
          payload: JSON.parse(r.payload_json) as Record<string, unknown>,
        })),
        context,
      ),
      queries: 1,
      statistics: body.statistics
        ? {
            rowsRead: body.statistics.rows_read,
            bytesRead: body.statistics.bytes_read,
            elapsedSeconds: body.statistics.elapsed,
          }
        : null,
    };
  }

  async read(
    projectId: string,
    moduleId: string,
    env: string,
    from: string,
    to: string,
    asOf: Date,
    pages: BusinessPageWindow[],
    buckets: CalendarBucket[] = [],
  ) {
    const result = await this.client.query({
      query: `SELECT event_id AS id,toUnixTimestamp64Milli(timestamp) AS at,toUnixTimestamp64Milli(received_at) AS received,user_id AS user,session_id AS session,page_route AS page,payload_json FROM raw_events WHERE project_id={project:String} AND env={env:String} AND event='custom' AND timestamp>=fromUnixTimestamp64Milli({from:Int64}) AND timestamp<=fromUnixTimestamp64Milli({asOf:Int64}) AND received_at<=fromUnixTimestamp64Milli({asOf:Int64}) AND (JSONExtractString(payload_json,'name')='form_summary' OR JSONExtractBool(payload_json,'businessAdapter')) LIMIT 50001`,
      query_params: {
        project: projectId,
        env,
        from: Date.parse(from) - 86400000,
        asOf: asOf.valueOf(),
      },
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 2,
        max_rows_to_read: "1000000",
        read_overflow_mode: "throw",
      },
    });
    const body = await result.json<
      Omit<EfficiencyEvent, "payload"> & { payload_json: string }
    >();
    const rows = body.data;
    if (rows.length > 50000) throw new Error("EFFICIENCY_FACT_LIMIT");
    const events = rows.map((r) => ({
      ...r,
      at: Number(r.at),
      received: Number(r.received),
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
    const proofResult = await this.client.query({
      query: `SELECT project,env,user,session,instance,operation,at,received,proof_from,proof_to,proof_received,hit,processed FROM repeated_operation_proofs WHERE project={project:UUID} AND env={env:String} AND at>={start:Int64} AND at<{end:Int64} AND processed<={asOf:Int64} LIMIT 200001`,
      query_params: {
        project: projectId,
        env,
        start: Date.parse(from) - 86400000,
        end: Date.parse(to) + 86400000,
        asOf: asOf.valueOf(),
      },
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 2,
        max_rows_to_read: "1000000",
        read_overflow_mode: "throw",
      },
    });
    const proofBody = await proofResult.json<RepeatedProof>();
    const proofRows = proofBody.data;
    if (proofRows.length > 200000) throw new Error("EFFICIENCY_FACT_LIMIT");
    const proofs = proofRows.map((p) => ({
      ...p,
      at: Number(p.at),
      received: Number(p.received),
      proof_from: Number(p.proof_from),
      proof_to: Number(p.proof_to),
      proof_received: Number(p.proof_received),
      processed: Number(p.processed),
    }));
    const repeated = (start: string, end: string) =>
      readRepeatedRate(events, proofs, {
        from: Date.parse(start),
        to: Date.parse(end),
        asOf: asOf.valueOf(),
        moduleId,
        pages,
      });
    const installationResult = await this.client.query({
      query: `SELECT groupUniqArray(10)(ifNull(sdk_collectors,'legacy')) AS declarations,count() AS events FROM raw_events WHERE project_id={project:UUID} AND env={env:String} AND received_at>=fromUnixTimestamp64Milli({from:Int64}) AND received_at<=fromUnixTimestamp64Milli({asOf:Int64})`,
      query_params: {
        project: projectId,
        env,
        from: Date.parse(from),
        asOf: asOf.valueOf(),
      },
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 2,
        max_rows_to_read: "1000000",
        read_overflow_mode: "throw",
      },
    });
    const installationBody = await installationResult.json<{
      declarations: string[];
      events: string;
    }>();
    const installation = installationBody.data[0];
    const collectorStates = Object.fromEntries(
      ["forms", "business_results", "repeated_operations"].map((key) => {
        const declarations = installation?.declarations ?? [];
        const enabled = declarations.filter(
          (d) => d !== "legacy" && (JSON.parse(d) as string[]).includes(key),
        ).length;
        const state = !Number(installation?.events)
          ? "SDK_NOT_OBSERVED"
          : declarations.every((d) => d === "legacy")
            ? "COMPATIBLE_SDK_NOT_OBSERVED"
            : declarations.includes("legacy")
              ? "MIXED_INSTALLATIONS"
              : enabled === declarations.length
                ? "ENABLED"
                : enabled
                  ? "MIXED_INSTALLATIONS"
                  : "COLLECTOR_DISABLED";
        return [key, state];
      }),
    );
    const efficiencyEvents = events.filter((e) => e.at >= Date.parse(from));
    const trends = buckets.map((b) => ({
      from: b.from,
      to: b.to,
      partialBucket: b.partial,
      ...reduceEfficiency(
        efficiencyEvents,
        Date.parse(b.from),
        Date.parse(b.to),
        asOf.valueOf(),
        pages,
        moduleId,
      ),
      repeated_operation_rate: repeated(b.from, b.to),
    }));
    if (trends.reduce((n, b) => n + b.form_efficiency.results.length + 1, 0) > 1000)
      throw new Error("EFFICIENCY_SERIES_LIMIT");
    return {
      ...reduceEfficiency(
        efficiencyEvents,
        Date.parse(from),
        Date.parse(to),
        asOf.valueOf(),
        pages,
        moduleId,
      ),
      repeated_operation_rate: repeated(from, to),
      repeatedQueries: 2,
      collectorStates,
      trends,
      statistics: body.statistics
        ? {
            rowsRead:
              body.statistics.rows_read +
              (proofBody.statistics?.rows_read ?? 0) +
              (installationBody.statistics?.rows_read ?? 0),
            bytesRead:
              body.statistics.bytes_read +
              (proofBody.statistics?.bytes_read ?? 0) +
              (installationBody.statistics?.bytes_read ?? 0),
            elapsedSeconds:
              body.statistics.elapsed +
              (proofBody.statistics?.elapsed ?? 0) +
              (installationBody.statistics?.elapsed ?? 0),
          }
        : null,
    };
  }
}
