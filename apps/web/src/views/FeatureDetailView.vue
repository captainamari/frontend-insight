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
import {
  fillTrendGaps,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
} from "../range";
import { useRemoteData } from "../remote";
import type { FeatureDetailResponse, TaskDetailResponse } from "../types";

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const resource = useRemoteData<{
  adoption: FeatureDetailResponse;
  task: TaskDetailResponse;
}>();
const featureId = computed(() => String(route.params.featureId ?? ""));
const fromTaskEvidence = computed(() => route.query.evidence === "task");
const chartPoints = computed(() => {
  const response = resource.data.value?.adoption;
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
  const metrics = resource.data.value?.adoption.metrics;
  if (!metrics) return [];
  return [
    ["曝光", metrics.exposed, "功能入口实际呈现"],
    ["开始", metrics.started, "用户开始操作；不代表成功"],
    ["成功", metrics.succeeded, "业务成功条件已满足"],
    ["失败", metrics.failed, "收到明确失败终态；v2 取消在任务实例证据中单列"],
  ] as const;
});

async function load(): Promise<void> {
  if (!context.projectId.value || !context.search.value || !featureId.value) return;
  const projectId = context.projectId.value;
  const query = context.search.value;
  await resource.load(async () => {
    const [adoption, task] = await Promise.all([
      api.request<FeatureDetailResponse>(
        `/api/projects/${projectId}/analytics/features/${featureId.value}?${query}`,
      ),
      api.request<TaskDetailResponse>(
        `/api/projects/${projectId}/analytics/tasks/${featureId.value}?${query}`,
      ),
    ]);
    return { adoption, task };
  });
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
      @click="
        router.push({
          name: fromTaskEvidence ? 'operational-overview' : 'features',
          query: route.query,
        })
      "
    >
      ← 返回{{ fromTaskEvidence ? "运营概览" : "功能采用" }}
    </button>
    <PageHeader
      eyebrow="FEATURE DETAIL"
      :title="resource.data.value?.adoption.feature.name ?? '功能详情'"
      :description="
        resource.data.value
          ? `${resource.data.value.adoption.feature.featureKey} · 标准阶段、跨会话采用与任务实例证据`
          : '查看标准采用阶段'
      "
    >
      <DefinitionsDrawer
        :sdk-versions="resource.data.value?.adoption.sdkVersions"
        :last-updated="resource.data.value?.adoption.sdkVersions[0]?.last_received_at"
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
            <p>不根据单一曝光后使用率自动判断设计好坏。</p>
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
                {{
                  formatNumber(resource.data.value?.adoption.metrics.succeeded_accounts)
                }}
              </dd>
            </div>
            <div>
              <dt>匿名浏览器</dt>
              <dd>
                {{
                  formatNumber(resource.data.value?.adoption.metrics.succeeded_visitors)
                }}
              </dd>
            </div>
            <div>
              <dt>重复使用账号</dt>
              <dd>
                {{
                  formatNumber(resource.data.value?.adoption.metrics.repeat_accounts)
                }}
              </dd>
            </div>
            <div>
              <dt>重复使用浏览器</dt>
              <dd>
                {{
                  formatNumber(resource.data.value?.adoption.metrics.repeat_visitors)
                }}
              </dd>
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
              Math.round(
                (resource.data.value?.adoption.metrics.visible_duration_ms ?? 0) / 1000,
              )
            }}
            秒
          </strong>
          <p>
            仅累计页面在前台可见的时间；后台标签页暂停，按同一长时实例的最大累计值去重。
          </p>
        </article>
      </section>

      <section
        v-if="resource.data.value?.task.feature.isKeyTask"
        class="panel"
        aria-label="v2 任务实例证据"
      >
        <div class="section-heading">
          <div>
            <span class="eyebrow">V2 OPERATION INSTANCES</span>
            <h2>任务实例与使用效率</h2>
            <p>
              按 SDK 随机 operationInstanceId 配对；保留数据中最早从
              {{ formatDateTime(resource.data.value.task.availableFrom) }}
              起可用。{{
                resource.data.value.task.availabilityStatus === "partial"
                  ? "当前筛选跨越 v1/v2 边界，仅展示边界后的任务实例。"
                  : ""
              }}
            </p>
          </div>
        </div>
        <section class="metrics-grid">
          <MetricCard
            label="开始 / 成功"
            :value="`${formatNumber(resource.data.value.task.metrics.started)} / ${formatNumber(resource.data.value.task.metrics.succeeded)}`"
            definition="同一实例的 started 与成功终态；并发任务不会按时间相邻关系配对。"
          />
          <MetricCard
            label="任务达成率"
            :value="formatPercent(resource.data.value.task.metrics.completionRate)"
            definition="成功 operation instances ÷ started instances。"
          />
          <MetricCard
            label="失败 / 取消 / 近似放弃"
            :value="`${formatNumber(resource.data.value.task.metrics.failed)} / ${formatNumber(resource.data.value.task.metrics.canceled)} / ${formatNumber(resource.data.value.task.metrics.abandoned)}`"
            :definition="resource.data.value.task.semantics.abandonment"
          />
          <MetricCard
            label="成功耗时 p50 / p75"
            :value="`${formatDuration(resource.data.value.task.metrics.successDurationP50Ms)} / ${formatDuration(resource.data.value.task.metrics.successDurationP75Ms)}`"
            :definition="resource.data.value.task.semantics.pairing"
          />
        </section>
      </section>
    </StatePanel>
  </div>
</template>
