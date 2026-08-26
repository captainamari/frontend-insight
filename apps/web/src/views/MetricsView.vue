<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useRoute } from "vue-router";
import { api } from "../api";
import {
  pageRoutePreview,
  selectorIsFragile,
  triggerConfigKey,
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

interface AnalysisObjectsData {
  modules: ProjectModule[];
  pages: PageDefinition[];
  workflows: WorkflowDefinition[];
  unclassified: UnclassifiedRoute[];
}

interface WorkflowStepForm {
  stepKey: string;
  name: string;
  triggerKind: WorkflowTriggerKind;
  configValue: string;
  httpMethod: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

const context = useDashboardContext();
const route = useRoute();
const resource = useRemoteData<AnalysisObjectsData>();
const activeObjectTab = ref(
  ["modules", "pages", "workflows"].includes(String(route.query.object))
    ? String(route.query.object)
    : "modules",
);
const handledCreateQuery = ref(false);
const saving = ref(false);
const moduleOpen = ref(false);
const pageOpen = ref(false);
const workflowOpen = ref(false);
const editingWorkflowId = ref<string | null>(null);

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
  () => resource.data.value?.modules.filter((item) => item.status === "active") ?? [],
);

const moduleForm = reactive({
  moduleKey: "",
  name: "",
  criticalityWeight: 1,
  displayOrder: 0,
});
const pageForm = reactive({
  pageRoute: "",
  moduleId: "",
  name: "",
  templateKey: "analysis_view" as PageTemplate,
  isCore: false,
  criticalityWeight: 1,
  expectedFrequency: "weekly" as ExpectedFrequency,
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
  steps: [
    {
      stepKey: "started",
      name: "开始",
      triggerKind: "explicit_sdk" as WorkflowTriggerKind,
      configValue: "started",
      httpMethod: "POST" as const,
    },
    {
      stepKey: "completed",
      name: "完成",
      triggerKind: "operation_terminal" as WorkflowTriggerKind,
      configValue: "completed",
      httpMethod: "POST" as const,
    },
  ] as WorkflowStepForm[],
});

const normalizedRoute = computed(() => pageRoutePreview(pageForm.pageRoute));
const templateLabels: Record<PageTemplate, string> = {
  monitoring_dashboard: "实时监测 / 驾驶舱",
  analysis_view: "信息分析",
  task_operation: "任务操作",
};
const triggerLabels: Record<WorkflowTriggerKind, string> = {
  explicit_sdk: "显式 SDK action",
  selector: "稳定选择器适配器",
  network_request: "受控网络请求完成",
  page_lifecycle: "页面生命周期",
  operation_terminal: "operation 终态",
};

function moduleName(moduleId: string): string {
  return resource.data.value?.modules.find((item) => item.id === moduleId)?.name ?? "—";
}

function triggerLabel(kind: WorkflowTriggerKind): string {
  return triggerLabels[kind];
}

async function load(): Promise<void> {
  if (!context.projectId.value) return;
  const projectId = context.projectId.value;
  const result = await resource.load(async () => {
    const analytics = context.search.value
      ? api.request<{ unclassified: UnclassifiedRoute[] }>(
          `/api/projects/${projectId}/analytics/modules?${context.search.value}`,
        )
      : Promise.resolve({ unclassified: [] });
    const [modules, pages, workflows, moduleAnalytics] = await Promise.all([
      api.request<ProjectModule[]>(`/api/projects/${projectId}/modules`),
      api.request<PageDefinition[]>(`/api/projects/${projectId}/page-definitions`),
      api.request<WorkflowDefinition[]>(
        `/api/projects/${projectId}/workflow-definitions`,
      ),
      analytics,
    ]);
    return { modules, pages, workflows, unclassified: moduleAnalytics.unclassified };
  });
  if (result) {
    if (!pageForm.moduleId) pageForm.moduleId = result.modules[0]?.id ?? "";
    if (!workflowForm.moduleId) workflowForm.moduleId = result.modules[0]?.id ?? "";
    if (
      !handledCreateQuery.value &&
      canWrite.value &&
      route.query.create === "page" &&
      typeof route.query.pageRoute === "string"
    ) {
      handledCreateQuery.value = true;
      activeObjectTab.value = "pages";
      openPage(route.query.pageRoute);
    }
  }
}

async function mutate(
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  saving.value = true;
  try {
    await operation();
    await load();
    void message;
  } finally {
    saving.value = false;
  }
}

function resetModuleForm(): void {
  moduleForm.moduleKey = "";
  moduleForm.name = "";
  moduleForm.criticalityWeight = 1;
  moduleForm.displayOrder =
    Math.max(
      0,
      ...(resource.data.value?.modules.map((item) => item.displayOrder) ?? [0]),
    ) + 10;
}

async function createModule(): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(`/api/projects/${context.projectId.value}/modules`, {
        method: "POST",
        body: JSON.stringify(moduleForm),
      }),
    "功能模块已创建",
  );
  moduleOpen.value = false;
  resetModuleForm();
}

async function saveModule(item: ProjectModule): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(`/api/projects/${context.projectId.value}/modules/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: item.name,
          criticalityWeight: item.criticalityWeight,
          displayOrder: item.displayOrder,
        }),
      }),
    "功能模块已保存",
  );
}

async function toggleModule(item: ProjectModule): Promise<void> {
  if (!context.projectId.value) return;
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

function openPage(route = ""): void {
  pageForm.pageRoute = route;
  pageForm.moduleId = activeModules.value[0]?.id ?? "";
  pageForm.name = route ? (route.split("/").filter(Boolean).at(-1) ?? "") : "";
  pageForm.templateKey = "analysis_view";
  pageForm.isCore = false;
  pageForm.criticalityWeight = 1;
  pageForm.expectedFrequency = "weekly";
  pageOpen.value = true;
}

async function createPage(): Promise<void> {
  if (!context.projectId.value || !normalizedRoute.value) return;
  await mutate(
    () =>
      api.request(`/api/projects/${context.projectId.value}/page-definitions`, {
        method: "POST",
        body: JSON.stringify(pageForm),
      }),
    "页面定义已创建",
  );
  pageOpen.value = false;
}

async function savePage(item: PageDefinition): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/page-definitions/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            moduleId: item.moduleId,
            name: item.name,
            templateKey: item.templateKey,
            isCore: item.isCore,
            criticalityWeight: item.criticalityWeight,
            expectedFrequency: item.expectedFrequency,
          }),
        },
      ),
    "页面定义已保存",
  );
}

async function togglePage(item: PageDefinition): Promise<void> {
  if (!context.projectId.value) return;
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

function defaultTriggerValue(kind: WorkflowTriggerKind, stepKey: string): string {
  return {
    explicit_sdk: stepKey,
    selector: `[data-fi-action="${stepKey}"]`,
    network_request: "/api/resource",
    page_lifecycle: "loaded",
    operation_terminal: "completed",
  }[kind];
}

function openWorkflow(item?: WorkflowDefinition): void {
  editingWorkflowId.value = item?.id ?? null;
  workflowForm.workflowKey = item?.workflowKey ?? "";
  workflowForm.name = item?.name ?? "";
  workflowForm.moduleId = item?.moduleId ?? activeModules.value[0]?.id ?? "";
  workflowForm.startPolicy = item?.latestVersion?.startPolicy ?? "first_step";
  workflowForm.timeoutSeconds = item?.latestVersion?.timeoutSeconds ?? 900;
  workflowForm.completedStepKey =
    item?.latestVersion?.terminalPolicy.completedStepKey ?? "completed";
  workflowForm.failedStepKey = item?.latestVersion?.terminalPolicy.failedStepKey ?? "";
  workflowForm.canceledStepKey =
    item?.latestVersion?.terminalPolicy.canceledStepKey ?? "";
  workflowForm.steps = item?.latestVersion?.steps.length
    ? item.latestVersion.steps.map((step) => ({
        stepKey: step.stepKey,
        name: step.name,
        triggerKind: step.triggerKind,
        configValue: String(
          step.triggerConfig[triggerConfigKey(step.triggerKind)] ?? "",
        ),
        httpMethod: String(step.triggerConfig.method ?? "POST") as
          "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      }))
    : [
        {
          stepKey: "started",
          name: "开始",
          triggerKind: "explicit_sdk",
          configValue: "started",
          httpMethod: "POST",
        },
        {
          stepKey: "completed",
          name: "完成",
          triggerKind: "operation_terminal",
          configValue: "completed",
          httpMethod: "POST",
        },
      ];
  workflowOpen.value = true;
}

function changeTrigger(step: WorkflowStepForm): void {
  step.configValue = defaultTriggerValue(step.triggerKind, step.stepKey || "step");
}

function addStep(): void {
  if (workflowForm.steps.length >= 20) return;
  let index = workflowForm.steps.length + 1;
  while (workflowForm.steps.some((item) => item.stepKey === `step_${index}`))
    index += 1;
  const stepKey = `step_${index}`;
  workflowForm.steps.push({
    stepKey,
    name: `步骤 ${index}`,
    triggerKind: "explicit_sdk",
    configValue: stepKey,
    httpMethod: "POST",
  });
}

function removeStep(index: number): void {
  if (workflowForm.steps.length <= 2) return;
  workflowForm.steps.splice(index, 1);
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
}

function workflowConfiguration() {
  return {
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
      triggerConfig:
        step.triggerKind === "network_request"
          ? { method: step.httpMethod, pathPattern: step.configValue }
          : { [triggerConfigKey(step.triggerKind)]: step.configValue },
    })),
  };
}

async function saveWorkflow(): Promise<void> {
  if (!context.projectId.value) return;
  const projectId = context.projectId.value;
  const configuration = workflowConfiguration();
  await mutate(
    async () => {
      if (editingWorkflowId.value) {
        await api.request(
          `/api/projects/${projectId}/workflow-definitions/${editingWorkflowId.value}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: workflowForm.name,
              moduleId: workflowForm.moduleId,
            }),
          },
        );
        await api.request(
          `/api/projects/${projectId}/workflow-definitions/${editingWorkflowId.value}/draft`,
          { method: "PUT", body: JSON.stringify(configuration) },
        );
      } else {
        await api.request(`/api/projects/${projectId}/workflow-definitions`, {
          method: "POST",
          body: JSON.stringify({
            workflowKey: workflowForm.workflowKey,
            name: workflowForm.name,
            moduleId: workflowForm.moduleId,
            ...configuration,
          }),
        });
      }
    },
    editingWorkflowId.value ? "工作流草稿已保存" : "工作流已创建",
  );
  workflowOpen.value = false;
}

async function activateWorkflow(item: WorkflowDefinition): Promise<void> {
  if (
    !context.projectId.value ||
    !item.latestVersion ||
    item.latestVersion.status !== "draft"
  ) {
    return;
  }
  await ElMessageBox.confirm(
    `激活 ${item.name} v${item.latestVersion.version}？激活后该版本不可原地编辑。`,
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
  if (!context.projectId.value) return;
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

watch(
  () => [context.projectId.value, context.search.value],
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <div>
    <PageHeader
      eyebrow="METRIC CENTER · R1-A"
      title="指标管理"
      description="分析对象是所有指标、分数和分析页面的统一业务语义来源。"
    >
      <el-button type="primary" :loading="resource.loading.value" @click="load">
        刷新
      </el-button>
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
        <section class="panel metric-center-tabs">
          <el-tabs model-value="analysis-objects">
            <el-tab-pane label="分析对象" name="analysis-objects" />
            <el-tab-pane label="运营指标（R1-B）" name="operations" disabled />
            <el-tab-pane label="质量指标（R1-C）" name="quality" disabled />
            <el-tab-pane label="分数管理（R1-C）" name="scores" disabled />
            <el-tab-pane label="版本库（R1-B）" name="versions" disabled />
          </el-tabs>
          <p class="scope-note">
            本里程碑只开放“分析对象”；工作流事实将在 R4-B 接入，当前不会显示虚假的 0。
          </p>
        </section>

        <section class="panel">
          <div class="analysis-object-tabs" role="tablist" aria-label="分析对象类型">
            <button
              v-for="tab in [
                { name: 'modules', label: '功能模块' },
                { name: 'pages', label: '页面' },
                { name: 'workflows', label: '工作流' },
              ]"
              :key="tab.name"
              type="button"
              role="tab"
              :aria-selected="activeObjectTab === tab.name"
              :tabindex="activeObjectTab === tab.name ? 0 : -1"
              :class="{ active: activeObjectTab === tab.name }"
              @click="activeObjectTab = tab.name"
            >
              {{ tab.label }}
            </button>
          </div>
          <el-tabs v-model="activeObjectTab" class="object-tabs">
            <el-tab-pane label="功能模块" name="modules">
              <div class="section-heading">
                <div>
                  <span class="eyebrow">FUNCTION MODULES</span>
                  <h2>功能模块</h2>
                  <p>稳定业务分组；不从 URL 自动推断，可排序和停用。</p>
                </div>
                <el-button
                  v-if="canWrite"
                  type="primary"
                  @click="
                    resetModuleForm();
                    moduleOpen = true;
                  "
                >
                  新建功能模块
                </el-button>
              </div>
              <el-table
                :data="resource.data.value.modules"
                row-key="id"
                empty-text="尚未配置功能模块"
              >
                <el-table-column label="名称" min-width="190">
                  <template #default="{ row }">
                    <el-input v-model="row.name" :disabled="!canWrite" />
                  </template>
                </el-table-column>
                <el-table-column prop="moduleKey" label="moduleKey" min-width="180" />
                <el-table-column label="关键度" width="130">
                  <template #default="{ row }">
                    <el-input-number
                      v-model="row.criticalityWeight"
                      :disabled="!canWrite"
                      :min="0.1"
                      :max="100"
                      :step="0.1"
                    />
                  </template>
                </el-table-column>
                <el-table-column label="顺序" width="120">
                  <template #default="{ row }">
                    <el-input-number
                      v-model="row.displayOrder"
                      :disabled="!canWrite"
                      :min="-10000"
                      :max="10000"
                    />
                  </template>
                </el-table-column>
                <el-table-column label="状态 / 操作" min-width="210">
                  <template #default="{ row }">
                    <el-tag :type="row.status === 'active' ? 'success' : 'info'">
                      {{ row.status === "active" ? "启用" : "停用" }}
                    </el-tag>
                    <template v-if="canWrite">
                      <el-button link type="primary" @click="saveModule(row)">
                        保存
                      </el-button>
                      <el-button link @click="toggleModule(row)">
                        {{ row.status === "active" ? "停用" : "启用" }}
                      </el-button>
                    </template>
                  </template>
                </el-table-column>
              </el-table>
            </el-tab-pane>

            <el-tab-pane label="页面" name="pages">
              <div class="section-heading">
                <div>
                  <span class="eyebrow">PAGE DEFINITIONS</span>
                  <h2>页面定义</h2>
                  <p>route 在保存前归一化；动态 ID 不会制造高基数页面。</p>
                </div>
                <el-button v-if="canWrite" type="primary" @click="openPage()">
                  新建页面定义
                </el-button>
              </div>
              <el-table :data="resource.data.value.pages" row-key="id">
                <el-table-column label="页面" min-width="250">
                  <template #default="{ row }">
                    <el-input v-model="row.name" :disabled="!canWrite" />
                    <small class="cell-reason">{{ row.pageRoute }}</small>
                  </template>
                </el-table-column>
                <el-table-column label="功能模块" min-width="180">
                  <template #default="{ row }">
                    <el-select v-model="row.moduleId" :disabled="!canWrite">
                      <el-option
                        v-for="module in resource.data.value.modules"
                        :key="module.id"
                        :label="module.name"
                        :value="module.id"
                      />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="模板" min-width="190">
                  <template #default="{ row }">
                    <el-select v-model="row.templateKey" :disabled="!canWrite">
                      <el-option
                        v-for="(label, value) in templateLabels"
                        :key="value"
                        :label="label"
                        :value="value"
                      />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="核心" width="90">
                  <template #default="{ row }">
                    <el-switch v-model="row.isCore" :disabled="!canWrite" />
                  </template>
                </el-table-column>
                <el-table-column label="状态 / 操作" min-width="210">
                  <template #default="{ row }">
                    <el-tag :type="row.status === 'active' ? 'success' : 'info'">
                      {{ row.status === "active" ? "启用" : "停用" }}
                    </el-tag>
                    <template v-if="canWrite">
                      <el-button link type="primary" @click="savePage(row)">
                        保存
                      </el-button>
                      <el-button link @click="togglePage(row)">
                        {{ row.status === "active" ? "停用" : "启用" }}
                      </el-button>
                    </template>
                  </template>
                </el-table-column>
              </el-table>

              <div class="section-heading unclassified-heading">
                <div>
                  <span class="eyebrow">UNCLASSIFIED ROUTES</span>
                  <h3>未归类 route</h3>
                  <p>仍保留访问证据，但不进入功能模块聚合或分数。</p>
                </div>
              </div>
              <el-table
                :data="resource.data.value.unclassified"
                empty-text="当前范围没有未归类 route"
              >
                <el-table-column prop="pageRoute" label="pageRoute" min-width="280" />
                <el-table-column prop="pageViews" label="PV" width="100" />
                <el-table-column label="操作" width="150">
                  <template #default="{ row }">
                    <el-button
                      v-if="canWrite"
                      link
                      type="primary"
                      @click="openPage(row.pageRoute)"
                    >
                      创建页面定义
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-tab-pane>

            <el-tab-pane label="工作流" name="workflows">
              <div class="section-heading">
                <div>
                  <span class="eyebrow">WORKFLOW DEFINITIONS</span>
                  <h2>工作流定义</h2>
                  <p>2–20 个有序步骤；定义与版本可配置，事实数据将在 R4-B 接入。</p>
                </div>
                <el-button v-if="canWrite" type="primary" @click="openWorkflow()">
                  新建工作流
                </el-button>
              </div>
              <el-table
                :data="resource.data.value.workflows"
                row-key="id"
                empty-text="尚未配置工作流"
              >
                <el-table-column type="expand">
                  <template #default="{ row }">
                    <div class="workflow-steps-preview">
                      <div
                        v-for="step in row.latestVersion?.steps ?? []"
                        :key="step.id"
                        class="workflow-step-chip"
                      >
                        <strong>{{ step.stepOrder }}. {{ step.name }}</strong>
                        <span
                          >{{ step.stepKey }} ·
                          {{ triggerLabel(step.triggerKind) }}</span
                        >
                      </div>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="工作流" min-width="220">
                  <template #default="{ row }">
                    <strong>{{ row.name }}</strong>
                    <small class="cell-reason">{{ row.workflowKey }}</small>
                  </template>
                </el-table-column>
                <el-table-column label="功能模块" min-width="170">
                  <template #default="{ row }">{{ moduleName(row.moduleId) }}</template>
                </el-table-column>
                <el-table-column label="最新版本" width="150">
                  <template #default="{ row }">
                    <span v-if="row.latestVersion">
                      v{{ row.latestVersion.version }} · {{ row.latestVersion.status }}
                    </span>
                    <span v-else>—</span>
                  </template>
                </el-table-column>
                <el-table-column label="步骤" width="90">
                  <template #default="{ row }">
                    {{ row.latestVersion?.steps.length ?? 0 }}
                  </template>
                </el-table-column>
                <el-table-column label="状态 / 操作" min-width="270">
                  <template #default="{ row }">
                    <el-tag :type="row.status === 'active' ? 'success' : 'info'">
                      {{ row.status === "active" ? "启用" : "停用" }}
                    </el-tag>
                    <template v-if="canWrite">
                      <el-button link type="primary" @click="openWorkflow(row)">
                        编辑草稿
                      </el-button>
                      <el-button
                        v-if="row.latestVersion?.status === 'draft'"
                        link
                        type="primary"
                        @click="activateWorkflow(row)"
                      >
                        激活
                      </el-button>
                      <el-button link @click="toggleWorkflow(row)">
                        {{ row.status === "active" ? "停用" : "启用" }}
                      </el-button>
                    </template>
                  </template>
                </el-table-column>
              </el-table>
            </el-tab-pane>
          </el-tabs>
        </section>
      </template>
    </StatePanel>

    <el-dialog v-model="moduleOpen" title="新建功能模块" width="520px">
      <el-form label-position="top">
        <el-form-item label="moduleKey">
          <el-input v-model="moduleForm.moduleKey" placeholder="energy_management" />
        </el-form-item>
        <el-form-item label="功能模块名称">
          <el-input v-model="moduleForm.name" placeholder="能源管理" />
        </el-form-item>
        <el-form-item label="关键度权重">
          <el-input-number
            v-model="moduleForm.criticalityWeight"
            :min="0.1"
            :max="100"
          />
        </el-form-item>
        <el-form-item label="展示顺序">
          <el-input-number v-model="moduleForm.displayOrder" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="moduleOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="createModule">
          创建
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pageOpen" title="新建页面定义" width="640px">
      <el-form label-position="top">
        <el-form-item label="观测或模板 route">
          <el-input v-model="pageForm.pageRoute" placeholder="/orders/123" />
          <small v-if="normalizedRoute" class="route-preview">
            保存为：{{ normalizedRoute }}
          </small>
          <small v-else class="route-preview invalid">
            route 必须以 / 开头，且不能包含 query 或 hash。
          </small>
        </el-form-item>
        <el-form-item label="页面名称">
          <el-input v-model="pageForm.name" />
        </el-form-item>
        <el-form-item label="所属功能模块">
          <el-select v-model="pageForm.moduleId">
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
            <el-select v-model="pageForm.templateKey">
              <el-option
                v-for="(label, value) in templateLabels"
                :key="value"
                :label="label"
                :value="value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="预期使用频率">
            <el-select v-model="pageForm.expectedFrequency">
              <el-option label="每天" value="daily" />
              <el-option label="每周" value="weekly" />
              <el-option label="每月" value="monthly" />
              <el-option label="按需" value="ad_hoc" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="关键度权重">
          <el-input-number v-model="pageForm.criticalityWeight" :min="0.1" :max="100" />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="pageForm.isCore">核心页面</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pageOpen = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!normalizedRoute"
          :loading="saving"
          @click="createPage"
        >
          创建
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="workflowOpen"
      :title="editingWorkflowId ? '编辑工作流草稿' : '新建工作流'"
      width="min(980px, 92vw)"
      destroy-on-close
    >
      <el-form label-position="top">
        <div class="form-grid three">
          <el-form-item label="workflowKey">
            <el-input
              v-model="workflowForm.workflowKey"
              :disabled="Boolean(editingWorkflowId)"
              placeholder="admin_model_download"
            />
          </el-form-item>
          <el-form-item label="工作流名称">
            <el-input v-model="workflowForm.name" placeholder="后台模型下载" />
          </el-form-item>
          <el-form-item label="所属功能模块">
            <el-select v-model="workflowForm.moduleId">
              <el-option
                v-for="module in activeModules"
                :key="module.id"
                :label="module.name"
                :value="module.id"
              />
            </el-select>
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="开始策略">
            <el-select v-model="workflowForm.startPolicy">
              <el-option label="首步骤自动创建匿名实例" value="first_step" />
              <el-option label="显式 SDK 创建匿名实例" value="explicit_sdk" />
            </el-select>
          </el-form-item>
          <el-form-item label="整体超时（秒）">
            <el-input-number
              v-model="workflowForm.timeoutSeconds"
              :min="30"
              :max="604800"
            />
          </el-form-item>
        </div>

        <div class="workflow-editor-heading">
          <div>
            <h3>有序步骤</h3>
            <p>推荐显式 SDK 或 data-fi-action；不采集 DOM 文本。</p>
          </div>
          <el-button plain :disabled="workflowForm.steps.length >= 20" @click="addStep">
            添加步骤
          </el-button>
        </div>
        <div class="workflow-editor-list">
          <article
            v-for="(step, index) in workflowForm.steps"
            :key="`${index}-${step.stepKey}`"
            class="workflow-editor-step"
          >
            <div class="step-order">
              <strong>{{ index + 1 }}</strong>
              <el-button text :disabled="index === 0" @click="moveStep(index, -1)">
                ↑
              </el-button>
              <el-button
                text
                :disabled="index === workflowForm.steps.length - 1"
                @click="moveStep(index, 1)"
              >
                ↓
              </el-button>
            </div>
            <div class="step-fields">
              <el-form-item label="stepKey">
                <el-input v-model="step.stepKey" />
              </el-form-item>
              <el-form-item label="步骤名称">
                <el-input v-model="step.name" />
              </el-form-item>
              <el-form-item label="触发类型">
                <el-select v-model="step.triggerKind" @change="changeTrigger(step)">
                  <el-option
                    v-for="(label, value) in triggerLabels"
                    :key="value"
                    :label="label"
                    :value="value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item v-if="step.triggerKind === 'network_request'" label="方法">
                <el-select v-model="step.httpMethod">
                  <el-option
                    v-for="method in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']"
                    :key="method"
                    :label="method"
                    :value="method"
                  />
                </el-select>
              </el-form-item>
              <el-form-item
                :label="
                  step.triggerKind === 'selector'
                    ? '选择器'
                    : step.triggerKind === 'network_request'
                      ? '路径模式'
                      : '受控值'
                "
              >
                <el-select
                  v-if="step.triggerKind === 'page_lifecycle'"
                  v-model="step.configValue"
                >
                  <el-option label="加载完成" value="loaded" />
                  <el-option label="刷新" value="refreshed" />
                </el-select>
                <el-select
                  v-else-if="step.triggerKind === 'operation_terminal'"
                  v-model="step.configValue"
                >
                  <el-option label="成功" value="completed" />
                  <el-option label="失败" value="failed" />
                  <el-option label="取消" value="canceled" />
                </el-select>
                <el-input v-else v-model="step.configValue" />
              </el-form-item>
            </div>
            <el-alert
              v-if="selectorIsFragile(step.triggerKind, step.configValue)"
              type="warning"
              :closable="false"
              show-icon
              title="普通 class 容易随样式变化而失效；推荐显式 SDK、ID 或 data-fi-action。"
            />
            <el-button
              text
              type="danger"
              :disabled="workflowForm.steps.length <= 2"
              @click="removeStep(index)"
            >
              删除步骤
            </el-button>
          </article>
        </div>

        <div class="form-grid three terminal-grid">
          <el-form-item label="成功终态步骤">
            <el-select v-model="workflowForm.completedStepKey">
              <el-option
                v-for="step in workflowForm.steps"
                :key="step.stepKey"
                :label="step.name || step.stepKey"
                :value="step.stepKey"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="失败终态步骤（可选）">
            <el-select v-model="workflowForm.failedStepKey" clearable>
              <el-option
                v-for="step in workflowForm.steps"
                :key="step.stepKey"
                :label="step.name || step.stepKey"
                :value="step.stepKey"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="取消终态步骤（可选）">
            <el-select v-model="workflowForm.canceledStepKey" clearable>
              <el-option
                v-for="step in workflowForm.steps"
                :key="step.stepKey"
                :label="step.name || step.stepKey"
                :value="step.stepKey"
              />
            </el-select>
          </el-form-item>
        </div>
        <el-alert
          type="info"
          :closable="false"
          title="超时终态固定为 approximate_abandoned；点击或请求完成不会被静默当作业务成功。"
        />
      </el-form>
      <template #footer>
        <el-button @click="workflowOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveWorkflow">
          {{ editingWorkflowId ? "保存草稿" : "创建工作流" }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.metric-center-tabs {
  margin-bottom: 18px;
}

.scope-note,
.workflow-editor-heading p {
  margin: 0;
  color: var(--text-secondary);
}

.analysis-object-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 18px;
  border-bottom: 1px solid var(--border-color, #d9d9d9);
}

.analysis-object-tabs button {
  padding: 10px 16px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  cursor: pointer;
}

.analysis-object-tabs button:hover,
.analysis-object-tabs button:focus-visible,
.analysis-object-tabs button.active {
  color: var(--primary-color, #2f6fed);
}

.analysis-object-tabs button:focus-visible {
  outline: 2px solid var(--primary-color, #2f6fed);
  outline-offset: 2px;
}

.analysis-object-tabs button.active {
  border-bottom-color: currentColor;
  font-weight: 600;
}

.object-tabs :deep(.el-tabs__header) {
  display: none;
}

.object-tabs :deep(.el-tabs__content) {
  overflow: visible;
}

.unclassified-heading,
.workflow-editor-heading {
  margin-top: 28px;
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
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 42px;
}

.workflow-step-chip {
  display: grid;
  gap: 3px;
  min-width: 190px;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #d9d9d9);
  border-radius: 10px;
}

.workflow-step-chip span {
  color: var(--text-secondary);
  font-size: 12px;
}

.workflow-editor-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
}

.workflow-editor-heading h3 {
  margin: 0 0 6px;
}

.workflow-editor-list {
  display: grid;
  gap: 12px;
  margin: 14px 0 20px;
}

.workflow-editor-step {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  padding: 14px;
  border: 1px solid var(--border-color, #d9d9d9);
  border-radius: 12px;
}

.step-order {
  display: grid;
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.step-fields :deep(.el-form-item) {
  margin-bottom: 0;
}

.terminal-grid {
  margin-top: 8px;
}

@media (max-width: 900px) {
  .form-grid,
  .form-grid.three,
  .step-fields {
    grid-template-columns: 1fr;
  }

  .workflow-editor-step {
    grid-template-columns: 48px minmax(0, 1fr);
  }
}
</style>
