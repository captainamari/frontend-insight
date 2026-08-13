<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import DataStatusBanner from "../components/DataStatusBanner.vue";
import MetricCard from "../components/MetricCard.vue";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import TrendChart from "../components/TrendChart.vue";
import { useDashboardContext } from "../context";
import {
  fillTrendGaps,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
} from "../range";
import { useRemoteData } from "../remote";
import type { PageDetailResponse } from "../types";

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const resource = useRemoteData<PageDetailResponse>();
const routeValue = computed(() =>
  typeof route.query.route === "string" ? route.query.route : "",
);
const chartPoints = computed(() => {
  const response = resource.data.value;
  return response
    ? fillTrendGaps(response.trend, response.range, "pv", "visitors")
    : [];
});
const viewState = computed(() => {
  if (
    !context.projectId.value ||
    !routeValue.value ||
    (resource.loading.value && !resource.data.value)
  ) {
    return "loading" as const;
  }
  if (resource.error.value && !resource.data.value) {
    return resource.error.value.status === 403
      ? ("forbidden" as const)
      : ("error" as const);
  }
  return resource.stale.value ? ("stale" as const) : ("ready" as const);
});
const cards = computed(() => {
  const metrics = resource.data.value?.metrics;
  if (!metrics) return [];
  return [
    {
      label: "PV",
      value: formatNumber(metrics.pageViews),
      definition: "去重 page_view 数；刷新和重复访问分别计数。",
    },
    {
      label: "账号 / 浏览器",
      value: `${formatNumber(metrics.accounts)} / ${formatNumber(metrics.browsers)}`,
      definition: "账号为项目级 HMAC 后去重；浏览器为 visitorId 存储实例。",
    },
    {
      label: "可见时长 p50 / p75",
      value: `${formatDuration(metrics.durationP50Ms)} / ${formatDuration(metrics.durationP75Ms)}`,
      definition: "先按 pageViewId 汇总有效时长片段，再计算分位数。",
    },
    {
      label: "时长覆盖率",
      value: formatPercent(metrics.durationCoverage),
      definition: "具有有效 page_leave 时长的 pageView ÷ 全部 pageView。",
    },
  ];
});

async function load(): Promise<void> {
  if (!context.projectId.value || !context.search.value || !routeValue.value) return;
  const query = new URLSearchParams(context.search.value);
  query.set("route", routeValue.value);
  await resource.load(() =>
    api.request<PageDetailResponse>(
      `/api/projects/${context.projectId.value}/analytics/page-detail?${query}`,
    ),
  );
}

watch(
  () => [context.projectId.value, context.search.value, routeValue.value],
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <div>
    <PageHeader
      eyebrow="PAGE DETAIL"
      :title="
        resource.data.value?.classification.status === 'classified'
          ? resource.data.value.classification.page.name
          : routeValue || '页面详情'
      "
      description="停留时长用于发现需要调查的体验信号，不单独推断设计好坏。"
    >
      <el-button
        plain
        @click="
          router.push({
            name: 'business-analysis',
            params: { projectId: context.projectId.value },
            query: route.query,
          })
        "
      >
        返回运营概览
      </el-button>
      <el-button type="primary" @click="load">刷新数据</el-button>
    </PageHeader>

    <DataStatusBanner :status="resource.data.value?.dataStatus ?? null" />

    <StatePanel
      :state="viewState"
      title="页面详情暂不可用"
      :message="resource.error.value?.message"
      :request-id="resource.error.value?.requestId"
      @retry="load"
    >
      <template v-if="resource.data.value">
        <el-alert
          v-if="resource.data.value.classification.status === 'unclassified'"
          type="warning"
          :closable="false"
          show-icon
          title="这个 route 尚未归类，基础指标可见，但不会进入项目运营指数。"
        >
          <el-button
            link
            type="primary"
            @click="
              router.push({
                name: 'settings',
                params: { projectId: context.projectId.value },
                query: route.query,
              })
            "
          >
            前往页面配置
          </el-button>
        </el-alert>

        <section v-else class="classification-strip" aria-label="页面业务定义">
          <span>
            模块：{{ resource.data.value.classification.module?.name ?? "模块已停用" }}
          </span>
          <span> 模板：{{ resource.data.value.classification.page.templateKey }} </span>
          <span>
            {{
              resource.data.value.classification.page.isCore ? "核心页面" : "普通页面"
            }}
          </span>
          <span>
            预期频率：{{ resource.data.value.classification.page.expectedFrequency }}
          </span>
        </section>

        <section class="metrics-grid" aria-label="页面运营指标">
          <MetricCard v-for="card in cards" :key="card.label" v-bind="card" />
        </section>

        <section class="panel chart-panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">PAGE TREND</span>
              <h2>本页 PV 与活跃浏览器趋势</h2>
              <p>仅包含当前归一化 route；缺失时间桶不会连线或补成 0。</p>
            </div>
            <span class="last-updated">
              定义 / 数据起点：
              {{ formatDateTime(resource.data.value.availableFrom) }}
            </span>
          </div>
          <TrendChart
            v-if="chartPoints.some((point) => point.primary !== null)"
            :points="chartPoints"
            primary-label="PV"
            secondary-label="活跃浏览器"
          />
          <div v-else class="inline-empty">所选范围内没有本页访问。</div>
        </section>

        <div class="overview-columns">
          <section class="panel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">DURATION SEMANTICS</span>
                <h2>停留时长与目标</h2>
                <p>缺失 page_leave 的访问不会以 0 毫秒参与统计。</p>
              </div>
            </div>
            <dl class="evidence-list">
              <div>
                <dt>有效时长样本</dt>
                <dd>{{ formatNumber(resource.data.value.metrics.durationSamples) }}</dd>
              </div>
              <div>
                <dt>平均可见时长</dt>
                <dd>
                  {{ formatDuration(resource.data.value.metrics.durationAverageMs) }}
                </dd>
              </div>
              <div>
                <dt>模板参考区间</dt>
                <dd>
                  {{ formatDuration(resource.data.value.templateTarget.minMs) }}
                  –
                  {{ formatDuration(resource.data.value.templateTarget.maxMs) }}
                </dd>
              </div>
              <div>
                <dt>容忍边界</dt>
                <dd>
                  {{
                    formatDuration(resource.data.value.templateTarget.toleranceMinMs)
                  }}
                  –
                  {{
                    formatDuration(resource.data.value.templateTarget.toleranceMaxMs)
                  }}
                </dd>
              </div>
            </dl>
          </section>

          <section class="panel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">SESSION DEPTH</span>
                <h2>访问路径</h2>
                <p>只描述同一会话覆盖页面的范围。</p>
              </div>
            </div>
            <dl class="evidence-list">
              <div>
                <dt>会话数</dt>
                <dd>{{ formatNumber(resource.data.value.metrics.sessions) }}</dd>
              </div>
              <div>
                <dt>会话不同页面 p50</dt>
                <dd>
                  {{
                    formatNumber(resource.data.value.metrics.sessionDistinctPagesP50)
                  }}
                </dd>
              </div>
              <div>
                <dt>会话不同页面 p75</dt>
                <dd>
                  {{
                    formatNumber(resource.data.value.metrics.sessionDistinctPagesP75)
                  }}
                </dd>
              </div>
              <div>
                <dt>会话模块广度 p50 / p75</dt>
                <dd>
                  {{
                    formatNumber(resource.data.value.metrics.sessionModuleBreadthP50)
                  }}
                  /
                  {{
                    formatNumber(resource.data.value.metrics.sessionModuleBreadthP75)
                  }}
                </dd>
              </div>
            </dl>
            <p class="muted">{{ resource.data.value.depthGuidance }}</p>
          </section>
        </div>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">PAGE TASKS</span>
              <h2>页面内关键任务</h2>
            </div>
          </div>
          <el-table
            :data="resource.data.value.keyTasks"
            empty-text="这个页面尚未绑定关键任务"
          >
            <el-table-column prop="name" label="任务" min-width="180" />
            <el-table-column prop="featureKey" label="featureKey" min-width="180" />
            <el-table-column label="权重" width="90">
              <template #default="{ row }">{{ row.taskWeight }}</template>
            </el-table-column>
            <el-table-column label="超时窗口" width="120">
              <template #default="{ row }"> {{ row.taskTimeoutSeconds }} 秒 </template>
            </el-table-column>
            <el-table-column label="实例配对" width="110">
              <template #default="{ row }">
                <el-tag :type="row.operationLifecycleEnabled ? 'success' : 'warning'">
                  {{ row.operationLifecycleEnabled ? "v2 已启用" : "未启用" }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">METRIC DEFINITIONS</span>
              <h2>页面指标口径</h2>
              <p>公式、业务问题和版本来自后端同一 MetricCatalog。</p>
            </div>
          </div>
          <el-table :data="resource.data.value.definitions">
            <el-table-column prop="displayName" label="指标" min-width="170" />
            <el-table-column prop="businessQuestion" label="业务问题" min-width="260" />
            <el-table-column
              prop="formulaDescription"
              label="计算公式"
              min-width="280"
            />
            <el-table-column prop="minimumSample" label="最小样本" width="100" />
            <el-table-column prop="definitionVersion" label="版本" width="150" />
          </el-table>
        </section>
      </template>
    </StatePanel>
  </div>
</template>
