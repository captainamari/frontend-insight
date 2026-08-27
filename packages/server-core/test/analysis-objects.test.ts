import { describe, expect, it } from "vitest";
import {
  isFragileWorkflowSelector,
  normalizePageRouteDefinition,
  validateWorkflowDefinition,
} from "../src/analysis-objects.js";

const validWorkflow = {
  steps: [
    {
      stepKey: "opened",
      name: "打开",
      stepOrder: 1,
      triggerKind: "explicit_sdk" as const,
      triggerConfig: { actionKey: "opened" },
    },
    {
      stepKey: "completed",
      name: "完成",
      stepOrder: 2,
      triggerKind: "operation_terminal" as const,
      triggerConfig: { state: "completed" },
    },
  ],
  terminalPolicy: {
    completedStepKey: "completed",
    failedStepKey: null,
    canceledStepKey: null,
    timeoutState: "approximate_abandoned" as const,
  },
};

describe("R1-A analysis object boundaries", () => {
  it("normalizes dynamic route segments before a page definition is stored", () => {
    expect(
      normalizePageRouteDefinition(
        "/orders/123/items/550e8400-e29b-41d4-a716-446655440000/",
      ),
    ).toEqual({
      pageRoute: "/orders/:id/items/:id",
      replacedSegments: 2,
    });
    expect(normalizePageRouteDefinition("//reports///daily").pageRoute).toBe(
      "/reports/daily",
    );
    expect(normalizePageRouteDefinition("/orders/:orderId").pageRoute).toBe(
      "/orders/:orderId",
    );
  });

  it("rejects query, hash, traversal and malformed encoding", () => {
    for (const route of [
      "/orders?token=secret",
      "/orders#details",
      "/../admin",
      "/orders/%E0%A4%A",
    ]) {
      expect(() => normalizePageRouteDefinition(route)).toThrow("PAGE_ROUTE_INVALID");
    }
  });

  it("requires 2-20 contiguous unique steps and valid distinct terminals", () => {
    expect(() => validateWorkflowDefinition(validWorkflow)).not.toThrow();
    expect(() =>
      validateWorkflowDefinition({
        ...validWorkflow,
        steps: validWorkflow.steps.map((step) => ({ ...step, stepOrder: 2 })),
      }),
    ).toThrow("WORKFLOW_STEP_ORDER_DUPLICATE");
    expect(() =>
      validateWorkflowDefinition({
        ...validWorkflow,
        terminalPolicy: {
          ...validWorkflow.terminalPolicy,
          failedStepKey: "missing",
        },
      }),
    ).toThrow("WORKFLOW_TERMINAL_STEP_INVALID");
  });

  it("marks ordinary class selectors as fragile without rejecting them", () => {
    expect(isFragileWorkflowSelector("selector", { selector: ".download" })).toBe(true);
    expect(
      isFragileWorkflowSelector("selector", {
        selector: '[data-fi-action="download"]',
      }),
    ).toBe(false);
    expect(isFragileWorkflowSelector("explicit_sdk", { actionKey: "download" })).toBe(
      false,
    );
  });
});
