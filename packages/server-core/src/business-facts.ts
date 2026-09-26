import { createClient, TupleParam, type ClickHouseClient } from "@clickhouse/client";
import type { CalendarBucket } from "@frontend-insight/event-contract/project-range";
import { SafeClickHouseLogger } from "./clickhouse-logger.js";
import type { FactWindow } from "./overview-facts.js";

export interface BusinessPageWindow {
  pageId: string;
  pageRoute: string;
  name: string;
  moduleId: string;
  pageRevisionId: string;
  moduleRevisionId: string;
  from: string;
  to: string;
  included: boolean;
  reason: string;
}
export interface BusinessObservation {
  events: number;
  pv: number | null;
  uv: number | null;
  unidentified: number;
  unclassified: number;
  excluded: number;
  lastDataAt: string | null;
  firstDataAt: string | null;
}
export const emptyBusinessObservation = (): BusinessObservation => ({
  events: 0,
  pv: null,
  uv: null,
  unidentified: 0,
  unclassified: 0,
  excluded: 0,
  lastDataAt: null,
  firstDataAt: null,
});
export function businessFactWindow(row: BusinessObservation): FactWindow {
  const raw: FactWindow["raw"] = {};
  const inputs: FactWindow["inputs"] = {};
  for (const key of ["pv", "uv"] as const) {
    raw[key] = {
      value: row[key],
      status: row[key] === null ? "missing" : "available",
      sampleSize: row.pv,
      reason: row[key] === null ? "NO_EVENTS_IN_BUCKET" : null,
    };
    inputs[key] = {
      value: null,
      status: "metric_not_available",
      sampleSize: row.pv,
      reason: "IDENTITY_AND_ENV_COVERAGE_NOT_VERIFIED",
    };
  }
  return { inputs, raw, events: row.events, lastDataAt: row.lastDataAt };
}
/** Observed page-view population only. This does not promote R6 UV completeness.
 * eventId dedup -> event-time revision -> module scope -> exact distinct states.
 * Four constant grouping copies per event, independent of pages/metrics/buckets.
 * No user identifiers or payload leave ClickHouse. */
export class BusinessFactStore {
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
    buckets: CalendarBucket[],
    pages: BusinessPageWindow[],
    onQuery?: () => void,
  ) {
    onQuery?.();
    const result = await this.client.query({
      query: `SELECT windowIndex, pageIndex, count() AS events,
        countIf(eligible AND event='page_view' AND identified) AS pv,
        uniqExactIf(user_id,eligible AND event='page_view' AND identified) AS uv,
        countIf(event='page_view' AND NOT identified) AS unidentified,
        countIf(event='page_view' AND revisionIndex=0) AS unclassified,
        countIf(event='page_view' AND NOT eligible) AS excluded,
        toString(max(received_at)) AS lastDataAt,toString(min(timestamp)) AS firstDataAt
      FROM (
        SELECT *, arrayJoin([-1,bucketIndex]) AS windowIndex,
          arrayJoin([-1,if(revisionIndex=0,-2,toInt32(revisionIndex)-1)]) AS pageIndex,
          user_id IS NOT NULL AND user_id!='' AS identified,
          revisionIndex>0 AND {pages:Array(Tuple(String,String,String,String,UInt8))}[revisionIndex].4={moduleId:String}
            AND {pages:Array(Tuple(String,String,String,String,UInt8))}[revisionIndex].5=1 AS eligible
        FROM (
          SELECT e.*,b.bucketIndex,
            arrayFirstIndex(p -> p.1=e.page_route AND e.timestamp>=parseDateTime64BestEffort(p.2,3) AND e.timestamp<parseDateTime64BestEffort(p.3,3),{pages:Array(Tuple(String,String,String,String,UInt8))}) AS revisionIndex
          FROM (
            SELECT event_id,event,timestamp,received_at,page_route,user_id,toUInt8(1) AS bucketKey
            FROM raw_events WHERE project_id={projectId:UUID} AND env={env:String}
              AND timestamp>=parseDateTime64BestEffort({from:String},3) AND timestamp<parseDateTime64BestEffort({to:String},3)
            ORDER BY received_at DESC LIMIT 1 BY event_id
          ) e
          ASOF LEFT JOIN (
            SELECT toUInt8(1) AS bucketKey,parseDateTime64BestEffort(item.1,3) AS bucketStart,item.2 AS bucketIndex
            FROM (SELECT arrayJoin({buckets:Array(Tuple(String,Int32))}) AS item) ORDER BY bucketStart
          ) b ON e.bucketKey=b.bucketKey AND e.timestamp>=b.bucketStart
        )
      ) GROUP BY windowIndex,pageIndex`,
      query_params: {
        projectId,
        moduleId,
        env,
        from: buckets[0]!.from,
        to: buckets.at(-1)!.to,
        buckets: buckets.map((b, i) => new TupleParam([b.from, i])),
        pages: pages.map(
          (p) =>
            new TupleParam([p.pageRoute, p.from, p.to, p.moduleId, p.included ? 1 : 0]),
        ),
      },
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 5,
        max_rows_to_read: "400000000",
        read_overflow_mode: "throw",
      },
    });
    const body = await result.json<Record<string, string | number>>();
    const iso = (v: unknown) =>
      v ? new Date(String(v).replace(" ", "T") + "Z").toISOString() : null;
    const rows = body.data.map((r) => ({
      windowIndex: Number(r.windowIndex),
      pageIndex: Number(r.pageIndex),
      events: Number(r.events),
      pv: Number(r.pv),
      uv: Number(r.uv),
      unidentified: Number(r.unidentified),
      unclassified: Number(r.unclassified),
      excluded: Number(r.excluded),
      lastDataAt: iso(r.lastDataAt),
      firstDataAt: iso(r.firstDataAt),
    }));
    const window = (index: number) =>
      rows.find((r) => r.windowIndex === index && r.pageIndex === -1) ??
      emptyBusinessObservation();
    return {
      window: window(-1),
      buckets: buckets.map((_, i) => window(i)),
      pages: pages.map((p, i) => ({
        ...p,
        observation:
          rows.find((r) => r.windowIndex === -1 && r.pageIndex === i) ??
          emptyBusinessObservation(),
      })),
      statistics: {
        rowsRead: body.statistics?.rows_read ?? 0,
        bytesRead: body.statistics?.bytes_read ?? 0,
        elapsedSeconds: body.statistics?.elapsed ?? 0,
      },
    };
  }
}
