import { jsonBytes } from "./console-snapshot.js";

export interface Evidence {
  state: string;
  value?: string;
  reason?: string;
  bytes: number;
  omittedBytes?: number;
  omittedBytesExact?: boolean;
}
export const unavailable = (reason: string): Evidence => ({ state: reason, bytes: 0 });
/** The budget includes the entire field, JSON escapes and status metadata. */
export function textEvidence(value: string, limit = 16384): Evidence {
  const reserve = 180;
  let lo = 0,
    hi = Math.min(value.length, limit);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes(value.slice(0, mid)) <= limit - reserve) lo = mid;
    else hi = mid - 1;
  }
  if (lo && /[\uD800-\uDBFF]/.test(value[lo - 1]!)) lo--;
  const kept = value.slice(0, lo);
  return {
    state: lo === value.length ? "captured" : "truncated",
    value: kept,
    bytes: jsonBytes(kept),
    omittedBytes: value.length - lo,
    omittedBytesExact: lo === value.length,
  };
}
/** Own data properties only; no getters, iterators or string conversion. */
export function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}
export function headersEvidence(value: unknown): Evidence {
  if (value === undefined) return unavailable("not_provided");
  try {
    const lines: string[] = [];
    let bytes = 0,
      truncated = false;
    // Use native brand-checked methods, never a user supplied iterator.
    if (Object.getPrototypeOf(value) === Headers.prototype) {
      const iterator = Headers.prototype.entries.call(value);
      for (let n = 0; n < 64; n++) {
        const item = iterator.next();
        if (item.done) return textEvidence(lines.join("\n"), 4096);
        const line = item.value[0] + ": " + item.value[1];
        if (line.length > 4096 || bytes + jsonBytes(line) > 3800) {
          truncated = true;
          break;
        }
        lines.push(line);
        bytes += jsonBytes(line) + 2;
      }
      truncated = true;
    } else if (
      value &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null)
    ) {
      const keys = Reflect.ownKeys(value);
      for (const key of keys.slice(0, 64)) {
        if (typeof key !== "string") continue;
        const item = data(value, key);
        if (typeof item !== "string")
          return unavailable("unreadable_accessor_or_headers");
        if (key.length + item.length > 4096) {
          truncated = true;
          break;
        }
        const line = key + ": " + item;
        if (bytes + jsonBytes(line) > 3800) {
          truncated = true;
          break;
        }
        lines.push(line);
        bytes += jsonBytes(line) + 2;
      }
      truncated ||= keys.length > 64;
    } else return unavailable("unsupported_headers");
    const result = textEvidence(lines.join("\n"), 4096);
    if (truncated) {
      result.state = "truncated";
      result.omittedBytesExact = false;
    }
    return result;
  } catch {
    return unavailable("unreadable_headers");
  }
}
