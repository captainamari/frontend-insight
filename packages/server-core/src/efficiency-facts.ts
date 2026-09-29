import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { SafeClickHouseLogger } from "./clickhouse-logger.js";
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
  const selected = [...ids.values()].filter((e) => {
    if (conflicts.has(e.id)) {
      excluded++;
      return false;
    }
    if (!e.user) {
      unidentified++;
      return false;
    }
    const matches = pages.filter(
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
      };
    row.lifecycles++;
    if (p.counterOverflow) row.overflow++;
    if (!Number(p.submitCount)) row.noSubmit++;
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
  return {
    form_efficiency: {
      value: null,
      status: "partial",
      reason: forms.size
        ? "FORM_WINDOW_DECISION_REQUIRED"
        : "FORM_COLLECTOR_NOT_OBSERVED",
      observations: [...forms.values()],
    },
    operation_fail_rate: {
      value: null,
      status: "partial",
      reason: counts.started
        ? "BUSINESS_RESULT_COMPLETENESS_DECISION_REQUIRED"
        : "BUSINESS_ADAPTER_NOT_OBSERVED",
      observations: counts,
    },
    repeated_operation_rate: {
      value: null,
      status: "not_collected",
      reason: "OBJECT_REFERENCE_PRIVACY_REVIEW_REQUIRED",
    },
    excluded,
    unidentified,
    coverage: "unknown",
    asOf: new Date(asOf).toISOString(),
    definitionVersion: "r4c-observation-1",
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
  async read(
    projectId: string,
    moduleId: string,
    env: string,
    from: string,
    to: string,
    asOf: Date,
    pages: BusinessPageWindow[],
  ) {
    const result = await this.client.query({
      query: `SELECT event_id AS id,toUnixTimestamp64Milli(timestamp) AS at,toUnixTimestamp64Milli(received_at) AS received,user_id AS user,session_id AS session,page_route AS page,payload_json FROM raw_events WHERE project_id={project:String} AND env={env:String} AND event='custom' AND timestamp>=fromUnixTimestamp64Milli({from:Int64}) AND timestamp<=fromUnixTimestamp64Milli({asOf:Int64}) AND received_at<=fromUnixTimestamp64Milli({asOf:Int64}) AND (JSONExtractString(payload_json,'name')='form_summary' OR JSONExtractBool(payload_json,'businessAdapter')) LIMIT 50001`,
      query_params: {
        project: projectId,
        env,
        from: Date.parse(from),
        asOf: asOf.valueOf(),
      },
      format: "JSONEachRow",
      clickhouse_settings: {
        max_execution_time: 2,
        max_rows_to_read: "1000000",
        read_overflow_mode: "throw",
      },
    });
    const rows = await result.json<
      Omit<EfficiencyEvent, "payload"> & { payload_json: string }
    >();
    if (rows.length > 50000) throw new Error("EFFICIENCY_FACT_LIMIT");
    return reduceEfficiency(
      rows.map((r) => ({
        ...r,
        at: Number(r.at),
        received: Number(r.received),
        payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      })),
      Date.parse(from),
      Date.parse(to),
      asOf.valueOf(),
      pages,
      moduleId,
    );
  }
}
