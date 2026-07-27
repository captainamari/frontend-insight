import type { RangePreset, RangeQuery, TrendPoint } from "./types";

export const rangeLabels: Record<RangePreset, string> = {
  "24h": "最近 24 小时",
  "7d": "最近 7 天",
  "30d": "最近 30 天",
};

export function isRangePreset(value: unknown): value is RangePreset {
  return value === "24h" || value === "7d" || value === "30d";
}

export function buildRangeQuery(
  preset: RangePreset,
  timezone: string,
  now = new Date(),
): RangeQuery {
  const durations: Record<RangePreset, number> = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  return {
    from: new Date(now.valueOf() - durations[preset]).toISOString(),
    to: now.toISOString(),
    timezone,
    granularity: preset === "30d" ? "day" : "hour",
  };
}

export function rangeSearch(query: RangeQuery): string {
  return new URLSearchParams({
    from: query.from,
    to: query.to,
    timezone: query.timezone,
    granularity: query.granularity,
  }).toString();
}

export interface ChartPoint {
  bucket: string;
  primary: number | null;
  secondary: number | null;
}

export function fillTrendGaps(
  points: TrendPoint[],
  range: RangeQuery,
  primary: keyof TrendPoint,
  secondary: keyof TrendPoint,
): ChartPoint[] {
  const step = range.granularity === "hour" ? 3_600_000 : 86_400_000;
  const normalized = points
    .map((point) => ({
      point,
      time: Date.parse(
        /(?:Z|[+-]\d\d:\d\d)$/.test(point.bucket)
          ? point.bucket
          : `${point.bucket.replace(" ", "T")}Z`,
      ),
    }))
    .filter((item) => Number.isFinite(item.time))
    .sort((left, right) => left.time - right.time);
  const result: ChartPoint[] = [];
  for (const [index, item] of normalized.entries()) {
    const point = item.point;
    result.push({
      bucket: point.bucket,
      primary: typeof point[primary] === "number" ? (point[primary] as number) : null,
      secondary:
        typeof point[secondary] === "number" ? (point[secondary] as number) : null,
    });
    const next = normalized[index + 1];
    if (next && next.time - item.time > step * 1.5) {
      result.push({
        bucket: new Date(item.time + step).toISOString(),
        primary: null,
        secondary: null,
      });
    }
  }
  return result;
}

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat("zh-CN").format(value ?? 0);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "尚无";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
