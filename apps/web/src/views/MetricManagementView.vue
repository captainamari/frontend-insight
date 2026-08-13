<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import { auth } from "../auth";
import { useDashboardContext } from "../context";
import { useRemoteData } from "../remote";
import type { MetricDefinition, MetricProfile } from "../types";

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const resource = useRemoteData<{
  definitions: MetricDefinition[];
  profiles: MetricProfile[];
}>();
const canWrite = computed(
  () =>
    auth.state.user?.globalRole === "admin" &&
    ["owner", "admin"].includes(context.project.value?.role ?? ""),
);

async function load(): Promise<void> {
  if (!context.projectId.value) return;
  const id = context.projectId.value;
  await resource.load(async () => {
    const [definitions, profiles] = await Promise.all([
      api.request<MetricDefinition[]>(`/api/projects/${id}/metrics`),
      api.request<MetricProfile[]>(`/api/projects/${id}/metric-profiles`),
    ]);
    return { definitions, profiles };
  });
}

watch(
  () => context.projectId.value,
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <div>
    <PageHeader
      eyebrow="METRIC GOVERNANCE"
      title="指标管理"
      description="指标口径由代码注册并版本化发布；这里提供定义、公式、版本、血缘和受控项目配置。"
    >
      <el-button
        v-if="canWrite"
        type="primary"
        @click="
          router.push({
            name: 'metric-configuration',
            params: { projectId: context.projectId.value, section: 'profiles' },
            query: route.query,
          })
        "
      >
        管理 profile 与目标
      </el-button>
    </PageHeader>

    <el-alert
      v-if="!canWrite"
      type="info"
      :closable="false"
      title="当前为只读权限：可查看指标定义、公式和版本，不能修改项目配置。"
    />

    <StatePanel
      :state="
        resource.loading.value ? 'loading' : resource.error.value ? 'error' : 'ready'
      "
      title="指标目录暂不可用"
      :message="resource.error.value?.message"
      @retry="load"
    >
      <section class="panel">
        <div class="section-heading">
          <div>
            <span class="eyebrow">METRIC CATALOG</span>
            <h2>正式指标目录</h2>
          </div>
          <el-tag effect="plain"
            >{{ resource.data.value?.definitions.length ?? 0 }} 项</el-tag
          >
        </div>
        <el-table :data="resource.data.value?.definitions ?? []">
          <el-table-column prop="displayName" label="指标" min-width="180" />
          <el-table-column prop="metricKey" label="稳定 key" min-width="180" />
          <el-table-column prop="formulaDescription" label="公式" min-width="260" />
          <el-table-column prop="denominatorDescription" label="分母" min-width="220" />
          <el-table-column prop="definitionVersion" label="版本" width="120" />
        </el-table>
      </section>

      <section class="panel">
        <div class="section-heading">
          <div>
            <span class="eyebrow">CONFIGURATION VERSIONS</span>
            <h2>项目 profile</h2>
          </div>
        </div>
        <el-table :data="resource.data.value?.profiles ?? []">
          <el-table-column prop="name" label="名称" min-width="180" />
          <el-table-column prop="profileKey" label="profile key" min-width="180" />
          <el-table-column prop="version" label="版本" width="100" />
          <el-table-column prop="status" label="状态" width="120" />
          <el-table-column label="指标数" width="100">
            <template #default="{ row }">{{ row.items.length }}</template>
          </el-table-column>
        </el-table>
      </section>
    </StatePanel>
  </div>
</template>
