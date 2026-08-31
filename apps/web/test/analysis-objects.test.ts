import { describe, expect, it } from "vitest";
import {
  analysisObjectMutationErrorMessage,
  pageRoutePreview,
  selectorIsFragile,
  synchronizeWorkflowTerminalReferences,
  triggerConfigKey,
  validateWorkflowDraft,
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
    expect(
      analysisObjectMutationErrorMessage({
        status: 400,
        code: "WORKFLOW_TERMINAL_STEP_INVALID",
        requestId: "request-terminal",
      }),
    ).toBe(
      "保存失败：终态步骤已失效，请重新选择当前工作流中的步骤。（request ID：request-terminal）",
    );
    expect(
      analysisObjectMutationErrorMessage({
        status: 400,
        code: "WORKFLOW_STEP_KEY_DUPLICATE",
      }),
    ).toBe("保存失败：stepKey 必须唯一，请修改重复步骤。");
  });

  it("keeps workflow terminal references aligned when a stepKey is renamed", () => {
    expect(
      synchronizeWorkflowTerminalReferences(
        {
          completedStepKey: "completed",
          failedStepKey: "failed",
          canceledStepKey: "",
        },
        "completed",
        "completed1",
      ),
    ).toEqual({
      completedStepKey: "completed1",
      failedStepKey: "failed",
      canceledStepKey: "",
    });
  });

  it("validates workflow keys, terminal references and operation registry locally", () => {
    const base = {
      workflowKey: "energy_workflow",
      name: "能源工作流",
      moduleId: "module-1",
      steps: [
        {
          stepKey: "started",
          name: "开始",
          triggerKind: "explicit_sdk" as const,
          configValue: "",
          operationKey: "",
        },
        {
          stepKey: "completed1",
          name: "完成",
          triggerKind: "operation_terminal" as const,
          configValue: "",
          operationKey: "energy_operation",
        },
      ],
      terminalPolicy: {
        completedStepKey: "completed1",
        failedStepKey: "",
        canceledStepKey: "",
      },
      availableOperationKeys: ["energy_operation"],
    };
    expect(validateWorkflowDraft(base)).toMatchObject({
      valid: true,
      firstMessage: null,
    });
    expect(
      validateWorkflowDraft({
        ...base,
        terminalPolicy: { ...base.terminalPolicy, completedStepKey: "completed" },
      }),
    ).toMatchObject({
      valid: false,
      completedStepKey: "成功终态步骤已失效，请重新选择当前工作流中的步骤。",
    });
    expect(
      validateWorkflowDraft({
        ...base,
        terminalPolicy: {
          ...base.terminalPolicy,
          failedStepKey: "completed1",
        },
      }),
    ).toMatchObject({
      valid: false,
      failedStepKey: "失败终态步骤不能与成功终态步骤重复。",
    });
    expect(
      validateWorkflowDraft({
        ...base,
        steps: base.steps.map((step) =>
          step.triggerKind === "operation_terminal"
            ? { ...step, operationKey: "unregistered_operation" }
            : step,
        ),
      }),
    ).toMatchObject({
      valid: false,
      triggerConfigs: ["", "请选择已登记且启用 lifecycle 的 operation。"],
    });
  });
});
