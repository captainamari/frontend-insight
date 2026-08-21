<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import DataStatusBanner from "../components/DataStatusBanner.vue";
import DefinitionsDrawer from "../components/DefinitionsDrawer.vue";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import TrendChart from "../components/TrendChart.vue";
import { useDashboardContext } from "../context";
import { fillTrendGaps, formatDateTime, formatNumber, formatPercent } from "../range";
import { useRemoteData } from "../remote";
import type { DataStatus, FeaturesResponse, FeatureType } from "../types";

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const resource = useRemoteData<{
  analytics: FeaturesResponse;
  status: DataStatus;
}>();
const search = ref("");
const type = ref<FeatureType | "all">("all");

const rows = computed(() => {
  const items = resource.data.value?.analytics.items ?? [];
  const needle = search.value.trim().toLowerCase();
  return items.filter(
    (item) =>
      (type.value === "all" || item.featureType === type.value) &&
      (!needle ||
        item.name.toLowerCase().includes(needle) ||
        item.featureKey.toLowerCase().includes(needle)),
  );
});
const chartPoints = computed(() => {
  const response = resource.data.value?.analytics;
  if (!response) return [];
  return fillTrendGaps(response.trend, response.range, "exposed", "succeeded");
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
  if (resource.stale.value) return "stale" as const;
  return "ready" as const;
});

function featureTypeLabel(value: FeatureType): string {
  return {
    data_view: "数据查看",
    action: "操作完成",
    long_view: "持续展示",
  }[value];
}

function openFeature(featureId: string): void {
  void router.push({
    name: "feature-detail",
    params: { featureId },
    query: route.query,
  });
}

async function load(): Promise<void> {
  if (!context.projectId.value || !context.search.value) return;
  const projectId = context.projectId.value;
  const query = context.search.value;
  await resource.load(async () => {
    const [analytics, status] = await Promise.all([
      api.request<FeaturesResponse>(
        `/api/projects/${projectId}/analytics/features?${query}`,
      ),
      api.request<DataStatus>(`/api/projects/${projectId}/data-status`),
    ]);
    return { analytics, status };
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
      eyebrow="PRODUCT ADOPTION"
      title="功能采用"
      description="先看功能是否被曝光，再判断是否成功使用和跨会话复用。"
    >
      <DefinitionsDrawer
        :sdk-versions="resource.data.value?.analytics.sdkVersions"
        :last-updated="resource.data.value?.status.lastQueryableAt"
      />
      <el-button type="primary" @click="load">刷新数据</el-button>
    </PageHeader>

    <DataStatusBanner :status="resource.data.value?.status ?? null" />

    <StatePanel
      :state="viewState"
      :title="viewState === 'forbidden' ? '无项目访问权限' : '功能采用数据暂不可用'"
      :message="
        viewState === 'forbidden'
          ? '当前账号未被授予这个项目的查看权限，请联系项目管理员。'
          : resource.error.value?.message
      "
      :request-id="resource.error.value?.requestId"
      @retry="load"
    >
      <section
        v-if="resource.data.value?.status.state === 'no_data'"
        class="onboarding-callout"
      >
        <div>
          <span class="eyebrow">FIRST EVENT</span>
          <h2>这个项目还没有收到事件</h2>
          <p>先完成 SDK 接入并发送测试事件；此处不会用一组 0 冒充真实分析结果。</p>
        </div>
        <el-button
          type="primary"
          @click="router.push({ name: 'onboarding', query: route.query })"
        >
          前往接入验证
        </el-button>
      </section>

      <template v-else>
        <section class="panel chart-panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">EXPOSURE → SUCCESS</span>
              <h2>采用趋势</h2>
              <p>缺失时间段保留为空，不跨越缺口连线。</p>
            </div>
          </div>
          <TrendChart
            v-if="chartPoints.length"
            :points="chartPoints"
            primary-label="曝光次数"
            secondary-label="成功次数"
          />
          <div v-else class="inline-empty">所选范围内尚无功能事件。</div>
        </section>

        <section class="panel">
          <div class="section-heading table-toolbar">
            <div>
              <span class="eyebrow">FEATURE EVIDENCE</span>
              <h2>功能列表</h2>
            </div>
            <div class="filters">
              <el-input
                v-model="search"
                clearable
                placeholder="搜索名称或 featureKey"
                aria-label="搜索功能"
              />
              <el-select v-model="type" aria-label="筛选功能类型">
                <el-option label="全部类型" value="all" />
                <el-option label="数据查看" value="data_view" />
                <el-option label="操作完成" value="action" />
                <el-option label="持续展示" value="long_view" />
              </el-select>
            </div>
          </div>

          <el-table
            :data="rows"
            empty-text="没有符合条件的功能"
            row-key="id"
            @row-click="(row: { id: string }) => openFeature(row.id)"
          >
            <el-table-column label="功能" min-width="220">
              <template #default="{ row }">
                <button
                  class="table-link"
                  type="button"
                  @click.stop="openFeature(row.id)"
                >
                  <strong>{{ row.name }}</strong>
                  <small>{{ row.featureKey }}</small>
                  <small
                    v-if="
                      (row.exposed_users ?? 0) === 0 &&
                      (row.exposed_visitors ?? 0) === 0
                    "
                    class="never-exposed"
                  >
                    尚未收到曝光事件 · 可前往接入页检查埋点
                  </small>
                </button>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="108">
              <template #default="{ row }">
                <el-tag effect="plain">{{ featureTypeLabel(row.featureType) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="曝光账号 / 浏览器" min-width="150">
              <template #default="{ row }">
                {{ formatNumber(row.exposed_users) }} /
                {{ formatNumber(row.exposed_visitors) }}
              </template>
            </el-table-column>
            <el-table-column label="成功账号 / 浏览器" min-width="150">
              <template #default="{ row }">
                <span v-if="(row.success_count ?? 0) > 0">
                  {{ formatNumber(row.succeeded_users) }} /
                  {{ formatNumber(row.succeeded_visitors) }}
                </span>
                <span v-else class="muted">尚无成功使用</span>
              </template>
            </el-table-column>
            <el-table-column label="成功次数" width="100">
              <template #default="{ row }">{{
                formatNumber(row.success_count)
              }}</template>
            </el-table-column>
            <el-table-column label="曝光后使用率（账号）" min-width="160">
              <template #default="{ row }">
                {{ formatPercent(row.userConversionRate) }}
              </template>
            </el-table-column>
            <el-table-column label="重复账号 / 浏览器" min-width="150">
              <template #default="{ row }">
                {{ formatNumber(row.repeat_users) }} /
                {{ formatNumber(row.repeat_visitors) }}
              </template>
            </el-table-column>
            <el-table-column label="最近成功" min-width="150">
              <template #default="{ row }">
                {{ formatDateTime(row.last_succeeded_at) }}
              </template>
            </el-table-column>
          </el-table>
        </section>
      </template>
    </StatePanel>
  </div>
</template>
