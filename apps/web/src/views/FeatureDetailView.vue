<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import DefinitionsDrawer from "../components/DefinitionsDrawer.vue";
import MetricCard from "../components/MetricCard.vue";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import TrendChart from "../components/TrendChart.vue";
import { useDashboardContext } from "../context";
import { fillTrendGaps, formatNumber } from "../range";
import { useRemoteData } from "../remote";
import type { FeatureDetailResponse } from "../types";

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const resource = useRemoteData<FeatureDetailResponse>();
const featureId = computed(() => String(route.params.featureId ?? ""));
const chartPoints = computed(() => {
  const response = resource.data.value;
  if (!response) return [];
  return fillTrendGaps(response.trend, response.range, "exposed", "succeeded");
});
const viewState = computed(() => {
  if (resource.loading.value && !resource.data.value) return "loading" as const;
  if (resource.error.value && !resource.data.value) {
    return resource.error.value.status === 403
      ? ("forbidden" as const)
      : ("error" as const);
  }
  return resource.stale.value ? ("stale" as const) : ("ready" as const);
});
const funnel = computed(() => {
  const metrics = resource.data.value?.metrics;
  if (!metrics) return [];
  return [
    ["曝光", metrics.exposed, "功能入口实际呈现"],
    ["开始", metrics.started, "用户开始操作；不代表成功"],
    ["成功", metrics.succeeded, "业务成功条件已满足"],
    ["失败", metrics.failed, "收到明确失败或取消结果"],
  ] as const;
});

async function load(): Promise<void> {
  if (!context.projectId.value || !context.search.value || !featureId.value) return;
  await resource.load(() =>
    api.request<FeatureDetailResponse>(
      `/api/projects/${context.projectId.value}/analytics/features/${featureId.value}?${context.search.value}`,
    ),
  );
}

watch(
  () => [context.projectId.value, context.search.value, featureId.value],
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <div>
    <button
      class="back-link"
      type="button"
      @click="router.push({ name: 'features', query: route.query })"
    >
      ← 返回功能采用
    </button>
    <PageHeader
      eyebrow="FEATURE DETAIL"
      :title="resource.data.value?.feature.name ?? '功能详情'"
      :description="
        resource.data.value
          ? `${resource.data.value.feature.featureKey} · 标准阶段与跨会话采用证据`
          : '查看标准采用阶段'
      "
    >
      <DefinitionsDrawer
        :sdk-versions="resource.data.value?.sdkVersions"
        :last-updated="resource.data.value?.sdkVersions[0]?.last_received_at"
      />
      <el-button type="primary" @click="load">刷新数据</el-button>
    </PageHeader>

    <StatePanel
      :state="viewState"
      :title="viewState === 'forbidden' ? '无项目访问权限' : '功能详情暂不可用'"
      :message="resource.error.value?.message"
      :request-id="resource.error.value?.requestId"
      @retry="load"
    >
      <section class="metrics-grid funnel-grid">
        <MetricCard
          v-for="[label, value, definition] in funnel"
          :key="label"
          :label="label"
          :value="formatNumber(value)"
          :definition="definition"
        />
      </section>

      <section class="panel chart-panel">
        <div class="section-heading">
          <div>
            <span class="eyebrow">STANDARD STAGES</span>
            <h2>曝光与成功趋势</h2>
            <p>不根据单一转化率自动判断设计好坏。</p>
          </div>
        </div>
        <TrendChart :points="chartPoints" primary-label="曝光" secondary-label="成功" />
      </section>

      <section class="detail-grid">
        <article class="panel evidence-card">
          <span class="eyebrow">AUDIENCE SEMANTICS</span>
          <h2>成功使用者口径</h2>
          <dl>
            <div>
              <dt>已识别账号</dt>
              <dd>
                {{ formatNumber(resource.data.value?.metrics.succeeded_accounts) }}
              </dd>
            </div>
            <div>
              <dt>匿名浏览器</dt>
              <dd>
                {{ formatNumber(resource.data.value?.metrics.succeeded_visitors) }}
              </dd>
            </div>
            <div>
              <dt>重复使用账号</dt>
              <dd>{{ formatNumber(resource.data.value?.metrics.repeat_accounts) }}</dd>
            </div>
            <div>
              <dt>重复使用浏览器</dt>
              <dd>{{ formatNumber(resource.data.value?.metrics.repeat_visitors) }}</dd>
            </div>
          </dl>
          <p class="muted">
            共享账号仍只计为一个账号；浏览器数和会话数不等于真实人数。
          </p>
        </article>

        <article class="panel evidence-card">
          <span class="eyebrow">LONG VIEW</span>
          <h2>累计前台可见时长</h2>
          <strong class="duration-value">
            {{
              Math.round((resource.data.value?.metrics.visible_duration_ms ?? 0) / 1000)
            }}
            秒
          </strong>
          <p>
            仅累计页面在前台可见的时间；后台标签页暂停，按同一长时实例的最大累计值去重。
          </p>
        </article>
      </section>
    </StatePanel>
  </div>
</template>
