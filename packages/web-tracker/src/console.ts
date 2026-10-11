import { createErrorDiagnostics } from "./errors.js";
import type { ErrorExtractor } from "./error-port.js";
import type { TrackerRuntime } from "./types.js";
import { jsonBytes, snapshotArguments } from "./console-snapshot.js";

const levels = ["error", "warn", "log", "info", "debug"] as const;
export type ConsoleLevel = (typeof levels)[number];
export interface ConsoleOptions {
  /** Explicit declaration: this app owns this realm's global console. Conflicting owners suspend capture. */
  scope: { appId: string };
  enabled?: boolean;
  levels?: readonly ConsoleLevel[];
  maximumEntries?: number;
  maximumBytes?: number;
  windowMs?: number;
  entryBytes?: number;
}
interface RecordEntry {
  level: ConsoleLevel;
  timestamp: number;
  sequence: number;
  pageViewId: string;
  source: "unknown";
  relativeMs: number;
  parameters: unknown[];
  issues: string[];
  omittedBytes: number;
  omittedBytesExact: boolean;
}
interface Subscriber {
  appId: string;
  prepare(level: ConsoleLevel, args: unknown[]): (() => void) | undefined;
  conflict(): void;
}
interface Hub {
  subscribers: Set<Subscriber>;
  restore: (() => void)[];
  unavailable: ConsoleLevel[];
  busy: boolean;
}
// Symbol registry also shares wrapper ownership across separately bundled SDK copies.
const hubKey = Symbol.for("frontend-insight.console.d2");
function connect(target: object, subscriber: Subscriber) {
  const host = target as Record<PropertyKey, unknown>;
  let hub = host[hubKey] as Hub | undefined;
  if (!hub) {
    hub = { subscribers: new Set(), restore: [], unavailable: [], busy: false };
    Object.defineProperty(host, hubKey, { value: hub, configurable: true });
    for (const level of levels) {
      try {
        const previous = host[level];
        const descriptor = Object.getOwnPropertyDescriptor(host, level);
        if (typeof previous !== "function") {
          hub.unavailable.push(level);
          continue;
        }
        const current = hub;
        function wrapper(this: unknown, ...args: unknown[]) {
          if (current.busy)
            return Reflect.apply(
              previous as (...args: unknown[]) => unknown,
              this,
              args,
            );
          current.busy = true;
          const commits: (() => void)[] = [];
          try {
            const owners = new Set([...current.subscribers].map((s) => s.appId));
            for (const sub of current.subscribers) {
              try {
                if (owners.size > 1) sub.conflict();
                else {
                  const commit = sub.prepare(level, args);
                  if (commit) commits.push(commit);
                }
              } catch {
                /* Collector failure never changes original console behavior. */
              }
            }
            const result = Reflect.apply(
              previous as (...args: unknown[]) => unknown,
              this,
              args,
            );
            for (const commit of commits) {
              try {
                commit();
              } catch {
                /* bounded best effort */
              }
            }
            return result;
          } finally {
            current.busy = false;
          }
        }
        // Assignment preserves existing descriptors; no attempt to defeat non-writable methods.
        host[level] = wrapper;
        if (host[level] !== wrapper) {
          hub.unavailable.push(level);
          continue;
        }
        hub.restore.push(() => {
          if (host[level] !== wrapper) return;
          if (descriptor) Object.defineProperty(host, level, descriptor);
          else delete host[level];
        });
      } catch {
        hub.unavailable.push(level);
      }
    }
  }
  hub.subscribers.add(subscriber);
  if (new Set([...hub.subscribers].map((s) => s.appId)).size > 1)
    for (const sub of hub.subscribers) sub.conflict();
  const current = hub;
  return {
    unavailable: [...hub.unavailable],
    disconnect() {
      current.subscribers.delete(subscriber);
      if (!current.subscribers.size) {
        for (const restore of current.restore) {
          try {
            restore();
          } catch {
            /* ownership may change */
          }
        }
        if (host[hubKey] === current) delete host[hubKey];
      }
    },
  };
}
const cap = (value: number | undefined, maximum: number, minimum: number) =>
  value === undefined
    ? maximum
    : Math.max(
        minimum,
        Math.min(maximum, Number.isFinite(value) ? Math.floor(value) : maximum),
      );

/** Optional console + D1 error diagnostics. No new error listeners or upload channel. */
export function createConsoleDiagnostics(options: ConsoleOptions): ErrorExtractor {
  const extract = createErrorDiagnostics();
  const states = new WeakMap<object, ReturnType<typeof start>>();
  const enabledLevels = new Set(options.levels ?? ["error", "warn"]);
  const limits = {
    entries: cap(options.maximumEntries, 50, 0),
    bytes: cap(options.maximumBytes, 24576, 2),
    windowMs: cap(options.windowMs, 60000, 0),
    entryBytes: cap(options.entryBytes, 2048, 0),
  };
  function start(runtime: TrackerRuntime, page: () => string, scope: object) {
    let records: RecordEntry[] = [],
      pageId = page(),
      sequence = 0;
    let removed = { window: 0, capacity: 0, bytes: 0, scope: 0, entry: 0 };
    const reset = () => {
      const next = page();
      if (next !== pageId) {
        records = [];
        pageId = next;
        removed = { window: 0, capacity: 0, bytes: 0, scope: 0, entry: 0 };
      }
    };
    const prune = (now: number) => {
      reset();
      const kept = records.filter(
        (r) => now - r.timestamp <= limits.windowMs && r.timestamp <= now,
      );
      removed.window += records.length - kept.length;
      records = kept;
    };
    const actualAppId = (scope as { appId?: string }).appId;
    const active = options.enabled !== false && options.scope.appId === actualAppId;
    let conflict = false;
    const sub: Subscriber = {
      appId: options.scope.appId,
      conflict() {
        reset();
        removed.scope += records.length;
        records = [];
        conflict = true;
      },
      prepare(level, args) {
        reset();
        conflict = false;
        if (!enabledLevels.has(level)) return;
        const now = runtime.now();
        prune(now);
        const entry: RecordEntry = {
          level,
          timestamp: now,
          sequence: ++sequence,
          pageViewId: pageId,
          source: "unknown",
          relativeMs: -60000,
          ...snapshotArguments(args, Math.max(0, limits.entryBytes - 600)),
        };
        while (jsonBytes(entry) > limits.entryBytes && entry.parameters.length) {
          const value = entry.parameters.pop();
          entry.omittedBytes += jsonBytes(value);
          entry.omittedBytesExact = false;
          if (!entry.issues.includes("record_budget_omitted"))
            entry.issues.push("record_budget_omitted");
        }
        if (jsonBytes(entry) > limits.entryBytes) {
          removed.entry++;
          return;
        }
        return () => {
          // The original console call has completed; never attach an in-progress handler log.
          if (page() !== entry.pageViewId) return;
          records.push(entry);
          while (records.length > limits.entries) {
            records.shift();
            removed.capacity++;
          }
          while (jsonBytes(records) > limits.bytes && records.length) {
            records.shift();
            removed.bytes++;
          }
        };
      },
    };
    let connection: ReturnType<typeof connect> | undefined;
    if (active) {
      try {
        connection = connect(
          (runtime.window as Window & { console: Console }).console,
          sub,
        );
      } catch {
        /* absent or locked console */
      }
    }
    return {
      freeze() {
        const now = runtime.now();
        prune(now);
        const frozen = records.map((r) => ({ ...r, relativeMs: r.timestamp - now }));
        return {
          records: frozen,
          metadata: {
            state: !active
              ? "not_enabled"
              : conflict
                ? "scope_conflict"
                : !connection
                  ? "unavailable"
                  : frozen.length
                    ? "captured"
                    : "empty",
            capturedAt: now,
            scopeAppId: options.scope.appId,
            levels: [...enabledLevels],
            limits,
            removed: { ...removed },
            unavailableLevels: connection?.unavailable ?? [...levels],
            bytes: jsonBytes(frozen),
            count: frozen.length,
          },
        };
      },
      destroy() {
        connection?.disconnect();
        records = [];
      },
    };
  }
  const extractor: ErrorExtractor = function (this: object, value, source, occurrence) {
    // Freeze first: extraction can encounter a hostile Proxy which itself logs.
    const frozen = states.get(this)?.freeze();
    const result = extract.call(this, value, source, occurrence);
    if (!result) return null;
    const d = result.diagnostic;
    if (!frozen) {
      d.raw.consoleCapture = { state: "not_enabled" };
      return result;
    }
    // Deep copy isolates snapshots from the live ring and from every other exception.
    const logs = JSON.parse(JSON.stringify(frozen.records)) as RecordEntry[];
    const meta = { ...frozen.metadata, envelopeOmitted: 0 };
    d.raw.console = logs;
    d.raw.consoleCapture = meta;
    d.policyVersion = "d2-1";
    if (logs.some((r) => r.issues.length) || Object.values(meta.removed).some(Boolean))
      d.status = "truncated";
    while (jsonBytes(d) > 65536 && logs.length) {
      logs.shift();
      meta.envelopeOmitted++;
      meta.count = logs.length;
      meta.bytes = jsonBytes(logs);
      d.status = "truncated";
    }
    return result;
  };
  extractor.start = (runtime, page, scope) => {
    states.get(scope)?.destroy();
    const state = start(runtime, page, scope);
    states.set(scope, state);
    return () => {
      state.destroy();
      states.delete(scope);
    };
  };
  return extractor;
}
