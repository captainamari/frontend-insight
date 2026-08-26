import type { WorkflowStepInput, WorkflowTerminalPolicy } from "./model.js";

const uuidSegment =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integerSegment = /^\d+$/;
const opaqueHexSegment = /^[0-9a-f]{16,}$/i;
const opaqueMixedSegment = /^(?=.*[a-z])(?=.*\d)[a-z0-9_-]{20,}$/i;
const parameterSegment = /^:[a-z][a-z0-9_]{0,63}$/i;

export interface NormalizedPageRoute {
  pageRoute: string;
  replacedSegments: number;
}

export function normalizePageRouteDefinition(input: string): NormalizedPageRoute {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || /[?#]/.test(trimmed)) {
    throw new Error("PAGE_ROUTE_INVALID");
  }
  const collapsed = trimmed.replace(/\/{2,}/g, "/");
  const segments = collapsed.split("/").filter(Boolean);
  let replacedSegments = 0;
  const normalized = segments.map((rawSegment) => {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      throw new Error("PAGE_ROUTE_INVALID");
    }
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      Array.from(segment).some((character) => character.charCodeAt(0) <= 31)
    ) {
      throw new Error("PAGE_ROUTE_INVALID");
    }
    if (parameterSegment.test(segment)) return segment;
    if (
      uuidSegment.test(segment) ||
      integerSegment.test(segment) ||
      opaqueHexSegment.test(segment) ||
      opaqueMixedSegment.test(segment)
    ) {
      replacedSegments += 1;
      return ":id";
    }
    return segment;
  });
  const pageRoute = normalized.length ? `/${normalized.join("/")}` : "/";
  if (pageRoute.length > 512) throw new Error("PAGE_ROUTE_INVALID");
  return { pageRoute, replacedSegments };
}

export function isFragileWorkflowSelector(
  triggerKind: WorkflowStepInput["triggerKind"],
  triggerConfig: WorkflowStepInput["triggerConfig"],
): boolean {
  if (triggerKind !== "selector") return false;
  const selector = String(triggerConfig.selector ?? "").trim();
  return selector.startsWith(".") && !selector.includes("[data-fi-action");
}

export function validateWorkflowDefinition(input: {
  steps: WorkflowStepInput[];
  terminalPolicy: WorkflowTerminalPolicy;
}): void {
  if (input.steps.length < 2 || input.steps.length > 20) {
    throw new Error("WORKFLOW_STEP_COUNT_INVALID");
  }
  const stepKeys = new Set<string>();
  const orders = new Set<number>();
  for (const step of input.steps) {
    if (stepKeys.has(step.stepKey)) throw new Error("WORKFLOW_STEP_KEY_DUPLICATE");
    if (orders.has(step.stepOrder)) throw new Error("WORKFLOW_STEP_ORDER_DUPLICATE");
    stepKeys.add(step.stepKey);
    orders.add(step.stepOrder);
  }
  const expectedOrders = Array.from(
    { length: input.steps.length },
    (_, index) => index + 1,
  );
  if (expectedOrders.some((order) => !orders.has(order))) {
    throw new Error("WORKFLOW_STEP_ORDER_INVALID");
  }
  const terminalKeys = [
    input.terminalPolicy.completedStepKey,
    input.terminalPolicy.failedStepKey,
    input.terminalPolicy.canceledStepKey,
  ].filter((value): value is string => value !== null);
  if (terminalKeys.some((key) => !stepKeys.has(key))) {
    throw new Error("WORKFLOW_TERMINAL_STEP_INVALID");
  }
  if (new Set(terminalKeys).size !== terminalKeys.length) {
    throw new Error("WORKFLOW_TERMINAL_STEP_DUPLICATE");
  }
}
