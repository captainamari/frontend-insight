import type { TrackerEvent, TrackerRuntime, TrackerDiagnostics } from "./types.js";
/** Optional quality entrypoint. No optional collector code is loaded by the base SDK. */
export type QualityEmit = (
  event: "performance" | "api" | "error",
  payload: TrackerEvent["payload"],
) => void;
export interface QualityPort {
  runtime: TrackerRuntime;
  capture(): QualityEmit;
  diagnostics(): Readonly<TrackerDiagnostics>;
}
export interface QualityHooks {
  enter(closed?: boolean): TrackerEvent["payload"];
  leave(closed: boolean): TrackerEvent["payload"];
  destroy(): void;
}
export type QualityFactory = (port: QualityPort) => QualityHooks;
