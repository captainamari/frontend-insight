import type { WorkflowStep, WorkflowTriggerKind } from "./types";

const uuidSegment =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const opaqueMixedSegment =
  /^(?:\d+|[0-9a-f]{16,}|(?=.*[a-z])(?=.*\d)[a-z0-9_-]{20,})$/i;

export function pageRoutePreview(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || /[?#]/.test(trimmed)) return null;
  try {
    const segments = trimmed
      .replace(/\/{2,}/g, "/")
      .split("/")
      .filter(Boolean)
      .map((raw) => decodeURIComponent(raw))
      .map((segment) => {
        if (
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment.includes("/") ||
          Array.from(segment).some((character) => character.charCodeAt(0) <= 31)
        ) {
          throw new Error("PAGE_ROUTE_INVALID");
        }
        return uuidSegment.test(segment) || opaqueMixedSegment.test(segment)
          ? ":id"
          : segment;
      });
    return segments.length ? `/${segments.join("/")}` : "/";
  } catch {
    return null;
  }
}

export function triggerConfigKey(kind: WorkflowTriggerKind): string | null {
  return {
    explicit_sdk: null,
    selector: "selector",
    network_request: "pathPattern",
    page_lifecycle: "event",
    operation_terminal: "operationKey",
  }[kind];
}

export interface WorkflowConditionContext {
  subject: string;
  timing: string;
  cannotInfer: string;
  helper: string;
}

export function workflowConditionContext(
  kind: WorkflowTriggerKind,
): WorkflowConditionContext {
  return {
    explicit_sdk: {
      subject: "业务开发者在当前 workflow handle 上显式上报",
      timing: "真实业务逻辑确认该阶段到达时",
      cannotInfer: "配置本身不会产生事件，也不能从任意点击或请求推断。",
      helper: "复制只读示例，并在真实业务阶段到达后调用 reachStep。",
    },
    selector: {
      subject: "用户与已配置元素的交互",
      timing: "匹配元素发生 click 或受控 change 时",
      cannotInfer: "元素出现或发生交互不等于业务成功；不采集 DOM 文本。",
      helper: "首版只响应用户 click/change，不支持元素出现。",
    },
    network_request: {
      subject: "受控请求适配器",
      timing: "匹配方法与脱敏路径模式的请求完成时",
      cannotInfer: "HTTP 2xx 不自动等于业务成功。",
      helper: "只填写不含 query、token 或业务对象 ID 的路径模式。",
    },
    page_lifecycle: {
      subject: "已配置页面",
      timing: "目标页面加载完成或刷新时",
      cannotInfer: "页面加载不等于任务完成。",
      helper: "生命周期仅描述页面就绪事件。",
    },
    operation_terminal: {
      subject: "与当前 workflow handle 关联的 operation",
      timing: "登记的 operation 上报 succeeded、failed 或 canceled 时",
      cannotInfer: "独立 operation、HTTP 结果或同 session 邻近事件不能自动关联。",
      helper: "需要已登记 operation 与 R4-B 关联 SDK；R1-A 仅保存定义。",
    },
  }[kind];
}

type PreviewStep = Pick<WorkflowStep, "stepKey" | "triggerKind" | "triggerConfig">;

export function workflowStepPreview(step: PreviewStep): string {
  const config = step.triggerConfig;
  switch (step.triggerKind) {
    case "explicit_sdk":
      return `当业务代码对当前工作流实例执行 reachStep('${step.stepKey}') 时，本步骤达成。`;
    case "selector":
      return `当用户${config.event === "change" ? "更改" : "点击"} ${String(config.selector || "所选元素")} 时，本步骤达成；这不代表业务成功。`;
    case "network_request":
      return `当 ${String(config.method || "HTTP")} ${String(config.pathPattern || "路径模式")} 请求完成时，本步骤达成；传输成功不等于业务成功。`;
    case "page_lifecycle":
      return `当已配置页面${config.event === "refreshed" ? "刷新" : "加载完成"}时，本步骤达成；这不代表任务完成。`;
    case "operation_terminal":
      return `当与当前工作流实例关联的 operation ${String(config.operationKey || "（请选择）")} 上报 ${String(config.state || "终态")} 时，本步骤达成；工作流是否成功由终态策略决定。`;
  }
}

export function selectorIsFragile(kind: WorkflowTriggerKind, value: string): boolean {
  return kind === "selector" && value.trim().startsWith(".");
}

interface MutationErrorShape {
  status?: number;
  code?: string;
  message?: string;
  requestId?: string | null;
  details?: unknown;
}

export function analysisObjectMutationErrorMessage(
  cause: unknown,
  conflictMessage = "唯一标识已存在，请修改后重试。",
): string {
  const error =
    typeof cause === "object" && cause !== null ? (cause as MutationErrorShape) : null;
  const requestId = error?.requestId ? `（request ID：${error.requestId}）` : "";
  if (error?.code?.endsWith("_MUST_BE_DISABLED")) {
    return `归档前必须先停用该对象。${requestId}`;
  }
  if (error?.code?.endsWith("_ARCHIVE_DEPENDENCIES")) {
    const details = error.details as
      { pages?: unknown[]; workflows?: unknown[]; features?: unknown[] } | undefined;
    const count =
      (details?.pages?.length ?? 0) +
      (details?.workflows?.length ?? 0) +
      (details?.features?.length ?? 0);
    return `归档失败：仍有 ${count} 个依赖，请先处理依赖对象。${requestId}`;
  }
  if (error?.code === "WORKFLOW_OPERATION_NOT_AVAILABLE") {
    return `保存失败：请选择已登记且启用 lifecycle 的 operation。${requestId}`;
  }
  if (error?.status === 409 || error?.code === "RESOURCE_CONFLICT") {
    return `${conflictMessage}${requestId}`;
  }
  if (error?.status === 0 || error?.code === "NETWORK_ERROR") {
    return `操作失败：无法连接到服务，请检查网络后重试。${requestId}`;
  }
  return `操作失败：${error?.message || "请求未完成，请重试。"}${requestId}`;
}
