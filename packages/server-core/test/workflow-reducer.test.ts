import { describe, it, expect } from "vitest";
import {
  reduceWorkflowInstances,
  summarizeWorkflowCohort,
  type WorkflowFactEvent,
} from "../src/workflow-reducer.js";
import type { WorkflowFactDefinition } from "../src/workflow-definitions.js";
const definition: WorkflowFactDefinition = {
  id: "w",
  versionId: "v1",
  version: 1,
  workflowKey: "download",
  moduleId: "m",
  name: "Download",
  status: "active",
  objectStatus: "active",
  archived: false,
  startPolicy: "explicit_sdk",
  effectiveFrom: "1970-01-01T00:00:00Z",
  effectiveTo: null,
  timeoutSeconds: 10,
  steps: [
    {
      stepKey: "requested",
      stepOrder: 1,
      name: "Requested",
      triggerKind: "explicit_sdk",
      triggerConfig: {},
    },
    {
      stepKey: "done",
      stepOrder: 2,
      name: "Done",
      triggerKind: "explicit_sdk",
      triggerConfig: {},
    },
  ],
  terminalPolicy: {
    completedStepKey: "done",
    failedStepKey: null,
    canceledStepKey: null,
    timeoutState: "approximate_abandoned",
  },
};
function event(
  name: string,
  timestamp: number,
  extra: Partial<WorkflowFactEvent> = {},
): WorkflowFactEvent {
  return {
    eventId: `${name}-${timestamp}`,
    name,
    timestamp,
    receivedAt: timestamp,
    workflowInstanceId: "wf1",
    workflowKey: "download",
    version: 1,
    sessionId: "s1",
    identified: true,
    ...extra,
  };
}
const success = (start: number, duration: number, id = "wf1") =>
  [
    event("workflow_started", start),
    event("workflow_step_reached", start + 1, { stepKey: "requested", stepOrder: 1 }),
    event("workflow_step_reached", start + duration, { stepKey: "done", stepOrder: 2 }),
    event("workflow_completed", start + duration),
  ].map((e) => ({ ...e, eventId: id + e.eventId, workflowInstanceId: id }));
describe("R4-B immutable instance facts", () => {
  it("uses event-time first terminal, reports conflicts and remains replay/order invariant", () => {
    const events = [...success(1000, 4000), event("workflow_failed", 5200)];
    const a = reduceWorkflowInstances(events, [definition], 6000),
      b = reduceWorkflowInstances([...events].reverse(), [definition], 6000);
    expect(a).toEqual(b);
    expect(a.instances[0]).toMatchObject({
      state: "completed",
      durationMs: 4000,
      reasons: ["WORKFLOW_TERMINAL_CONFLICT"],
    });
  });
  it("does not manufacture a first terminal for equal-time conflicting outcomes", () => {
    expect(
      reduceWorkflowInstances(
        [...success(1000, 4000), event("workflow_failed", 5000)],
        [definition],
        6000,
      ).instances[0],
    ).toMatchObject({ state: "unresolved", durationMs: null });
  });
  it("deduplicates replay and repeated steps; rejects missing start, context and invalid step", () => {
    const events = success(1000, 4000);
    expect(
      reduceWorkflowInstances([...events, ...events], [definition], 6000).instances,
    ).toHaveLength(1);
    expect(
      reduceWorkflowInstances(events.slice(1), [definition], 6000).rejected,
    ).toEqual({ WORKFLOW_START_MISSING: 1 });
    expect(
      reduceWorkflowInstances(
        [...events, event("workflow_failed", 5500, { sessionId: "other" })],
        [definition],
        6000,
      ).instances[0]?.state,
    ).toBe("unresolved");
    expect(
      reduceWorkflowInstances(
        [
          ...events,
          event("workflow_step_reached", 2000, { stepKey: "unknown", stepOrder: 3 }),
        ],
        [definition],
        6000,
      ).instances[0]?.state,
    ).toBe("unresolved");
  });
  it("uses half-open start cohort, not incompatible terminal-window numerator", () => {
    const result = reduceWorkflowInstances(
      [...success(1000, 4000), ...success(2000, 1000, "wf2")],
      [definition],
      6000,
    );
    expect(
      summarizeWorkflowCohort(result.instances, definition, 2000, 5000),
    ).toMatchObject({ started: 1, completed: 1, successRate: 1 });
    expect(
      summarizeWorkflowCohort(result.instances, definition, 3000, 5000),
    ).toMatchObject({ started: 0, completed: 0, successRate: null });
  });
  it("derives timeout at exact boundary; delayed real terminal supersedes approximation only after receipt asOf", () => {
    const events = [
      event("workflow_started", 1000),
      event("workflow_canceled", 5000, { receivedAt: 15000 }),
    ];
    expect(
      reduceWorkflowInstances(events, [definition], 10999).instances[0]?.state,
    ).toBe("started");
    expect(
      reduceWorkflowInstances(events, [definition], 11000).instances[0]?.state,
    ).toBe("approximate_abandoned");
    expect(
      reduceWorkflowInstances(events, [definition], 15000).instances[0]?.state,
    ).toBe("canceled");
  });
  it("matches explicit operation instance, key and first terminal evidence", () => {
    const d = structuredClone(definition);
    d.steps[1]!.triggerKind = "operation_terminal";
    d.steps[1]!.triggerConfig = { operationKey: "download", state: "succeeded" };
    const events = success(1000, 4000);
    events[2]!.operationInstanceId = "op1";
    expect(reduceWorkflowInstances(events, [d], 6000).instances[0]?.state).toBe(
      "unresolved",
    );
    events.push(
      event("feature_started", 2000, {
        operationKey: "download",
        operationInstanceId: "op1",
      }),
      event("feature_succeeded", 5000, {
        operationKey: "download",
        operationInstanceId: "op1",
      }),
    );
    expect(reduceWorkflowInstances(events, [d], 6000).instances[0]?.state).toBe(
      "completed",
    );
    events.at(-1)!.operationInstanceId = "op2";
    expect(reduceWorkflowInstances(events, [d], 6000).instances[0]?.state).toBe(
      "unresolved",
    );
  });
  it("computes ordinary P50/P90/P75/P99 by linear interpolation, independent of score weighting", () => {
    const events = [
      ...success(1000, 10000, "a"),
      ...success(1000, 100000, "b"),
      ...success(1000, 60000, "c"),
    ];
    const result = summarizeWorkflowCohort(
      reduceWorkflowInstances(events, [definition], 110000).instances,
      definition,
      1000,
      1001,
    );
    expect(result.task_duration).toMatchObject({
      p50: 60000,
      p90: 92000,
      p75: 80000,
      p99: 99200,
      sample: 3,
      algorithm: "linear_interpolation",
    });
    expect(result.stages[1]).toMatchObject({ reached: 3, rate: 1, adjacentDropoff: 0 });
  });
});
