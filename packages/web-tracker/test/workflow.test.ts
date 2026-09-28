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

describe("R4-B opt-in adapters", () => {
  it("requires matching request configuration and explicit business success; preserves host result and rejection", async () => {
    const f = fixture();
    f.definition.steps[1] = {
      stepKey: "received",
      stepOrder: 2,
      triggerKind: "network_request",
      triggerConfig: { method: "POST", pathPattern: "/synthetic/result" },
    };
    const w = f.tracker.startWorkflow("download");
    w.reachStep("requested");
    const response = { status: 200, valid: false, secret: "DO_NOT_COLLECT" };
    expect(
      await w.observeNetwork(
        "received",
        { method: "POST", pathPattern: "/synthetic/result" },
        async () => response,
        (r) => r.valid,
      ),
    ).toBe(response);
    expect(w.getState()).toBe("started");
    await expect(
      w.observeNetwork(
        "received",
        { method: "POST", pathPattern: "/synthetic/result" },
        async () => {
          throw new Error("host failure");
        },
        () => true,
      ),
    ).rejects.toThrow("host failure");
    await w.observeNetwork(
      "received",
      { method: "GET", pathPattern: "/synthetic/result" },
      async () => response,
      () => true,
    );
    expect(w.getState()).toBe("started");
    await w.observeNetwork(
      "received",
      { method: "POST", pathPattern: "/synthetic/result" },
      async () => response,
      () => {
        throw new Error("predicate failure");
      },
    );
    expect(w.getState()).toBe("started");
    await w.observeNetwork(
      "received",
      { method: "POST", pathPattern: "/synthetic/result" },
      async () => response,
      () => true,
    );
    expect(w.getState()).toBe("completed");
    expect(JSON.stringify(await f.events())).not.toContain("DO_NOT_COLLECT");
  });
  it("uses a scoped lifecycle target and removes listeners at terminal", async () => {
    const f = fixture();
    f.definition.steps[1] = {
      stepKey: "received",
      stepOrder: 2,
      triggerKind: "page_lifecycle",
      triggerConfig: { event: "loaded" },
    };
    const w = f.tracker.startWorkflow("download"),
      a = new EventTarget(),
      b = new EventTarget();
    w.reachStep("requested");
    w.bindPageLifecycle(a);
    b.dispatchEvent(new Event("fi:page-loaded"));
    expect(w.getState()).toBe("started");
    a.dispatchEvent(
      new CustomEvent("fi:page-loaded", { detail: { secret: "DO_NOT_COLLECT" } }),
    );
    a.dispatchEvent(new Event("fi:page-loaded"));
    expect(w.getState()).toBe("completed");
    const events = await f.events();
    expect(events.filter((e) => e.payload.name === "workflow_completed")).toHaveLength(
      1,
    );
    expect(JSON.stringify(events)).not.toContain("DO_NOT_COLLECT");
  });
  it("first_step begins at the first configured step rather than handle allocation", async () => {
    const f = fixture();
    f.definition.startPolicy = "first_step";
    const w = f.tracker.startWorkflow("download");
    expect(w.getState()).toBe("pending");
    w.reachStep("received");
    expect(w.getState()).toBe("pending");
    vi.advanceTimersByTime(5000);
    w.reachStep("requested");
    vi.advanceTimersByTime(5001);
    expect(w.getState()).toBe("started");
    w.reachStep("received");
    expect(
      (await f.events()).filter((e) => e.payload.name === "workflow_started"),
    ).toHaveLength(1);
  });
});

describe("R4-B reload persistence", () => {
  it("restores SDK-owned IDs and pinned retired version only in the same live session", async () => {
    const { WorkflowRuntime } = await import("../src/workflow.js");
    const f = fixture();
    let saved: unknown = null,
      session = "controlled-session";
    const emitted: { name: string; control: unknown }[] = [];
    const host = {
      runtime: f.runtime,
      session: () => session,
      emit: (name: string, control: unknown) => emitted.push({ name, control }),
      operation: () => ({
        succeed() {},
        fail() {},
        cancel() {},
        getState: () => "started" as const,
      }),
      warn: vi.fn(),
      persistence: {
        read: () => saved,
        write: (value: unknown) => {
          saved = structuredClone(value);
        },
      },
    };
    const a = new WorkflowRuntime(host, [f.definition]);
    a.start("download").reachStep("requested");
    const retired = { ...f.definition, canStart: false };
    const b = new WorkflowRuntime(host, [retired, { ...f.definition, version: 2 }]);
    expect(b.handles("download")).toHaveLength(1);
    b.handles("download")[0]!.reachStep("received");
    expect(emitted.filter((e) => e.name === "workflow_started")).toHaveLength(1);
    expect(
      emitted.filter((e) => e.name === "workflow_completed")[0]!.control,
    ).toMatchObject({ workflowDefinitionVersion: 1 });
    expect(saved).toEqual([]);
    a.start("download");
    session = "rotated-session";
    const c = new WorkflowRuntime(host, [f.definition]);
    expect(c.handles("download")).toHaveLength(0);
    expect(a.handles("download")[0]!.getState()).toBe("expired");
    a.destroy();
    b.destroy();
    c.destroy();
  });
});

it("records bounded synchronous SDK cost for 2–20 steps and three concurrent instances", async () => {
  const clock = performance.now.bind(performance);
  const f = fixture();
  const results: unknown[] = [];
  for (const stepCount of [2, 20]) {
    const keys = Array.from({ length: stepCount }, (_, i) => `stage_${i + 1}`);
    f.definition.steps = keys.map((stepKey, i) => ({
      stepKey,
      stepOrder: i + 1,
      triggerKind: "explicit_sdk" as const,
      triggerConfig: {},
    }));
    f.definition.terminalPolicy.completedStepKey = keys.at(-1)!;
    for (const concurrency of [1, 3]) {
      const rawMs: number[] = [];
      for (let i = 0; i < 110; i++) {
        const start = clock();
        const workflows = Array.from({ length: concurrency }, () =>
          f.tracker.startWorkflow("download"),
        );
        for (const key of keys) for (const w of workflows) w.reachStep(key);
        const elapsed = clock() - start;
        if (i >= 10) rawMs.push(elapsed);
        expect(workflows.every((w) => w.getState() === "completed")).toBe(true);
        await f.tracker.flush();
      }
      const p95 = [...rawMs].sort((a, b) => a - b)[Math.ceil(rawMs.length * 0.95) - 1]!;
      expect(p95).toBeLessThan(16);
      results.push({
        steps: stepCount,
        concurrency,
        warmup: 10,
        sampleCount: rawMs.length,
        rawMs,
        p95,
        budgetMs: 16,
        p95Algorithm: "nearest_rank_ceil_0.95n",
      });
    }
  }
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/r4b-sdk-synchronous.json",
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA ?? null,
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        measurement:
          "Node/happy-dom synchronous handle+event enqueue only; fetch stub; not browser main-thread production capacity",
        results,
      },
      null,
      2,
    ),
  );
});
