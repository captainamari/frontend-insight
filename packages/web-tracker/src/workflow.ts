import type {
  EventPayload,
  InteractionType,
  OperationHandle,
  TrackerRuntime,
} from "./types.js";

export interface WorkflowDefinition {
  workflowKey: string;
  version: number;
  startPolicy?: "explicit_sdk" | "first_step";
  canStart?: boolean;
  timeoutSeconds: number;
  steps: readonly {
    stepKey: string;
    stepOrder: number;
    triggerKind:
      | "explicit_sdk"
      | "selector"
      | "network_request"
      | "page_lifecycle"
      | "operation_terminal";
    triggerConfig: Readonly<Record<string, string | boolean>>;
  }[];
  terminalPolicy: {
    completedStepKey: string;
    failedStepKey: string | null;
    canceledStepKey: string | null;
  };
}
export type WorkflowState =
  "pending" | "started" | "completed" | "failed" | "canceled" | "expired";
export interface WorkflowHandle {
  reachStep(stepKey: string): void;
  complete(): void;
  fail(): void;
  cancel(): void;
  startOperation(
    operationKey: string,
    payload?: EventPayload,
    interactionType?: InteractionType,
  ): OperationHandle;
  /** Bind a selector to this instance's explicit root; no global DOM scanning. */
  bindInteractions(root: Element): () => void;
  /** Opt-in wrapper: business success predicate is mandatory; response stays in the host. */
  observeNetwork<T>(
    stepKey: string,
    request: { method: string; pathPattern: string },
    execute: () => Promise<T>,
    accepted: (response: T) => boolean,
  ): Promise<T>;
  /** Explicit host lifecycle target; event.detail and DOM content are never read. */
  bindPageLifecycle(target: EventTarget): () => void;
  getState(): WorkflowState;
}
interface SavedWorkflow {
  instance: string;
  workflowKey: string;
  version: number;
  session: string;
  startedAt: number;
  reached: string[];
  pending: boolean;
}
export interface WorkflowHost {
  persistence?: { read(): unknown; write(value: SavedWorkflow[]): void };
  runtime: TrackerRuntime;
  session(): string;
  emit(name: string, control: EventPayload): void;
  operation(
    key: string,
    payload: EventPayload,
    interaction: InteractionType,
    association: EventPayload,
    onTerminal: (state: string, operationInstanceId: string) => void,
  ): OperationHandle;
  warn(code: string): void;
}
const noopOperation = (): OperationHandle => ({
  succeed() {},
  fail() {},
  cancel() {},
  getState: () => "started",
});
export function noopWorkflow(): WorkflowHandle {
  return Object.freeze({
    reachStep() {},
    complete() {},
    fail() {},
    cancel() {},
    startOperation: noopOperation,
    bindInteractions: () => () => {},
    bindPageLifecycle: () => () => {},
    observeNetwork: <T>(_key: string, _request: unknown, execute: () => Promise<T>) =>
      execute(),
    getState: () => "expired" as const,
  });
}
/** Explicit instance engine. Adapter listeners never infer a target from session or key. */
export class WorkflowRuntime {
  private readonly active = new Map<
    string,
    {
      expire(): void;
      startedAt: number;
      snapshot(): SavedWorkflow;
      handle?: WorkflowHandle;
    }
  >();
  private destroyed = false;
  constructor(
    private readonly host: WorkflowHost,
    private readonly definitions: readonly WorkflowDefinition[],
  ) {
    try {
      const saved = host.persistence?.read();
      if (Array.isArray(saved) && saved.length <= 32)
        for (const item of saved) {
          if (
            !item ||
            typeof item !== "object" ||
            typeof item.instance !== "string" ||
            !/^wf_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(item.instance) ||
            typeof item.workflowKey !== "string" ||
            !Number.isSafeInteger(item.version) ||
            !Number.isSafeInteger(item.startedAt) ||
            typeof item.pending !== "boolean" ||
            !Array.isArray(item.reached) ||
            item.reached.length > 20 ||
            !item.reached.every((k: unknown) => typeof k === "string") ||
            item.session !== host.session()
          )
            continue;
          this.create(item.workflowKey, item as SavedWorkflow);
        }
    } catch {
      host.warn("WORKFLOW_STORAGE_UNAVAILABLE");
    }
  }
  handles(workflowKey: string): readonly WorkflowHandle[] {
    return [...this.active.values()]
      .filter((v) => v.snapshot().workflowKey === workflowKey)
      .flatMap((v) => (v.handle ? [v.handle] : []));
  }
  private persist() {
    try {
      this.host.persistence?.write([...this.active.values()].map((v) => v.snapshot()));
    } catch {
      this.host.warn("WORKFLOW_STORAGE_UNAVAILABLE");
    }
  }
  start(workflowKey: string): WorkflowHandle {
    return this.create(workflowKey);
  }
  private create(workflowKey: string, saved?: SavedWorkflow): WorkflowHandle {
    try {
      const now = this.host.runtime.now();
      for (const value of this.active.values())
        if (now - value.startedAt > 604800000) value.expire();
      const configured = this.definitions.find(
        (d) =>
          d.workflowKey === workflowKey &&
          (saved ? d.version === saved.version : d.canStart !== false),
      );
      if (this.destroyed || !configured) return this.reject("WORKFLOW_NOT_CONFIGURED");
      if (saved && this.active.has(saved.instance))
        return this.reject("WORKFLOW_RESTORE_DUPLICATE");
      if (this.active.size >= 32) return this.reject("WORKFLOW_INSTANCE_LIMIT");
      const definition = structuredClone(configured);
      if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(workflowKey) ||
        !Number.isSafeInteger(definition.version) ||
        definition.version < 1 ||
        !Number.isFinite(definition.timeoutSeconds) ||
        definition.timeoutSeconds <= 0 ||
        definition.timeoutSeconds > 604800 ||
        definition.steps.length < 2 ||
        definition.steps.length > 20 ||
        definition.steps.some(
          (s, i) => s.stepOrder !== i + 1 || !/^[a-z][a-z0-9_]{0,63}$/.test(s.stepKey),
        ) ||
        new Set(definition.steps.map((s) => s.stepKey)).size !==
          definition.steps.length ||
        !definition.steps.some(
          (s) => s.stepKey === definition.terminalPolicy.completedStepKey,
        )
      )
        return this.reject("WORKFLOW_CONFIG_INVALID");
      const session = this.host.session();
      if (
        saved &&
        (saved.startedAt > now ||
          now >= saved.startedAt + definition.timeoutSeconds * 1000 ||
          saved.reached.some((k) => !definition.steps.some((s) => s.stepKey === k)))
      )
        return this.reject("WORKFLOW_RESTORE_EXPIRED_OR_INVALID");
      const instance =
        saved?.instance ??
        `wf_${this.host.runtime.crypto.randomUUID().replaceAll("-", "")}`;
      const association: EventPayload = {
        workflowInstanceId: instance,
        workflowKey,
        workflowDefinitionVersion: definition.version,
      };
      let state: WorkflowState = (
        saved ? saved.pending : definition.startPolicy === "first_step"
      )
        ? "pending"
        : "started";
      let startedAt = saved?.startedAt ?? now;
      let operations = 0;
      const reached = new Set<string>(saved?.reached ?? []);
      const cleanup = new Set<() => void>();
      const release = () => {
        for (const stop of [...cleanup]) stop();
        cleanup.clear();
        this.active.delete(instance);
        this.persist();
      };
      const expire = () => {
        if (state === "started" || state === "pending") {
          state = "expired";
          release();
        }
      };
      const current = () => {
        if (
          this.destroyed ||
          this.host.session() !== session ||
          this.host.runtime.now() >= startedAt + definition.timeoutSeconds * 1000
        )
          expire();
        return state === "started" || state === "pending";
      };
      const safe = (action: () => void) => {
        try {
          if (current()) action();
        } catch {
          this.host.warn("WORKFLOW_ADAPTER_ERROR");
        }
      };
      const finish = (next: "completed" | "failed" | "canceled") =>
        safe(() => {
          if (
            next === "completed" &&
            !reached.has(definition.terminalPolicy.completedStepKey)
          ) {
            this.host.warn("WORKFLOW_SUCCESS_STEP_REQUIRED");
            return;
          }
          if (state === "pending") {
            state = next;
            release();
            return;
          }
          state = next;
          this.host.emit(`workflow_${next}`, association);
          release();
        });
      const reach = (
        key: string,
        kind: WorkflowDefinition["steps"][number]["triggerKind"],
        operationInstanceId?: string,
      ) =>
        safe(() => {
          const step = definition.steps.find((s) => s.stepKey === key);
          if (!step || step.triggerKind !== kind) {
            this.host.warn("WORKFLOW_STEP_TRIGGER_MISMATCH");
            return;
          }
          if (reached.has(key)) return;
          if (state === "pending") {
            if (step.stepOrder !== 1) {
              this.host.warn("WORKFLOW_FIRST_STEP_REQUIRED");
              return;
            }
            startedAt = this.host.runtime.now();
            record.startedAt = startedAt;
            state = "started";
            this.host.runtime.clearTimeout(timer);
            timer = this.host.runtime.setTimeout(
              expire,
              definition.timeoutSeconds * 1000,
            );
            if (state === "started") this.host.emit("workflow_started", association);
          }
          reached.add(key);
          this.persist();
          this.host.emit("workflow_step_reached", {
            ...association,
            workflowStepKey: key,
            workflowStepOrder: step.stepOrder,
            ...(operationInstanceId ? { operationInstanceId } : {}),
          });
          if (key === definition.terminalPolicy.completedStepKey) finish("completed");
          else if (key === definition.terminalPolicy.failedStepKey) finish("failed");
          else if (key === definition.terminalPolicy.canceledStepKey)
            finish("canceled");
        });
      const record: {
        expire(): void;
        startedAt: number;
        snapshot(): SavedWorkflow;
        handle?: WorkflowHandle;
      } = {
        expire,
        startedAt,
        snapshot: () => ({
          instance,
          workflowKey,
          version: definition.version,
          session,
          startedAt,
          reached: [...reached],
          pending: state === "pending",
        }),
      };
      this.active.set(instance, record);
      let timer = this.host.runtime.setTimeout(
        expire,
        Math.max(0, startedAt + definition.timeoutSeconds * 1000 - now),
      );
      cleanup.add(() => this.host.runtime.clearTimeout(timer));
      if (!saved && state === "started")
        this.host.emit("workflow_started", association);
      const handle: WorkflowHandle = Object.freeze({
        reachStep: (key: string) => reach(key, "explicit_sdk"),
        complete: () => finish("completed"),
        fail: () => finish("failed"),
        cancel: () => finish("canceled"),
        getState: () => {
          current();
          return state;
        },
        startOperation: (
          key: string,
          payload: EventPayload = {},
          interaction: InteractionType = "programmatic",
        ) => {
          try {
            if (!current() || operations >= 32) {
              this.host.warn("WORKFLOW_OPERATION_LIMIT_OR_CLOSED");
              return noopOperation();
            }
            operations++;
            return this.host.operation(
              key,
              payload,
              interaction,
              association,
              (terminal, operationInstanceId) =>
                safe(() => {
                  operations--;
                  for (const step of definition.steps)
                    if (
                      step.triggerKind === "operation_terminal" &&
                      step.triggerConfig.operationKey === key &&
                      step.triggerConfig.state === terminal
                    )
                      reach(step.stepKey, "operation_terminal", operationInstanceId);
                }),
            );
          } catch {
            this.host.warn("WORKFLOW_OPERATION_ERROR");
            return noopOperation();
          }
        },
        observeNetwork: async <T>(
          stepKey: string,
          request: { method: string; pathPattern: string },
          execute: () => Promise<T>,
          accepted: (response: T) => boolean,
        ): Promise<T> => {
          // Execute exactly once, preserve rejection and the original result; no fetch patch.
          const result = await execute();
          safe(() => {
            const step = definition.steps.find((s) => s.stepKey === stepKey);
            if (
              !step ||
              step.triggerKind !== "network_request" ||
              step.triggerConfig.method !== request.method ||
              step.triggerConfig.pathPattern !== request.pathPattern ||
              !/^\/[^?#]*$/.test(request.pathPattern)
            ) {
              this.host.warn("WORKFLOW_NETWORK_CONFIG_MISMATCH");
              return;
            }
            if (accepted(result) === true) reach(stepKey, "network_request");
          });
          return result;
        },
        bindPageLifecycle: (target: EventTarget) => {
          const stops: (() => void)[] = [];
          safe(() => {
            for (const event of ["loaded", "refreshed"] as const) {
              const listener = () =>
                safe(() => {
                  for (const step of definition.steps)
                    if (
                      step.triggerKind === "page_lifecycle" &&
                      step.triggerConfig.event === event
                    )
                      reach(step.stepKey, "page_lifecycle");
                });
              const name = `fi:page-${event}`;
              target.addEventListener(name, listener);
              const stop = () => target.removeEventListener(name, listener);
              stops.push(stop);
              cleanup.add(stop);
            }
          });
          return () => {
            for (const stop of stops) {
              stop();
              cleanup.delete(stop);
            }
          };
        },
        bindInteractions: (root: Element) => {
          const stops: (() => void)[] = [];
          safe(() => {
            for (const event of ["click", "change"] as const) {
              const listener = (e: Event) =>
                safe(() => {
                  for (const step of definition.steps) {
                    if (
                      step.triggerKind !== "selector" ||
                      step.triggerConfig.event !== event
                    )
                      continue;
                    const selector = String(step.triggerConfig.selector);
                    if (
                      !/^(#[A-Za-z][\w-]*|\[data-fi-action=['"][a-z][a-z0-9_-]*['"]\])$/.test(
                        selector,
                      )
                    ) {
                      this.host.warn("WORKFLOW_SELECTOR_UNSAFE");
                      continue;
                    }
                    const target = e.target as Element | null;
                    const match = target?.closest?.(selector);
                    if (match && root.contains(match)) reach(step.stepKey, "selector");
                  }
                });
              root.addEventListener(event, listener);
              const stop = () => root.removeEventListener(event, listener);
              stops.push(stop);
              cleanup.add(stop);
            }
          });
          return () => {
            for (const stop of stops) {
              stop();
              cleanup.delete(stop);
            }
          };
        },
      });
      record.handle = handle;
      this.persist();
      return handle;
    } catch {
      return this.reject("WORKFLOW_INTERNAL_ERROR");
    }
  }
  destroy() {
    this.destroyed = true;
    for (const v of this.active.values()) v.expire();
    this.active.clear();
  }
  private reject(code: string) {
    this.host.warn(code);
    return noopWorkflow();
  }
}
