import type { DataStatusRecord } from "./model.js";

export type DataState = "healthy" | "delayed" | "no_data" | "broken";

export interface EvaluatedDataStatus extends DataStatusRecord {
  state: DataState;
  reason: string;
}

export function evaluateDataStatus(
  status: DataStatusRecord,
  options: { nowMs?: number; delayThresholdMs?: number } = {},
): EvaluatedDataStatus {
  const nowMs = options.nowMs ?? Date.now();
  const threshold = options.delayThresholdMs ?? 5 * 60 * 1000;
  if (!status.lastReceivedAt) {
    return { ...status, state: "no_data", reason: "NO_EVENTS_RECEIVED" };
  }
  if (status.deadLetterEvents > 0 && !status.lastQueryableAt) {
    return { ...status, state: "broken", reason: "DEAD_LETTER_WITHOUT_QUERYABLE_DATA" };
  }
  const received = Date.parse(status.lastReceivedAt);
  const queryable = status.lastQueryableAt ? Date.parse(status.lastQueryableAt) : 0;
  if (
    !queryable ||
    received - queryable > threshold ||
    (nowMs - received < threshold && !queryable)
  ) {
    return { ...status, state: "delayed", reason: "INGESTION_BEHIND_RECEIVE" };
  }
  return { ...status, state: "healthy", reason: "PIPELINE_CURRENT" };
}
