import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { createHash } from "node:crypto";
import { localDateTime } from "@frontend-insight/event-contract/project-range";
import { SafeClickHouseLogger } from "./clickhouse-logger.js";

export interface SettingsFact {
  event_id: string;
  at: number;
  sdk_version: string;
  schema_version: number;
  event: string;
  user_id: string | null;
  device_id: string;
  operation_instance_id: string | null;
  feature_stage: string | null;
  request_id: string;
}
export function probeDistribution(rows: SettingsFact[], from: string, to: string) {
  const seen = new Set<string>();
  const selected = rows.filter((r) => {
    if (seen.has(r.event_id) || r.at < Date.parse(from) || r.at >= Date.parse(to))
      return false;
    seen.add(r.event_id);
    return true;
  });
  const groups = new Map<
    string,
    { version: string; contractVersion: number; count: number; lastObservedAt: string }
  >();
  for (const r of selected) {
    const version = r.sdk_version || "unknown",
      key = version + ":" + r.schema_version;
    const g = groups.get(key) ?? {
      version,
      contractVersion: r.schema_version,
      count: 0,
      lastObservedAt: new Date(r.at).toISOString(),
    };
    g.count++;
    g.lastObservedAt = new Date(
      Math.max(Date.parse(g.lastObservedAt), r.at),
    ).toISOString();
    groups.set(key, g);
  }
  return {
    denominator: selected.length,
    denominatorDefinition:
      "项目/env/[from,to)全部事件，按eventId去重；未知版本计入分母",
    items: [...groups.values()].map((g) => ({
      ...g,
      share: g.count / selected.length,
    })),
    dataState: selected.length ? "observed" : "no_data",
  };
}
export interface AbnormalConfig {
  env: string;
  threshold: number;
  minimumSample: number;
  baselineDays: number;
  minimumBaselineDays: number;
  multiplier: number;
  workStart: number;
  workEnd: number;
  workDays: number[];
  visibleRoles: string[];
  sharedSubjects: string[];
  exceptions: { subject: string; from: string; to: string; reason: string }[];
}
export const abnormalSubject = (user: string) =>
  createHash("sha256").update(user).digest("hex").slice(0, 24);
/** Only observed, explicitly started operations; page views are never permission denials. */
export function evaluateAbnormal(
  rows: SettingsFact[],
  key: string,
  config: AbnormalConfig,
  from: string,
  to: string,
  zone: string,
) {
  if (key === "permission_denied" || key === "multi_ip")
    return {
      status: "not_collected",
      reason:
        key === "multi_ip"
          ? "IP_FACT_NOT_COLLECTED"
          : "PERMISSION_DENIAL_FACT_NOT_COLLECTED",
      items: [],
    };
  const seen = new Set<string>();
  const users = new Map<string, SettingsFact[]>();
  for (const r of rows) {
    if (!r.user_id || !r.operation_instance_id || r.feature_stage !== "feature_started")
      continue;
    const id = r.user_id + ":" + r.operation_instance_id;
    if (seen.has(id)) continue;
    seen.add(id);
    const subject = abnormalSubject(r.user_id);
    const list = users.get(subject) ?? [];
    list.push(r);
    users.set(subject, list);
  }
  const items: {
    subject: string;
    status: string;
    reason: string;
    observed: number | null;
    baseline: number | null;
  }[] = [];
  for (const [subject, events] of users) {
    const selected = events.filter(
      (r) => r.at >= Date.parse(from) && r.at < Date.parse(to),
    );
    if (!selected.length) continue;
    if (config.sharedSubjects.includes(subject)) {
      items.push({
        subject,
        status: "excluded",
        reason: "SHARED_ACCOUNT",
        observed: null,
        baseline: null,
      });
      continue;
    }
    // Any overlap excludes the whole subject window; never compares a partial numerator to a full baseline.
    if (
      config.exceptions.some(
        (e) =>
          e.subject === subject &&
          Date.parse(e.from) < Date.parse(to) &&
          Date.parse(e.to) > Date.parse(from),
      )
    ) {
      items.push({
        subject,
        status: "excluded",
        reason: "APPROVED_EXCEPTION",
        observed: null,
        baseline: null,
      });
      continue;
    }
    if (selected.length < config.minimumSample) {
      items.push({
        subject,
        status: "insufficient_sample",
        reason: "SMALL_SAMPLE",
        observed: null,
        baseline: null,
      });
      continue;
    }
    let count = selected.length,
      baseline: number | null = null;
    if (key === "outside_hours")
      count = selected.filter((r) => {
        const date = localDateTime(new Date(r.at).toISOString(), zone),
          hour = Number(date.slice(11, 13));
        const weekday = new Date(date.slice(0, 10) + "T12:00:00Z").getUTCDay();
        return (
          !config.workDays.includes(weekday) ||
          hour < config.workStart ||
          hour >= config.workEnd
        );
      }).length;
    if (key === "multi_device")
      count = new Set(selected.map((r) => r.device_id).filter(Boolean)).size;
    if (key === "historical_volume") {
      const days = new Map<string, number>();
      for (const r of events.filter((r) => r.at < Date.parse(from))) {
        const day = localDateTime(new Date(r.at).toISOString(), zone).slice(0, 10);
        days.set(day, (days.get(day) ?? 0) + 1);
      }
      if (days.size < config.minimumBaselineDays) {
        items.push({
          subject,
          status: "insufficient_sample",
          reason: "BASELINE_DAYS_MISSING",
          observed: null,
          baseline: null,
        });
        continue;
      }
      baseline = [...days.values()].reduce((a, b) => a + b, 0) / days.size;
      // Normalize by elapsed 24h; documented observation only, not a full-traffic or natural-day claim.
      count = selected.length / ((Date.parse(to) - Date.parse(from)) / 86400000);
    }
    const hit =
      count >= config.threshold &&
      (baseline === null || count >= baseline * config.multiplier);
    items.push({
      subject,
      status: hit ? "hit" : "observed",
      reason: "OBSERVED_OPERATIONS_ONLY",
      observed: count,
      baseline,
    });
  }
  return {
    status: items.length ? "observed" : "no_data",
    reason: "COVERAGE_UNKNOWN_NOT_A_PERSONAL_SCORE",
    items,
  };
}
export class SettingsFactStore {
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
  async read(projectId: string, env: string, from: string, to: string) {
    const response = await this.client.query({
      query: `SELECT event_id,toUnixTimestamp64Milli(timestamp) AS at,sdk_version,schema_version,event,user_id,device_id,operation_instance_id,feature_stage,request_id FROM raw_events WHERE project_id={projectId:UUID} AND env={env:String} AND timestamp>=parseDateTime64BestEffort({from:String},3) AND timestamp<parseDateTime64BestEffort({to:String},3) AND received_at<=now64(3) ORDER BY received_at DESC,event_id DESC LIMIT 1 BY event_id LIMIT 50001`,
      query_params: { projectId, env, from, to },
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 5,
        max_rows_to_read: "1000000",
        max_bytes_to_read: "268435456",
        read_overflow_mode: "throw",
      },
    });
    const body = await response.json<SettingsFact>();
    if (body.data.length > 50000) throw new Error("SETTINGS_SCAN_BUDGET_EXCEEDED");
    return {
      rows: body.data.map((r) => ({ ...r, at: Number(r.at) })),
      statistics: {
        clickHouseQueries: 1,
        rowsRead: body.statistics?.rows_read ?? 0,
        bytesRead: body.statistics?.bytes_read ?? 0,
        elapsedSeconds: body.statistics?.elapsed ?? 0,
      },
    };
  }
  async receipt(projectId: string, env: string, eventId: string, requestId: string) {
    const result = await this.client.query({
      query: `SELECT count() AS count FROM raw_events WHERE project_id={projectId:UUID} AND env={env:String} AND event_id={eventId:String} AND request_id={requestId:UUID} AND received_at>=now64(3)-INTERVAL 1 DAY`,
      query_params: { projectId, env, eventId, requestId },
      format: "JSONEachRow",
      clickhouse_settings: {
        max_execution_time: 5,
        max_rows_to_read: "1000000",
        read_overflow_mode: "throw",
      },
    });
    const rows = await result.json<{ count: string }>();
    return Number(rows[0]?.count ?? 0) > 0;
  }
  async close() {
    await this.client.close();
  }
}
