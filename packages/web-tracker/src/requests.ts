import { createConsoleDiagnostics, type ConsoleOptions } from "./console.js";
import { jsonBytes, snapshotArguments } from "./console-snapshot.js";
import {
  data,
  headersEvidence,
  textEvidence,
  unavailable,
  type Evidence,
} from "./request-evidence.js";
import type { ErrorExtractor, ErrorSource } from "./error-port.js";
import type { Tracker, TrackerRuntime } from "./types.js";

export interface RequestAssociation {
  requestId?: string;
  traceId?: string;
  operationInstanceId?: string;
  workflowInstanceId?: string;
  stepKey?: string;
  attemptId?: string;
}
export interface RequestOptions {
  scope: { appId: string };
  enabled?: boolean;
  onCollectorError?: () => void;
  console?: Omit<ConsoleOptions, "scope">;
  /** Exact URL pathnames, never body inspection or heuristics. */
  successBodyRoutes?: readonly string[];
  excludeRoutes?: readonly string[];
  /** Optional D6 intersection; local authorization remains authoritative. */
  routeAllowed?: (pathname: string) => boolean;
  successBodyAllowed?: (pathname: string) => boolean;
  maximumEntries?: number;
  maximumBytes?: number;
  windowMs?: number;
}
export interface RequestRecord {
  kind: "request";
  localId: string;
  sequence: number;
  timestamp: number;
  appId: string;
  pageViewId: string;
  pageUrl: Evidence;
  method: string;
  url: Evidence;
  endedAt?: number;
  durationMs?: number;
  bodyCapturedAt?: number;
  status?: number;
  result: string;
  failureReason?: Evidence;
  association: RequestAssociation;
  basis: string;
  relativeMs?: number;
  requestBody: Evidence;
  responseBody: Evidence;
  requestHeaders: Evidence;
  responseHeaders: Evidence;
  responseUrl?: Evidence;
  redirected?: boolean;
}
interface ActionRecord {
  kind: "action" | "navigation";
  sequence: number;
  timestamp: number;
  pageViewId: string;
  name: Evidence;
  target: Evidence;
  association: RequestAssociation;
  context: unknown;
  relativeMs?: number;
}
const controlledFetches = new WeakMap<
  object,
  { binding: object; source: string; original: typeof fetch }
>();
const requestStream = Symbol("request_stream");
const bounded = (n: number | undefined, max: number) =>
  Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n!))) : max;
const assocKeys = [
  "requestId",
  "traceId",
  "operationInstanceId",
  "workflowInstanceId",
  "stepKey",
  "attemptId",
] as const;
function association(value: RequestAssociation): RequestAssociation {
  const result: RequestAssociation = {};
  for (const key of assocKeys) {
    const v = data(value, key);
    if (typeof v === "string" && v.length <= 128) result[key] = v;
  }
  return result;
}

/** Scoped controlled adapter. Does not patch fetch/XHR or emit API/error facts. */
export function createRequestDiagnostics(options: RequestOptions) {
  const safe = (f: () => void) => {
    try {
      f();
    } catch {
      try {
        options.onCollectorError?.();
      } catch {
        /* health callbacks cannot change host behavior */
      }
    }
  };
  const appId = options.scope.appId;
  const extract = createConsoleDiagnostics({
    ...options.console,
    scope: { appId },
    onCollectorError: options.onCollectorError,
  });
  const limits = {
    entries: bounded(options.maximumEntries, 20),
    bytes: bounded(options.maximumBytes, 32768),
    windowMs: bounded(options.windowMs, 60000),
    actions: 30,
    actionBytes: 8192,
  };
  const enabled = options.enabled !== false;
  const localSuccessRoutes = new Set(options.successBodyRoutes ?? []);
  const successRoutes = {
    has: (path: string) =>
      localSuccessRoutes.has(path) &&
      (!options.successBodyAllowed || options.successBodyAllowed(path)),
  };
  const excluded = new Set(options.excludeRoutes ?? []);
  const errorAssociations = new WeakMap<object, RequestAssociation>();
  let runtime: TrackerRuntime | undefined, page: (() => string) | undefined;
  let owner: object | undefined,
    pageId = "",
    sequence = 0,
    alive = false;
  let epoch = 0;
  let endpoint = "";
  let requests: RequestRecord[] = [],
    actions: ActionRecord[] = [];
  const removed = { window: 0, capacity: 0, bytes: 0, scope: 0, excluded: 0 };
  const reset = () => {
    if (!runtime || !page) return;
    const next = page();
    if (next !== pageId) {
      removed.scope += requests.length + actions.length;
      requests = [];
      actions = [];
      pageId = next;
      actions.push({
        kind: "navigation",
        sequence: ++sequence,
        timestamp: runtime.now(),
        relativeMs: -60000,
        pageViewId: next,
        name: textEvidence("page_enter", 512),
        target: textEvidence(runtime.window.location.href, 2048),
        association: {},
        context: null,
      });
    }
  };
  const prune = () => {
    reset();
    if (!runtime) return;
    const now = runtime.now();
    const keep = <T extends { timestamp: number }>(items: T[]) =>
      items.filter((r) => r.timestamp <= now && now - r.timestamp <= limits.windowMs);
    for (const record of requests) {
      for (const key of [
        "requestBody",
        "responseBody",
        "requestHeaders",
        "responseHeaders",
      ] as const) {
        if (jsonBytes(record) <= 24576) break;
        const field = record[key];
        record[key] = field.value
          ? {
              ...textEvidence(field.value, 2048),
              state: "truncated",
              reason: "record_budget",
              omittedBytes:
                (field.omittedBytes ?? 0) +
                (textEvidence(field.value, 2048).omittedBytes ?? 0),
              omittedBytesExact: false,
            }
          : field;
      }
    }
    for (const action of actions) {
      if (jsonBytes(action) > 2048) action.context = { state: "record_budget_omitted" };
      if (jsonBytes(action) > 2048) {
        action.name = textEvidence(action.name.value ?? "", 256);
        action.target = textEvidence(action.target.value ?? "", 256);
      }
    }
    const r = keep(requests),
      a = keep(actions);
    removed.window += requests.length + actions.length - r.length - a.length;
    requests = r;
    actions = a;
    const evictRequest = () => {
      const index = requests.findIndex((r) => r.result === "success");
      requests.splice(index < 0 ? 0 : index, 1);
    };
    while (requests.length > limits.entries) {
      evictRequest();
      removed.capacity++;
    }
    while (jsonBytes(requests) > limits.bytes && requests.length) {
      evictRequest();
      removed.bytes++;
    }
    for (const [id, ref] of responseRefs) {
      if (!requests.some((r) => r.localId === id)) {
        const response = ref.deref();
        if (response && responseRecords.get(response) === id)
          responseRecords.delete(response);
        responseRefs.delete(id);
      }
    }
    while (
      (actions.length > limits.actions || jsonBytes(actions) > limits.actionBytes) &&
      actions.length
    ) {
      actions.shift();
      removed.capacity++;
    }
  };
  const active = () => {
    reset();
    return alive && enabled && !!runtime && !!page;
  };
  const current = (record: RequestRecord) =>
    active() && record.pageViewId === pageId && requests.includes(record);
  const begin = (
    method: string,
    url: string,
    binding: RequestAssociation,
    body: unknown,
    headers: unknown,
    source: string,
  ) => {
    if (!active() || !runtime) return;
    prune();
    if (requests.filter((r) => r.result === "pending").length >= 4) {
      removed.capacity++;
      return;
    }
    const absolute = new URL(url, runtime.window.location.href);
    if (
      (endpoint &&
        absolute.origin + absolute.pathname ===
          new URL(endpoint).origin + new URL(endpoint).pathname) ||
      excluded.has(absolute.pathname) ||
      (options.routeAllowed && !options.routeAllowed(absolute.pathname)) ||
      source !== "application"
    ) {
      removed.excluded++;
      return;
    }
    // Files/FormData/streams are never read. Explicit source=upload excludes the whole record.
    const record: RequestRecord = {
      kind: "request",
      relativeMs: -60000,
      localId: `local_${++sequence}`,
      sequence,
      timestamp: runtime.now(),
      appId,
      pageViewId: pageId,
      pageUrl: textEvidence(runtime.window.location.href, 2048),
      method: method.slice(0, 32),
      url: textEvidence(absolute.href, 4096),
      result: "pending",
      association: { ...binding },
      basis: "temporal",
      requestBody:
        typeof body === "string"
          ? textEvidence(body)
          : unavailable(
              body === requestStream
                ? "request_stream_not_read"
                : body == null
                  ? "not_provided"
                  : "binary_file_form_or_stream",
            ),
      requestHeaders: headersEvidence(headers),
      responseBody: unavailable("pending"),
      responseHeaders: unavailable("pending"),
    };
    requests.push(record);
    prune();
    return record;
  };
  const finish = (
    localId: string | undefined,
    response: Response | undefined,
    error?: unknown,
  ) =>
    safe(() => {
      const record = requests.find((r) => r.localId === localId);
      if (!record || !current(record) || !runtime) return;
      record.endedAt = runtime.now();
      record.durationMs = Math.max(0, record.endedAt - record.timestamp);
      if (!response) {
        let name =
          data(error, "name") ??
          (error instanceof Error
            ? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error), "name")
                ?.value
            : undefined);
        if (!name && typeof DOMException !== "undefined") {
          try {
            name = Object.getOwnPropertyDescriptor(
              DOMException.prototype,
              "name",
            )?.get?.call(error);
          } catch {
            /* non-native error */
          }
        }
        record.result =
          name === "AbortError"
            ? "aborted"
            : name === "TimeoutError"
              ? "timeout"
              : "network";
        const message = data(error, "message");
        record.failureReason =
          typeof message === "string"
            ? textEvidence(message, 1024)
            : unavailable("unreadable_error");
        record.responseBody = unavailable("unavailable");
        record.responseHeaders = unavailable("unavailable");
      } else {
        // Native getters are brand checked and cannot invoke an overridden business getter.
        const native = (key: string) =>
          Object.getOwnPropertyDescriptor(Response.prototype, key)!.get!.call(response);
        record.status = native("status") as number;
        record.result =
          record.status === 0 ? "opaque" : record.status >= 400 ? "http" : "success";
        record.responseHeaders =
          record.result === "opaque"
            ? unavailable("opaque_cors")
            : headersEvidence(native("headers"));
        record.responseUrl =
          record.result === "opaque"
            ? unavailable("opaque_cors")
            : textEvidence(native("url") as string, 4096);
        record.redirected = native("redirected") as boolean;
        const route = new URL(record.url.value!, runtime.window.location.href).pathname;
        const collect = record.result !== "success" || successRoutes.has(route);
        // Fetch exposes a tee-able stream, not a bounded immutable byte buffer. Even a
        // small/untrusted Content-Length cannot bound tee buffering. Never clone/read it.
        const contentType =
          Headers.prototype.get.call(native("headers"), "content-type") ?? "";
        record.responseBody = unavailable(
          record.result === "opaque"
            ? "opaque_cors"
            : /text\/event-stream|ndjson/i.test(contentType)
              ? "stream_not_read"
              : contentType &&
                  !/text\/|json|xml|javascript|x-www-form-urlencoded/i.test(contentType)
                ? "binary_not_read"
                : !collect
                  ? "success_body_disabled"
                  : "host_text_required",
        );
      }
      prune();
    });
  function bind(context: RequestAssociation = {}) {
    const binding = association(context);
    const boundEpoch = epoch;
    const wrappers = new WeakMap<typeof fetch, Map<string, typeof fetch>>();
    return {
      /** Pass exactly one metrics observer (e.g. quality.observeApi) outside this wrapper. */
      wrapFetch(
        original: typeof fetch,
        source: "application" | "upload" | "sdk" = "application",
      ): typeof fetch {
        const prior = controlledFetches.get(original);
        if (prior?.binding === binding && prior.source === source) return original;
        // Rebinding a known controlled adapter explicitly changes the owner. Unwrap
        // our observation layer so another project's body cannot be copied twice.
        if (prior) original = prior.original;
        const cached = wrappers.get(original)?.get(source);
        if (cached) return cached;
        const wrapped: typeof fetch = function (
          this: unknown,
          ...args: Parameters<typeof fetch>
        ) {
          let localId: string | undefined;
          safe(() => {
            if (boundEpoch !== epoch) return;
            const [input, init] = args;
            let url: string,
              fallbackMethod = "GET",
              fallbackHeaders: unknown,
              fallbackBody: unknown;
            if (typeof input === "string") url = input;
            else if (Object.getPrototypeOf(input) === URL.prototype)
              url = Object.getOwnPropertyDescriptor(URL.prototype, "href")!.get!.call(
                input,
              );
            else {
              // Brand-checked metadata only. Request's body is never cloned or consumed.
              url = Object.getOwnPropertyDescriptor(
                Request.prototype,
                "url",
              )!.get!.call(input);
              fallbackMethod = Object.getOwnPropertyDescriptor(
                Request.prototype,
                "method",
              )!.get!.call(input);
              fallbackBody =
                Object.getOwnPropertyDescriptor(Request.prototype, "body")!.get!.call(
                  input,
                ) === null
                  ? undefined
                  : requestStream;
              fallbackHeaders = Object.getOwnPropertyDescriptor(
                Request.prototype,
                "headers",
              )!.get!.call(input);
            }
            const method = data(init, "method"),
              body = data(init, "body") ?? fallbackBody;
            const proto =
              body && typeof body === "object" ? Object.getPrototypeOf(body) : null;
            const file =
              proto === FormData.prototype ||
              proto === Blob.prototype ||
              proto === ArrayBuffer.prototype;
            localId = begin(
              typeof method === "string" ? method : fallbackMethod,
              url,
              binding,
              body,
              data(init, "headers") ?? fallbackHeaders,
              file ? "upload" : source,
            )?.localId;
          });
          let result: Promise<Response>;
          try {
            result = Reflect.apply(original, this, args);
          } catch (error) {
            finish(localId, undefined, error);
            throw error;
          }
          if (!localId) return result;
          // A derived native Promise preserves the Response/error identities and keeps
          // rejection observable at the application boundary without an orphan observer.
          try {
            return Promise.prototype.then.call(
              result,
              (response: Response) => {
                finish(localId, response);
                safe(() => {
                  if (
                    typeof WeakRef !== "undefined" &&
                    requests.some((r) => r.localId === localId)
                  ) {
                    responseRecords.set(response, localId!);
                    responseRefs.set(localId!, new WeakRef(response));
                  }
                });
                return response;
              },
              (error: unknown) => {
                finish(localId, undefined, error);
                throw error;
              },
            ) as Promise<Response>;
          } catch {
            // A third-party adapter may return a non-native thenable/object.
            // Do not invoke its then getter or let observation change the return.
            return result;
          }
        };
        controlledFetches.set(wrapped, { binding, source, original });
        if (!wrappers.has(original)) wrappers.set(original, new Map());
        wrappers.get(original)!.set(source, wrapped);
        return wrapped;
      },
      action(name: string, target = "", context: unknown = null) {
        safe(() => {
          if (boundEpoch !== epoch || !active() || !runtime) return;
          actions.push({
            kind: "action",
            relativeMs: -60000,
            sequence: ++sequence,
            timestamp: runtime.now(),
            pageViewId: pageId,
            name: textEvidence(name, 512),
            target: textEvidence(target, 512),
            association: { ...binding },
            context: snapshotArguments([context], 1024),
          });
          prune();
        });
      },
      capture(tracker: Tracker, error: unknown, source: ErrorSource = "explicit") {
        if (error && typeof error === "object") errorAssociations.set(error, binding);
        try {
          tracker.captureException(error, source);
        } finally {
          if (error && typeof error === "object") errorAssociations.delete(error);
        }
      },
    };
  }
  const responseRecords = new WeakMap<Response, string>();
  const responseRefs = new Map<string, WeakRef<Response>>();
  /** Supply text the application already read for its own purpose. No extra stream
   * reads, clone, JSON stringify or unbounded background work is performed by SDK. */
  const responseText = (response: Response, text: string, businessFailure = false) =>
    safe(() => {
      const record = requests.find((r) => r.localId === responseRecords.get(response));
      if (!record || !current(record) || typeof text !== "string" || !runtime) return;
      if (businessFailure) {
        record.result = "business";
      }
      const collect =
        record.result !== "success" ||
        successRoutes.has(
          new URL(record.url.value!, runtime.window.location.href).pathname,
        );
      if (
        collect &&
        !["opaque_cors", "stream_not_read", "binary_not_read"].includes(
          record.responseBody.state,
        )
      ) {
        record.responseBody = textEvidence(text);
        record.bodyCapturedAt = runtime.now();
      }
      prune();
    });
  const errorDiagnostics: ErrorExtractor = function (
    this: object,
    value,
    source,
    occurrence,
  ) {
    if (this !== owner) return extract.call(this, value, source, occurrence);
    prune();
    const at = runtime?.now() ?? 0;
    const binding =
      value && typeof value === "object" ? errorAssociations.get(value) : undefined;
    const frozen = JSON.parse(JSON.stringify({ requests, actions, removed })) as {
      requests: RequestRecord[];
      actions: ActionRecord[];
      removed: typeof removed;
    };
    const result = extract.call(this, value, source, occurrence);
    if (!result) return null;
    const d = result.diagnostic;
    const records = frozen.requests.map((r) => ({
      ...r,
      relativeMs: r.timestamp - at,
      requestBody:
        r.result === "success" &&
        !successRoutes.has(
          new URL(r.url.value!, runtime!.window.location.href).pathname,
        )
          ? unavailable("success_body_disabled")
          : r.requestBody,
      basis:
        binding &&
        ["requestId", "traceId", "operationInstanceId", "workflowInstanceId"].some(
          (k) =>
            binding[k as keyof RequestAssociation] &&
            binding[k as keyof RequestAssociation] ===
              r.association[k as keyof RequestAssociation],
        ) &&
        assocKeys.every(
          (k) => !binding[k] || !r.association[k] || binding[k] === r.association[k],
        )
          ? "explicit"
          : "temporal",
    }));
    const timeline = frozen.actions.map((a) => ({
      ...a,
      relativeMs: a.timestamp - at,
    }));
    const meta = {
      state: !alive || !enabled ? "not_enabled" : records.length ? "captured" : "empty",
      capturedAt: at,
      pendingPolicy: "freeze_at_exception",
      limits: { ...limits },
      removed: frozen.removed,
      envelopeOmitted: 0,
      count: records.length,
      bytes: jsonBytes(records),
      association: binding ?? {},
    };
    d.raw.requests = records;
    d.raw.timeline = timeline;
    d.raw.requestCapture = meta;
    d.policyVersion = "d3-1";
    // Reserve core error/compiled stack first, then failures, then recent console.
    const logs = d.raw.console as unknown[] | undefined;
    while (jsonBytes(d) > 65024 && logs?.length) {
      logs.shift();
      meta.envelopeOmitted++;
    }
    while (jsonBytes(d) > 65024 && timeline.length) {
      timeline.shift();
      meta.envelopeOmitted++;
    }
    while (jsonBytes(d) > 65024 && records.length) {
      const i = records.findIndex((r) => r.result === "success");
      records.splice(i < 0 ? 0 : i, 1);
      meta.envelopeOmitted++;
    }
    meta.count = records.length;
    meta.bytes = jsonBytes(records);
    const cm = d.raw.consoleCapture as Record<string, unknown> | undefined;
    if (cm && logs) {
      cm.count = logs.length;
      cm.bytes = jsonBytes(logs);
    }
    if (
      records.some((r) =>
        [
          r.requestBody,
          r.responseBody,
          r.requestHeaders,
          r.responseHeaders,
          r.url,
        ].some((f) => f.state === "truncated"),
      ) ||
      meta.envelopeOmitted ||
      Object.values(meta.removed).some(Boolean)
    )
      d.status = "truncated";
    return result;
  };
  let stop: (() => void) | undefined;
  errorDiagnostics.start = (rt, getPage, scope) => {
    // An adapter is a scope handle: reuse across trackers fails closed, never rebinds.
    if (alive && owner !== scope) return () => {};
    stop?.();
    epoch++;
    owner = scope;
    runtime = rt;
    page = getPage;
    alive = data(scope, "appId") === appId;
    endpoint =
      typeof data(scope, "endpoint") === "string"
        ? (data(scope, "endpoint") as string)
        : "";
    reset();
    const consoleStop = extract.start?.(rt, getPage, scope);
    stop = () => {
      alive = false;
      for (const ref of responseRefs.values()) {
        const response = ref.deref();
        if (response) responseRecords.delete(response);
      }
      responseRefs.clear();
      requests = [];
      actions = [];
      consoleStop?.();
      runtime = undefined;
      page = undefined;
    };
    return stop;
  };
  return {
    errorDiagnostics,
    bind,
    responseText,
    stats: () => {
      prune();
      return {
        requests: requests.length,
        bytes: jsonBytes(requests),
        actions: actions.length,
        actionBytes: jsonBytes(actions),
        responseAssociations: responseRefs.size,
        activeReads: 0,
        pendingReads: 0,
        removed: { ...removed },
      };
    },
  };
}
