<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import DataStatusBanner from "../components/DataStatusBanner.vue";
import DefinitionsDrawer from "../components/DefinitionsDrawer.vue";
import MetricCard from "../components/MetricCard.vue";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import TrendChart from "../components/TrendChart.vue";
import { useDashboardContext } from "../context";
import { resolveProductPresentation } from "../presentation";
import { fillTrendGaps, formatDateTime, formatNumber } from "../range";
import { useRemoteData } from "../remote";
import type {
  DataStatus,
  OverviewMetrics,
  OverviewResponse,
  PagesResponse,
  TrendResponse,
} from "../types";

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const page = ref(1);
const search = ref("");
const resource = useRemoteData<{
  overview: OverviewResponse;
  trend: TrendResponse;
  pages: PagesResponse;
  status: DataStatus;
}>();

const cards = computed(() => {
  const current = resource.data.value?.overview.current;
  const previous = resource.data.value?.overview.comparison.metrics;
  if (!current || !previous) return [];
  const definitions: Array<[keyof OverviewMetrics, string, string]> = [
    ["pv", "PV", "page_view 事件数；刷新和重复访问会重复计数。"],
    ["visitors", "活跃浏览器", "去重 visitorId，表示浏览器存储实例，不是真实人数。"],
    [
      "accounts",
      "已识别账号",
      "业务显式账号引用经项目级 HMAC 后去重；共享账号只算一个。",
    ],
    ["sessions", "会话", "标签页内连续活动，30 分钟无活动后新建。"],
  ];
  return definitions.map(([key, label, definition]) => ({
    label,
    value: formatNumber(Number(current[key] ?? 0)),
    comparison: `昨日同时段 ${formatNumber(Number(previous[key] ?? 0))}`,
    definition,
  }));
});
const chartPoints = computed(() => {
  const response = resource.data.value?.trend;
  if (!response) return [];
  return fillTrendGaps(response.points, response.range, "pv", "visitors");
});
const presentation = computed(() =>
  resolveProductPresentation({
    loading: !context.projectId.value || resource.loading.value,
    hasData: Boolean(resource.data.value),
    errorStatus: resource.error.value?.status ?? null,
    dataState: resource.data.value?.status.state ?? null,
    hasActivity:
      resource.data.value === null ? null : resource.data.value.overview.current.pv > 0,
    hasGaps: chartPoints.value.some((point) => point.primary === null),
  }),
);
const viewState = computed(() => {
  if (presentation.value === "loading") return "loading" as const;
  if (presentation.value === "forbidden") return "forbidden" as const;
  if (presentation.value === "error") return "error" as const;
  if (presentation.value === "stale") return "stale" as const;
  return "ready" as const;
});

async function load(resetPage = false): Promise<void> {
  if (!context.projectId.value || !context.search.value) return;
  if (resetPage) page.value = 1;
  const projectId = context.projectId.value;
  const range = context.search.value;
  const pagesQuery = new URLSearchParams(range);
  pagesQuery.set("page", String(page.value));
  pagesQuery.set("pageSize", "20");
  pagesQuery.set("sort", "pv");
  pagesQuery.set("direction", "desc");
  if (search.value.trim()) pagesQuery.set("search", search.value.trim());
  await resource.load(async () => {
    const [overview, trend, pages, status] = await Promise.all([
      api.request<OverviewResponse>(
        `/api/projects/${projectId}/analytics/overview?${range}`,
      ),
      api.request<TrendResponse>(`/api/projects/${projectId}/analytics/trend?${range}`),
      api.request<PagesResponse>(
        `/api/projects/${projectId}/analytics/pages?${pagesQuery}`,
      ),
      api.request<DataStatus>(`/api/projects/${projectId}/data-status`),
    ]);
    return { overview, trend, pages, status };
  });
}

watch(
  () => [context.projectId.value, context.search.value, page.value],
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <div>
    <PageHeader
      eyebrow="PAGE EVIDENCE"
      title="页面访问"
      description="查看访问量、匿名浏览器、已识别账号和标签页会话，不把它们混称为真实人数。"
    >
      <DefinitionsDrawer
        :sdk-versions="resource.data.value?.overview.sdkVersions"
        :last-updated="resource.data.value?.status.lastQueryableAt"
      />
      <el-button type="primary" @click="load()">刷新数据</el-button>
    </PageHeader>

    <DataStatusBanner :status="resource.data.value?.status ?? null" />

    <StatePanel
      :state="viewState"
      :title="viewState === 'forbidden' ? '无项目访问权限' : '页面数据暂不可用'"
      :message="
        viewState === 'forbidden'
          ? '当前账号未被授予这个项目的查看权限。'
          : resource.error.value?.message
      "
      :request-id="resource.error.value?.requestId"
      @retry="load()"
    >
      <section v-if="presentation === 'onboarding'" class="onboarding-callout">
        <div>
          <span class="eyebrow">FIRST EVENT</span>
          <h2>尚未收到任何页面事件</h2>
          <p>请先完成项目接入；系统不会把尚未接入显示成正常的 0 访问。</p>
        </div>
        <el-button
          type="primary"
          @click="router.push({ name: 'onboarding', query: route.query })"
        >
          前往接入验证
        </el-button>
      </section>

      <template v-else>
        <section class="metrics-grid" aria-label="页面访问核心指标">
          <MetricCard v-for="card in cards" :key="card.label" v-bind="card" />
        </section>

        <section class="panel chart-panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">TRAFFIC TREND</span>
              <h2>PV 与活跃浏览器趋势</h2>
              <p>昨日比较为项目时区下的相同时长区间。</p>
            </div>
            <span class="last-updated">
              数据更新时间：{{
                formatDateTime(resource.data.value?.overview.current.last_received_at)
              }}
            </span>
          </div>
          <TrendChart
            v-if="chartPoints.some((point) => point.primary !== null)"
            :points="chartPoints"
            primary-label="PV"
            secondary-label="活跃浏览器"
          />
          <div v-else class="inline-empty">
            所选时间范围内无有效访问；链路状态仍为
            {{ resource.data.value?.status.state === "healthy" ? "正常" : "非正常" }}。
          </div>
        </section>

        <section class="panel">
          <div class="section-heading table-toolbar">
            <div>
              <span class="eyebrow">ROUTE RANKING</span>
              <h2>页面排行</h2>
            </div>
            <el-input
              v-model="search"
              class="route-search"
              clearable
              placeholder="搜索归一化路由"
              aria-label="搜索页面路由"
              @keyup.enter="load(true)"
              @clear="load(true)"
            >
              <template #append>
                <el-button @click="load(true)">搜索</el-button>
              </template>
            </el-input>
          </div>

          <el-table
            :data="resource.data.value?.pages.items ?? []"
            empty-text="所选范围内没有匹配页面"
          >
            <el-table-column label="归一化路由" min-width="280">
              <template #default="{ row }">
                <button
                  type="button"
                  class="table-link"
                  @click="
                    router.push({
                      name: 'page-detail',
                      query: { ...route.query, route: row.route },
                    })
                  "
                >
                  <strong>{{ row.route }}</strong>
                  <small>查看停留、深度与页面任务</small>
                </button>
              </template>
            </el-table-column>
            <el-table-column label="PV" width="100">
              <template #default="{ row }">{{ formatNumber(row.pv) }}</template>
            </el-table-column>
            <el-table-column label="浏览器" width="110">
              <template #default="{ row }">{{ formatNumber(row.visitors) }}</template>
            </el-table-column>
            <el-table-column label="会话" width="100">
              <template #default="{ row }">{{ formatNumber(row.sessions) }}</template>
            </el-table-column>
            <el-table-column label="最后访问" min-width="170">
              <template #default="{ row }">
                {{ formatDateTime(row.last_visit_at) }}
              </template>
            </el-table-column>
            <el-table-column label="最后接收" min-width="170">
              <template #default="{ row }">
                {{ formatDateTime(row.last_received_at) }}
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-if="(resource.data.value?.pages.total ?? 0) > 20"
            v-model:current-page="page"
            class="table-pagination"
            :page-size="20"
            layout="prev, pager, next, total"
            :total="resource.data.value?.pages.total ?? 0"
          />
        </section>
      </template>
    </StatePanel>
  </div>
</template>
