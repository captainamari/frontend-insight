<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { auth } from "../auth";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import { useDashboardContext } from "../context";
import { formatDateTime } from "../range";
import { useRemoteData } from "../remote";
import type { ProjectCollectorSettings } from "../types";

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const resource = useRemoteData<{
  active: ProjectCollectorSettings | null;
  versions: ProjectCollectorSettings[];
}>();
const saving = reactive({ value: false });
const canWrite = computed(
  () =>
    auth.state.user?.globalRole === "admin" &&
    ["owner", "admin"].includes(context.project.value?.role ?? ""),
);
const form = reactive({
  api: { enabled: false, sampleRate: 1, slowThresholdMs: 2_000, globalFetch: false },
  resources: { enabled: false, sampleRate: 1 },
  firstScreen: { enabled: false, sampleRate: 1 },
  listRender: { enabled: false, sampleRate: 1 },
  longTasks: { enabled: false, sampleRate: 1 },
  blankScreen: { enabled: false, sampleRate: 1 },
  breadcrumbs: { enabled: false, sampleRate: 1, allowedActionKeys: "" },
});
const collectorRows = computed(() => [
  {
    key: "api" as const,
    name: "API 请求汇总",
    evidence: "请求分母、P50/P90、成功/错误/慢请求率",
    boundary: "优先显式请求层适配；全局 fetch 默认关闭",
  },
  {
    key: "resources" as const,
    name: "资源请求汇总",
    evidence: "资源请求分母、失败次数和失败率",
    boundary: "只发送按 pageView 汇总，不发送完整资源 URL",
  },
  {
    key: "firstScreen" as const,
    name: "首屏 readiness",
    evidence: "页面模板首屏 P90 与 coverage",
    boundary: "必须由业务显式调用 readiness API",
  },
  {
    key: "listRender" as const,
    name: "列表渲染",
    evidence: "页面 × 行数桶的 P90",
    boundary: "只发送 <100 / 100-1000 / >1000 桶",
  },
  {
    key: "longTasks" as const,
    name: "长任务",
    evidence: "数量、总时长和受影响 PV 率",
    boundary: "不发送脚本 URL 与 attribution 明细",
  },
  {
    key: "blankScreen" as const,
    name: "白屏候选",
    evidence: "候选数、检测分母和候选率",
    boundary: "Canvas/Cesium/骨架页未配置 adapter 时保持关闭",
  },
  {
    key: "breadcrumbs" as const,
    name: "错误 breadcrumb",
    evidence: "错误前最多 50 条允许列表动作",
    boundary: "禁止 DOM、输入、console、query、header/body 和业务 ID",
  },
]);

function hydrate(settings: ProjectCollectorSettings | null): void {
  if (!settings) return;
  Object.assign(form.api, settings.api);
  Object.assign(form.resources, settings.resources);
  Object.assign(form.firstScreen, settings.firstScreen);
  Object.assign(form.listRender, settings.listRender);
  Object.assign(form.longTasks, settings.longTasks);
  Object.assign(form.blankScreen, settings.blankScreen);
  Object.assign(form.breadcrumbs, {
    ...settings.breadcrumbs,
    allowedActionKeys: settings.breadcrumbs.allowedActionKeys.join(", "),
  });
}

async function load(): Promise<void> {
  if (!context.projectId.value) return;
  await resource.load(() =>
    api.request(`/api/projects/${context.projectId.value}/collector-settings`),
  );
  hydrate(resource.data.value?.active ?? null);
}

async function save(): Promise<void> {
  if (!context.projectId.value || !canWrite.value || saving.value) return;
  saving.value = true;
  try {
    await api.request(
      `/api/projects/${context.projectId.value}/collector-settings/versions`,
      {
        method: "POST",
        body: JSON.stringify({
          api: form.api,
          resources: form.resources,
          firstScreen: form.firstScreen,
          listRender: form.listRender,
          longTasks: form.longTasks,
          blankScreen: form.blankScreen,
          breadcrumbs: {
            enabled: form.breadcrumbs.enabled,
            sampleRate: form.breadcrumbs.sampleRate,
            allowedActionKeys: form.breadcrumbs.allowedActionKeys
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          },
        }),
      },
    );
    await load();
  } finally {
    saving.value = false;
  }
}

watch(
  () => context.projectId.value,
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <div>
    <button
      class="back-link"
      type="button"
      @click="
        router.push({
          name: 'settings',
          params: { projectId: context.projectId.value },
          query: route.query,
        })
      "
    >
      ← 返回设置
    </button>
    <PageHeader
      eyebrow="OPT-IN COLLECTORS"
      title="采集开关"
      description="每个 P1 事件族独立启用、采样和回滚；所有新 collector 默认关闭。"
    >
      <el-button v-if="canWrite" type="primary" :loading="saving.value" @click="save">
        保存为新版本
      </el-button>
    </PageHeader>

    <el-alert
      v-if="!canWrite"
      type="info"
      :closable="false"
      title="当前账号只读；只有项目 admin/owner 可以发布新的采集配置版本。"
    />

    <StatePanel
      :state="
        resource.loading.value ? 'loading' : resource.error.value ? 'error' : 'ready'
      "
      title="采集配置暂不可用"
      :message="resource.error.value?.message"
      @retry="load"
    >
      <section class="panel collector-table" aria-label="P1 collector 配置">
        <div
          v-for="collector in collectorRows"
          :key="collector.key"
          class="collector-row"
        >
          <div>
            <strong>{{ collector.name }}</strong>
            <p>{{ collector.evidence }}</p>
            <small>{{ collector.boundary }}</small>
          </div>
          <label>
            <span>启用</span>
            <el-switch
              v-model="form[collector.key].enabled"
              :disabled="!canWrite"
              :aria-label="`启用${collector.name}`"
            />
          </label>
          <label>
            <span>采样率</span>
            <el-input-number
              v-model="form[collector.key].sampleRate"
              :disabled="!canWrite"
              :min="0"
              :max="1"
              :step="0.05"
              :precision="2"
              :aria-label="`${collector.name}采样率`"
            />
          </label>
        </div>
      </section>

      <section class="panel collector-advanced">
        <h2>受控参数</h2>
        <label>
          <span>API 慢请求门槛（ms）</span>
          <el-input-number
            v-model="form.api.slowThresholdMs"
            :disabled="!canWrite"
            :min="1"
            :max="60000"
          />
        </label>
        <label>
          <span>全局 fetch 包装</span>
          <el-switch
            v-model="form.api.globalFetch"
            :disabled="!canWrite"
            aria-label="全局 fetch 包装"
          />
          <small>默认关闭；优先在业务请求层显式调用 captureApiRequest。</small>
        </label>
        <label>
          <span>breadcrumb action key allowlist</span>
          <el-input
            v-model="form.breadcrumbs.allowedActionKeys"
            :disabled="!canWrite"
            placeholder="report_export_started, alarm_acknowledged"
            aria-label="breadcrumb action key allowlist"
          />
        </label>
      </section>

      <section class="panel">
        <div class="section-heading">
          <div>
            <span class="eyebrow">CLONE-ON-WRITE</span>
            <h2>配置版本</h2>
          </div>
          <el-tag v-if="resource.data.value?.active" type="success">
            当前 v{{ resource.data.value.active.version }}
          </el-tag>
        </div>
        <el-table :data="resource.data.value?.versions ?? []">
          <el-table-column prop="version" label="版本" width="90" />
          <el-table-column prop="status" label="状态" width="120" />
          <el-table-column label="启用项" min-width="280">
            <template #default="{ row }">
              {{
                [
                  row.api.enabled && "API",
                  row.resources.enabled && "资源",
                  row.firstScreen.enabled && "首屏",
                  row.listRender.enabled && "列表",
                  row.longTasks.enabled && "长任务",
                  row.blankScreen.enabled && "白屏候选",
                  row.breadcrumbs.enabled && "breadcrumb",
                ]
                  .filter(Boolean)
                  .join("、") || "全部关闭"
              }}
            </template>
          </el-table-column>
          <el-table-column label="生效时间" min-width="190">
            <template #default="{ row }">{{
              formatDateTime(row.effectiveFrom)
            }}</template>
          </el-table-column>
        </el-table>
      </section>
    </StatePanel>
  </div>
</template>
