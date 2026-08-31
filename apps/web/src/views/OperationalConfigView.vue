<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { api } from "../api";
import { auth } from "../auth";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import { useDashboardContext } from "../context";
import { formatDateTime, formatNumber, formatPercent } from "../range";
import { useRemoteData } from "../remote";
import type {
  Feature,
  MetricDefinition,
  MetricProfile,
  MetricProfileItem,
  OperationalOverviewResponse,
  PageDefinition,
  PageTemplate,
  ProjectModule,
  ProjectOperationalSettings,
} from "../types";

interface ConfigData {
  modules: ProjectModule[];
  pages: PageDefinition[];
  features: Feature[];
  settings: {
    active: ProjectOperationalSettings | null;
    versions: ProjectOperationalSettings[];
  };
  profiles: MetricProfile[];
  definitions: MetricDefinition[];
  baseline: OperationalOverviewResponse;
}

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const resource = useRemoteData<ConfigData>();
const saving = ref(false);
const moduleOpen = ref(false);
const pageOpen = ref(false);
const analysisObjectsMoved = true;
const profileItems = ref<MetricProfileItem[]>([]);
const canWrite = computed(
  () =>
    auth.state.user?.globalRole === "admin" &&
    ["owner", "admin"].includes(context.project.value?.role ?? ""),
);
const activeProfile = computed(() =>
  resource.data.value?.profiles.find((profile) => profile.status === "active"),
);
const drafts = computed(
  () =>
    resource.data.value?.profiles.filter((profile) => profile.status === "draft") ?? [],
);
const profileImpact = computed(() => {
  const enabled = profileItems.value.filter((item) => item.enabled);
  const dimensions = new Map<string, number>();
  for (const item of enabled) dimensions.set(item.dimensionKey, item.dimensionWeight);
  return {
    enabledMetrics: enabled.length,
    enabledDimensions: dimensions.size,
    configuredLeafWeight: enabled.reduce(
      (sum, item) => sum + item.dimensionWeight * item.metricWeight,
      0,
    ),
  };
});
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

const moduleForm = reactive({
  moduleKey: "",
  name: "",
  displayOrder: 0,
});
const pageForm = reactive({
  pageRoute: typeof route.query.pageRoute === "string" ? route.query.pageRoute : "",
  moduleId: "",
  name: "",
  templateKey: "analysis_view" as PageTemplate,
  isCore: false,
  criticalityWeight: 1,
  expectedFrequency: "weekly",
});
const settingsForm = reactive({
  targetUsers: null as number | null,
  expectedActiveWeekdays: [1, 2, 3, 4, 5] as number[],
});
const weekdayOptions = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 7, label: "周日" },
];
const templateLabels: Record<PageTemplate, string> = {
  monitoring_dashboard: "实时监测 / 驾驶舱",
  analysis_view: "信息分析",
  task_operation: "任务操作",
};
const templateGuidance: Array<{
  key: PageTemplate;
  focus: string;
  duration: string;
  depth: string;
}> = [
  {
    key: "monitoring_dashboard",
    focus: "持续展示、活跃日与数据就绪",
    duration: "目标区间或有上限的越高越好",
    depth: "单页面会话可完全健康，不因低深度扣分",
  },
  {
    key: "analysis_view",
    focus: "阅读分析、探索范围与持续使用",
    duration: "目标区间；过短或过长都只表示待调查",
    depth: "按页面数和模块广度目标区间解释",
  },
  {
    key: "task_operation",
    focus: "任务达成、不利终态与操作耗时",
    duration: "越低越好或目标区间",
    depth: "关注任务前是否需要过多跳转",
  },
];
const scoreDirectionLabels: Record<MetricDefinition["scoreDirection"], string> = {
  higher_better: "越高越好",
  lower_better: "越低越好",
  target_range: "目标区间",
  none: "不参与评分",
};

function definitionFor(metricKey: string): MetricDefinition | undefined {
  return resource.data.value?.definitions.find(
    (definition) => definition.metricKey === metricKey,
  );
}

function syncForms(data: ConfigData): void {
  if (data.settings.active) {
    settingsForm.targetUsers = data.settings.active.targetUsers;
    settingsForm.expectedActiveWeekdays = [
      ...data.settings.active.expectedActiveWeekdays,
    ];
  }
  const active = data.profiles.find((profile) => profile.status === "active");
  profileItems.value = active ? active.items.map((item) => ({ ...item })) : [];
  if (!pageForm.moduleId) {
    pageForm.moduleId = data.modules.find((item) => item.status === "active")?.id ?? "";
  }
}

async function load(): Promise<void> {
  if (!context.projectId.value || !context.search.value) return;
  const projectId = context.projectId.value;
  const range = context.search.value;
  const result = await resource.load(async () => {
    const [modules, pages, features, settings, profiles, definitions, baseline] =
      await Promise.all([
        api.request<ProjectModule[]>(`/api/projects/${projectId}/modules`),
        api.request<PageDefinition[]>(`/api/projects/${projectId}/page-definitions`),
        api.request<Feature[]>(`/api/projects/${projectId}/features`),
        api.request<ConfigData["settings"]>(
          `/api/projects/${projectId}/operational-settings`,
        ),
        api.request<MetricProfile[]>(`/api/projects/${projectId}/metric-profiles`),
        api.request<MetricDefinition[]>(`/api/projects/${projectId}/metrics`),
        api.request<OperationalOverviewResponse>(
          `/api/projects/${projectId}/analytics/operational-overview?${range}`,
        ),
      ]);
    return {
      modules,
      pages,
      features,
      settings,
      profiles,
      definitions,
      baseline,
    };
  });
  if (result) syncForms(result);
}

async function mutate(operation: () => Promise<unknown>, message: string) {
  saving.value = true;
  try {
    await operation();
    await load();
    void message;
  } finally {
    saving.value = false;
  }
}

async function createModule(): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(`/api/projects/${context.projectId.value}/modules`, {
        method: "POST",
        body: JSON.stringify(moduleForm),
      }),
    "模块已创建",
  );
  moduleOpen.value = false;
  moduleForm.moduleKey = "";
  moduleForm.name = "";
}

async function createPage(): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(`/api/projects/${context.projectId.value}/page-definitions`, {
        method: "POST",
        body: JSON.stringify(pageForm),
      }),
    "页面定义已创建",
  );
  pageOpen.value = false;
  pageForm.pageRoute = "";
  pageForm.name = "";
}

async function toggleModule(item: ProjectModule): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(`/api/projects/${context.projectId.value}/modules/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: item.status === "active" ? "disabled" : "active",
        }),
      }),
    "模块状态已更新",
  );
}

async function saveModule(item: ProjectModule): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(`/api/projects/${context.projectId.value}/modules/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: item.name,
          displayOrder: item.displayOrder,
        }),
      }),
    "模块已更新",
  );
}

async function togglePage(item: PageDefinition): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/page-definitions/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: item.status === "active" ? "disabled" : "active",
            effectiveFrom: new Date().toISOString(),
          }),
        },
      ),
    "页面状态已更新",
  );
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
            effectiveFrom: new Date().toISOString(),
          }),
        },
      ),
    "页面定义已更新",
  );
}

async function saveTask(item: Feature): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(`/api/projects/${context.projectId.value}/features/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          pageDefinitionId: item.pageDefinitionId,
          isKeyTask: item.isKeyTask,
          taskWeight: item.taskWeight,
          taskTimeoutSeconds: item.taskTimeoutSeconds,
          operationLifecycleEnabled: item.operationLifecycleEnabled,
          configurationEffectiveFrom: new Date().toISOString(),
        }),
      }),
    "任务元数据已创建新生效边界",
  );
}

async function saveSettings(): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/operational-settings/versions`,
        {
          method: "POST",
          body: JSON.stringify({
            targetUsers: settingsForm.targetUsers,
            expectedActiveWeekdays: settingsForm.expectedActiveWeekdays,
          }),
        },
      ),
    "目标与业务日历已创建新版本",
  );
}

async function createDefaultProfile(): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(`/api/projects/${context.projectId.value}/metric-profiles`, {
        method: "POST",
        body: JSON.stringify({
          profileKey: "operational_v1",
          name: "智慧园区运营指数 v1",
          templateKey: "operational_v1",
        }),
      }),
    "默认 profile 草稿已创建",
  );
}

function profilePayload() {
  return profileItems.value.map(({ id: _id, profileId: _profileId, ...item }) => {
    void _id;
    void _profileId;
    return item;
  });
}

async function cloneProfile(): Promise<void> {
  if (!context.projectId.value || !activeProfile.value) return;
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/metric-profiles/${activeProfile.value!.id}/versions`,
        {
          method: "POST",
          body: JSON.stringify({
            name: `${activeProfile.value!.name} 调整版`,
            items: profilePayload(),
          }),
        },
      ),
    "权重与目标已保存为草稿新版本，历史版本未被改写",
  );
}

async function activateProfile(profile: MetricProfile): Promise<void> {
  if (!context.projectId.value) return;
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/metric-profiles/${profile.id}/activate`,
        { method: "POST", body: "{}" },
      ),
    `profile v${profile.version} 已激活`,
  );
}

async function retireProfile(profile: MetricProfile): Promise<void> {
  if (!context.projectId.value) return;
  try {
    await ElMessageBox.confirm(
      profile.status === "active"
        ? "停用当前 profile 后，项目运营指数将不再生成总分，直到激活新版本。历史版本和原始数据会保留。"
        : "废弃这个草稿？已保存的历史版本不会被删除。",
      profile.status === "active" ? "停用当前 profile" : "废弃草稿",
      {
        confirmButtonText: "确认",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
  } catch {
    return;
  }
  await mutate(
    () =>
      api.request(
        `/api/projects/${context.projectId.value}/metric-profiles/${profile.id}`,
        { method: "DELETE" },
      ),
    profile.status === "active" ? "当前 profile 已停用" : "草稿已废弃",
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
      eyebrow="OPERATIONAL CONFIGURATION"
      title="运营指标配置"
      description="注册稳定的模块、页面和关键任务，并用版本化目标定义项目运营指数。"
    >
      <el-button
        plain
        @click="router.push({ name: 'operational-index', query: route.query })"
      >
        返回项目运营指数
      </el-button>
      <el-button type="primary" @click="load">刷新配置</el-button>
    </PageHeader>

    <el-alert
      type="warning"
      :closable="false"
      show-icon
      title="功能模块与页面定义已迁移到“指标管理 → 分析对象”；此处只保留旧运营目标和 profile 的阶段性配置。"
    >
      <el-button
        link
        type="primary"
        @click="
          router.push({
            name: 'project-metrics',
            params: { projectId: context.projectId.value },
            query: {
              range: context.preset.value,
              tab: 'analysis-objects',
              object: 'modules',
            },
          })
        "
      >
        前往分析对象
      </el-button>
    </el-alert>

    <el-alert
      v-if="!canWrite"
      type="info"
      :closable="false"
      show-icon
      title="当前账号为只读权限；可以查看版本、目标和权重，但不能修改。"
    />

    <StatePanel
      :state="viewState"
      title="运营配置暂不可用"
      :message="resource.error.value?.message"
      :request-id="resource.error.value?.requestId"
      @retry="load"
    >
      <template v-if="resource.data.value">
        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">BUSINESS TAXONOMY</span>
              <h2>模块</h2>
              <p>模块必须显式注册，不能从 URL 第一段自动推断。</p>
            </div>
            <el-button
              v-if="canWrite && !analysisObjectsMoved"
              @click="moduleOpen = true"
            >
              新建模块
            </el-button>
          </div>
          <el-table :data="resource.data.value.modules" empty-text="尚未配置模块">
            <el-table-column label="模块" min-width="180">
              <template #default="{ row }">
                <el-input
                  v-model="row.name"
                  :disabled="analysisObjectsMoved || !canWrite"
                />
              </template>
            </el-table-column>
            <el-table-column prop="moduleKey" label="moduleKey" min-width="170" />
            <el-table-column label="顺序" width="120">
              <template #default="{ row }">
                <el-input-number
                  v-model="row.displayOrder"
                  :disabled="analysisObjectsMoved || !canWrite"
                  :min="-10000"
                  :max="10000"
                />
              </template>
            </el-table-column>
            <el-table-column label="状态 / 操作" min-width="190">
              <template #default="{ row }">
                <el-tag :type="row.status === 'active' ? 'success' : 'info'">
                  {{ row.status === "active" ? "启用" : "停用" }}
                </el-tag>
                <el-button
                  v-if="canWrite && !analysisObjectsMoved"
                  link
                  type="primary"
                  @click="saveModule(row)"
                >
                  保存
                </el-button>
                <el-button
                  v-if="canWrite && !analysisObjectsMoved"
                  link
                  type="primary"
                  @click="toggleModule(row)"
                >
                  {{ row.status === "active" ? "停用" : "启用" }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">PAGE DEFINITIONS</span>
              <h2>页面</h2>
              <p>route、模板、核心标记和关键度共同决定运营口径。</p>
            </div>
            <el-button
              v-if="canWrite && !analysisObjectsMoved"
              @click="pageOpen = true"
            >
              新建页面定义
            </el-button>
          </div>
          <div class="template-guidance-grid" aria-label="页面模板业务解释">
            <article v-for="item in templateGuidance" :key="item.key">
              <strong>{{ templateLabels[item.key] }}</strong>
              <span>{{ item.focus }}</span>
              <small>时长：{{ item.duration }}</small>
              <small>深度：{{ item.depth }}</small>
            </article>
          </div>
          <el-table :data="resource.data.value.pages" empty-text="尚未配置页面">
            <el-table-column label="页面" min-width="240" fixed>
              <template #default="{ row }">
                <el-input
                  v-model="row.name"
                  :disabled="analysisObjectsMoved || !canWrite"
                />
                <small class="cell-reason">{{ row.pageRoute }}</small>
              </template>
            </el-table-column>
            <el-table-column label="模块" min-width="180">
              <template #default="{ row }">
                <el-select
                  v-model="row.moduleId"
                  :disabled="analysisObjectsMoved || !canWrite"
                >
                  <el-option
                    v-for="module in resource.data.value?.modules"
                    :key="module.id"
                    :label="module.name"
                    :value="module.id"
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="模板" min-width="210">
              <template #default="{ row }">
                <el-select
                  v-model="row.templateKey"
                  :disabled="analysisObjectsMoved || !canWrite"
                >
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
                <el-switch
                  v-model="row.isCore"
                  :disabled="analysisObjectsMoved || !canWrite"
                />
              </template>
            </el-table-column>
            <el-table-column label="关键度" width="130">
              <template #default="{ row }">
                <el-input-number
                  v-model="row.criticalityWeight"
                  :disabled="analysisObjectsMoved || !canWrite"
                  :min="0.1"
                  :max="100"
                  :step="0.1"
                />
              </template>
            </el-table-column>
            <el-table-column label="预期频率" width="130">
              <template #default="{ row }">
                <el-select
                  v-model="row.expectedFrequency"
                  :disabled="analysisObjectsMoved || !canWrite"
                >
                  <el-option label="每天" value="daily" />
                  <el-option label="每周" value="weekly" />
                  <el-option label="每月" value="monthly" />
                  <el-option label="按需" value="ad_hoc" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="状态 / 操作" min-width="190">
              <template #default="{ row }">
                <el-tag :type="row.status === 'active' ? 'success' : 'info'">
                  {{ row.status === "active" ? "启用" : "停用" }}
                </el-tag>
                <el-button
                  v-if="canWrite && !analysisObjectsMoved"
                  link
                  type="primary"
                  @click="savePage(row)"
                >
                  保存
                </el-button>
                <el-button
                  v-if="canWrite && !analysisObjectsMoved"
                  link
                  type="primary"
                  @click="togglePage(row)"
                >
                  {{ row.status === "active" ? "停用" : "启用" }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">KEY TASKS</span>
              <h2>功能与任务元数据</h2>
              <p>启用 v2 operation 后，并发实例按随机 ID 独立配对。</p>
            </div>
          </div>
          <el-table :data="resource.data.value.features" empty-text="尚无功能定义">
            <el-table-column label="功能" min-width="170">
              <template #default="{ row }">
                <strong>{{ row.name }}</strong>
                <small class="cell-reason">{{ row.featureKey }}</small>
              </template>
            </el-table-column>
            <el-table-column label="所属页面" min-width="190">
              <template #default="{ row }">
                <el-select
                  v-model="row.pageDefinitionId"
                  :disabled="!canWrite"
                  clearable
                  placeholder="未绑定"
                >
                  <el-option
                    v-for="page in resource.data.value?.pages"
                    :key="page.id"
                    :label="page.name"
                    :value="page.id"
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="关键任务" width="105">
              <template #default="{ row }">
                <el-switch v-model="row.isKeyTask" :disabled="!canWrite" />
              </template>
            </el-table-column>
            <el-table-column label="权重" width="110">
              <template #default="{ row }">
                <el-input-number
                  v-model="row.taskWeight"
                  :disabled="!canWrite"
                  :min="0.1"
                  :max="100"
                  :step="0.1"
                  controls-position="right"
                />
              </template>
            </el-table-column>
            <el-table-column label="超时（秒）" width="130">
              <template #default="{ row }">
                <el-input-number
                  v-model="row.taskTimeoutSeconds"
                  :disabled="!canWrite"
                  :min="30"
                  :max="86400"
                  controls-position="right"
                />
              </template>
            </el-table-column>
            <el-table-column label="v2 实例" width="100">
              <template #default="{ row }">
                <el-switch
                  v-model="row.operationLifecycleEnabled"
                  :disabled="!canWrite"
                />
              </template>
            </el-table-column>
            <el-table-column v-if="canWrite" label="操作" width="90">
              <template #default="{ row }">
                <el-button link type="primary" @click="saveTask(row)"> 保存 </el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">VERSIONED TARGETS</span>
              <h2>目标账号与业务日历</h2>
              <p>历史活跃账号仅作为参考；保存会创建新版本，不自动改写业务目标。</p>
            </div>
          </div>
          <el-alert
            type="info"
            :closable="false"
            show-icon
            :title="`历史参考（当前筛选）：有效活跃账号 ${formatNumber(resource.data.value.baseline.summary.activeUsers)}；活跃日 ${resource.data.value.baseline.summary.activeExpectedDays} / ${resource.data.value.baseline.summary.expectedActiveDays}。参考值不会自动改写业务目标。`"
          />
          <el-form class="operational-form" label-position="top">
            <el-form-item label="目标账号数">
              <el-input-number
                v-model="settingsForm.targetUsers"
                :disabled="!canWrite"
                :min="1"
                :max="100000000"
                placeholder="未配置"
              />
            </el-form-item>
            <el-form-item label="预期活跃日">
              <el-checkbox-group
                v-model="settingsForm.expectedActiveWeekdays"
                :disabled="!canWrite"
              >
                <el-checkbox
                  v-for="weekday in weekdayOptions"
                  :key="weekday.value"
                  :value="weekday.value"
                >
                  {{ weekday.label }}
                </el-checkbox>
              </el-checkbox-group>
            </el-form-item>
            <el-form-item v-if="canWrite">
              <el-button type="primary" :loading="saving" @click="saveSettings">
                保存为新版本
              </el-button>
            </el-form-item>
          </el-form>
          <el-table :data="resource.data.value.settings.versions" size="small">
            <el-table-column prop="version" label="版本" width="80" />
            <el-table-column prop="targetUsers" label="目标账号" width="110" />
            <el-table-column label="生效时间" min-width="180">
              <template #default="{ row }">
                {{ formatDateTime(row.effectiveFrom) }}
              </template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="110" />
          </el-table>
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">METRIC PROFILE</span>
              <h2>指标权重与目标</h2>
              <p>激活版本不可原地编辑；调整后先生成草稿，再显式激活。</p>
            </div>
            <el-button v-if="canWrite && !activeProfile" @click="createDefaultProfile">
              从默认模板创建
            </el-button>
          </div>

          <el-alert
            v-if="activeProfile"
            type="success"
            :closable="false"
            :title="`当前：${activeProfile.name} · v${activeProfile.version}`"
          />
          <div v-if="canWrite && activeProfile" class="panel-actions">
            <el-button plain type="danger" @click="retireProfile(activeProfile)">
              停用当前 profile
            </el-button>
          </div>
          <div v-if="profileItems.length" class="profile-impact-strip">
            <span>
              启用分项：<strong>{{ profileImpact.enabledMetrics }}</strong>
            </span>
            <span>
              覆盖维度：<strong>{{ profileImpact.enabledDimensions }} / 4</strong>
            </span>
            <span>
              配置叶子权重：<strong>{{
                formatPercent(profileImpact.configuredLeafWeight)
              }}</strong>
            </span>
            <small>
              这只是保存前的配置影响预览；最终 eligible
              与总分仍由后端结合样本和数据状态计算。
            </small>
          </div>
          <el-table v-if="profileItems.length" :data="profileItems">
            <el-table-column label="指标与业务问题" min-width="290" fixed>
              <template #default="{ row }">
                <strong>
                  {{ definitionFor(row.metricKey)?.displayName ?? row.metricKey }}
                </strong>
                <small class="cell-reason">{{ row.metricKey }}</small>
                <small class="cell-reason">
                  {{
                    definitionFor(row.metricKey)?.businessQuestion ?? "指标定义暂不可用"
                  }}
                </small>
              </template>
            </el-table-column>
            <el-table-column prop="dimensionKey" label="维度" min-width="170" />
            <el-table-column label="计分方向" width="110">
              <template #default="{ row }">
                {{
                  scoreDirectionLabels[
                    definitionFor(row.metricKey)?.scoreDirection ?? "none"
                  ]
                }}
              </template>
            </el-table-column>
            <el-table-column label="参与" width="80">
              <template #default="{ row }">
                <el-switch v-model="row.enabled" :disabled="!canWrite" />
              </template>
            </el-table-column>
            <el-table-column label="维度权重" width="130">
              <template #default="{ row }">
                <el-input-number
                  v-model="row.dimensionWeight"
                  :disabled="!canWrite"
                  :min="0.01"
                  :max="1"
                  :step="0.05"
                />
              </template>
            </el-table-column>
            <el-table-column label="子项权重" width="130">
              <template #default="{ row }">
                <el-input-number
                  v-model="row.metricWeight"
                  :disabled="!canWrite"
                  :min="0.01"
                  :max="1"
                  :step="0.05"
                />
              </template>
            </el-table-column>
            <el-table-column label="目标参数" min-width="390">
              <template #default="{ row }">
                <div
                  v-if="
                    definitionFor(row.metricKey)?.scoreDirection === 'higher_better'
                  "
                  class="profile-target-grid"
                >
                  <label>
                    <span>达标值</span>
                    <el-input-number
                      v-model="row.targetValue"
                      :disabled="!canWrite"
                      :step="0.1"
                    />
                  </label>
                  <label>
                    <span>零分下界</span>
                    <el-input-number
                      v-model="row.floorValue"
                      :disabled="!canWrite"
                      :step="0.1"
                    />
                  </label>
                </div>
                <div
                  v-else-if="
                    definitionFor(row.metricKey)?.scoreDirection === 'lower_better'
                  "
                  class="profile-target-grid"
                >
                  <label>
                    <span>达标值</span>
                    <el-input-number
                      v-model="row.targetValue"
                      :disabled="!canWrite"
                      :step="0.1"
                    />
                  </label>
                  <label>
                    <span>零分上界</span>
                    <el-input-number
                      v-model="row.ceilingValue"
                      :disabled="!canWrite"
                      :step="0.1"
                    />
                  </label>
                </div>
                <div
                  v-else-if="
                    definitionFor(row.metricKey)?.scoreDirection === 'target_range'
                  "
                  class="profile-target-grid profile-target-grid--range"
                >
                  <label>
                    <span>容忍下界</span>
                    <el-input-number
                      v-model="row.toleranceMin"
                      :disabled="!canWrite"
                      :step="0.1"
                    />
                  </label>
                  <label>
                    <span>目标下界</span>
                    <el-input-number
                      v-model="row.targetMin"
                      :disabled="!canWrite"
                      :step="0.1"
                    />
                  </label>
                  <label>
                    <span>目标上界</span>
                    <el-input-number
                      v-model="row.targetMax"
                      :disabled="!canWrite"
                      :step="0.1"
                    />
                  </label>
                  <label>
                    <span>容忍上界</span>
                    <el-input-number
                      v-model="row.toleranceMax"
                      :disabled="!canWrite"
                      :step="0.1"
                    />
                  </label>
                </div>
                <span v-else>不参与运营指数评分</span>
              </template>
            </el-table-column>
            <el-table-column label="最小样本" width="130">
              <template #default="{ row }">
                <el-input-number
                  v-model="row.minimumSample"
                  :disabled="!canWrite"
                  :min="1"
                  :max="1000000"
                  :step="1"
                />
              </template>
            </el-table-column>
            <el-table-column label="叶子权重" width="100">
              <template #default="{ row }">
                {{ formatPercent(row.dimensionWeight * row.metricWeight) }}
              </template>
            </el-table-column>
          </el-table>
          <div v-if="canWrite && activeProfile" class="panel-actions">
            <el-button type="primary" :loading="saving" @click="cloneProfile">
              保存调整为草稿新版本
            </el-button>
          </div>

          <div v-if="drafts.length" class="draft-list">
            <h3>待激活草稿</h3>
            <div v-for="draft in drafts" :key="draft.id" class="draft-row">
              <span>{{ draft.name }} · v{{ draft.version }}</span>
              <el-button
                v-if="canWrite"
                type="primary"
                plain
                @click="activateProfile(draft)"
              >
                激活
              </el-button>
              <el-button
                v-if="canWrite"
                plain
                type="danger"
                @click="retireProfile(draft)"
              >
                废弃
              </el-button>
            </div>
          </div>
        </section>
      </template>
    </StatePanel>

    <el-dialog v-model="moduleOpen" title="新建模块" width="520px">
      <el-form label-position="top">
        <el-form-item label="moduleKey">
          <el-input v-model="moduleForm.moduleKey" placeholder="energy_management" />
        </el-form-item>
        <el-form-item label="模块名称">
          <el-input v-model="moduleForm.name" placeholder="能源管理" />
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

    <el-dialog v-model="pageOpen" title="新建页面定义" width="620px">
      <el-form label-position="top">
        <el-form-item label="归一化 route">
          <el-input v-model="pageForm.pageRoute" placeholder="/energy/overview" />
        </el-form-item>
        <el-form-item label="页面名称">
          <el-input v-model="pageForm.name" />
        </el-form-item>
        <el-form-item label="所属模块">
          <el-select v-model="pageForm.moduleId">
            <el-option
              v-for="module in resource.data.value?.modules"
              :key="module.id"
              :label="module.name"
              :value="module.id"
            />
          </el-select>
        </el-form-item>
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
        <el-form-item label="关键度权重">
          <el-input-number v-model="pageForm.criticalityWeight" :min="0.1" :max="100" />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="pageForm.isCore">核心页面</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pageOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="createPage">
          创建
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
