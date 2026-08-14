<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api";
import DataStatusBanner from "../components/DataStatusBanner.vue";
import MetricCard from "../components/MetricCard.vue";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import TrendChart from "../components/TrendChart.vue";
import { useDashboardContext } from "../context";
import { formatDateTime, formatDuration, formatNumber, formatPercent } from "../range";
import { useRemoteData } from "../remote";
import type {
  ErrorGroupDetailResponse,
  ErrorGroupSummary,
  ObservabilityErrorType,
  ObservabilityOverviewResponse,
  ObservabilitySeverity,
  PagePerformanceResponse,
  WebVitalSummary,
} from "../types";

const context = useDashboardContext();
const resource = useRemoteData<ObservabilityOverviewResponse>();
const performance = useRemoteData<PagePerformanceResponse>();
const detail = useRemoteData<ErrorGroupDetailResponse>();
const drawerOpen = ref(false);
const errorType = ref<ObservabilityErrorType | "all">("all");
const severity = ref<ObservabilitySeverity | "all">("all");

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

const filteredErrors = computed(() =>
  (resource.data.value?.errors ?? []).filter(
    (item) =>
      (errorType.value === "all" || item.errorType === errorType.value) &&
      (severity.value === "all" || item.severity === severity.value),
  ),
);

const trendPoints = computed(() =>
  (resource.data.value?.trend ?? []).map((point) => ({
    bucket: point.bucket,
    primary: point.errors,
    secondary: point.poorVitalSamples,
  })),
);

const cards = computed(() => {
  const summary = resource.data.value?.summary;
  if (!summary) return [];
  return [
    {
      label: "错误发生次数",
      value: formatNumber(summary.errorOccurrences),
      definition: "所选范围内去重 eventId 后的 JS、资源与 API 错误事件总数。",
    },
    {
      label: "错误组",
      value: formatNumber(summary.errorGroups),
      definition:
        "按错误类型和稳定脱敏特征聚类；动态数字、标识符与 URL 参数不参与分组。",
    },
    {
      label: "受影响账号",
      value: formatNumber(summary.affectedAccounts),
      definition: "发生错误事件的去重 HMAC 账号数；平台不保存业务账号原值。",
    },
    {
      label: "受影响浏览器",
      value: formatNumber(summary.affectedBrowsers),
      definition: "发生错误事件的去重 SDK visitorId 数，不等同于自然人数量。",
    },
    {
      label: "Web Vitals 较差占比",
      value: formatPercent(
        summary.vitalSamples ? summary.poorVitalSamples / summary.vitalSamples : null,
      ),
      definition: `${summary.poorVitalSamples} / ${summary.vitalSamples} 个性能样本由 SDK 按固定阈值判定为 poor。`,
    },
    {
      label: "活跃固定告警",
      value: formatNumber(summary.activeAlerts),
      definition:
        "由当前时间范围实时计算的固定规则结果；M8 不包含确认、关闭或自定义规则流程。",
    },
  ];
});

function errorHeadline(item: ErrorGroupSummary): string {
  if (item.errorType === "api") {
    return `${item.requestMethod ?? "HTTP"} ${item.requestPath ?? "未知路径"} · ${item.httpStatus ?? "失败"}`;
  }
  if (item.errorType === "resource") {
    return `${item.resourceType ?? "资源"} · ${item.requestPath ?? "未知路径"}`;
  }
  return `${item.errorName ?? "JavaScript Error"} · ${item.message ?? "无脱敏消息"}`;
}

function errorTypeLabel(value: ObservabilityErrorType): string {
  return { js: "JS", resource: "资源", api: "API" }[value];
}

function severityLabel(value: ObservabilitySeverity): string {
  return { critical: "严重", high: "高", warning: "关注", info: "信息" }[value];
}

function severityTagType(value: ObservabilitySeverity) {
  if (value === "critical" || value === "high") return "danger" as const;
  if (value === "warning") return "warning" as const;
  return "info" as const;
}

function vitalValue(item: WebVitalSummary): string {
  if (item.p75 === null) return "—";
  return item.vitalName === "CLS" ? item.p75.toFixed(3) : `${Math.round(item.p75)} ms`;
}

async function load(): Promise<void> {
  if (!context.projectId.value || !context.search.value) return;
  await Promise.all([
    resource.load(() =>
      api.request<ObservabilityOverviewResponse>(
        `/api/projects/${context.projectId.value}/observability/overview?${context.search.value}`,
      ),
    ),
    performance.load(() =>
      api.request<PagePerformanceResponse>(
        `/api/projects/${context.projectId.value}/observability/page-performance?${context.search.value}`,
      ),
    ),
  ]);
}

async function openError(item: ErrorGroupSummary): Promise<void> {
  if (!context.projectId.value || !context.search.value) return;
  drawerOpen.value = true;
  await detail.load(() =>
    api.request<ErrorGroupDetailResponse>(
      `/api/projects/${context.projectId.value}/observability/errors/${item.groupId}?${context.search.value}`,
    ),
  );
}

watch(
  () => [context.projectId.value, context.search.value],
  () => {
    drawerOpen.value = false;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div>
    <PageHeader
      eyebrow="FRONTEND OBSERVABILITY / V1"
      title="页面分析"
      description="统一查看页面使用、性能、错误和发布影响；可观测性是诊断子域。"
    >
      <el-button type="primary" @click="load">刷新数据</el-button>
    </PageHeader>

    <DataStatusBanner :status="resource.data.value?.dataStatus ?? null" />

    <StatePanel
      :state="viewState"
      :title="viewState === 'forbidden' ? '无项目访问权限' : '可观测性数据暂不可用'"
      :message="
        viewState === 'forbidden'
          ? '当前账号未被授予这个项目的查看权限。'
          : resource.error.value?.message
      "
      :request-id="resource.error.value?.requestId"
      @retry="load"
    >
      <template v-if="resource.data.value">
        <section class="observability-boundary" aria-label="M8 边界">
          <div>
            <strong>独立证据层</strong>
            <span>项目运营指数仍为 v1，错误与性能不参与当前总分。</span>
          </div>
          <div>
            <strong>SourceMap 暂未启用</strong>
            <span>先用脱敏首帧验证真实定位需求，再单独评审源码暴露与存储边界。</span>
          </div>
          <small>{{ resource.data.value.boundaries.causality }}</small>
        </section>

        <section class="metrics-grid" aria-label="可观测性摘要">
          <MetricCard v-for="card in cards" :key="card.label" v-bind="card" />
        </section>

        <section class="panel p1-performance" aria-label="P1 页面性能证据">
          <div class="section-heading observability-heading">
            <div>
              <span class="eyebrow">CONTROLLED COLLECTORS / P1</span>
              <h2>页面性能与操作耗时</h2>
              <p>
                仅展示显式启用 collector 后的证据；没有分母时显示“未采集”，不会用 0
                代替。
              </p>
            </div>
            <router-link
              :to="{
                name: 'collector-settings',
                params: { projectId: context.projectId.value },
              }"
            >
              管理采集开关
            </router-link>
          </div>

          <div
            v-if="performance.loading.value && !performance.data.value"
            class="inline-empty compact-empty"
          >
            正在加载 P1 采集证据…
          </div>
          <div
            v-else-if="performance.error.value && !performance.data.value"
            class="collector-status collector-status-error"
          >
            <strong>P1 证据暂不可用</strong>
            <span>{{ performance.error.value.message }}</span>
            <el-button text type="primary" @click="load">重试</el-button>
          </div>
          <template v-else-if="performance.data.value">
            <div class="coverage-grid">
              <div>
                <span>页面浏览分母</span>
                <strong>{{
                  formatNumber(performance.data.value.coverage.pageViews)
                }}</strong>
              </div>
              <div>
                <span>API 覆盖</span>
                <strong>{{
                  formatPercent(performance.data.value.coverage.api.rate)
                }}</strong>
                <small
                  >{{ performance.data.value.coverage.api.observedPageViews }} /
                  {{ performance.data.value.coverage.pageViews }} · 采样
                  {{ formatPercent(performance.data.value.coverage.api.sampleRate) }}</small
                >
              </div>
              <div>
                <span>首屏覆盖</span>
                <strong>{{
                  formatPercent(performance.data.value.coverage.readiness.rate)
                }}</strong>
                <small
                  >{{ performance.data.value.coverage.readiness.observedPageViews }} /
                  {{ performance.data.value.coverage.pageViews }} · 采样
                  {{
                    formatPercent(performance.data.value.coverage.readiness.sampleRate)
                  }}</small
                >
              </div>
              <div>
                <span>资源覆盖</span>
                <strong>{{
                  formatPercent(performance.data.value.coverage.resources.rate)
                }}</strong>
                <small
                  >{{ performance.data.value.coverage.resources.observedPageViews }} /
                  {{ performance.data.value.coverage.pageViews }} · 采样
                  {{
                    formatPercent(performance.data.value.coverage.resources.sampleRate)
                  }}</small
                >
              </div>
              <div>
                <span>列表渲染覆盖</span>
                <strong>{{
                  formatPercent(performance.data.value.coverage.listRender.rate)
                }}</strong>
                <small
                  >{{ performance.data.value.coverage.listRender.observedPageViews }} /
                  {{ performance.data.value.coverage.pageViews }} · 采样
                  {{
                    formatPercent(performance.data.value.coverage.listRender.sampleRate)
                  }}</small
                >
              </div>
              <div>
                <span>长任务覆盖</span>
                <strong>{{
                  formatPercent(performance.data.value.coverage.longTasks.rate)
                }}</strong>
                <small
                  >{{ performance.data.value.coverage.longTasks.observedPageViews }} /
                  {{ performance.data.value.coverage.pageViews }} · 采样
                  {{
                    formatPercent(performance.data.value.coverage.longTasks.sampleRate)
                  }}</small
                >
              </div>
              <div>
                <span>白屏候选检测覆盖</span>
                <strong>{{
                  formatPercent(performance.data.value.coverage.blankScreen.rate)
                }}</strong>
                <small
                  >{{ performance.data.value.coverage.blankScreen.observedPageViews }} /
                  {{ performance.data.value.coverage.pageViews }} · 采样
                  {{
                    formatPercent(
                      performance.data.value.coverage.blankScreen.sampleRate,
                    )
                  }}</small
                >
              </div>
              <div>
                <span>Breadcrumb 错误覆盖</span>
                <strong>{{
                  formatPercent(performance.data.value.coverage.breadcrumbs.rate)
                }}</strong>
                <small
                  >{{ performance.data.value.coverage.breadcrumbs.observedErrors }} /
                  {{ performance.data.value.coverage.breadcrumbs.errorEvents }} · 采样
                  {{
                    formatPercent(
                      performance.data.value.coverage.breadcrumbs.sampleRate,
                    )
                  }}</small
                >
              </div>
            </div>

            <div
              v-if="
                [
                  performance.data.value.api.status,
                  performance.data.value.resources.status,
                  performance.data.value.readiness.status,
                  performance.data.value.listRender.status,
                  performance.data.value.longTasks.status,
                  performance.data.value.blankScreen.status,
                  performance.data.value.breadcrumbs.status,
                ].every((status) => status === 'not_collected')
              "
              class="collector-status"
            >
              <strong>当前范围未采集 P1 事件</strong>
              <span>请先在“采集开关”中按项目启用，再按 SDK 接入说明显式上报。</span>
            </div>

            <div class="p1-summary-grid">
              <article>
                <span>资源失败率</span>
                <strong>{{
                  performance.data.value.resources.status === "not_collected"
                    ? "未采集"
                    : formatPercent(performance.data.value.resources.failureRate)
                }}</strong>
                <small
                  v-if="performance.data.value.resources.status !== 'not_collected'"
                  >{{ performance.data.value.resources.numerator }} /
                  {{ performance.data.value.resources.denominator }} 次请求 · 可用起点
                  {{
                    formatDateTime(performance.data.value.resources.availableFrom)
                  }}</small
                >
              </article>
              <article>
                <span>长任务影响 PV 率</span>
                <strong>{{
                  performance.data.value.longTasks.status === "not_collected"
                    ? "未采集"
                    : formatPercent(
                        performance.data.value.longTasks.affectedPageViewRate,
                      )
                }}</strong>
                <small
                  v-if="performance.data.value.longTasks.status !== 'not_collected'"
                  >{{ performance.data.value.longTasks.count }} 次 ·
                  {{
                    formatDuration(performance.data.value.longTasks.durationMs)
                  }}</small
                >
              </article>
              <article>
                <span>白屏候选率</span>
                <strong>{{
                  performance.data.value.blankScreen.status === "not_collected"
                    ? "未采集"
                    : formatPercent(performance.data.value.blankScreen.candidateRate)
                }}</strong>
                <small
                  v-if="performance.data.value.blankScreen.status !== 'not_collected'"
                  >{{ performance.data.value.blankScreen.numerator }} /
                  {{ performance.data.value.blankScreen.denominator }} 个已检测 PV ·
                  关联错误
                  {{
                    formatNumber(
                      performance.data.value.blankScreen.relatedErrors.occurrences,
                    )
                  }}
                  次 · 关联资源失败
                  {{
                    formatNumber(
                      performance.data.value.blankScreen.relatedResources.numerator,
                    )
                  }}
                  /
                  {{
                    formatNumber(
                      performance.data.value.blankScreen.relatedResources.denominator,
                    )
                  }}</small
                >
              </article>
            </div>

            <div class="section-heading">
              <h3>API 请求汇总</h3>
              <small
                >可用起点：{{
                  formatDateTime(performance.data.value.api.availableFrom)
                }}</small
              >
            </div>
            <el-table
              :data="performance.data.value.api.items"
              empty-text="未采集 API 请求汇总"
            >
              <el-table-column label="接口" min-width="260">
                <template #default="{ row }"
                  ><code>{{ row.requestMethod }} {{ row.requestPath }}</code></template
                >
              </el-table-column>
              <el-table-column label="P50 / P90" width="170">
                <template #default="{ row }"
                  >{{ formatDuration(row.p50Ms) }} /
                  {{ formatDuration(row.p90Ms) }}</template
                >
              </el-table-column>
              <el-table-column label="成功 / 错误 / 慢" min-width="230">
                <template #default="{ row }"
                  >{{ formatPercent(row.successRate) }} /
                  {{ formatPercent(row.errorRate) }} /
                  {{ formatPercent(row.slowRequestRate) }}</template
                >
              </el-table-column>
              <el-table-column label="分母" width="90">
                <template #default="{ row }">{{
                  formatNumber(row.denominator)
                }}</template>
              </el-table-column>
              <el-table-column label="状态" width="110">
                <template #default="{ row }">{{
                  row.status === "insufficient_sample" ? "样本不足" : "可用"
                }}</template>
              </el-table-column>
            </el-table>

            <h3>资源失败率 · 发布版本对比</h3>
            <el-table
              :data="performance.data.value.resources.releases"
              empty-text="未采集资源发布版本对比"
            >
              <el-table-column prop="releaseVersion" label="发布版本" min-width="150" />
              <el-table-column label="失败 / 分母" min-width="150">
                <template #default="{ row }">
                  {{ formatNumber(row.numerator) }} /
                  {{ formatNumber(row.denominator) }}
                </template>
              </el-table-column>
              <el-table-column label="失败率" width="110">
                <template #default="{ row }">{{
                  formatPercent(row.failureRate)
                }}</template>
              </el-table-column>
              <el-table-column label="采样率" width="110">
                <template #default="{ row }">{{
                  formatPercent(row.sampleRate)
                }}</template>
              </el-table-column>
              <el-table-column label="可用起点" min-width="180">
                <template #default="{ row }">{{
                  formatDateTime(row.availableFrom)
                }}</template>
              </el-table-column>
            </el-table>

            <div class="overview-columns p1-detail-columns">
              <section>
                <h3>首屏 readiness（按模板）</h3>
                <small
                  >可用起点：{{
                    formatDateTime(performance.data.value.readiness.availableFrom)
                  }}</small
                >
                <el-table
                  :data="performance.data.value.readiness.items"
                  empty-text="未采集显式 readiness"
                >
                  <el-table-column prop="templateKey" label="模板" min-width="130" />
                  <el-table-column label="P50 / P90" min-width="150">
                    <template #default="{ row }"
                      >{{ formatDuration(row.p50Ms) }} /
                      {{ formatDuration(row.p90Ms) }}</template
                    >
                  </el-table-column>
                  <el-table-column prop="sampleSize" label="样本" width="72" />
                  <el-table-column label="白屏候选" width="110">
                    <template #default="{ row }">{{
                      formatPercent(row.blankCandidateRate)
                    }}</template>
                  </el-table-column>
                </el-table>
              </section>
              <section>
                <h3>列表渲染（按行数桶）</h3>
                <small
                  >可用起点：{{
                    formatDateTime(performance.data.value.listRender.availableFrom)
                  }}</small
                >
                <el-table
                  :data="performance.data.value.listRender.items"
                  empty-text="未采集列表渲染"
                >
                  <el-table-column prop="route" label="页面" min-width="140" />
                  <el-table-column prop="rowCountBucket" label="行数桶" width="110" />
                  <el-table-column label="P50 / P90" min-width="150">
                    <template #default="{ row }"
                      >{{ formatDuration(row.p50Ms) }} /
                      {{ formatDuration(row.p90Ms) }}</template
                    >
                  </el-table-column>
                  <el-table-column prop="sampleSize" label="样本" width="72" />
                </el-table>
              </section>
            </div>
            <p class="privacy-note">
              白屏仅表示 adapter 判定的候选状态，不等同于事实；API、资源、长任务和
              breadcrumb 均不采集 query、header/body、DOM、输入内容或业务对象 ID。口径
              {{ performance.data.value.definitionVersion }}。
            </p>
          </template>
        </section>

        <section class="panel chart-panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">INCIDENT TREND</span>
              <h2>错误与较差性能样本趋势</h2>
              <p>可与发布版本并列查看，但时间重合只提供排查线索，不自动推断因果。</p>
            </div>
            <small>
              数据可用起点：{{ formatDateTime(resource.data.value.availableFrom) }}
            </small>
          </div>
          <TrendChart
            v-if="trendPoints.length"
            :points="trendPoints"
            primary-label="错误次数"
            secondary-label="较差性能样本"
          />
          <div v-else class="inline-empty">所选范围内没有错误或性能样本。</div>
        </section>

        <section class="panel">
          <div class="section-heading observability-heading">
            <div>
              <span class="eyebrow">ERROR GROUPS</span>
              <h2>错误组与影响范围</h2>
              <p>
                点击错误组查看页面 × 发布版本下钻；消息、路径和首帧已在 SDK 侧裁剪。
              </p>
            </div>
            <div class="observability-filters">
              <el-select
                v-model="errorType"
                aria-label="错误类型"
                class="compact-select"
              >
                <el-option label="全部类型" value="all" />
                <el-option label="JS" value="js" />
                <el-option label="资源" value="resource" />
                <el-option label="API" value="api" />
              </el-select>
              <el-select
                v-model="severity"
                aria-label="错误级别"
                class="compact-select"
              >
                <el-option label="全部级别" value="all" />
                <el-option label="严重" value="critical" />
                <el-option label="高" value="high" />
                <el-option label="关注" value="warning" />
                <el-option label="信息" value="info" />
              </el-select>
            </div>
          </div>
          <el-table
            :data="filteredErrors"
            empty-text="所选范围内没有匹配的错误组"
            class="clickable-table"
            @row-click="openError"
          >
            <el-table-column label="错误" min-width="300">
              <template #default="{ row }">
                <div class="error-cell">
                  <span>
                    <el-tag size="small" effect="plain">{{
                      errorTypeLabel(row.errorType)
                    }}</el-tag>
                    <el-tag
                      size="small"
                      :type="severityTagType(row.severity)"
                      effect="dark"
                    >
                      {{ severityLabel(row.severity) }}
                    </el-tag>
                  </span>
                  <strong>{{ errorHeadline(row) }}</strong>
                  <small>{{ row.stackTopFrame ?? row.groupId.slice(0, 16) }}</small>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="次数" width="90">
              <template #default="{ row }">{{
                formatNumber(row.occurrences)
              }}</template>
            </el-table-column>
            <el-table-column label="账号 / 浏览器" width="150">
              <template #default="{ row }">
                {{ formatNumber(row.affectedAccounts) }} /
                {{ formatNumber(row.affectedBrowsers) }}
              </template>
            </el-table-column>
            <el-table-column label="页面" width="90">
              <template #default="{ row }">{{
                formatNumber(row.affectedPages)
              }}</template>
            </el-table-column>
            <el-table-column label="发布版本" min-width="150">
              <template #default="{ row }">{{
                row.releases.join(", ") || "unknown"
              }}</template>
            </el-table-column>
            <el-table-column label="最近发生" width="180">
              <template #default="{ row }">{{
                formatDateTime(row.lastSeenAt)
              }}</template>
            </el-table-column>
          </el-table>
        </section>

        <div class="overview-columns">
          <section class="panel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">WEB VITALS</span>
                <h2>页面性能 p75</h2>
                <p>按页面、指标和发布版本分组；至少 20 个样本才触发固定告警判断。</p>
              </div>
            </div>
            <el-table
              :data="resource.data.value.vitals"
              empty-text="所选范围内没有 Web Vitals 样本"
            >
              <el-table-column prop="route" label="页面" min-width="170" />
              <el-table-column prop="vitalName" label="指标" width="80" />
              <el-table-column label="p75" width="100">
                <template #default="{ row }">{{ vitalValue(row) }}</template>
              </el-table-column>
              <el-table-column label="poor" width="110">
                <template #default="{ row }">
                  {{ formatPercent(row.poorRate) }} · {{ row.poorSamples }}/{{
                    row.sampleSize
                  }}
                </template>
              </el-table-column>
              <el-table-column prop="releaseVersion" label="发布" min-width="120" />
            </el-table>
          </section>

          <section class="panel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">FIXED ALERTS</span>
                <h2>固定告警证据</h2>
                <p>当前只读且不可确认/关闭；避免在处理流程验证前引入隐式状态。</p>
              </div>
            </div>
            <ol v-if="resource.data.value.alerts.length" class="alert-list">
              <li v-for="alert in resource.data.value.alerts" :key="alert.id">
                <el-tag :type="severityTagType(alert.severity)" effect="dark">
                  {{ severityLabel(alert.severity) }}
                </el-tag>
                <div>
                  <strong>{{ alert.title }}</strong>
                  <p>{{ alert.evidence }}</p>
                  <small>{{ formatDateTime(alert.triggeredAt) }}</small>
                </div>
              </li>
            </ol>
            <div v-else class="inline-empty">当前没有达到固定门槛的告警。</div>
            <details class="policy-details">
              <summary>查看固定规则构成</summary>
              <p>错误：{{ resource.data.value.alertPolicy.errorSpike }}</p>
              <p>性能：{{ resource.data.value.alertPolicy.webVitalPoor }}</p>
              <small
                >口径版本：{{
                  resource.data.value.alertPolicy.definitionVersion
                }}</small
              >
            </details>
          </section>
        </div>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">RELEASE EVIDENCE</span>
              <h2>发布版本关联</h2>
              <p>releaseVersion 由宿主显式注入；unknown 不会被平台猜测或回填。</p>
            </div>
          </div>
          <el-table
            :data="resource.data.value.releases"
            empty-text="所选范围内没有带发布版本的可观测性事件"
          >
            <el-table-column prop="releaseVersion" label="版本" min-width="150" />
            <el-table-column prop="deploymentEnvironment" label="环境" width="120" />
            <el-table-column label="错误 / 错误组" width="150">
              <template #default="{ row }">
                {{ formatNumber(row.errors) }} / {{ formatNumber(row.errorGroups) }}
              </template>
            </el-table-column>
            <el-table-column label="poor 样本" width="110">
              <template #default="{ row }">{{
                formatNumber(row.poorVitalSamples)
              }}</template>
            </el-table-column>
            <el-table-column label="影响浏览器" width="120">
              <template #default="{ row }">{{
                formatNumber(row.affectedBrowsers)
              }}</template>
            </el-table-column>
            <el-table-column label="首次 / 最近" min-width="260">
              <template #default="{ row }">
                {{ formatDateTime(row.firstSeenAt) }} →
                {{ formatDateTime(row.lastSeenAt) }}
              </template>
            </el-table-column>
          </el-table>
        </section>
      </template>
    </StatePanel>

    <el-drawer v-model="drawerOpen" title="错误组证据" size="min(720px, 92vw)">
      <div v-if="detail.loading.value && !detail.data.value" class="inline-empty">
        正在加载错误组…
      </div>
      <div v-else-if="detail.error.value" class="inline-empty">
        {{ detail.error.value.message }}
        <small v-if="detail.error.value.requestId">
          requestId: {{ detail.error.value.requestId }}
        </small>
      </div>
      <div v-else-if="detail.data.value" class="error-drawer">
        <div class="error-drawer-title">
          <span>
            <el-tag effect="plain">{{
              errorTypeLabel(detail.data.value.item.errorType)
            }}</el-tag>
            <el-tag
              :type="severityTagType(detail.data.value.item.severity)"
              effect="dark"
            >
              {{ severityLabel(detail.data.value.item.severity) }}
            </el-tag>
          </span>
          <h2>{{ errorHeadline(detail.data.value.item) }}</h2>
          <code>{{ detail.data.value.item.stackTopFrame ?? "没有可用首帧" }}</code>
        </div>
        <dl class="evidence-list">
          <div>
            <dt>发生次数</dt>
            <dd>{{ formatNumber(detail.data.value.item.occurrences) }}</dd>
          </div>
          <div>
            <dt>影响账号 / 浏览器 / 页面</dt>
            <dd>
              {{ formatNumber(detail.data.value.item.affectedAccounts) }} /
              {{ formatNumber(detail.data.value.item.affectedBrowsers) }} /
              {{ formatNumber(detail.data.value.item.affectedPages) }}
            </dd>
          </div>
          <div>
            <dt>首次 / 最近</dt>
            <dd>
              {{ formatDateTime(detail.data.value.item.firstSeenAt) }} →
              {{ formatDateTime(detail.data.value.item.lastSeenAt) }}
            </dd>
          </div>
          <div>
            <dt>浏览器 / OS 粗粒度</dt>
            <dd>
              {{ detail.data.value.item.browserFamilies.join(", ") || "unknown" }} /
              {{ detail.data.value.item.osFamilies.join(", ") || "unknown" }}
            </dd>
          </div>
          <div>
            <dt>视口档位</dt>
            <dd>
              {{ detail.data.value.item.viewportBuckets.join(", ") || "unknown" }}
            </dd>
          </div>
        </dl>
        <section>
          <h3>页面 × 发布版本</h3>
          <el-table :data="detail.data.value.impact" empty-text="没有影响明细">
            <el-table-column prop="route" label="页面" min-width="180" />
            <el-table-column prop="releaseVersion" label="发布" min-width="130" />
            <el-table-column prop="occurrences" label="次数" width="80" />
            <el-table-column prop="affectedBrowsers" label="浏览器" width="90" />
          </el-table>
        </section>
        <section>
          <h3>错误前 Breadcrumb 诊断证据</h3>
          <el-collapse v-if="detail.data.value.breadcrumbSamples.length">
            <el-collapse-item
              v-for="(sample, index) in detail.data.value.breadcrumbSamples"
              :key="`${sample.occurredAt ?? 'unknown'}-${index}`"
              :title="`${sample.route} · ${sample.releaseVersion} · ${formatDateTime(
                sample.occurredAt,
              )}`"
            >
              <el-timeline>
                <el-timeline-item
                  v-for="(item, itemIndex) in sample.items"
                  :key="`${item.occurredAt}-${itemIndex}`"
                  :timestamp="formatDateTime(item.occurredAt)"
                >
                  {{ item.kind }} · {{ item.key }}
                  <code v-if="item.method || item.path">
                    {{ item.method ?? "" }} {{ item.path ?? "" }}
                  </code>
                  <span v-if="item.statusCode"> · {{ item.statusCode }}</span>
                </el-timeline-item>
              </el-timeline>
            </el-collapse-item>
          </el-collapse>
          <div v-else class="inline-empty">该错误组未采集 breadcrumb。</div>
        </section>
        <p class="privacy-note">{{ detail.data.value.privacy }}</p>
      </div>
    </el-drawer>
  </div>
</template>
