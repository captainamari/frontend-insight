// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTracker,
  type Tracker,
  type TrackerRuntime,
  type WorkflowDefinition,
} from "../src/index.js";
const trackers: Tracker[] = [];
afterEach(() => {
  for (const t of trackers) t.destroy();
  trackers.length = 0;
  vi.useRealTimers();
});
function fixture(operation = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T01:00:00Z"));
  const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
  const runtime: TrackerRuntime = {
    window,
    document,
    navigator: { userAgent: "Chrome", sendBeacon: () => true },
    fetch: fetchMock as typeof fetch,
    crypto: globalThis.crypto,
    now: Date.now,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const definition: WorkflowDefinition = {
    workflowKey: "download",
    version: 1,
    timeoutSeconds: 10,
    steps: [
      {
        stepKey: "requested",
        stepOrder: 1,
        triggerKind: "explicit_sdk",
        triggerConfig: {},
      },
      {
        stepKey: "received",
        stepOrder: 2,
        triggerKind: operation ? "operation_terminal" : "explicit_sdk",
        triggerConfig: operation
          ? { operationKey: "download", state: "succeeded" }
          : {},
      },
    ],
    terminalPolicy: {
      completedStepKey: "received",
      failedStepKey: null,
      canceledStepKey: null,
    },
  };
  const tracker = createTracker({
    appId: `fi_${crypto.randomUUID().slice(0, 8)}`,
    env: "dev",
    release: "test",
    endpoint: "https://collector.test/v1/events",
    runtime,
    registeredFeatures: ["download"],
    workflowDefinitions: [definition],
  });
  trackers.push(tracker);
  return {
    tracker,
    definition,
    runtime,
    async events() {
      await tracker.flush();
      return fetchMock.mock.calls.flatMap(
        (call) =>
          JSON.parse(String((call as unknown as [string, RequestInit])[1].body))
            .events as {
            event: string;
            payload: Record<string, unknown>;
            sessionId: string;
          }[],
      );
    },
  };
}
describe("R4-B explicit SDK instances", () => {
  it("keeps three same-key workflows and operations separate; independent operations do not reach steps", async () => {
    const f = fixture(true),
      w = Array.from({ length: 3 }, () => f.tracker.startWorkflow("download"));
    for (const x of w) x.reachStep("requested");
    const ops = w.map((x) => x.startOperation("download"));
    f.tracker.startOperation("download").succeed();
    expect(w.map((x) => x.getState())).toEqual(["started", "started", "started"]);
    ops[1]!.succeed();
    ops[0]!.fail("rejected");
    ops[2]!.cancel();
    expect(w.map((x) => x.getState())).toEqual(["started", "completed", "started"]);
    const events = await f.events(),
      starts = events.filter((e) => e.payload.name === "workflow_started");
    expect(new Set(starts.map((e) => e.payload.workflowInstanceId)).size).toBe(3);
    const terminals = events.filter((e) => e.payload.name === "workflow_completed");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.payload.workflowInstanceId).toBe(
      starts[1]!.payload.workflowInstanceId,
    );
    const operationEvents = events.filter((e) => e.payload.operationInstanceId);
    expect(
      new Set(operationEvents.map((e) => e.payload.operationInstanceId)).size,
    ).toBe(4);
  });
  it("pins version, deduplicates steps and terminal; no business payload API on workflow", async () => {
    const f = fixture(),
      w = f.tracker.startWorkflow("download");
    f.definition.version = 2;
    w.complete();
    expect(w.getState()).toBe("started");
    w.reachStep("requested");
    w.reachStep("requested");
    w.reachStep("received");
    w.fail();
    w.cancel();
    w.complete();
    const events = (await f.events()).filter((e) =>
      String(e.payload.name).startsWith("workflow_"),
    );
    expect(events.map((e) => e.payload.name)).toEqual([
      "workflow_started",
      "workflow_step_reached",
      "workflow_step_reached",
      "workflow_completed",
    ]);
    expect(events.every((e) => e.payload.workflowDefinitionVersion === 1)).toBe(true);
    expect(events.every((e) => !e.payload.labels)).toBe(true);
  });
  it("does not emit timeout or disconnect as cancellation; TTL cleans handles", async () => {
    const f = fixture(),
      w = f.tracker.startWorkflow("download");
    vi.advanceTimersByTime(9999);
    expect(w.getState()).toBe("started");
    vi.advanceTimersByTime(1);
    expect(w.getState()).toBe("expired");
    w.cancel();
    expect(
      (await f.events()).filter((e) => e.payload.name === "workflow_canceled"),
    ).toHaveLength(0);
  });
  it("limits concurrent workflows and associated operations and isolates invalid calls", () => {
    const f = fixture();
    const ws = Array.from({ length: 33 }, () => f.tracker.startWorkflow("download"));
    expect(ws[32]!.getState()).toBe("expired");
    expect(f.tracker.startWorkflow("customer-email@example.com").getState()).toBe(
      "expired",
    );
    expect(() => ws[0]!.reachStep("unknown")).not.toThrow();
    expect(f.tracker.getDiagnostics().warnings).toContain("WORKFLOW_INSTANCE_LIMIT");
    ws[0]!.cancel();
    expect(f.tracker.startWorkflow("download").getState()).toBe("started");
  });
  it("requires explicit per-instance selector roots and removes listeners", () => {
    const f = fixture();
    f.definition.steps[0] = {
      stepKey: "requested",
      stepOrder: 1,
      triggerKind: "selector",
      triggerConfig: { event: "click", selector: '[data-fi-action="request"]' },
    };
    const a = document.createElement("div"),
      b = document.createElement("div");
    a.innerHTML = b.innerHTML =
      '<button data-fi-action="request">sensitive DOM text</button>';
    const wa = f.tracker.startWorkflow("download"),
      wb = f.tracker.startWorkflow("download");
    wa.bindInteractions(a);
    const stop = wb.bindInteractions(b);
    stop();
    a.querySelector("button")!.click();
    b.querySelector("button")!.click();
    wa.cancel();
    wb.cancel();
    a.querySelector("button")!.click();
    expect(wa.getState()).toBe("canceled");
  });
  it("destroys active handles and never accepts explicit SDK events for an operation trigger", () => {
    const f = fixture(true),
      w = f.tracker.startWorkflow("download");
    w.reachStep("received");
    expect(w.getState()).toBe("started");
    f.tracker.destroy();
    expect(w.getState()).toBe("expired");
    expect(f.tracker.startWorkflow("download").getState()).toBe("expired");
  });
});
