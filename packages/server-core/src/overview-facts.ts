import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { CalendarBucket } from "@frontend-insight/event-contract/project-range";
import { IDENTITY_DEFINITION_VERSION } from "./system-metric-catalog.js";
import type { FormulaInputValue } from "./formula.js";

export interface FactWindow {
  inputs: Record<string, FormulaInputValue>;
  raw: Record<string, FormulaInputValue>;
  events: number;
  lastDataAt: string | null;
}
export interface OverviewFacts {
  window: FactWindow;
  buckets: FactWindow[];
  availableFrom: string | null;
  statistics: { rowsRead: number; bytesRead: number; elapsedSeconds: number };
}
export interface PageRevisionWindow {
  pageRoute: string;
  from: string;
  to: string;
}
const iso = (s: string | null) =>
  s ? new Date(s.replace(" ", "T") + "Z").toISOString() : null;
/** Bounded aggregate states: one window and all calendar buckets in one request.
 * Only PV has an exact existing observed primitive. Completeness remains unverified.
 * UV/VV/workflows/quality denominators are not inferred from page-view counts. */
export class OverviewFactStore {
  private readonly client: ClickHouseClient;
  constructor(config: {
    url: string;
    username: string;
    password: string;
    database: string;
  }) {
    this.client = createClient(config);
  }
  async close() {
    await this.client.close();
  }
  async read(
    projectId: string,
    env: string,
    buckets: CalendarBucket[],
    pages: PageRevisionWindow[],
  ): Promise<OverviewFacts> {
    const from = buckets[0]!.from,
      to = buckets.at(-1)!.to;
    const r = await this.client.query({
      query: `SELECT windowIndex,count() AS events,countIf(event='page_view' AND user_id IS NOT NULL AND user_id!='' AND arrayExists(p -> p.1=page_route AND timestamp>=parseDateTime64BestEffort(p.2,3) AND timestamp<parseDateTime64BestEffort(p.3,3),{pages:Array(Tuple(String,String,String))})) AS pv,toString(max(received_at)) AS lastDataAt,toString(min(timestamp)) AS firstDataAt FROM (SELECT *,arrayJoin([-1,toInt32(arrayFirstIndex(b -> timestamp>=parseDateTime64BestEffort(b.1,3) AND timestamp<parseDateTime64BestEffort(b.2,3),{buckets:Array(Tuple(String,String))}))-1]) AS windowIndex FROM (SELECT event_id,event,timestamp,received_at,page_route,user_id FROM raw_events WHERE project_id={projectId:UUID} AND env={env:String} AND timestamp>=parseDateTime64BestEffort({from:String},3) AND timestamp<parseDateTime64BestEffort({to:String},3) ORDER BY received_at DESC LIMIT 1 BY event_id)) GROUP BY windowIndex`,
      query_params: {
        projectId,
        env,
        from,
        to,
        buckets: buckets.map((b) => [b.from, b.to]),
        pages: pages.map((p) => [p.pageRoute, p.from, p.to]),
      },
      format: "JSON",
      clickhouse_settings: {
        max_execution_time: 5,
        max_rows_to_read: "400000000",
        read_overflow_mode: "throw",
      },
    });
    const body = await r.json<{
      windowIndex: number;
      events: string;
      pv: string;
      lastDataAt: string;
      firstDataAt: string;
    }>();
    const map = new Map(body.data.map((row) => [Number(row.windowIndex), row]));
    const window = (i: number): FactWindow => {
      const row = map.get(i),
        observed = row ? Number(row.pv) : null;
      return {
        events: Number(row?.events ?? 0),
        lastDataAt: iso(row?.lastDataAt ?? null),
        inputs: {
          pv: {
            value: null,
            status: "metric_not_available",
            sampleSize: observed,
            reason: "ENV_EXPOSURE_NOT_VERIFIED",
          },
        },
        raw: {
          pv: {
            value: observed,
            status: row ? "available" : "missing",
            sampleSize: observed,
            reason: row ? null : "NO_EVENTS_IN_BUCKET",
          },
        },
      };
    };
    return {
      window: window(-1),
      buckets: buckets.map((_, i) => window(i)),
      availableFrom: iso(map.get(-1)?.firstDataAt ?? null),
      statistics: {
        rowsRead: body.statistics?.rows_read ?? 0,
        bytesRead: body.statistics?.bytes_read ?? 0,
        elapsedSeconds: body.statistics?.elapsed ?? 0,
      },
    };
  }
}
export const OBSERVED_PV_DEFINITION = IDENTITY_DEFINITION_VERSION;
