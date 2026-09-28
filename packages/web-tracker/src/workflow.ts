import type {
  EventPayload,
  InteractionType,
  OperationHandle,
  TrackerRuntime,
} from "./types.js";

export interface WorkflowDefinition {
  workflowKey: string;
  version: number;
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
export type WorkflowState = "started" | "completed" | "failed" | "canceled" | "expired";
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
  getState(): WorkflowState;
}
export interface WorkflowHost {
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
    getState: () => "expired" as const,
  });
}
/** Explicit instance engine. Adapter listeners never infer a target from session or key. */
export class WorkflowRuntime {
  private readonly active = new Map<string, { expire(): void; startedAt: number }>();
  private destroyed = false;
  constructor(
    private readonly host: WorkflowHost,
    private readonly definitions: readonly WorkflowDefinition[],
  ) {}
  start(workflowKey: string): WorkflowHandle {
    try {
      const now = this.host.runtime.now();
      for (const value of this.active.values())
        if (now - value.startedAt > 604800000) value.expire();
      const configured = this.definitions.find((d) => d.workflowKey === workflowKey);
      if (this.destroyed || !configured) return this.reject("WORKFLOW_NOT_CONFIGURED");
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
      const instance = `wf_${this.host.runtime.crypto.randomUUID().replaceAll("-", "")}`;
      const association: EventPayload = {
        workflowInstanceId: instance,
        workflowKey,
        workflowDefinitionVersion: definition.version,
      };
      let state: WorkflowState = "started";
      let operations = 0;
      const reached = new Set<string>();
      const cleanup = new Set<() => void>();
      const release = () => {
        for (const stop of [...cleanup]) stop();
        cleanup.clear();
        this.active.delete(instance);
      };
      const expire = () => {
        if (state === "started") {
          state = "expired";
          release();
        }
      };
      const current = () => {
        if (
          this.destroyed ||
          this.host.session() !== session ||
          this.host.runtime.now() >= now + definition.timeoutSeconds * 1000
        )
          expire();
        return state === "started";
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
          reached.add(key);
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
      this.active.set(instance, { expire, startedAt: now });
      const timer = this.host.runtime.setTimeout(
        expire,
        definition.timeoutSeconds * 1000,
      );
      cleanup.add(() => this.host.runtime.clearTimeout(timer));
      this.host.emit("workflow_started", association);
      return Object.freeze({
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
