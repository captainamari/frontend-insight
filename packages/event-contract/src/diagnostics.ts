import { DIAGNOSTIC_LIMITS as L } from "./constants.js";
import type { DiagnosticEnvelope } from "./generated/event-batch-v3.js";
const bytes = (v: unknown) =>
  new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)).length;
/** D0 budgets for reserved raw sections. Collectors/serialization arrive in D1–D3. */
export function diagnosticBudgetError(d: DiagnosticEnvelope): string | null {
  if (bytes(JSON.stringify(d)) > L.maximumEnvelopeBytes) return "envelope";
  const raw = d.raw;
  const error = (
    raw.error && typeof raw.error === "object" ? raw.error : raw
  ) as Record<string, unknown>;
  if (
    typeof error.stack === "string" &&
    (bytes(error.stack) > L.stackBytes ||
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
      bytes(raw.console) > L.consoleBytes
    )
      return "console";
    if (raw.console.some((v) => bytes(v) > L.consoleEntryBytes)) return "console_entry";
  }
  if (raw.request !== undefined && raw.request && typeof raw.request === "object") {
    const request = raw.request as Record<string, unknown>;
    for (const key of ["requestBody", "responseBody"])
      if (request[key] !== undefined && bytes(request[key]) > L.bodyBytes)
        return "body";
    for (const key of ["requestHeaders", "responseHeaders"])
      if (request[key] !== undefined && bytes(request[key]) > L.headersBytes)
        return "headers";
  }
  return null;
}
