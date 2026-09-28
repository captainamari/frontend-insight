import type { Logger, ErrorLogParams, WarnLogParams } from "@clickhouse/client";

/** Driver error messages can contain SQL parameters and business values. Keep only
 * bounded diagnostic codes and the storage request ID; API request IDs stay in HTTP logs. */
export class SafeClickHouseLogger implements Logger {
  trace() {}
  debug() {}
  info() {}
  warn(params: WarnLogParams) {
    this.write("warn", params);
  }
  error(params: ErrorLogParams) {
    this.write("error", params);
  }
  private write(level: "warn" | "error", params: WarnLogParams) {
    const error = params.err as { code?: unknown } | undefined;
    const code =
      typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code
        : "CLICKHOUSE_REQUEST_FAILED";
    const id = params.args?.query_id;
    console[level](
      JSON.stringify({
        source: "clickhouse",
        code,
        queryId: typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id) ? id : null,
      }),
    );
  }
}

/** Only transport enums and numeric ClickHouse codes may enter operational logs. */
export function storageFailureCode(cause: unknown): string {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? cause.code
      : null;
  const normalized =
    typeof code === "string" || typeof code === "number" ? String(code) : "";
  if (/^[0-9]{1,5}$/.test(normalized)) return `CLICKHOUSE_${normalized}`;
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "ABORT_ERR",
    ].includes(normalized)
  )
    return normalized;
  if (cause instanceof RangeError) return "INVALID_FACT_VALUE";
  if (cause instanceof SyntaxError) return "INVALID_FACT_RESPONSE";
  if (cause instanceof TypeError) return "FACT_RESPONSE_TYPE_ERROR";
  return "FACT_READ_FAILED";
}
