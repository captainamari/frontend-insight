<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import DataStatusBanner from "../components/DataStatusBanner.vue";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import { useDashboardContext } from "../context";
import { formatNumber } from "../range";
import { useRemoteData } from "../remote";
import type {
  DataStatus,
  Feature,
  OperationalIndexResponse,
  OperationalOverviewResponse,
  PageDefinition,
  ProjectModule,
} from "../types";

interface OverviewData {
  status: DataStatus;
  modules: ProjectModule[];
  pages: PageDefinition[];
  features: Feature[];
  business: OperationalOverviewResponse;
  index: OperationalIndexResponse;
}

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const resource = useRemoteData<OverviewData>();
const viewState = computed(() => {
  if (!context.projectId.value || (resource.loading.value && !resource.data.value))
    return "loading" as const;
  if (resource.error.value && !resource.data.value)
    return resource.error.value.status === 403
      ? ("forbidden" as const)
      : ("error" as const);
  return resource.stale.value ? ("stale" as const) : ("ready" as const);
});

async function load(): Promise<void> {
  if (!context.projectId.value || !context.search.value) return;
  const id = context.projectId.value;
  const query = context.search.value;
  await resource.load(async () => {
    const [status, modules, pages, features, business, index] = await Promise.all([
      api.request<DataStatus>(`/api/projects/${id}/data-status`),
      api.request<ProjectModule[]>(`/api/projects/${id}/modules`),
      api.request<PageDefinition[]>(`/api/projects/${id}/page-definitions`),
      api.request<Feature[]>(`/api/projects/${id}/features`),
      api.request<OperationalOverviewResponse>(
        `/api/projects/${id}/analytics/operational-overview?${query}`,
      ),
      api.request<OperationalIndexResponse>(
        `/api/projects/${id}/operational-index?${query}`,
      ),
    ]);
    return { status, modules, pages, features, business, index };
  });
}

function open(name: string, extra: Record<string, string> = {}): void {
  void router.push({
    name,
    params: { projectId: context.projectId.value, ...extra },
    query: route.query,
  });
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
      eyebrow="PROJECT OVERVIEW"
      :title="context.project.value?.name ?? '项目概览'"
      description="统一查看项目属性、资产规模、数据状态、运营指数与四个一级模块摘要。"
    >
      <el-button @click="load">刷新</el-button>
    </PageHeader>
    <DataStatusBanner :status="resource.data.value?.status ?? null" />

    <StatePanel
      :state="viewState"
      :title="viewState === 'forbidden' ? '无项目访问权限' : '项目概览暂不可用'"
      :message="resource.error.value?.message"
      :request-id="resource.error.value?.requestId"
      @retry="load"
    >
      <section class="overview-identity panel">
        <div>
          <span>项目标识</span><strong>{{ context.project.value?.projectKey }}</strong>
        </div>
        <div>
          <span>模块</span
          ><strong>{{ resource.data.value?.modules.length ?? 0 }}</strong>
        </div>
        <div>
          <span>页面</span><strong>{{ resource.data.value?.pages.length ?? 0 }}</strong>
        </div>
        <div>
          <span>功能 / 任务</span
          ><strong>{{ resource.data.value?.features.length ?? 0 }}</strong>
        </div>
      </section>

      <section class="overview-module-grid">
        <button
          class="overview-module-card index-card"
          type="button"
          @click="open('operational-index')"
        >
          <span>项目运营指数</span>
          <strong>{{ resource.data.value?.index.index.value ?? "—" }}</strong>
          <small>查看分数状态、版本与四维构成；指数不是一级导航。</small>
        </button>
        <button
          class="overview-module-card"
          type="button"
          @click="open('business-analysis')"
        >
          <span>业务分析</span>
          <strong
            >{{
              formatNumber(resource.data.value?.business.summary.activeAccounts ?? 0)
            }}
            活跃账号</strong
          >
          <small>功能采用、关键任务、持续使用与操作效率</small>
        </button>
        <button class="overview-module-card" type="button" @click="open('page-usage')">
          <span>页面分析</span>
          <strong
            >{{
              formatNumber(resource.data.value?.business.summary.pageViews ?? 0)
            }}
            PV</strong
          >
          <small>页面使用、停留深度、性能、错误与发布影响</small>
        </button>
        <button class="overview-module-card" type="button" @click="open('metrics')">
          <span>指标管理</span>
          <strong>定义与治理</strong>
          <small>查看口径、公式、版本、血缘、profile 与目标</small>
        </button>
        <button class="overview-module-card" type="button" @click="open('settings')">
          <span>设置</span>
          <strong>{{ context.project.value?.origins.length ?? 0 }} 个 Origin</strong>
          <small>项目、资产、接入、成员、隐私、保留和审计</small>
        </button>
      </section>
    </StatePanel>
  </div>
</template>
