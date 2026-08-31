<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import {
  analysisObjectMutationErrorMessage,
  pageRoutePreview,
  selectorIsFragile,
  synchronizeWorkflowTerminalReferences,
  validateWorkflowDraft,
  workflowConditionContext,
  workflowStepPreview,
} from "../analysis-objects";
import { auth } from "../auth";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import { useDashboardContext } from "../context";
import { useRemoteData } from "../remote";
import type {
  ExpectedFrequency,
  PageDefinition,
  PageTemplate,
  ProjectModule,
  WorkflowDefinition,
  WorkflowStartPolicy,
  WorkflowTriggerKind,
} from "../types";

interface UnclassifiedRoute {
  pageRoute: string;
  pageViews: number;
  users: number;
  browsers: number;
  vv: number;
  lastVisitAt: string | null;
}

interface OperationRegistryItem {
  operationKey: string;
  name: string;
}

interface AnalysisObjectsData {
  modules: ProjectModule[];
  pages: PageDefinition[];
  workflows: WorkflowDefinition[];
  unclassified: UnclassifiedRoute[];
  operations: OperationRegistryItem[];
}

interface WorkflowStepForm {
  clientId: string;
  stepKey: string;
  name: string;
  triggerKind: WorkflowTriggerKind;
  configValue: string;
  httpMethod: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  selectorEvent: "click" | "change";
  operationKey: string;
  operationState: "succeeded" | "failed" | "canceled";
}

const context = useDashboardContext();
const route = useRoute();
const router = useRouter();
const resource = useRemoteData<AnalysisObjectsData>();
const tabs = [
  { name: "modules", label: "功能模块" },
  { name: "pages", label: "页面" },
  { name: "workflows", label: "工作流" },
] as const;
type AnalysisObjectTab = (typeof tabs)[number]["name"];

function isTab(value: unknown): value is AnalysisObjectTab {
  return tabs.some((tab) => tab.name === value);
}

const activeTab = ref<AnalysisObjectTab>(
  isTab(route.query.object) ? route.query.object : "modules",
);
const saving = ref(false);
const showArchived = ref(false);
const selectedModuleId = ref("");
const pageSearch = ref("");
const moduleOpen = ref(false);
const editingModuleId = ref<string | null>(null);
const pageOpen = ref(false);
const editingPageId = ref<string | null>(null);
const pageSemanticDirty = ref(false);
const workflowOpen = ref(false);
const editingWorkflowId = ref<string | null>(null);
const activeStepIndex = ref(0);
const workflowValidationVisible = ref(false);
const handledCreateQuery = ref(false);
const showOperationMessage = ElMessage as unknown as (options: {
  type: "success" | "error";
  message: string;
  showClose: boolean;
  center?: boolean;
  duration?: number;
}) => void;

const canWrite = computed(
  () =>
    auth.state.user?.globalRole === "admin" &&
    ["owner", "admin"].includes(context.project.value?.role ?? ""),
);
const viewState = computed(() => {
  if (!context.projectId.value || (resource.loading.value && !resource.data.value)) {
    return "loading" as const;
  }
  if (resource.error.value && !resource.data.value) {
    return resource.error.value.status === 403
      ? ("forbidden" as const)
      : ("error" as const);
  }
  return resource.stale.value ? ("stale" as const) : ("ready" as const);
});
const activeModules = computed(
  () =>
    resource.data.value?.modules.filter(
      (item) => item.status === "active" && !item.archivedAt,
    ) ?? [],
);
const selectedModule = computed(
  () =>
    resource.data.value?.modules.find((item) => item.id === selectedModuleId.value) ??
    null,
);
const selectedPages = computed(() => {
  const needle = pageSearch.value.trim().toLocaleLowerCase();
  return (
    resource.data.value?.pages.filter(
      (item) =>
        item.moduleId === selectedModuleId.value &&
        (!needle ||
          item.name.toLocaleLowerCase().includes(needle) ||
          item.pageRoute.toLocaleLowerCase().includes(needle)),
    ) ?? []
  );
});
const operationRegistry = computed(() => resource.data.value?.operations ?? []);

const moduleForm = reactive({ moduleKey: "", name: "", displayOrder: 0 });
const pageForm = reactive({
  pageRoute: "",
  moduleId: "",
  name: "",
  templateKey: "analysis_view" as PageTemplate,
  isCore: false,
  criticalityWeight: 1,
  expectedFrequency: "weekly" as ExpectedFrequency,
  status: "active" as "active" | "disabled",
});
const workflowForm = reactive({
  workflowKey: "",
  name: "",
  moduleId: "",
  startPolicy: "first_step" as WorkflowStartPolicy,
  timeoutSeconds: 900,
  completedStepKey: "completed",
  failedStepKey: "",
  canceledStepKey: "",
  steps: [] as WorkflowStepForm[],
});
let workflowStepClientSequence = 0;
const workflowValidation = computed(() =>
  validateWorkflowDraft({
    workflowKey: workflowForm.workflowKey,
    name: workflowForm.name,
    moduleId: workflowForm.moduleId,
    steps: workflowForm.steps,
    terminalPolicy: {
      completedStepKey: workflowForm.completedStepKey,
      failedStepKey: workflowForm.failedStepKey,
      canceledStepKey: workflowForm.canceledStepKey,
    },
    availableOperationKeys: operationRegistry.value.map((item) => item.operationKey),
  }),
);

const normalizedRoute = computed(() => pageRoutePreview(pageForm.pageRoute));
const templateLabels: Record<PageTemplate, string> = {
  monitoring_dashboard: "实时监测 / 驾驶舱",
  analysis_view: "信息分析",
  task_operation: "任务操作",
};
const triggerLabels: Record<WorkflowTriggerKind, string> = {
  explicit_sdk: "显式 SDK 上报",
  selector: "元素交互",
  network_request: "请求完成",
  page_lifecycle: "页面生命周期",
  operation_terminal: "operation 终态",
};

function moduleName(moduleId: string): string {
  return resource.data.value?.modules.find((item) => item.id === moduleId)?.name ?? "—";
}

function templateLabel(template: PageTemplate): string {
  return templateLabels[template];
}

function selectedModuleStorageKey(): string {
  return `fi.r1a.selected-module.${context.projectId.value || "none"}`;
}

async function load(): Promise<void> {
  if (!context.projectId.value) return;
  const projectId = context.projectId.value;
  const archivedQuery = showArchived.value ? "?includeArchived=true" : "";
  const result = await resource.load(async () => {
    const analytics = context.search.value
      ? api.request<{ unclassified: UnclassifiedRoute[] }>(
          `/api/projects/${projectId}/analytics/modules?${context.search.value}`,
        )
      : Promise.resolve({ unclassified: [] });
    const [modules, pages, workflows, operations, moduleAnalytics] = await Promise.all([
      api.request<ProjectModule[]>(
        `/api/projects/${projectId}/modules${archivedQuery}`,
      ),
      api.request<PageDefinition[]>(
        `/api/projects/${projectId}/page-definitions${archivedQuery}`,
      ),
      api.request<WorkflowDefinition[]>(
        `/api/projects/${projectId}/workflow-definitions${archivedQuery}`,
      ),
      api.request<OperationRegistryItem[]>(
        `/api/projects/${projectId}/operation-registry`,
      ),
      analytics,
    ]);
    return {
      modules,
      pages,
      workflows,
      operations,
      unclassified: moduleAnalytics.unclassified,
    };
  });
  if (!result) return;
  const saved = localStorage.getItem(selectedModuleStorageKey());
  const candidate = result.modules.find(
    (item) => item.id === selectedModuleId.value || item.id === saved,
  );
  selectedModuleId.value =
    candidate?.id ??
    result.modules.find((item) => item.status === "active" && !item.archivedAt)?.id ??
    result.modules[0]?.id ??
    "";
  if (!workflowForm.moduleId) workflowForm.moduleId = activeModules.value[0]?.id ?? "";
  if (
    !handledCreateQuery.value &&
    canWrite.value &&
    route.query.create === "page" &&
    typeof route.query.pageRoute === "string"
  ) {
    handledCreateQuery.value = true;
    setTab("pages");
    openNewPage(route.query.pageRoute);
  }
}

async function mutate(
  operation: () => Promise<unknown>,
  successMessage: string,
  conflictMessage?: string,
): Promise<boolean> {
  saving.value = true;
  try {
    await operation();
    await load();
    showOperationMessage({
      type: "success",
      message: successMessage,
      showClose: true,
      center: true,
    });
    return true;
  } catch (cause) {
    showOperationMessage({
      type: "error",
      message: analysisObjectMutationErrorMessage(cause, conflictMessage),
      showClose: true,
      center: true,
      duration: 6_000,
    });
    return false;
  } finally {
    saving.value = false;
  }
}

function setTab(tab: AnalysisObjectTab): void {
  activeTab.value = tab;
  if (route.query.object !== tab) {
    void router.push({ query: { ...route.query, object: tab } });
  }
}

function openNewModule(): void {
  editingModuleId.value = null;
  moduleForm.moduleKey = "";
  moduleForm.name = "";
  moduleForm.displayOrder =
    Math.max(
      0,
      ...(resource.data.value?.modules.map((item) => item.displayOrder) ?? [0]),
    ) + 10;
  moduleOpen.value = true;
}

function openModule(item: ProjectModule): void {
  editingModuleId.value = item.id;
  moduleForm.moduleKey = item.moduleKey;
  moduleForm.name = item.name;
  moduleForm.displayOrder = item.displayOrder;
  moduleOpen.value = true;
}

async function saveModule(): Promise<void> {
  if (!context.projectId.value) return;
  const editing = editingModuleId.value;
  const succeeded = await mutate(
    () =>
      api.request(
        editing
          ? `/api/projects/${context.projectId.value}/modules/${editing}`
          : `/api/projects/${context.projectId.value}/modules`,
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify(moduleForm),
        },
      ),
    editing ? "功能模块已保存并创建新 revision" : "功能模块已创建",
    "创建失败：moduleKey 已存在，请使用唯一的 key。",
  );
  if (succeeded) moduleOpen.value = false;
}

async function toggleModule(item: ProjectModule): Promise<void> {
  const status = item.status === "active" ? "disabled" : "active";
  await mutate(
    () =>
      api.request(`/api/projects/${context.projectId.value}/modules/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    status === "active" ? "功能模块已启用" : "功能模块已停用",
  );
}

async function archiveModule(item: ProjectModule): Promise<void> {
  await ElMessageBox.confirm(
    `归档 ${item.name}？唯一 moduleKey 将继续占用，且可从“显示已归档”恢复。`,
    "归档功能模块",
    { type: "warning", confirmButtonText: "归档", cancelButtonText: "取消" },
  );
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/modules/${item.id}/archive`,
        { method: "POST" },
      ),
    "功能模块已归档",
  );
}

async function restoreModule(item: ProjectModule): Promise<void> {
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/modules/${item.id}/restore`,
        { method: "POST" },
      ),
    "功能模块已恢复（保持停用状态）",
  );
}

function openNewPage(observedRoute = ""): void {
  editingPageId.value = null;
  pageSemanticDirty.value = false;
  pageForm.pageRoute = observedRoute;
  pageForm.moduleId =
    (selectedModule.value?.status === "active" && !selectedModule.value.archivedAt
      ? selectedModule.value.id
      : activeModules.value[0]?.id) ?? "";
  pageForm.name = observedRoute.split("/").filter(Boolean).at(-1) ?? "";
  pageForm.templateKey = "analysis_view";
  pageForm.isCore = false;
  pageForm.criticalityWeight = 1;
  pageForm.expectedFrequency = "weekly";
  pageForm.status = "active";
  pageOpen.value = true;
}

function openPage(item: PageDefinition): void {
  editingPageId.value = item.id;
  pageSemanticDirty.value = false;
  Object.assign(pageForm, {
    pageRoute: item.pageRoute,
    moduleId: item.moduleId,
    name: item.name,
    templateKey: item.templateKey,
    isCore: item.isCore,
    criticalityWeight: item.criticalityWeight,
    expectedFrequency: item.expectedFrequency,
    status: item.status,
  });
  pageOpen.value = true;
}

function markPageSemanticDirty(): void {
  if (editingPageId.value) pageSemanticDirty.value = true;
}

async function savePage(): Promise<void> {
  if (!context.projectId.value || (!editingPageId.value && !normalizedRoute.value)) {
    return;
  }
  const editing = editingPageId.value;
  const body = editing
    ? {
        moduleId: pageForm.moduleId,
        name: pageForm.name,
        templateKey: pageForm.templateKey,
        isCore: pageForm.isCore,
        criticalityWeight: pageForm.criticalityWeight,
        expectedFrequency: pageForm.expectedFrequency,
        status: pageForm.status,
      }
    : pageForm;
  const succeeded = await mutate(
    () =>
      api.request(
        editing
          ? `/api/projects/${context.projectId.value}/page-definitions/${editing}`
          : `/api/projects/${context.projectId.value}/page-definitions`,
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify(body),
        },
      ),
    editing ? "页面定义已保存并创建新 revision" : "页面定义已创建",
    "创建失败：归一化后的 pageRoute 已存在，请检查现有页面定义。",
  );
  if (succeeded) pageOpen.value = false;
}

async function togglePage(item: PageDefinition): Promise<void> {
  const status = item.status === "active" ? "disabled" : "active";
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/page-definitions/${item.id}`,
        { method: "PATCH", body: JSON.stringify({ status }) },
      ),
    status === "active" ? "页面定义已启用" : "页面定义已停用",
  );
}

async function archivePage(item: PageDefinition): Promise<void> {
  await ElMessageBox.confirm(
    `归档 ${item.name}？pageRoute 将继续占用，历史查询仍按原 revision 解析。`,
    "归档页面定义",
    { type: "warning", confirmButtonText: "归档", cancelButtonText: "取消" },
  );
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/page-definitions/${item.id}/archive`,
        { method: "POST" },
      ),
    "页面定义已归档",
  );
}

async function restorePage(item: PageDefinition): Promise<void> {
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/page-definitions/${item.id}/restore`,
        { method: "POST" },
      ),
    "页面定义已恢复（保持停用状态）",
  );
}

function newStep(stepKey: string, name: string): WorkflowStepForm {
  return {
    clientId: `workflow-step-${++workflowStepClientSequence}`,
    stepKey,
    name,
    triggerKind: "explicit_sdk",
    configValue: "",
    httpMethod: "POST",
    selectorEvent: "click",
    operationKey: resource.data.value?.operations[0]?.operationKey ?? "",
    operationState: "succeeded",
  };
}

function stepTriggerConfig(step: WorkflowStepForm): Record<string, string | boolean> {
  if (step.triggerKind === "explicit_sdk") return {};
  if (step.triggerKind === "selector") {
    return { event: step.selectorEvent, selector: step.configValue };
  }
  if (step.triggerKind === "network_request") {
    return { method: step.httpMethod, pathPattern: step.configValue };
  }
  if (step.triggerKind === "page_lifecycle") return { event: step.configValue };
  return { operationKey: step.operationKey, state: step.operationState };
}

function stepPreview(step: WorkflowStepForm): string {
  return workflowStepPreview({
    stepKey: step.stepKey,
    triggerKind: step.triggerKind,
    triggerConfig: stepTriggerConfig(step),
  });
}

function sdkExample(step: WorkflowStepForm): string {
  return `const workflow = tracker.startWorkflow("${workflowForm.workflowKey || "workflow_key"}");\nworkflow.reachStep("${step.stepKey || "step_key"}");`;
}

function operationExample(step: WorkflowStepForm): string {
  return `const workflow = tracker.startWorkflow("${workflowForm.workflowKey || "workflow_key"}");\nconst operation = workflow.startOperation("${step.operationKey || "operation_key"}", {}, "click");\noperation.${step.operationState === "succeeded" ? "succeed" : step.operationState === "failed" ? "fail" : "cancel"}();`;
}

function openWorkflow(item?: WorkflowDefinition): void {
  editingWorkflowId.value = item?.id ?? null;
  workflowForm.workflowKey = item?.workflowKey ?? "";
  workflowForm.name = item?.latestVersion?.name ?? item?.name ?? "";
  workflowForm.moduleId =
    item?.latestVersion?.moduleId ?? item?.moduleId ?? activeModules.value[0]?.id ?? "";
  workflowForm.startPolicy = item?.latestVersion?.startPolicy ?? "first_step";
  workflowForm.timeoutSeconds = item?.latestVersion?.timeoutSeconds ?? 900;
  workflowForm.completedStepKey =
    item?.latestVersion?.terminalPolicy.completedStepKey ?? "completed";
  workflowForm.failedStepKey = item?.latestVersion?.terminalPolicy.failedStepKey ?? "";
  workflowForm.canceledStepKey =
    item?.latestVersion?.terminalPolicy.canceledStepKey ?? "";
  workflowForm.steps = item?.latestVersion?.steps.length
    ? item.latestVersion.steps.map((step) => ({
        clientId: `workflow-step-${++workflowStepClientSequence}`,
        stepKey: step.stepKey,
        name: step.name,
        triggerKind: step.triggerKind,
        configValue: String(
          step.triggerConfig.selector ??
            step.triggerConfig.pathPattern ??
            step.triggerConfig.event ??
            "",
        ),
        httpMethod: String(step.triggerConfig.method ?? "POST") as
          "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        selectorEvent: String(step.triggerConfig.event ?? "click") as
          "click" | "change",
        operationKey: String(step.triggerConfig.operationKey ?? ""),
        operationState: String(step.triggerConfig.state ?? "succeeded") as
          "succeeded" | "failed" | "canceled",
      }))
    : [newStep("started", "开始"), newStep("completed", "完成")];
  activeStepIndex.value = 0;
  workflowValidationVisible.value = false;
  workflowOpen.value = true;
}

function updateStepKey(step: WorkflowStepForm, nextStepKey: string): void {
  const previousStepKey = step.stepKey;
  const terminalPolicy = synchronizeWorkflowTerminalReferences(
    {
      completedStepKey: workflowForm.completedStepKey,
      failedStepKey: workflowForm.failedStepKey,
      canceledStepKey: workflowForm.canceledStepKey,
    },
    previousStepKey,
    nextStepKey,
  );
  step.stepKey = nextStepKey;
  workflowForm.completedStepKey = terminalPolicy.completedStepKey;
  workflowForm.failedStepKey = terminalPolicy.failedStepKey;
  workflowForm.canceledStepKey = terminalPolicy.canceledStepKey;
}

function changeTrigger(step: WorkflowStepForm): void {
  step.configValue =
    step.triggerKind === "selector"
      ? `[data-fi-action="${step.stepKey || "action"}"]`
      : step.triggerKind === "network_request"
        ? "/api/resource"
        : step.triggerKind === "page_lifecycle"
          ? "loaded"
          : "";
  if (step.triggerKind === "operation_terminal") {
    step.operationKey = resource.data.value?.operations[0]?.operationKey ?? "";
    step.operationState = "succeeded";
  }
}

function addStep(): void {
  if (workflowForm.steps.length >= 20) return;
  let index = workflowForm.steps.length + 1;
  while (workflowForm.steps.some((item) => item.stepKey === `step_${index}`)) index++;
  workflowForm.steps.push(newStep(`step_${index}`, `步骤 ${index}`));
  activeStepIndex.value = workflowForm.steps.length - 1;
}

function removeStep(index: number): void {
  if (workflowForm.steps.length <= 2) return;
  workflowForm.steps.splice(index, 1);
  activeStepIndex.value = Math.min(
    activeStepIndex.value,
    workflowForm.steps.length - 1,
  );
  const keys = new Set(workflowForm.steps.map((item) => item.stepKey));
  if (!keys.has(workflowForm.completedStepKey)) {
    workflowForm.completedStepKey = workflowForm.steps.at(-1)?.stepKey ?? "";
  }
  if (!keys.has(workflowForm.failedStepKey)) workflowForm.failedStepKey = "";
  if (!keys.has(workflowForm.canceledStepKey)) workflowForm.canceledStepKey = "";
}

function moveStep(index: number, direction: -1 | 1): void {
  const target = index + direction;
  if (target < 0 || target >= workflowForm.steps.length) return;
  const [step] = workflowForm.steps.splice(index, 1);
  if (step) workflowForm.steps.splice(target, 0, step);
  activeStepIndex.value = target;
}

function workflowConfiguration() {
  return {
    moduleId: workflowForm.moduleId,
    name: workflowForm.name,
    startPolicy: workflowForm.startPolicy,
    timeoutSeconds: workflowForm.timeoutSeconds,
    terminalPolicy: {
      completedStepKey: workflowForm.completedStepKey,
      failedStepKey: workflowForm.failedStepKey || null,
      canceledStepKey: workflowForm.canceledStepKey || null,
      timeoutState: "approximate_abandoned" as const,
    },
    steps: workflowForm.steps.map((step, index) => ({
      stepKey: step.stepKey,
      name: step.name,
      stepOrder: index + 1,
      triggerKind: step.triggerKind,
      triggerConfig: stepTriggerConfig(step),
    })),
  };
}

async function saveWorkflow(): Promise<void> {
  if (!context.projectId.value) return;
  workflowValidationVisible.value = true;
  if (!workflowValidation.value.valid) {
    showOperationMessage({
      type: "error",
      message: workflowValidation.value.firstMessage ?? "请检查工作流配置。",
      showClose: true,
      center: true,
      duration: 6_000,
    });
    await nextTick();
    const firstInvalid = document.querySelector<HTMLElement>(
      ".r1a-workflow-dialog .el-form-item.is-error input, .r1a-workflow-dialog .el-form-item.is-error textarea",
    );
    firstInvalid?.focus();
    return;
  }
  const configuration = workflowConfiguration();
  const editing = editingWorkflowId.value;
  const succeeded = await mutate(
    () =>
      api.request(
        editing
          ? `/api/projects/${context.projectId.value}/workflow-definitions/${editing}/draft`
          : `/api/projects/${context.projectId.value}/workflow-definitions`,
        {
          method: editing ? "PUT" : "POST",
          body: JSON.stringify(
            editing
              ? configuration
              : { workflowKey: workflowForm.workflowKey, ...configuration },
          ),
        },
      ),
    editing ? "工作流新草稿已保存；激活版本未被原地修改" : "工作流已创建",
    "保存失败：workflowKey 已存在，请使用唯一的 key。",
  );
  if (succeeded) workflowOpen.value = false;
}

async function activateWorkflow(item: WorkflowDefinition): Promise<void> {
  if (!item.latestVersion || item.latestVersion.status !== "draft") return;
  await ElMessageBox.confirm(
    `激活 ${item.name} v${item.latestVersion.version}？上一激活版本的有效期将在此时关闭。`,
    "激活工作流版本",
    { confirmButtonText: "激活", cancelButtonText: "取消", type: "warning" },
  );
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/workflow-definitions/${item.id}/activate`,
        {
          method: "POST",
          body: JSON.stringify({ versionId: item.latestVersion!.id }),
        },
      ),
    "工作流版本已激活",
  );
}

async function toggleWorkflow(item: WorkflowDefinition): Promise<void> {
  const status = item.status === "active" ? "disabled" : "active";
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/workflow-definitions/${item.id}`,
        { method: "PATCH", body: JSON.stringify({ status }) },
      ),
    status === "active" ? "工作流已启用" : "工作流已停用",
  );
}

async function archiveWorkflow(item: WorkflowDefinition): Promise<void> {
  await ElMessageBox.confirm(
    `归档 ${item.name}？workflowKey 将继续占用，历史版本仍保留。`,
    "归档工作流",
    { type: "warning", confirmButtonText: "归档", cancelButtonText: "取消" },
  );
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/workflow-definitions/${item.id}/archive`,
        { method: "POST" },
      ),
    "工作流已归档",
  );
}

async function restoreWorkflow(item: WorkflowDefinition): Promise<void> {
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/workflow-definitions/${item.id}/restore`,
        { method: "POST" },
      ),
    "工作流已恢复（保持停用状态）",
  );
}

const currentStep = computed(() => workflowForm.steps[activeStepIndex.value] ?? null);
const currentCondition = computed(() =>
  currentStep.value ? workflowConditionContext(currentStep.value.triggerKind) : null,
);

function goToR6(): void {
  void router.push({ name: "pages", query: { ...route.query, tab: "operations" } });
}

watch(
  () => [context.projectId.value, context.search.value, showArchived.value],
  () => void load(),
  { immediate: true },
);
watch(selectedModuleId, (value) => {
  if (value) localStorage.setItem(selectedModuleStorageKey(), value);
});
watch(
  () => route.query.object,
  (value) => {
    if (isTab(value)) activeTab.value = value;
  },
);
</script>

<template>
  <div>
    <PageHeader
      eyebrow="METRIC CENTER · R1-A"
      title="指标管理"
      description="模块、页面和工作流以稳定标识与有效期 revision 保存分析语义。"
    >
      <el-button type="primary" :loading="resource.loading.value" @click="load"
        >刷新</el-button
      >
    </PageHeader>
    <el-alert
      v-if="!canWrite"
      type="info"
      :closable="false"
      show-icon
      title="当前账号为只读权限；可以查看分析对象和工作流版本，但不能修改。"
    />
    <StatePanel
      :state="viewState"
      title="分析对象暂不可用"
      :message="resource.error.value?.message"
      :request-id="resource.error.value?.requestId"
      @retry="load"
    >
      <template v-if="resource.data.value">
        <section class="panel">
          <div class="analysis-object-tabs" role="tablist" aria-label="分析对象">
            <button
              v-for="tab in tabs"
              :id="`analysis-object-tab-${tab.name}`"
              :key="tab.name"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab.name"
              :class="{ active: activeTab === tab.name }"
              @click="setTab(tab.name)"
            >
              {{ tab.label }}
            </button>
            <el-checkbox v-model="showArchived" class="archive-toggle"
              >显示已归档</el-checkbox
            >
          </div>

          <section v-if="activeTab === 'modules'" role="tabpanel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">FUNCTION MODULES</span>
                <h2>功能模块</h2>
                <p>模块级关键度已删除；页面关键度仍在页面 revision 中维护。</p>
              </div>
              <el-button v-if="canWrite" type="primary" @click="openNewModule"
                >新建功能模块</el-button
              >
            </div>
            <el-table :data="resource.data.value.modules" row-key="id">
              <el-table-column label="模块" min-width="220">
                <template #default="{ row }">
                  <strong>{{ row.name }}</strong>
                  <small class="cell-reason">{{ row.moduleKey }}</small>
                </template>
              </el-table-column>
              <el-table-column prop="displayOrder" label="顺序" width="90" />
              <el-table-column prop="pageCount" label="页面数" width="100" />
              <el-table-column label="revision" width="110">
                <template #default="{ row }">v{{ row.revision }}</template>
              </el-table-column>
              <el-table-column label="状态 / 操作" min-width="330">
                <template #default="{ row }">
                  <el-tag v-if="row.archivedAt" type="warning">已归档</el-tag>
                  <el-tag v-else :type="row.status === 'active' ? 'success' : 'info'">{{
                    row.status === "active" ? "启用" : "停用"
                  }}</el-tag>
                  <template v-if="canWrite">
                    <el-button v-if="!row.archivedAt" link @click="openModule(row)"
                      >编辑</el-button
                    >
                    <el-button v-if="!row.archivedAt" link @click="toggleModule(row)">{{
                      row.status === "active" ? "停用" : "启用"
                    }}</el-button>
                    <el-button
                      v-if="!row.archivedAt"
                      link
                      type="danger"
                      @click="archiveModule(row)"
                      >归档</el-button
                    >
                    <el-button v-else link type="primary" @click="restoreModule(row)"
                      >恢复</el-button
                    >
                  </template>
                </template>
              </el-table-column>
            </el-table>
          </section>

          <section v-else-if="activeTab === 'pages'" role="tabpanel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">MODULE → PAGES</span>
                <h2>页面定义</h2>
                <p>先选择功能模块，再管理该模块所属页面。</p>
              </div>
              <el-button
                v-if="canWrite"
                type="primary"
                :disabled="
                  !selectedModule ||
                  selectedModule.status !== 'active' ||
                  Boolean(selectedModule.archivedAt)
                "
                @click="openNewPage()"
                >新建页面定义</el-button
              >
            </div>
            <div class="page-master-controls">
              <el-form-item label="功能模块">
                <el-select v-model="selectedModuleId" aria-label="功能模块">
                  <el-option
                    v-for="module in resource.data.value.modules"
                    :key="module.id"
                    :value="module.id"
                    :label="`${module.name} · ${module.archivedAt ? '已归档' : module.status === 'active' ? '启用' : '停用'} · ${module.pageCount} 页`"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="搜索页面">
                <el-input
                  v-model="pageSearch"
                  clearable
                  placeholder="页面名称或 pageRoute"
                />
              </el-form-item>
            </div>
            <el-table :data="selectedPages" row-key="id" empty-text="当前模块尚无页面">
              <el-table-column prop="name" label="页面名称" min-width="180" />
              <el-table-column prop="pageRoute" label="pageRoute" min-width="250" />
              <el-table-column label="页面模板" min-width="190">
                <template #default="{ row }">{{
                  templateLabel(row.templateKey)
                }}</template>
              </el-table-column>
              <el-table-column label="核心状态" width="100">
                <template #default="{ row }">{{
                  row.isCore ? "核心" : "普通"
                }}</template>
              </el-table-column>
              <el-table-column label="状态 / 操作" min-width="300">
                <template #default="{ row }">
                  <el-tag v-if="row.archivedAt" type="warning">已归档</el-tag>
                  <el-tag v-else :type="row.status === 'active' ? 'success' : 'info'">{{
                    row.status === "active" ? "启用" : "停用"
                  }}</el-tag>
                  <template v-if="canWrite">
                    <el-button v-if="!row.archivedAt" link @click="openPage(row)"
                      >编辑</el-button
                    >
                    <el-button v-if="!row.archivedAt" link @click="togglePage(row)">{{
                      row.status === "active" ? "停用" : "启用"
                    }}</el-button>
                    <el-button
                      v-if="!row.archivedAt"
                      link
                      type="danger"
                      @click="archivePage(row)"
                      >归档</el-button
                    >
                    <el-button v-else link type="primary" @click="restorePage(row)"
                      >恢复</el-button
                    >
                  </template>
                </template>
              </el-table-column>
            </el-table>
            <div class="list-footer">
              <el-button
                v-if="canWrite"
                :disabled="
                  !selectedModule ||
                  selectedModule.status !== 'active' ||
                  Boolean(selectedModule.archivedAt)
                "
                @click="openNewPage()"
                >新增页面到当前模块</el-button
              >
            </div>
            <details class="unclassified-temporary">
              <summary>
                未归类 route 临时入口
                <el-badge :value="resource.data.value.unclassified.length" />
              </summary>
              <p>R6 交付后迁移到“页面分析 → 运营分析”；这里不会长期展示大块空表。</p>
              <el-button plain @click="goToR6"
                >前往 R6 页面运营入口（待交付）</el-button
              >
              <ul v-if="resource.data.value.unclassified.length">
                <li
                  v-for="item in resource.data.value.unclassified"
                  :key="item.pageRoute"
                >
                  <code>{{ item.pageRoute }}</code> · {{ item.pageViews }} PV
                  <el-button v-if="canWrite" link @click="openNewPage(item.pageRoute)"
                    >预填页面</el-button
                  >
                </li>
              </ul>
            </details>
          </section>

          <section v-else role="tabpanel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">WORKFLOW DEFINITIONS</span>
                <h2>工作流定义</h2>
                <p>R1-A 仅保存并解释定义；workflow SDK collector 和事实关联在 R4-B。</p>
              </div>
              <el-button v-if="canWrite" type="primary" @click="openWorkflow()"
                >新建工作流</el-button
              >
            </div>
            <el-table :data="resource.data.value.workflows" row-key="id">
              <el-table-column type="expand">
                <template #default="{ row }">
                  <div class="workflow-steps-preview">
                    <article
                      v-for="step in row.latestVersion?.steps ?? []"
                      :key="step.id"
                    >
                      <strong>{{ step.stepOrder }}. {{ step.name }}</strong>
                      <span>{{ workflowStepPreview(step) }}</span>
                    </article>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="工作流" min-width="220">
                <template #default="{ row }"
                  ><strong>{{ row.name }}</strong
                  ><small class="cell-reason">{{ row.workflowKey }}</small></template
                >
              </el-table-column>
              <el-table-column label="功能模块" min-width="170"
                ><template #default="{ row }">{{
                  moduleName(row.moduleId)
                }}</template></el-table-column
              >
              <el-table-column label="最新版本" width="150"
                ><template #default="{ row }"
                  ><span v-if="row.latestVersion"
                    >v{{ row.latestVersion.version }} ·
                    {{ row.latestVersion.status }}</span
                  ><span v-else>—</span></template
                ></el-table-column
              >
              <el-table-column label="状态 / 操作" min-width="330">
                <template #default="{ row }">
                  <el-tag v-if="row.archivedAt" type="warning">已归档</el-tag>
                  <el-tag v-else :type="row.status === 'active' ? 'success' : 'info'">{{
                    row.status === "active" ? "启用" : "停用"
                  }}</el-tag>
                  <template v-if="canWrite">
                    <el-button v-if="!row.archivedAt" link @click="openWorkflow(row)"
                      >编辑草稿</el-button
                    >
                    <el-button
                      v-if="!row.archivedAt && row.latestVersion?.status === 'draft'"
                      link
                      type="primary"
                      @click="activateWorkflow(row)"
                      >激活</el-button
                    >
                    <el-button
                      v-if="!row.archivedAt"
                      link
                      @click="toggleWorkflow(row)"
                      >{{ row.status === "active" ? "停用" : "启用" }}</el-button
                    >
                    <el-button
                      v-if="!row.archivedAt"
                      link
                      type="danger"
                      @click="archiveWorkflow(row)"
                      >归档</el-button
                    >
                    <el-button v-else link type="primary" @click="restoreWorkflow(row)"
                      >恢复</el-button
                    >
                  </template>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </section>
      </template>
    </StatePanel>

    <el-dialog
      v-model="moduleOpen"
      :title="editingModuleId ? '编辑功能模块' : '新建功能模块'"
      width="520px"
      class="r1a-config-dialog"
      align-center
      :close-on-click-modal="false"
      :close-on-press-escape="false"
    >
      <el-form label-position="top">
        <el-form-item label="moduleKey"
          ><el-input
            v-model="moduleForm.moduleKey"
            :disabled="Boolean(editingModuleId)"
        /></el-form-item>
        <el-form-item label="功能模块名称"
          ><el-input v-model="moduleForm.name"
        /></el-form-item>
        <el-form-item label="展示顺序"
          ><el-input-number v-model="moduleForm.displayOrder"
        /></el-form-item>
        <small v-if="editingModuleId" class="field-helper"
          >保存会创建新 revision 并关闭上一有效期；启用状态不会阻止修改。</small
        >
      </el-form>
      <template #footer>
        <el-button @click="moduleOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveModule">{{
          editingModuleId ? "保存" : "创建"
        }}</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="pageOpen"
      :title="editingPageId ? '编辑页面定义' : '新建页面定义'"
      width="min(760px, 94vw)"
      class="r1a-config-dialog"
      align-center
      :close-on-click-modal="false"
      :close-on-press-escape="false"
    >
      <el-form label-position="top">
        <el-form-item label="观测或模板 route">
          <el-input
            v-model="pageForm.pageRoute"
            :disabled="Boolean(editingPageId)"
            placeholder="/orders/123"
          />
          <small v-if="!editingPageId && normalizedRoute" class="route-preview"
            >保存为：{{ normalizedRoute }}</small
          >
          <small v-else-if="!editingPageId" class="route-preview invalid"
            >route 必须以 / 开头，且不能包含 query 或 hash。</small
          >
        </el-form-item>
        <el-form-item label="页面名称"
          ><el-input v-model="pageForm.name"
        /></el-form-item>
        <el-form-item label="所属功能模块">
          <el-select v-model="pageForm.moduleId" @change="markPageSemanticDirty">
            <el-option
              v-for="module in activeModules"
              :key="module.id"
              :label="module.name"
              :value="module.id"
            />
          </el-select>
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="页面模板">
            <el-select v-model="pageForm.templateKey" @change="markPageSemanticDirty">
              <el-option
                v-for="(label, value) in templateLabels"
                :key="value"
                :label="label"
                :value="value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="预期使用频率">
            <el-select
              v-model="pageForm.expectedFrequency"
              @change="markPageSemanticDirty"
            >
              <el-option label="每天" value="daily" /><el-option
                label="每周"
                value="weekly"
              /><el-option label="每月" value="monthly" /><el-option
                label="按需"
                value="ad_hoc"
              />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="页面关键度"
          ><el-input-number
            v-model="pageForm.criticalityWeight"
            :min="0.1"
            :max="100"
            @change="markPageSemanticDirty"
        /></el-form-item>
        <el-form-item
          ><el-checkbox v-model="pageForm.isCore" @change="markPageSemanticDirty"
            >核心页面</el-checkbox
          ></el-form-item
        >
        <el-form-item v-if="editingPageId" label="状态">
          <el-select v-model="pageForm.status"
            ><el-option label="启用" value="active" /><el-option
              label="停用"
              value="disabled"
          /></el-select>
        </el-form-item>
        <el-alert
          v-if="pageSemanticDirty"
          type="warning"
          :closable="false"
          show-icon
          title="不建议频繁修改该字段"
          description="保存会创建新 revision 和 effective window；历史查询继续使用当时版本。"
        />
      </el-form>
      <template #footer>
        <el-button @click="pageOpen = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!editingPageId && !normalizedRoute"
          :loading="saving"
          @click="savePage"
          >{{ editingPageId ? "保存" : "创建" }}</el-button
        >
      </template>
    </el-dialog>

    <el-dialog
      v-model="workflowOpen"
      :title="editingWorkflowId ? '编辑工作流草稿' : '新建工作流'"
      width="min(1180px, 96vw)"
      class="r1a-config-dialog r1a-workflow-dialog"
      align-center
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      destroy-on-close
    >
      <el-form label-position="top">
        <div class="form-grid three">
          <el-form-item
            label="workflowKey"
            :error="workflowValidationVisible ? workflowValidation.workflowKey : ''"
            ><el-input
              v-model="workflowForm.workflowKey"
              :disabled="Boolean(editingWorkflowId)"
          /></el-form-item>
          <el-form-item
            label="工作流名称"
            :error="workflowValidationVisible ? workflowValidation.name : ''"
            ><el-input v-model="workflowForm.name"
          /></el-form-item>
          <el-form-item
            label="所属功能模块"
            :error="workflowValidationVisible ? workflowValidation.moduleId : ''"
          >
            <el-select v-model="workflowForm.moduleId"
              ><el-option
                v-for="module in activeModules"
                :key="module.id"
                :label="module.name"
                :value="module.id"
            /></el-select>
          </el-form-item>
        </div>
        <el-alert
          v-if="editingWorkflowId"
          type="info"
          :closable="false"
          title="编辑会创建或打开新草稿；已激活版本不可原地修改。"
        />
        <div class="form-grid">
          <el-form-item label="开始策略"
            ><el-select v-model="workflowForm.startPolicy"
              ><el-option label="首步骤自动创建匿名实例" value="first_step" /><el-option
                label="显式 SDK 创建匿名实例"
                value="explicit_sdk" /></el-select
          ></el-form-item>
          <el-form-item label="整体超时（秒）"
            ><el-input-number
              v-model="workflowForm.timeoutSeconds"
              :min="30"
              :max="604800"
          /></el-form-item>
        </div>
        <div class="workflow-editor-heading">
          <div>
            <h3>有序步骤</h3>
            <p>每个条件都显示主体、判定时机、预览和不能推断的内容。</p>
          </div>
          <el-button plain :disabled="workflowForm.steps.length >= 20" @click="addStep"
            >添加步骤</el-button
          >
        </div>
        <div class="workflow-layout">
          <div class="workflow-editor-list">
            <article
              v-for="(step, index) in workflowForm.steps"
              :key="step.clientId"
              class="workflow-editor-step"
              :class="{ current: activeStepIndex === index }"
              @focusin="activeStepIndex = index"
              @click="activeStepIndex = index"
            >
              <div class="step-order">
                <strong>{{ index + 1 }}</strong>
                <el-button
                  text
                  :disabled="index === 0"
                  @click.stop="moveStep(index, -1)"
                  >↑</el-button
                >
                <el-button
                  text
                  :disabled="index === workflowForm.steps.length - 1"
                  @click.stop="moveStep(index, 1)"
                  >↓</el-button
                >
              </div>
              <div class="step-main">
                <div class="step-fields">
                  <el-form-item
                    label="stepKey"
                    :error="
                      workflowValidationVisible
                        ? workflowValidation.stepKeys[index]
                        : ''
                    "
                    ><el-input
                      :model-value="step.stepKey"
                      @update:model-value="updateStepKey(step, String($event))"
                  /></el-form-item>
                  <el-form-item
                    label="步骤名称"
                    :error="
                      workflowValidationVisible
                        ? workflowValidation.stepNames[index]
                        : ''
                    "
                    ><el-input v-model="step.name"
                  /></el-form-item>
                  <el-form-item label="步骤达成条件">
                    <el-select v-model="step.triggerKind" @change="changeTrigger(step)"
                      ><el-option
                        v-for="(label, value) in triggerLabels"
                        :key="value"
                        :label="label"
                        :value="value"
                    /></el-select>
                  </el-form-item>
                </div>
                <div v-if="step.triggerKind === 'selector'" class="condition-fields">
                  <el-form-item>
                    <template #label>
                      交互事件
                      <el-tooltip
                        content="首版只响应用户 click/change；元素出现不代表阶段达成。"
                        ><button
                          type="button"
                          class="help-icon"
                          aria-label="元素交互范围说明"
                        >
                          ?
                        </button></el-tooltip
                      >
                    </template>
                    <el-select v-model="step.selectorEvent"
                      ><el-option label="click" value="click" /><el-option
                        label="change"
                        value="change"
                    /></el-select>
                    <small class="field-helper">只支持用户 click/change。</small>
                  </el-form-item>
                  <el-form-item
                    label="选择器"
                    :error="
                      workflowValidationVisible
                        ? workflowValidation.triggerConfigs[index]
                        : ''
                    "
                    ><el-input v-model="step.configValue" /><small class="field-helper"
                      >推荐 ID 或 data-fi-action；不采集 DOM 文本。</small
                    ></el-form-item
                  >
                </div>
                <div
                  v-else-if="step.triggerKind === 'network_request'"
                  class="condition-fields"
                >
                  <el-form-item label="HTTP 方法"
                    ><el-select v-model="step.httpMethod"
                      ><el-option
                        v-for="method in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']"
                        :key="method"
                        :label="method"
                        :value="method" /></el-select
                  ></el-form-item>
                  <el-form-item
                    label="脱敏路径模式"
                    :error="
                      workflowValidationVisible
                        ? workflowValidation.triggerConfigs[index]
                        : ''
                    "
                    ><el-input v-model="step.configValue" /><small class="field-helper"
                      >不能包含 query、token 或业务对象 ID。</small
                    ></el-form-item
                  >
                </div>
                <el-form-item
                  v-else-if="step.triggerKind === 'page_lifecycle'"
                  label="生命周期事件"
                  :error="
                    workflowValidationVisible
                      ? workflowValidation.triggerConfigs[index]
                      : ''
                  "
                >
                  <el-select v-model="step.configValue"
                    ><el-option label="加载完成" value="loaded" /><el-option
                      label="刷新"
                      value="refreshed" /></el-select
                  ><small class="field-helper">页面加载不等于任务完成。</small>
                </el-form-item>
                <div
                  v-else-if="step.triggerKind === 'operation_terminal'"
                  class="condition-fields"
                >
                  <el-form-item
                    label="匹配的 operation"
                    :error="
                      workflowValidationVisible
                        ? workflowValidation.triggerConfigs[index]
                        : ''
                    "
                    ><el-select v-model="step.operationKey" filterable
                      ><el-option
                        v-for="operation in operationRegistry"
                        :key="operation.operationKey"
                        :label="`${operation.name} · ${operation.operationKey}`"
                        :value="operation.operationKey" /></el-select
                    ><small class="field-helper"
                      >仅列出已登记且启用 lifecycle 的 operation。</small
                    ></el-form-item
                  >
                  <el-form-item label="operation 终态"
                    ><el-select v-model="step.operationState"
                      ><el-option label="succeeded" value="succeeded" /><el-option
                        label="failed"
                        value="failed" /><el-option
                        label="canceled"
                        value="canceled" /></el-select
                  ></el-form-item>
                </div>
                <div v-else class="sdk-example">
                  <label>只读接入示例</label
                  ><el-input :model-value="sdkExample(step)" type="textarea" readonly />
                </div>
                <div
                  v-if="step.triggerKind === 'operation_terminal'"
                  class="sdk-example"
                >
                  <label>R4-B 目标关联示例（只读）</label>
                  <el-input
                    :model-value="operationExample(step)"
                    type="textarea"
                    :rows="4"
                    readonly
                  />
                  <el-alert
                    type="warning"
                    :closable="false"
                    title="当前 R1-A 只配置定义；关联采集在 R4-B 交付。独立 tracker.startOperation(featureKey) 不能驱动 workflow step。"
                  />
                </div>
                <p class="step-preview">{{ stepPreview(step) }}</p>
                <el-alert
                  v-if="selectorIsFragile(step.triggerKind, step.configValue)"
                  class="workflow-step-guidance"
                  type="warning"
                  :closable="false"
                  show-icon
                  title="普通 class 容易随样式变化而失效；推荐显式 SDK、ID 或 data-fi-action。"
                />
                <div class="mobile-condition-context">
                  <template v-if="activeStepIndex === index">
                    <strong>配置说明</strong
                    ><span
                      >主体：{{
                        workflowConditionContext(step.triggerKind).subject
                      }}</span
                    ><span
                      >判定时机：{{
                        workflowConditionContext(step.triggerKind).timing
                      }}</span
                    ><span
                      >不能推断：{{
                        workflowConditionContext(step.triggerKind).cannotInfer
                      }}</span
                    >
                  </template>
                </div>
                <el-button
                  text
                  type="danger"
                  :disabled="workflowForm.steps.length <= 2"
                  @click.stop="removeStep(index)"
                  >删除步骤</el-button
                >
              </div>
            </article>
          </div>
          <aside v-if="currentStep && currentCondition" class="condition-context">
            <span class="eyebrow">CONTEXT</span>
            <h3>配置说明</h3>
            <strong>{{ triggerLabels[currentStep.triggerKind] }}</strong>
            <dl>
              <dt>主体</dt>
              <dd>{{ currentCondition.subject }}</dd>
              <dt>判定时机</dt>
              <dd>{{ currentCondition.timing }}</dd>
              <dt>填写提示</dt>
              <dd>{{ currentCondition.helper }}</dd>
              <dt>不能推断</dt>
              <dd>{{ currentCondition.cannotInfer }}</dd>
            </dl>
            <p class="step-preview">{{ stepPreview(currentStep) }}</p>
          </aside>
        </div>
        <h3>工作流终态策略</h3>
        <p class="field-helper">
          这里决定整个 workflow 的 completed/failed/canceled；与单个步骤的达成条件分层。
        </p>
        <div class="form-grid three terminal-grid">
          <el-form-item
            label="成功终态步骤（completed）"
            :error="
              workflowValidationVisible ? workflowValidation.completedStepKey : ''
            "
            ><el-select v-model="workflowForm.completedStepKey"
              ><el-option
                v-for="step in workflowForm.steps"
                :key="step.clientId"
                :label="`${step.name || '未命名步骤'} · ${step.stepKey || 'stepKey 未填写'}`"
                :value="step.stepKey" /></el-select
          ></el-form-item>
          <el-form-item
            label="失败终态步骤（可选）"
            :error="workflowValidationVisible ? workflowValidation.failedStepKey : ''"
            ><el-select v-model="workflowForm.failedStepKey" clearable
              ><el-option
                v-for="step in workflowForm.steps"
                :key="step.clientId"
                :label="`${step.name || '未命名步骤'} · ${step.stepKey || 'stepKey 未填写'}`"
                :value="step.stepKey" /></el-select
          ></el-form-item>
          <el-form-item
            label="取消终态步骤（可选）"
            :error="workflowValidationVisible ? workflowValidation.canceledStepKey : ''"
            ><el-select v-model="workflowForm.canceledStepKey" clearable
              ><el-option
                v-for="step in workflowForm.steps"
                :key="step.clientId"
                :label="`${step.name || '未命名步骤'} · ${step.stepKey || 'stepKey 未填写'}`"
                :value="step.stepKey" /></el-select
          ></el-form-item>
        </div>
        <el-alert
          type="info"
          :closable="false"
          title="超时固定为 approximate_abandoned，不显示为业务失败。"
        />
      </el-form>
      <template #footer
        ><el-button @click="workflowOpen = false">取消</el-button
        ><el-button type="primary" :loading="saving" @click="saveWorkflow">{{
          editingWorkflowId ? "保存草稿" : "创建工作流"
        }}</el-button></template
      >
    </el-dialog>
  </div>
</template>

<style scoped>
.analysis-object-tabs {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-bottom: 18px;
  border-bottom: 1px solid var(--border-color, #d9d9d9);
}
.analysis-object-tabs > button {
  padding: 10px 16px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  cursor: pointer;
}
.analysis-object-tabs > button.active {
  border-bottom-color: currentColor;
  color: var(--primary-color, #2f6fed);
  font-weight: 600;
}
.analysis-object-tabs > button:focus-visible,
.help-icon:focus-visible {
  outline: 2px solid var(--primary-color, #2f6fed);
  outline-offset: 2px;
}
.archive-toggle {
  margin-left: auto;
}
.cell-reason,
.field-helper {
  display: block;
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}
.page-master-controls {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr);
  gap: 16px;
  padding: 14px;
  border: 1px solid var(--border-color, #d9d9d9);
  border-radius: 12px;
  background: var(--surface-muted, #f7f8fa);
}
.page-master-controls :deep(.el-form-item) {
  margin: 0;
}
.list-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.unclassified-temporary {
  margin-top: 24px;
  padding: 14px 16px;
  border: 1px dashed var(--border-color, #cbd5e1);
  border-radius: 10px;
}
.unclassified-temporary summary {
  cursor: pointer;
  font-weight: 600;
}
.unclassified-temporary li {
  margin: 8px 0;
}
.route-preview {
  display: block;
  margin-top: 8px;
  color: var(--success-color, #2f855a);
}
.route-preview.invalid {
  color: var(--danger-color, #c53030);
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.form-grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.workflow-steps-preview {
  display: grid;
  gap: 8px;
  padding: 8px 42px;
}
.workflow-steps-preview article {
  display: grid;
  gap: 4px;
}
.workflow-steps-preview span {
  color: var(--text-secondary);
}
.workflow-editor-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  margin-top: 22px;
}
.workflow-editor-heading h3,
.workflow-editor-heading p {
  margin: 0 0 6px;
}
.workflow-editor-heading p {
  color: var(--text-secondary);
}
.workflow-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(250px, 0.34fr);
  gap: 16px;
  align-items: start;
  margin: 14px 0 24px;
}
.workflow-editor-list {
  display: grid;
  gap: 12px;
}
.workflow-editor-step {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border-color, #d9d9d9);
  border-radius: 12px;
}
.workflow-editor-step.current {
  border-color: var(--primary-color, #2f6fed);
}
.step-order {
  display: grid;
  align-content: start;
  justify-items: center;
}
.step-order strong {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-muted, #f5f5f5);
}
.step-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.condition-fields {
  display: grid;
  grid-template-columns: minmax(160px, 0.42fr) minmax(240px, 1fr);
  gap: 10px;
}
.help-icon {
  display: inline-grid;
  width: 20px;
  height: 20px;
  margin-left: 5px;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  background: transparent;
  color: var(--primary-color, #2f6fed);
  cursor: help;
}
.sdk-example {
  display: grid;
  gap: 7px;
  margin-bottom: 14px;
}
.sdk-example label {
  font-weight: 600;
}
.step-preview {
  padding: 10px 12px;
  border-left: 3px solid var(--primary-color, #2f6fed);
  background: var(--surface-muted, #f7f8fa);
  line-height: 1.55;
}
.workflow-step-guidance {
  width: 100%;
  margin-bottom: 10px;
}
.condition-context {
  position: sticky;
  top: 12px;
  padding: 16px;
  border: 1px solid var(--border-color, #d9d9d9);
  border-radius: 12px;
  background: var(--surface-muted, #f7f8fa);
}
.condition-context h3 {
  margin-top: 6px;
}
.condition-context dt {
  margin-top: 12px;
  font-weight: 600;
}
.condition-context dd {
  margin: 3px 0 0;
  color: var(--text-secondary);
  line-height: 1.5;
}
.mobile-condition-context {
  display: none;
}
:global(.r1a-config-dialog) {
  display: flex;
  max-height: calc(100vh - 48px);
  flex-direction: column;
  margin: 0 auto;
}
:global(.r1a-config-dialog .el-dialog__body) {
  min-height: 0;
  overflow-y: auto;
}
:global(.r1a-workflow-dialog .el-dialog__body) {
  padding-top: 10px;
}
@media (max-width: 760px) {
  .page-master-controls,
  .form-grid,
  .form-grid.three,
  .step-fields,
  .condition-fields {
    grid-template-columns: 1fr;
  }
  .workflow-layout {
    grid-template-columns: 1fr;
  }
  .condition-context {
    display: none;
  }
  .mobile-condition-context {
    display: grid;
    gap: 6px;
    margin: 10px 0;
    padding: 12px;
    border-radius: 8px;
    background: var(--surface-muted, #f7f8fa);
  }
  .analysis-object-tabs {
    flex-wrap: wrap;
  }
  .archive-toggle {
    width: 100%;
    margin: 4px 12px 10px;
  }
}
</style>
