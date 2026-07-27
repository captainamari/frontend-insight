import type { DataState } from "./types";

export type ProductPresentation =
  | "loading"
  | "onboarding"
  | "no_activity"
  | "delayed"
  | "partial"
  | "error"
  | "forbidden"
  | "stale"
  | "ready";

export function resolveProductPresentation(input: {
  loading: boolean;
  hasData: boolean;
  errorStatus: number | null;
  dataState: DataState | null;
  hasActivity: boolean | null;
  hasGaps: boolean;
}): ProductPresentation {
  if (input.loading && !input.hasData) return "loading";
  if (input.errorStatus && !input.hasData) {
    return input.errorStatus === 403 ? "forbidden" : "error";
  }
  if (input.errorStatus && input.hasData) return "stale";
  if (input.dataState === "no_data") return "onboarding";
  if (input.dataState === "delayed" || input.dataState === "broken") {
    return "delayed";
  }
  if (input.hasGaps) return "partial";
  if (input.hasActivity === false) return "no_activity";
  return "ready";
}
