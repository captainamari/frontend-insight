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
import type { OperationalOverviewResponse, TrendResponse } from "../types";

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const resource = useRemoteData<{
  overview: OperationalOverviewResponse;
  trend: TrendResponse;
}>();

const chartPoints = computed(() => {
  const trend = resource.data.value?.trend;
  return trend ? fillTrendGaps(trend.points, trend.range, "pv", "visitors") : [];
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
const cards = computed(() => {
  const summary = resource.data.value?.overview.summary;
  const depth = resource.data.value?.overview.depth;
  const tasks = resource.data.value?.overview.taskSummary;
  if (!summary || !depth || !tasks) return [];
  return [
    {
      label: "项目 PV",
      value: formatNumber(summary.pageViews),
      definition: "所选范围内全部已去重 page_view；未归类访问也在此原始值中。",
    },
    {
      label: "有效活跃账号",
      value: formatNumber(summary.activeAccounts),
      definition:
        "已注册、已启用实体上的生产活动账号；不包含 onboarding、demo 和未归类 route。",
    },
    {
      label: "活跃日覆盖",
      value: formatPercent(summary.activeDayCoverage),
      definition: `${summary.activeExpectedDays} / ${summary.expectedActiveDays} 个预期活跃日存在有效使用。`,
    },
    {
      label: "跨日持续账号",
      value: `${formatNumber(summary.crossDayAccounts)} / ${formatNumber(summary.activeAccounts)}`,
      definition: "在至少两个项目本地日期有有效使用的已识别账号。",
    },
    {
      label: "关键任务达成",
      value: formatPercent(tasks.completionRate),
      definition: "v2 成功 operation instances ÷ started instances，按任务权重汇总。",
    },
    {
      label: "会话不同页面 p50",
      value:
        depth.distinctPagesP50 === null ? "—" : formatNumber(depth.distinctPagesP50),
      definition: "每个 session 的归一化 route 去重数的中位数；不是 URL 段数。",
    },
  ];
});

async function load(): Promise<void> {
  if (!context.projectId.value || !context.search.value) return;
  const projectId = context.projectId.value;
  const query = context.search.value;
  await resource.load(async () => {
    const [overview, trend] = await Promise.all([
      api.request<OperationalOverviewResponse>(
        `/api/projects/${projectId}/analytics/operational-overview?${query}`,
      ),
      api.request<TrendResponse>(`/api/projects/${projectId}/analytics/trend?${query}`),
    ]);
    return { overview, trend };
  });
}

function openPage(routeValue: string): void {
  void router.push({
    name: "page-detail",
    query: { ...route.query, route: routeValue },
  });
}

function openTask(featureId: string): void {
  void router.push({
    name: "feature-detail",
    params: { featureId },
    query: { ...route.query, evidence: "task" },
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
      eyebrow="OPERATIONAL OVERVIEW"
      title="运营概览"
      description="从模块、核心页面、关键任务和访问深度判断内部产品是否被持续、有效地使用。"
    >
      <el-button
        plain
        @click="router.push({ name: 'operational-index', query: route.query })"
      >
        查看项目运营指数
      </el-button>
      <el-button type="primary" @click="load">刷新数据</el-button>
    </PageHeader>

    <DataStatusBanner :status="resource.data.value?.overview.dataStatus ?? null" />

    <StatePanel
      :state="viewState"
      :title="viewState === 'forbidden' ? '无项目访问权限' : '运营数据暂不可用'"
      :message="
        viewState === 'forbidden'
          ? '当前账号未被授予这个项目的查看权限。'
          : resource.error.value?.message
      "
      :request-id="resource.error.value?.requestId"
      @retry="load"
    >
      <template v-if="resource.data.value">
        <section class="metrics-grid" aria-label="运营摘要">
          <MetricCard v-for="card in cards" :key="card.label" v-bind="card" />
        </section>

        <section class="panel chart-panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">SUSTAINED USE</span>
              <h2>访问与活跃浏览器趋势</h2>
              <p>趋势保留数据缺口，不把缺失时间桶绘制成 0。</p>
            </div>
          </div>
          <TrendChart
            v-if="chartPoints.length"
            :points="chartPoints"
            primary-label="PV"
            secondary-label="活跃浏览器"
          />
          <div v-else class="inline-empty">所选范围内没有页面访问。</div>
        </section>

        <div class="overview-columns">
          <section class="panel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">MODULE COVERAGE</span>
                <h2>模块使用</h2>
              </div>
            </div>
            <el-table
              :data="resource.data.value.overview.modules"
              empty-text="尚未配置模块"
            >
              <el-table-column prop="name" label="模块" min-width="140" />
              <el-table-column label="PV" width="90">
                <template #default="{ row }">
                  {{ formatNumber(row.pageViews) }}
                </template>
              </el-table-column>
              <el-table-column label="账号" width="90">
                <template #default="{ row }">
                  {{ formatNumber(row.accounts) }}
                </template>
              </el-table-column>
              <el-table-column label="浏览器" width="95">
                <template #default="{ row }">
                  {{ formatNumber(row.browsers) }}
                </template>
              </el-table-column>
              <el-table-column label="会话" width="90">
                <template #default="{ row }">
                  {{ formatNumber(row.sessions) }}
                </template>
              </el-table-column>
              <el-table-column label="已用 / 已配页面" min-width="130">
                <template #default="{ row }">
                  {{ row.usedPages }} / {{ row.configuredPages }}
                </template>
              </el-table-column>
            </el-table>
          </section>

          <section class="panel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">WORK DEPTH</span>
                <h2>访问深度</h2>
                <p>描述任务路径，不把页面越多简单解释为越好。</p>
              </div>
            </div>
            <dl class="evidence-list">
              <div>
                <dt>会话页面打开数 p50 / p75</dt>
                <dd>
                  {{ formatNumber(resource.data.value.overview.depth.pageViewsP50) }}
                  /
                  {{ formatNumber(resource.data.value.overview.depth.pageViewsP75) }}
                </dd>
              </div>
              <div>
                <dt>会话不同页面数 p50 / p75</dt>
                <dd>
                  {{
                    formatNumber(resource.data.value.overview.depth.distinctPagesP50)
                  }}
                  /
                  {{
                    formatNumber(resource.data.value.overview.depth.distinctPagesP75)
                  }}
                </dd>
              </div>
              <div>
                <dt>会话模块广度 p50 / p75</dt>
                <dd>
                  {{
                    formatNumber(resource.data.value.overview.depth.moduleBreadthP50)
                  }}
                  /
                  {{
                    formatNumber(resource.data.value.overview.depth.moduleBreadthP75)
                  }}
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">CORE PAGES</span>
              <h2>核心页面</h2>
              <p>关键度由管理员显式配置，不从流量自动推断。</p>
            </div>
          </div>
          <el-table
            :data="resource.data.value.overview.corePages"
            empty-text="尚未配置核心页面"
          >
            <el-table-column label="页面" min-width="220">
              <template #default="{ row }">
                <button
                  type="button"
                  class="table-link"
                  @click="openPage(row.normalizedRoute)"
                >
                  <strong>{{ row.name }}</strong>
                  <small>{{ row.normalizedRoute }}</small>
                </button>
              </template>
            </el-table-column>
            <el-table-column prop="templateKey" label="模板" width="190" />
            <el-table-column label="PV" width="90">
              <template #default="{ row }">
                {{ formatNumber(row.metrics?.pageViews) }}
              </template>
            </el-table-column>
            <el-table-column label="可见时长 p50" width="140">
              <template #default="{ row }">
                {{ formatDuration(row.metrics?.durationP50Ms) }}
              </template>
            </el-table-column>
            <el-table-column label="时长覆盖率" width="120">
              <template #default="{ row }">
                {{ formatPercent(row.metrics?.durationCoverage) }}
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">KEY TASKS</span>
              <h2>关键任务</h2>
              <p>取消、失败与超时未结束分别保留，不并入成功。</p>
            </div>
          </div>
          <el-table
            :data="resource.data.value.overview.keyTasks"
            empty-text="尚未配置关键任务"
          >
            <el-table-column label="任务" min-width="180">
              <template #default="{ row }">
                <button type="button" class="table-link" @click="openTask(row.id)">
                  <strong>{{ row.name }}</strong>
                  <small>查看任务实例证据</small>
                </button>
              </template>
            </el-table-column>
            <el-table-column label="开始" width="90">
              <template #default="{ row }">{{ formatNumber(row.started) }}</template>
            </el-table-column>
            <el-table-column label="达成率" width="110">
              <template #default="{ row }">
                {{ formatPercent(row.completionRate) }}
              </template>
            </el-table-column>
            <el-table-column label="失败 / 取消 / 近似放弃" min-width="180">
              <template #default="{ row }">
                {{ formatNumber(row.failed) }} / {{ formatNumber(row.canceled) }} /
                {{ formatNumber(row.abandoned) }}
              </template>
            </el-table-column>
            <el-table-column label="成功耗时 p50" width="140">
              <template #default="{ row }">
                {{ formatDuration(row.successDurationP50Ms) }}
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section
          v-if="resource.data.value.overview.unclassified.length"
          class="panel warning-panel"
        >
          <div class="section-heading">
            <div>
              <span class="eyebrow">CONFIGURATION GAP</span>
              <h2>未归类 route</h2>
              <p>仍展示基础访问数据，但不会进入核心页面覆盖率或项目运营指数。</p>
            </div>
            <el-button
              plain
              @click="router.push({ name: 'operational-config', query: route.query })"
            >
              前往配置
            </el-button>
          </div>
          <el-table :data="resource.data.value.overview.unclassified">
            <el-table-column prop="route" label="route" min-width="260" />
            <el-table-column label="PV" width="100">
              <template #default="{ row }">
                {{ formatNumber(row.pageViews) }}
              </template>
            </el-table-column>
            <el-table-column label="账号 / 浏览器 / 会话" min-width="190">
              <template #default="{ row }">
                {{ formatNumber(row.accounts) }} / {{ formatNumber(row.browsers) }} /
                {{ formatNumber(row.sessions) }}
              </template>
            </el-table-column>
            <el-table-column label="最后访问" min-width="170">
              <template #default="{ row }">
                {{ formatDateTime(row.lastVisitAt) }}
              </template>
            </el-table-column>
          </el-table>
        </section>
      </template>
    </StatePanel>
  </div>
</template>
