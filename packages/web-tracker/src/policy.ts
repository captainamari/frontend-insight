import {
  DEFAULT_DIAGNOSTIC_POLICY,
  validDiagnosticPolicy,
  diagnosticRouteMatches,
  type PublishedDiagnosticPolicy,
} from "@frontend-insight/event-contract/diagnostic-policy";
import { createErrorDiagnostics } from "./errors.js";
import {
  createRequestDiagnostics,
  type RequestOptions,
  type RequestAssociation,
} from "./requests.js";
import type { ErrorExtractor } from "./error-port.js";
import type { TrackerRuntime } from "./types.js";

/** Explicit opt-in adapter. No addition to the base entrypoint or quality counters. */
export function createDiagnosticPolicy(options: {
  appId: string;
  env: "dev" | "staging" | "prod";
  endpoint: string;
  requests?: Omit<RequestOptions, "scope">;
  console?: RequestOptions["console"];
}) {
  const local = structuredClone({
    requests: options.requests,
    console: options.console,
  });
  let published: PublishedDiagnosticPolicy = {
    revision: 0,
    version: "d0-1",
    updatedAt: null,
    policy: structuredClone(DEFAULT_DIAGNOSTIC_POLICY),
  };
  let runtime: TrackerRuntime | undefined,
    page: (() => string) | undefined,
    owner: object | undefined;
  let adapter: ReturnType<typeof createRequestDiagnostics> | undefined;
  let stop: (() => void) | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0,
    requestNo = 0,
    appliedNo = 0,
    alive = false;
  let lastSyncAt: string | null = null,
    lastSuccessAt: string | null = null;
  let syncState: "pending" | "applied" | "last_valid" | "failed" | "destroyed" =
    "pending";
  const counters = { collectorErrors: 0, syncFailures: 0, suppressed: 0, truncated: 0 };
  let windowPage = "";
  let windowAt = 0,
    count = 0,
    healthAt = 0,
    sequence = 0,
    healthBackoff = 60000;
  const clientId = globalThis.crypto.randomUUID();
  const controllers = new Set<AbortController>();
  // The extractor keeps deduplication alive while raw collectors are suspended.
  const fallback = createErrorDiagnostics(function () {
    return this === owner && alive && published.policy.enabled;
  });
  function enabled() {
    if (!alive || !published.policy.enabled) return [] as string[];
    return [
      "errors",
      ...(published.policy.level === "context"
        ? [
            ...(local.console &&
            local.console.enabled !== false &&
            (local.console.levels ?? ["error", "warn"]).some((l) =>
              published.policy.consoleLevels.includes(l),
            )
              ? ["console"]
              : []),
            ...(local.requests &&
            local.requests.enabled !== false &&
            published.policy.requestRoutes.length > 0
              ? ["requests"]
              : []),
          ]
        : []),
    ];
  }
  function rebuild() {
    stop?.();
    stop = undefined;
    adapter = undefined;
    if (
      !runtime ||
      !page ||
      !owner ||
      !alive ||
      !published.policy.enabled ||
      published.policy.level === "errors"
    )
      return;
    adapter = createRequestDiagnostics({
      ...local.requests,
      onCollectorError: () => {
        counters.collectorErrors = Math.min(1000000, counters.collectorErrors + 1);
      },
      scope: { appId: options.appId },
      enabled:
        !!local.requests &&
        local.requests.enabled !== false &&
        published.policy.requestRoutes.length > 0,
      console: {
        ...local.console,
        enabled:
          !!local.console &&
          local.console.enabled !== false &&
          (local.console.levels ?? ["error", "warn"]).some((l) =>
            published.policy.consoleLevels.includes(l),
          ),
        levels: (local.console?.levels ?? ["error", "warn"]).filter((l) =>
          published.policy.consoleLevels.includes(l),
        ),
      },
      routeAllowed: (path) =>
        diagnosticRouteMatches(path, published.policy.requestRoutes),
      successBodyAllowed: (path) =>
        diagnosticRouteMatches(path, published.policy.successBodyRoutes),
    });
    stop = adapter.errorDiagnostics.start?.(runtime, page, owner);
  }
  function status() {
    return {
      version: published.version,
      revision: published.revision,
      lastSyncAt,
      lastSuccessAt,
      sync: syncState,
      enabled: enabled(),
      disabled: ["errors", "console", "requests"].flatMap((collector) => {
        if (enabled().includes(collector)) return [];
        const option = collector === "console" ? local.console : local.requests;
        const reason = !alive
          ? "not_started"
          : collector !== "errors" && !option
            ? "not_installed"
            : collector !== "errors" && option?.enabled === false
              ? "locally_disabled"
              : "policy_suppressed";
        return [{ collector, reason }];
      }),
      unavailable: [
        !local.console && "console:not_installed",
        !local.requests && "requests:not_installed",
        "xhr:unsupported",
      ].filter(Boolean),
      counters: { ...counters },
      compatibility: published.revision === 0,
      clientId,
    };
  }
  async function ownRequest(path: string, body: unknown) {
    if (!runtime) throw new Error("SDK_NOT_STARTED");
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await runtime.fetch(options.endpoint.replace(/\/$/, "") + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        credentials: "omit",
      });
      if (!response.ok) throw new Error("SDK_POLICY_HTTP");
      // This is the SDK's own config response, never a business Response.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("SDK_POLICY_EMPTY");
      let text = "",
        bytes = 0;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 65536) {
            await reader.cancel();
            throw new Error("SDK_POLICY_BUDGET");
          }
          text += decoder.decode(item.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(text + decoder.decode());
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }
  async function reportHealth() {
    if (!alive || Date.now() - healthAt < healthBackoff) return;
    healthAt = Date.now();
    const epoch = generation;
    try {
      await ownRequest("/diagnostics-health", {
        appId: options.appId,
        clientId,
        sequence: ++sequence,
        metadata: {
          version: published.version,
          sync: syncState,
          ...counters,
          enabled: enabled(),
        },
      });
      if (epoch === generation) healthBackoff = 60000;
    } catch {
      if (epoch === generation) healthBackoff = Math.min(900000, healthBackoff * 2);
    }
  }
  async function sync() {
    if (!alive) return status();
    const epoch = generation,
      request = ++requestNo;
    try {
      const result = await ownRequest("/workflow-config", {
        appId: options.appId,
        env: options.env,
        diagnosticsOnly: true,
      });
      if (!alive || epoch !== generation || request < appliedNo) return status();
      const p = result.diagnostics as PublishedDiagnosticPolicy;
      if (
        result.appId !== options.appId ||
        result.env !== options.env ||
        !p ||
        !Number.isInteger(p.revision) ||
        p.revision < 0 ||
        typeof p.version !== "string" ||
        !/^[a-z0-9-]{1,64}$/.test(p.version) ||
        !validDiagnosticPolicy(p.policy) ||
        p.revision < published.revision
      )
        throw new Error("SDK_POLICY_INVALID");
      appliedNo = request;
      const changed = JSON.stringify(p) !== JSON.stringify(published);
      published = structuredClone(p);
      lastSuccessAt = new Date().toISOString();
      syncState = "applied";
      if (changed) rebuild();
    } catch {
      if (alive && epoch === generation && request >= appliedNo) {
        counters.syncFailures = Math.min(1000000, counters.syncFailures + 1);
        syncState = lastSuccessAt ? "last_valid" : "failed";
      }
    } finally {
      if (alive && epoch === generation) lastSyncAt = new Date().toISOString();
    }
    if (alive && epoch === generation) void reportHealth();
    return status();
  }
  const errorDiagnostics: ErrorExtractor = function (
    this: object,
    value,
    source,
    occurrence,
  ) {
    if (this !== owner) {
      const unrelated = fallback.call(this, value, source, occurrence);
      if (unrelated) {
        unrelated.diagnostic.raw = {};
        unrelated.diagnostic.status = "unavailable";
      }
      return unrelated;
    }
    let result;
    try {
      result = (adapter?.errorDiagnostics ?? fallback).call(
        this,
        value,
        source,
        occurrence,
      );
    } catch {
      counters.collectorErrors = Math.min(1000000, counters.collectorErrors + 1);
      result = fallback.call(this, value, source, occurrence);
    }
    if (!result) return null;
    const d = result.diagnostic,
      now = Date.now();
    d.policyVersion = published.version;
    if (now - windowAt >= 60000 || windowPage !== page?.()) {
      windowPage = page?.() ?? "";
      windowAt = now;
      count = 0;
    }
    if (!published.policy.enabled || !alive) {
      d.raw = {};
      d.status = "unavailable";
      counters.suppressed = Math.min(1000000, counters.suppressed + 1);
    } else if (count++ >= published.policy.envelopesPerMinute) {
      d.raw = {};
      d.status = "rate_limited";
      d.suppressed = 1;
      counters.suppressed = Math.min(1000000, counters.suppressed + 1);
    } else if (
      new TextEncoder().encode(JSON.stringify(d)).byteLength >
      published.policy.envelopeBytes
    ) {
      d.raw = {};
      d.status = "too_large";
      counters.suppressed = Math.min(1000000, counters.suppressed + 1);
    }
    if (d.status === "truncated")
      counters.truncated = Math.min(1000000, counters.truncated + 1);
    return result;
  };
  function destroy() {
    alive = false;
    generation++;
    stop?.();
    stop = undefined;
    adapter = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const c of controllers) c.abort();
    controllers.clear();
    runtime = undefined;
    page = undefined;
    syncState = "destroyed";
  }
  errorDiagnostics.start = (rt, getPage, scope) => {
    if (owner && owner !== scope) return () => {};
    if ((scope as { appId?: string }).appId !== options.appId) return () => {};
    destroy();
    owner = scope;
    runtime = rt;
    page = getPage;
    alive = true;
    syncState = lastSuccessAt ? "last_valid" : "pending";
    rebuild();
    void sync();
    timer = setInterval(() => {
      void sync();
    }, 60000);
    return destroy;
  };
  return {
    errorDiagnostics,
    sync,
    status,
    destroy,
    reportHealth,
    bind(binding: RequestAssociation = {}) {
      return {
        wrapFetch(
          original: typeof fetch,
          source: "application" | "sdk" | "upload" = "application",
        ): typeof fetch {
          return function (this: unknown, ...args: Parameters<typeof fetch>) {
            const wrapped =
              adapter?.bind(binding).wrapFetch(original, source) ?? original;
            return Reflect.apply(wrapped, this, args);
          };
        },
        action(name: string, target = "", context: unknown = null) {
          adapter?.bind(binding).action(name, target, context);
        },
      };
    },
    responseText(response: Response, text: string, businessFailure = false) {
      adapter?.responseText(response, text, businessFailure);
    },
  };
}
