/** Bounded JSON-safe value snapshots; no accessors, toJSON, iterators or conversion hooks. */
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const encoder = new TextEncoder();
export const jsonBytes = (value: unknown): number =>
  encoder.encode(JSON.stringify(value)).length;
export function snapshotArguments(args: unknown[], budget: number) {
  const issues = new Set<string>();
  let nodes = 0,
    remaining = budget,
    omittedBytes = 0;
  const seen = new WeakSet<object>();
  const mark = (reason: string) => {
    issues.add(reason);
    return `[${reason}]`;
  };
  const text = (value: string) => {
    const original = value.length > 8192 ? null : jsonBytes(value);
    if (original !== null && original <= remaining) {
      remaining -= original;
      return value;
    }
    let lo = 0,
      hi = Math.min(value.length, Math.max(0, remaining));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (jsonBytes(value.slice(0, mid)) <= remaining) lo = mid;
      else hi = mid - 1;
    }
    if (lo && /[\uD800-\uDBFF]/.test(value[lo - 1]!)) lo--;
    const kept = value.slice(0, lo);
    omittedBytes +=
      original === null ? value.length - kept.length : original - jsonBytes(kept);
    if (original === null) mark("string_bytes_lower_bound");
    remaining = Math.max(0, remaining - jsonBytes(kept));
    mark("string_truncated");
    return kept;
  };
  const read = (value: object, key: PropertyKey): unknown => {
    try {
      let owner: object | null = value;
      for (let i = 0; owner && i < 8; i++, owner = Object.getPrototypeOf(owner)) {
        const d = Object.getOwnPropertyDescriptor(owner, key);
        if (d) {
          if (key === "stack" && nativeStackGetter && d.get === nativeStackGetter)
            return Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")
              ? mark("unreadable_stack_formatter")
              : d.get.call(value);
          return "value" in d ? d.value : mark("unreadable_accessor");
        }
      }
    } catch {
      return mark("unreadable_property");
    }
    return undefined;
  };
  const visit = (value: unknown, depth: number, causes: number): unknown => {
    if (++nodes > 128 || depth > 8 || remaining < 24) return mark("budget_omitted");
    remaining -= 4;
    if (typeof value === "string") return text(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number")
      return Number.isFinite(value) ? value : mark(`number:${value}`);
    if (typeof value === "bigint") return text(`[bigint:${value}]`);
    if (typeof value !== "object") return mark(typeof value);
    if (seen.has(value)) return mark("circular");
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const length = read(value, "length");
        if (typeof length !== "number") return mark("unreadable_array");
        const result: unknown[] = [];
        for (let i = 0; i < Math.min(length, 32); i++) {
          if (remaining < 24) {
            result.push(mark("items_omitted"));
            break;
          }
          result.push(visit(read(value, String(i)), depth + 1, causes));
        }
        if (length > 32) mark("items_omitted");
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      const proto = Object.getPrototypeOf(value);
      // Recognize ordinary objects and Errors without invoking Symbol.toStringTag.
      const error = value instanceof Error;
      if (proto !== null && proto !== Object.prototype && !error)
        result.$type = mark("special_object");
      const keys = Reflect.ownKeys(value);
      const names: (string | symbol)[] = error
        ? [...new Set(["name", "message", "stack", "cause", "errors", ...keys])]
        : keys;
      if (names.length > 32) mark("properties_omitted");
      for (const key of names.slice(0, 32)) {
        if (remaining < 24) {
          mark("properties_omitted");
          break;
        }
        if (typeof key === "symbol") {
          mark("symbol_key_omitted");
          continue;
        }
        if (key.length > 128) {
          mark("property_key_omitted");
          continue;
        }
        const child = read(value, key);
        // Do not fabricate absent Error fields; own undefined values remain explicit.
        if (
          error &&
          child === undefined &&
          !Object.getOwnPropertyDescriptor(value, key)
        )
          continue;
        remaining -= jsonBytes(key) + 2;
        result[key] =
          key === "cause" && causes >= 4
            ? mark("cause_depth_omitted")
            : visit(child, depth + 1, causes + (key === "cause" ? 1 : 0));
      }
      return result;
    } catch {
      return mark("unreadable_object");
    } finally {
      seen.delete(value);
    }
  };
  const parameters: unknown[] = [];
  for (const arg of args.slice(0, 32)) {
    if (remaining < 24) {
      mark("arguments_omitted");
      break;
    }
    parameters.push(visit(arg, 0, 0));
  }
  if (args.length > 32) mark("arguments_omitted");
  // Metadata is bounded too. Unknown unvisited values have no fabricated byte count.
  return {
    parameters,
    issues: [...issues],
    omittedBytes,
    omittedBytesExact:
      issues.size === 0 || [...issues].every((i) => i === "string_truncated"),
  };
}
