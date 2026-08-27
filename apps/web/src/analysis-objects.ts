import type { WorkflowTriggerKind } from "./types";

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

export function triggerConfigKey(kind: WorkflowTriggerKind): string {
  return {
    explicit_sdk: "actionKey",
    selector: "selector",
    network_request: "pathPattern",
    page_lifecycle: "event",
    operation_terminal: "state",
  }[kind];
}

export function selectorIsFragile(kind: WorkflowTriggerKind, value: string): boolean {
  return kind === "selector" && value.trim().startsWith(".");
}

interface MutationErrorShape {
  status?: number;
  code?: string;
  message?: string;
  requestId?: string | null;
}

export function analysisObjectMutationErrorMessage(
  cause: unknown,
  conflictMessage = "唯一标识已存在，请修改后重试。",
): string {
  const error =
    typeof cause === "object" && cause !== null ? (cause as MutationErrorShape) : null;
  const requestId = error?.requestId ? `（request ID：${error.requestId}）` : "";
  if (error?.status === 409 || error?.code === "RESOURCE_CONFLICT") {
    return `${conflictMessage}${requestId}`;
  }
  if (error?.status === 0 || error?.code === "NETWORK_ERROR") {
    return `操作失败：无法连接到服务，请检查网络后重试。${requestId}`;
  }
  return `操作失败：${error?.message || "请求未完成，请重试。"}${requestId}`;
}
