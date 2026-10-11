import { DIAGNOSTIC_LIMITS as L } from "./constants.js";
import type { DiagnosticEnvelope } from "./generated/event-batch-v3.js";
export const diagnosticBytes = (v: unknown) =>
  new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)).length;
export const diagnosticJsonBytes = (value: unknown) =>
  diagnosticBytes(JSON.stringify(value));
/** D0 budgets for reserved raw sections. Collectors/serialization arrive in D1–D3. */
export function diagnosticBudgetError(d: DiagnosticEnvelope): string | null {
  if (diagnosticJsonBytes(d) > L.maximumEnvelopeBytes) return "envelope";
  const raw = d.raw;
  const error = (
    raw.error && typeof raw.error === "object" ? raw.error : raw
  ) as Record<string, unknown>;
  if (
    typeof error.stack === "string" &&
    (diagnosticBytes(error.stack) > L.stackBytes ||
      error.stack.split("\n").filter((l) => /^\s*at\s|@/.test(l)).length >
        L.stackFrames)
  )
    return "stack";
  let cause = error.cause,
    depth = 0;
  while (cause && typeof cause === "object") {
    if (++depth > L.causeDepth) return "cause";
    cause = (cause as Record<string, unknown>).cause;
  }
  if (raw.console !== undefined) {
    if (
      !Array.isArray(raw.console) ||
      raw.console.length > L.consoleEntries ||
      diagnosticJsonBytes(raw.console) > L.consoleBytes
    )
      return "console";
    if (raw.console.some((v) => diagnosticJsonBytes(v) > L.consoleEntryBytes))
      return "console_entry";
  }
  if (raw.request !== undefined && raw.request && typeof raw.request === "object") {
    const request = raw.request as Record<string, unknown>;
    for (const key of ["requestBody", "responseBody"])
      if (request[key] !== undefined && diagnosticJsonBytes(request[key]) > L.bodyBytes)
        return "body";
    for (const key of ["requestHeaders", "responseHeaders"])
      if (
        request[key] !== undefined &&
        diagnosticJsonBytes(request[key]) > L.headersBytes
      )
        return "headers";
  }
  if (raw.requests !== undefined) {
    if (
      !Array.isArray(raw.requests) ||
      raw.requests.length > 20 ||
      diagnosticJsonBytes(raw.requests) > 32768
    )
      return "requests";
    for (const entry of raw.requests) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return "request_shape";
      const r = entry as Record<string, unknown>;
      for (const key of ["requestBody", "responseBody"])
        if (diagnosticJsonBytes(r[key] ?? null) > L.bodyBytes) return "body";
      for (const key of ["requestHeaders", "responseHeaders", "url", "responseUrl"])
        if (diagnosticJsonBytes(r[key] ?? null) > L.headersBytes) return "headers";
      if (diagnosticJsonBytes(r) > 24576) return "request_entry";
    }
  }
  if (raw.timeline !== undefined) {
    if (
      !Array.isArray(raw.timeline) ||
      raw.timeline.length > 30 ||
      diagnosticJsonBytes(raw.timeline) > 8192
    )
      return "timeline";
    if (raw.timeline.some((r) => diagnosticJsonBytes(r) > 2048))
      return "timeline_entry";
  }
  if (
    raw.requestCapture !== undefined &&
    diagnosticJsonBytes(raw.requestCapture) > 2048
  )
    return "request_metadata";
  return null;
}
