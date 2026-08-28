import { describe, expect, it } from "vitest";
import {
  analysisObjectMutationErrorMessage,
  pageRoutePreview,
  selectorIsFragile,
  triggerConfigKey,
  workflowConditionContext,
  workflowStepPreview,
} from "../src/analysis-objects";

describe("R1-A analysis object presentation", () => {
  it("previews the same common dynamic route normalization as the API", () => {
    expect(pageRoutePreview("/orders/123/items/0123456789abcdef")).toBe(
      "/orders/:id/items/:id",
    );
    expect(pageRoutePreview("/orders?token=secret")).toBeNull();
  });

  it("shows a fragility warning only for ordinary class selectors", () => {
    expect(selectorIsFragile("selector", ".download-button")).toBe(true);
    expect(selectorIsFragile("selector", '[data-fi-action="download"]')).toBe(false);
    expect(triggerConfigKey("explicit_sdk")).toBeNull();
    expect(triggerConfigKey("operation_terminal")).toBe("operationKey");
  });

  it("explains every condition and renders natural-language previews", () => {
    for (const kind of [
      "explicit_sdk",
      "selector",
      "network_request",
      "page_lifecycle",
      "operation_terminal",
    ] as const) {
      expect(workflowConditionContext(kind).subject).not.toBe("");
      expect(workflowConditionContext(kind).timing).not.toBe("");
      expect(workflowConditionContext(kind).cannotInfer).not.toBe("");
    }
    expect(
      workflowStepPreview({
        stepKey: "downloaded",
        triggerKind: "operation_terminal",
        triggerConfig: { operationKey: "model_download", state: "succeeded" },
      }),
    ).toContain("model_download 上报 succeeded");
  });

  it("turns duplicate and request failures into actionable messages", () => {
    expect(
      analysisObjectMutationErrorMessage(
        { status: 409, code: "RESOURCE_CONFLICT", requestId: "request-1" },
        "创建失败：moduleKey 已存在，请使用唯一的 key。",
      ),
    ).toBe("创建失败：moduleKey 已存在，请使用唯一的 key。（request ID：request-1）");
    expect(
      analysisObjectMutationErrorMessage({
        status: 0,
        code: "NETWORK_ERROR",
        requestId: null,
      }),
    ).toBe("操作失败：无法连接到服务，请检查网络后重试。");
    expect(
      analysisObjectMutationErrorMessage({
        status: 409,
        code: "MODULE_ARCHIVE_DEPENDENCIES",
        details: { pages: [{ id: "page-1" }], workflows: [] },
      }),
    ).toContain("仍有 1 个依赖");
  });
});
