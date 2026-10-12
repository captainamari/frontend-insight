/** D6 policy is intentionally not imported by the base SDK entrypoint. */
export const DIAGNOSTIC_LEVELS = ["error", "warn", "log", "info", "debug"] as const;
export interface DiagnosticPolicy {
  enabled: boolean;
  level: "errors" | "context";
  consoleLevels: string[];
  requestRoutes: string[];
  successBodyRoutes: string[];
  envelopeBytes: number;
  envelopesPerMinute: number;
  retentionDays: number;
}
export const DEFAULT_DIAGNOSTIC_POLICY: DiagnosticPolicy = {
  enabled: true,
  level: "context",
  consoleLevels: [...DIAGNOSTIC_LEVELS],
  requestRoutes: ["/**"],
  successBodyRoutes: ["/**"],
  envelopeBytes: 65536,
  envelopesPerMinute: 20,
  retentionDays: 14,
};
export function validDiagnosticPolicy(value: unknown): value is DiagnosticPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as DiagnosticPolicy;
  if (
    Object.keys(p).sort().join() !==
    Object.keys(DEFAULT_DIAGNOSTIC_POLICY).sort().join()
  )
    return false;
  const integer = (n: number, lo: number, hi: number) =>
    Number.isInteger(n) && n >= lo && n <= hi;
  const routes = (v: unknown) =>
    Array.isArray(v) &&
    v.length <= 32 &&
    v.every(
      (r) =>
        typeof r === "string" &&
        r.length <= 256 &&
        /^\/(?:[A-Za-z0-9_./~%-]*)(?:\*\*)?$/.test(r) &&
        (!r.includes("**") || r.endsWith("/**")),
    );
  return (
    typeof p.enabled === "boolean" &&
    ["errors", "context"].includes(p.level) &&
    Array.isArray(p.consoleLevels) &&
    p.consoleLevels.length <= 5 &&
    new Set(p.consoleLevels).size === p.consoleLevels.length &&
    p.consoleLevels.every((l) =>
      (DIAGNOSTIC_LEVELS as readonly string[]).includes(l),
    ) &&
    routes(p.requestRoutes) &&
    routes(p.successBodyRoutes) &&
    integer(p.envelopeBytes, 1024, 65536) &&
    integer(p.envelopesPerMinute, 1, 20) &&
    integer(p.retentionDays, 1, 90)
  );
}
/** Exact URL pathname or /prefix/** segment subtree; no query, origin, regex or decoding. */
export function diagnosticRouteMatches(path: string, rules: readonly string[]) {
  return rules.some(
    (r) =>
      r === path ||
      (r.endsWith("/**") &&
        (path === r.slice(0, -3) || path.startsWith(r.slice(0, -2)))),
  );
}
export interface PublishedDiagnosticPolicy {
  revision: number;
  version: string;
  updatedAt: string | null;
  policy: DiagnosticPolicy;
}
