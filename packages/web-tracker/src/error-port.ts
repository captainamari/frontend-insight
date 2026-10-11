import type { DiagnosticEnvelope } from "@frontend-insight/event-contract";
import type { TrackerEvent, TrackerRuntime } from "./types.js";
export type ErrorSource = DiagnosticEnvelope["source"];
export type ErrorReport = (
  value: unknown,
  source: ErrorSource,
  occurrence?: object,
  extra?: TrackerEvent["payload"],
) => void;
export type ErrorExtractor = ((
  value: unknown,
  source: ErrorSource,
  occurrence?: object,
) => { diagnostic: DiagnosticEnvelope; payload: TrackerEvent["payload"] } | null) & {
  start?(runtime: TrackerRuntime, page: () => string, scope: object): () => void;
};
