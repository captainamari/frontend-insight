import { SafeClickHouseLogger } from "./clickhouse-logger.js";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { assertClickHouseReady } from "./clickhouse-health.js";

export type Granularity = "hour" | "day";

export interface AnalyticsRange {
  from: string;
  to: string;
  timezone: string;
  granularity: Granularity;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function zonedParts(instant: Date, timezone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
    millisecond: values.fractionalSecond!,
  };
}

function partsAsUtc(parts: ZonedDateParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
}

function localPartsToInstant(parts: ZonedDateParts, timezone: string): Date {
  const target = partsAsUtc(parts);
  let candidate = target;
  for (let index = 0; index < 4; index += 1) {
    const observed = partsAsUtc(zonedParts(new Date(candidate), timezone));
    const adjustment = target - observed;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(candidate);
}

export function previousLocalCalendarDay(iso: string, timezone: string): string {
  const current = zonedParts(new Date(iso), timezone);
  const previousDate = new Date(
    Date.UTC(current.year, current.month - 1, current.day - 1),
  );
  return localPartsToInstant(
    {
      ...current,
      year: previousDate.getUTCFullYear(),
      month: previousDate.getUTCMonth() + 1,
      day: previousDate.getUTCDate(),
    },
    timezone,
  ).toISOString();
}

export function validateAnalyticsRange(input: AnalyticsRange): AnalyticsRange {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (
    !Number.isFinite(from.valueOf()) ||
    !Number.isFinite(to.valueOf()) ||
    from >= to
  ) {
    throw new Error("ANALYTICS_RANGE_INVALID");
  }
  const maximum = new Date(from);
  maximum.setUTCMonth(maximum.getUTCMonth() + 13);
  if (to > maximum) throw new Error("ANALYTICS_RANGE_TOO_LARGE");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(from);
  } catch {
    throw new Error("TIMEZONE_INVALID");
  }
  const durationDays = (to.valueOf() - from.valueOf()) / 86_400_000;
  if (input.granularity === "hour" && durationDays > 31) {
    throw new Error("GRANULARITY_TOO_FINE");
  }
  return {
    ...input,
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

export class AnalyticsStore {
  private readonly client: ClickHouseClient;
  private readonly durationSamples: number[] = [];
  private queryFailures = 0;

  constructor(clickhouse: {
    url: string;
    username: string;
    password: string;
    database: string;
  }) {
    this.client = createClient({
      ...clickhouse,
      log: { LoggerClass: SafeClickHouseLogger },
    });
  }

  /** One bounded, parameterized query for every authorized candidate, independent of page size. */
  async projectObservations(
    projects: { id: string; appId: string }[],
    query: { env: string; from: string; to: string },
    onQuery?: () => void,
  ) {
    return this.measure(async () => {
      onQuery?.();
      const response = await this.client.query({
        query: `SELECT toString(project_id) AS projectId,count() AS retainedEvents,countIf(timestamp>=parseDateTime64BestEffort({from:String},3) AND timestamp<parseDateTime64BestEffort({to:String},3)) AS windowEvents,countIf(event='page_view' AND timestamp>=parseDateTime64BestEffort({from:String},3) AND timestamp<parseDateTime64BestEffort({to:String},3)) AS windowPageViews,toString(max(received_at)) AS lastDataAt,toString(min(timestamp)) AS availableFrom FROM raw_events WHERE app_id IN {appIds:Array(String)} AND project_id IN {projectIds:Array(UUID)} AND env={env:String} GROUP BY project_id`,
        query_params: {
          appIds: projects.map((p) => p.appId),
          projectIds: projects.map((p) => p.id),
          ...query,
        },
        format: "JSON",
        clickhouse_settings: {
          max_execution_time: 5,
          max_rows_to_read: "400000000",
          read_overflow_mode: "throw",
        },
      });
      const body = await response.json<{
        projectId: string;
        retainedEvents: string;
        windowEvents: string;
        windowPageViews: string;
        lastDataAt: string;
        availableFrom: string;
      }>();
      return {
        items: body.data.map((row) => ({
          ...row,
          retainedEvents: Number(row.retainedEvents),
          windowEvents: Number(row.windowEvents),
          windowPageViews: Number(row.windowPageViews),
          lastDataAt: new Date(row.lastDataAt.replace(" ", "T") + "Z").toISOString(),
          availableFrom: new Date(
            row.availableFrom.replace(" ", "T") + "Z",
          ).toISOString(),
        })),
        statistics: {
          rowsRead: body.statistics?.rows_read ?? 0,
          bytesRead: body.statistics?.bytes_read ?? 0,
          elapsedSeconds: body.statistics?.elapsed ?? 0,
        },
      };
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async ping(): Promise<void> {
    await assertClickHouseReady(this.client);
  }

  getMetrics(): { queries: number; failures: number; latencyP95Ms: number } {
    const sorted = [...this.durationSamples].sort((left, right) => left - right);
    return {
      queries: this.durationSamples.length,
      failures: this.queryFailures,
      latencyP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    };
  }
  private async measure<T>(operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } catch (cause) {
      this.queryFailures++;
      throw cause;
    } finally {
      this.durationSamples.push(performance.now() - started);
      if (this.durationSamples.length > 1000) this.durationSamples.shift();
    }
  }
}
