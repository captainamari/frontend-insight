import { storageFailureCode } from "../src/clickhouse-logger.js";
import { describe, expect, it, vi } from "vitest";
import { WorkflowFactStore } from "../src/workflow-facts.js";
import type { WorkflowFactDefinition } from "../src/workflow-definitions.js";
import type { BusinessPageWindow } from "../src/business-facts.js";

const from = Date.parse("2026-09-28T01:00:00Z");
const definition: WorkflowFactDefinition = {
  id: "w",
  versionId: "v",
  workflowKey: "task",
  version: 1,
  moduleId: "m",
  name: "Task",
  status: "active",
  objectStatus: "active",
  archived: false,
  startPolicy: "explicit_sdk",
  effectiveFrom: new Date(from - 3600000).toISOString(),
  effectiveTo: null,
  timeoutSeconds: 600,
  terminalPolicy: {
    completedStepKey: "end",
    failedStepKey: null,
    canceledStepKey: null,
    timeoutState: "approximate_abandoned",
  },
  steps: ["start", "end"].map((stepKey, i) => ({
    stepKey,
    stepOrder: i + 1,
    name: stepKey,
    triggerKind: "explicit_sdk",
    triggerConfig: {},
  })),
};
const page = (
  route: string,
  moduleId: string,
  included = true,
): BusinessPageWindow => ({
  pageId: route,
  pageRoute: route,
  name: route,
  moduleId,
  pageRevisionId: route,
  moduleRevisionId: moduleId,
  from: new Date(from - 1800000).toISOString(),
  to: new Date(from + 10000).toISOString(),
  included,
  reason: included ? "INCLUDED" : "PAGE_DISABLED",
});
function store(instanceCount: number) {
  const events = Array.from({ length: instanceCount }, (_, i) =>
    [
      ["workflow_started", 0],
      ["workflow_step_reached", 1, "start", 1],
      ["workflow_step_reached", 1000, "end", 2],
      ["workflow_completed", 1000],
    ].map(([name, delta, stepKey, stepOrder], n) => ({
      projectId: "p",
      eventId: `${i}-${n}`,
      timestampMs: from + Number(delta),
      receivedAt: from + Number(delta),
      sessionId: "s",
      identified: 1,
      identityScope: "internal",
      name,
      workflowInstanceId: `w${i}`,
      workflowKey: "task",
      version: 1,
      stepKey,
      stepOrder,
    })),
  ).flat();
  const paths = [
    ["/a", -1000, "pv1"],
    ["/b", 5, "pv2"],
    ["/a", 10, "pv3"],
    ["/a", 11, "pv3"],
    ["/disabled", 20, "pv4"],
    ["/unknown", 30, "pv5"],
    ["/a", 40, "conflict"],
    ["/b", 41, "conflict"],
    ["/b", 1000, "boundary"],
  ].map(([pageRoute, delta, pageViewId]) => ({
    sessionId: "s",
    pageRoute,
    timestampMs: from + Number(delta),
    pageViewId,
  }));
  const query = vi
    .fn()
    .mockResolvedValueOnce({ json: async () => ({ data: events }) })
    .mockResolvedValueOnce({
      json: async () => ({
        data: [{ projectId: "p", observed: "1", compatible: "1" }],
      }),
    })
    .mockResolvedValueOnce({ json: async () => ({ data: paths }) });
  const reader = Object.create(WorkflowFactStore.prototype) as WorkflowFactStore;
  Object.assign(reader, { client: { query } });
  return { reader, query };
}
describe("R4-B bounded canonical path read model", () => {
  it.each([1, 1000])(
    "hand-counts paths, excludes conflicts and keeps query count constant for %i instances",
    async (n) => {
      const { reader, query } = store(n);
      const result = await reader.read(
        "p",
        "dev",
        new Date(from).toISOString(),
        new Date(from + 2000).toISOString(),
        [definition],
        [],
        [page("/a", "m1"), page("/b", "m2"), page("/disabled", "m3", false)],
        new Date(from + 3000),
      );
      expect(result.evidenceTotal).toBe(n);
      expect(result.evidence).toHaveLength(Math.min(n, 50));
      expect(result.evidence[0]?.path_steps).toMatchObject({
        distinctPages: 2,
        totalSteps: 3,
        backtrackSteps: 1,
        moduleSpan: 2,
        excluded: 2,
        status: "partial",
      });
      expect(result.diagnostics).toMatchObject({
        clickHouseQueries: 3,
        pathPageViewConflicts: 1,
      });
      expect(query).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(result)).not.toContain("internal");
      expect(result.definitions[0]).toMatchObject({
        started: n,
        completed: n,
        successRate: 1,
      });
    },
  );
});

describe("R4-B storage failure diagnostics privacy", () => {
  it.each([
    ["ECONNRESET", "ECONNRESET"],
    ["UND_ERR_SOCKET", "UND_ERR_SOCKET"],
    ["159", "CLICKHOUSE_159"],
    [241, "CLICKHOUSE_241"],
  ])("keeps only bounded transport/storage codes: %s", (code, expected) => {
    expect(storageFailureCode({ code })).toBe(expected);
  });
  it("drops messages, SQL, query, header values and arbitrary error codes", () => {
    const sensitive = "FI_PRIVATE_BODY_QUERY_HEADER_PATH";
    const cause = Object.assign(new Error(sensitive), { code: sensitive });
    expect(storageFailureCode(cause)).toBe("FACT_READ_FAILED");
    expect(storageFailureCode(new RangeError(sensitive))).toBe("INVALID_FACT_VALUE");
    expect(storageFailureCode(new SyntaxError(sensitive))).toBe(
      "INVALID_FACT_RESPONSE",
    );
    expect(storageFailureCode(new TypeError(sensitive))).toBe(
      "FACT_RESPONSE_TYPE_ERROR",
    );
  });
});
