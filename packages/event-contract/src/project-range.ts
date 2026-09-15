import {
  CANONICAL_RANGES,
  type CanonicalEnvironment,
} from "./generated/canonical-names.js";

export type ProjectRangeKey = (typeof CANONICAL_RANGES)[number]["key"];
export type CalendarGranularity = "day" | "week" | "month";
export interface CalendarBucket {
  from: string;
  to: string;
  start: string;
  end: string;
  localStart: string;
  partial: boolean;
}
export interface ProjectRangeQuery {
  range: ProjectRangeKey;
  env: CanonicalEnvironment;
  from?: string | undefined;
  to?: string | undefined;
}
export class ProjectRangeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  if (/^[+-]/.test(zone)) throw new ProjectRangeError("TIMEZONE_INVALID");
  let value = formatters.get(zone);
  if (!value) {
    try {
      value = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
        hourCycle: "h23",
      });
    } catch {
      throw new ProjectRangeError("TIMEZONE_INVALID");
    }
    if (formatters.size >= 128) formatters.clear();
    formatters.set(zone, value);
  }
  return value;
}
/** A UTC-shaped calendar coordinate, never an elapsed-time bucket. */
function localCoordinate(instant: number, zone: string): number {
  const p = Object.fromEntries(
    formatter(zone)
      .formatToParts(instant)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(
    p.year!,
    p.month! - 1,
    p.day!,
    p.hour!,
    p.minute!,
    p.second!,
    p.fractionalSecond!,
  );
}
/** Earlier instant for overlaps; first valid local time after a clock gap. */
function instantFromCoordinate(target: number, zone: string): number {
  const offsets = new Set(
    [-2, -1, 0, 1, 2].map((d) => {
      const t = target + d * 86400000;
      return localCoordinate(t, zone) - t;
    }),
  );
  const candidates = [...offsets].map((o) => target - o).sort((a, b) => a - b);
  const exact = candidates.find((t) => localCoordinate(t, zone) === target);
  if (exact !== undefined) return exact;
  const after = candidates
    .filter((t) => localCoordinate(t, zone) > target)
    .sort((a, b) => localCoordinate(a, zone) - localCoordinate(b, zone));
  if (after[0] === undefined) throw new ProjectRangeError("LOCAL_TIME_INVALID");
  return after[0];
}
export function localDateTime(iso: string, zone: string): string {
  return new Date(localCoordinate(Date.parse(iso), zone))
    .toISOString()
    .replace("Z", "");
}
export function projectLocalInstant(local: string, zone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(local))
    throw new ProjectRangeError("LOCAL_TIME_INVALID");
  const coordinate = Date.parse(local + "Z");
  if (
    !Number.isFinite(coordinate) ||
    new Date(coordinate).toISOString().slice(0, 16) !== local.slice(0, 16)
  )
    throw new ProjectRangeError("LOCAL_TIME_INVALID");
  return new Date(instantFromCoordinate(coordinate, zone)).toISOString();
}
export function resolveProjectCalendar(
  input: ProjectRangeQuery,
  timezone: string,
  now = new Date(),
) {
  formatter(timezone);
  const preset = CANONICAL_RANGES.find((p) => p.key === input.range);
  if (
    !preset ||
    Boolean(input.from) !== Boolean(input.to) ||
    (input.range === "custom" && !input.from)
  )
    throw new ProjectRangeError("PROJECT_RANGE_INVALID");
  const to = input.to ? Date.parse(input.to) : now.valueOf();
  if (!Number.isFinite(to)) throw new ProjectRangeError("PROJECT_RANGE_INVALID");
  const start = new Date(localCoordinate(to, timezone));
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ("days" in preset ? preset.days - 1 : 6));
  const from = input.from
    ? Date.parse(input.from)
    : instantFromCoordinate(start.valueOf(), timezone);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
    throw new ProjectRangeError("PROJECT_RANGE_INVALID");
  const max = new Date(localCoordinate(from, timezone)),
    day = max.getUTCDate();
  max.setUTCDate(1);
  max.setUTCMonth(max.getUTCMonth() + 13);
  const last = new Date(
    Date.UTC(max.getUTCFullYear(), max.getUTCMonth() + 1, 0),
  ).getUTCDate();
  max.setUTCDate(Math.min(day, last));
  if (to > instantFromCoordinate(max.valueOf(), timezone))
    throw new ProjectRangeError("PROJECT_RANGE_TOO_LARGE");
  const days =
    (localCoordinate(to, timezone) - localCoordinate(from, timezone)) / 86400000;
  const granularity: CalendarGranularity =
    preset.granularity === "adaptive"
      ? days <= 31
        ? "day"
        : days <= 120
          ? "week"
          : "month"
      : preset.granularity;
  const cursor = new Date(localCoordinate(from, timezone));
  cursor.setUTCHours(0, 0, 0, 0);
  if (granularity === "week")
    cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
  if (granularity === "month") cursor.setUTCDate(1);
  const buckets: CalendarBucket[] = [];
  while (true) {
    const a = instantFromCoordinate(cursor.valueOf(), timezone),
      localStart = cursor.toISOString().slice(0, 10);
    if (a >= to) break;
    if (granularity === "month") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + (granularity === "week" ? 7 : 1));
    const b = instantFromCoordinate(cursor.valueOf(), timezone);
    if (b > from && b > a)
      buckets.push({
        start: new Date(a).toISOString(),
        end: new Date(b).toISOString(),
        from: new Date(Math.max(a, from)).toISOString(),
        to: new Date(Math.min(b, to)).toISOString(),
        localStart,
        partial: a < from || b > to,
      });
    if (buckets.length > 400) throw new ProjectRangeError("PROJECT_BUCKET_LIMIT");
  }
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    timezone,
    env: input.env,
    range: input.range,
    granularity,
    boundary: "[from,to)" as const,
    weekStartsOn: 1 as const,
    presetBoundary: "including_today" as const,
    localFrom: localDateTime(new Date(from).toISOString(), timezone),
    localTo: localDateTime(new Date(to).toISOString(), timezone),
    buckets,
  };
}
