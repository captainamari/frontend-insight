import type { DiagnosticEnvelope } from "@frontend-insight/event-contract";
import type { ErrorExtractor, ErrorSource } from "./error-port.js";

const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;
/** Optional D1 extractor: never evaluates accessors or calls user toJSON/toString. */
export function extractError(value: unknown, source: ErrorSource): DiagnosticEnvelope {
  let remaining = 40000,
    nodes = 0,
    omittedBytes = 0;
  const issues: string[] = [],
    seen = new WeakSet<object>();
  const issue = (s: string) => {
    if (issues.length < 64) issues.push(s);
  };
  const text = (s: string, cap: number, path: string) => {
    const length = bytes(s);
    const fits = (v: string) =>
      bytes(v) <= cap && bytes(JSON.stringify(v)) <= remaining;
    if (!fits(s)) {
      let low = 0,
        high = Math.min(s.length, cap);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(s.slice(0, mid))) low = mid;
        else high = mid - 1;
      }
      if (low && /[\uD800-\uDBFF]/.test(s[low - 1]!)) low--;
      omittedBytes += length - bytes(s.slice(0, low));
      issue(`${path}:truncated`);
      s = s.slice(0, low);
    }
    remaining -= bytes(JSON.stringify(s));
    return s;
  };
  const read = (o: object, key: string, path: string): unknown => {
    try {
      let current: object | null = o;
      for (let i = 0; current && i < 8; i++, current = Object.getPrototypeOf(current)) {
        const d = Object.getOwnPropertyDescriptor(current, key);
        if (d) {
          if (key === "stack" && nativeStackGetter && d.get === nativeStackGetter)
            return d.get.call(o);
          if (!("value" in d)) {
            issue(`${path}:unreadable_accessor`);
            return "[unreadable]";
          }
          return d.value;
        }
      }
    } catch {
      issue(`${path}:unreadable`);
      return "[unreadable]";
    }
    return undefined;
  };
  const snapshot = (
    v: unknown,
    depth: number,
    causeDepth: number,
    path: string,
  ): unknown => {
    if (++nodes > 256 || depth > 8 || remaining <= 0) {
      issue(`${path}:omitted`);
      return "[omitted]";
    }
    if (typeof v === "string") return text(v, 16384, path);
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : `[${v}]`;
    if (typeof v !== "object") {
      issue(`${path}:non_json`);
      return `[${typeof v}${typeof v === "bigint" ? `:${v}` : ""}]`;
    }
    if (seen.has(v)) {
      issue(`${path}:circular`);
      return "[circular]";
    }
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const length = Math.min(Number(read(v, "length", path)) || 0, 32);
        const result = Array.from({ length }, (_, i) =>
          snapshot(
            read(v, String(i), `${path}.${i}`),
            depth + 1,
            causeDepth,
            `${path}.${i}`,
          ),
        );
        if (v.length > length) issue(`${path}:items_omitted`);
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      // Include non-enumerable Error fields and ordinary rejection-object data.
      const keys = [
        ...new Set(["name", "message", "stack", "cause", "errors", ...Object.keys(v)]),
      ];
      if (keys.length > 32) issue(`${path}:properties_omitted`);
      for (const key of keys.slice(0, 32)) {
        const child = read(v, key, `${path}.${key}`);
        if (child === undefined) continue;
        if (key === "cause" && causeDepth >= 4) {
          issue(`${path}.cause:depth_omitted`);
          continue;
        }
        if (key === "stack" && typeof child === "string") {
          let count = 0;
          const lines = child.split("\n"),
            kept: string[] = [];
          for (const line of lines) {
            if (/^\s*at\s|@/.test(line) && ++count > 32) break;
            kept.push(line);
          }
          const stack = kept.join("\n");
          if (stack.length < child.length) {
            omittedBytes += bytes(child.slice(stack.length));
            issue(`${path}.stack:frames_truncated`);
          }
          result[key] = text(stack, 16384, `${path}.stack`);
        } else
          result[text(key, 128, `${path}.key`)] = snapshot(
            child,
            depth + 1,
            causeDepth + (key === "cause" ? 1 : 0),
            `${path}.${key}`,
          );
      }
      return result;
    } catch {
      issue(`${path}:unreadable`);
      return "[unreadable]";
    } finally {
      seen.delete(v);
    }
  };
  const captured = snapshot(value, 0, 0, "error");
  const error =
    captured && typeof captured === "object" && !Array.isArray(captured)
      ? captured
      : {
          name: "NonError",
          message: typeof value === "string" ? captured : JSON.stringify(captured),
          reason: captured,
        };
  return {
    diagnosticVersion: 1,
    contentType: "application/json",
    source,
    policyVersion: "d1-1",
    status: issues.length ? "truncated" : "complete",
    omittedBytes: Math.min(2147483647, omittedBytes),
    suppressed: 0,
    correlation: {},
    raw: { error, extraction: { issues } },
  };
}
/** One instance per tracker. Event identity de-duplicates listeners; same-object
 * cross-source propagation is scoped to one task, never a message fingerprint cap. */
export function createErrorDiagnostics(): ErrorExtractor {
  const events = new WeakSet<object>();
  let propagation = new WeakMap<object, ErrorSource>();
  let pending = false;
  return (value, source, occurrence) => {
    if (occurrence) {
      if (events.has(occurrence)) return null;
      events.add(occurrence);
    }
    if (value && typeof value === "object") {
      const previous = propagation.get(value);
      if (previous && previous !== source) {
        propagation.delete(value);
        return null;
      }
      propagation.set(value, source);
      if (!pending) {
        pending = true;
        setTimeout(() => {
          propagation = new WeakMap();
          pending = false;
        }, 0);
      }
    }
    const diagnostic = extractError(value, source);
    const raw = diagnostic.raw.error as Record<string, unknown>;
    // An opaque derived signature keeps messages/URLs out of ordinary lists.
    let hash = 2166136261;
    for (const char of JSON.stringify([raw.name, raw.message, raw.stack]))
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const name = [
      "Error",
      "TypeError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "URIError",
      "EvalError",
      "AggregateError",
    ].includes(String(raw.name))
      ? String(raw.name)
      : "Error";
    return {
      diagnostic,
      payload: {
        errorType: "js",
        errorCategory: ["vue", "react", "promise"].includes(source) ? source : "js",
        errorName: name,
        errorMessage: `Error group ${(hash >>> 0).toString(16)}`,
        stackTopFrame: "",
      },
    };
  };
}
/** Vue's existing handler is called with its original receiver/arguments. */
export function installVueErrorHandler<Args extends unknown[]>(
  app: { config: { errorHandler?: ((...args: Args) => unknown) | undefined } },
  capture: (error: unknown, source: "vue") => void,
) {
  const previous = app.config.errorHandler;
  function handler(this: unknown, ...args: Args) {
    try {
      capture(args[0], "vue");
    } catch {
      /* Host behavior wins. */
    }
    if (previous) return previous.apply(this, args);
    console.error(args[0]);
  }
  app.config.errorHandler = handler;
  return () => {
    if (app.config.errorHandler === handler) app.config.errorHandler = previous;
  };
}
/** Compose with React ErrorBoundary.componentDidCatch or root error callbacks. */
export function createReactErrorHandler(
  capture: (error: unknown, source: "react") => void,
  previous?: (...args: unknown[]) => unknown,
) {
  return function (this: unknown, ...args: unknown[]) {
    try {
      capture(args[0], "react");
    } catch {
      /* Host behavior wins. */
    }
    return previous?.apply(this, args);
  };
}
