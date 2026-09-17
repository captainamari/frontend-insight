<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api";
import { auth } from "../auth";
import { projects } from "../projects";
import { entryReason, pipelineLabels, projectStateLabels } from "../project-entry";
import type { OverviewResponse, OverviewMetric } from "../overview-types";
import OverviewScore from "../components/OverviewScore.vue";
import OverviewTrends from "../components/OverviewTrends.vue";
import ScoreExplanation from "../components/ScoreExplanation.vue";
import { ElDrawer } from "element-plus";
import "element-plus/es/components/drawer/style/css";
const route = useRoute(),
  router = useRouter();
const data = ref<OverviewResponse | null>(null),
  loading = ref(false),
  error = ref(""),
  dataRequest = ref("");
let generation = 0,
  controller: AbortController | null = null;
const drill = ref("");
const signature = computed(() =>
  JSON.stringify([
    route.params.projectId,
    route.query.env,
    route.query.range,
    route.query.from,
    route.query.to,
    route.query.trends,
  ]),
);
const canWrite = computed(
  () =>
    auth.state.user?.globalRole === "admin" &&
    ["owner", "admin"].includes(
      projects.find(String(route.params.projectId))?.role ?? "",
    ),
);
const selectedMetric = computed(() =>
  data.value?.metrics.cards.find(
    (m) => "metric:" + m.definition.metricKey === drill.value,
  ),
);
const selectedAlert = computed(() =>
  data.value?.alerts.items.find((a) => "alert:" + a.id === drill.value),
);
const selectedScore = computed(() =>
  drill.value === "operational"
    ? data.value?.operational.result
    : drill.value === "quality"
      ? data.value?.quality.result
      : null,
);
const stale = computed(
  () => Boolean(data.value) && (loading.value || Boolean(error.value)),
);
async function load() {
  const id = ++generation,
    key = signature.value;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = "";
  if (dataRequest.value !== key) {
    data.value = null;
    drill.value = "";
  }
  const params = new URLSearchParams();
  for (const k of ["env", "range", "from", "to"])
    if (typeof route.query[k] === "string") params.set(k, String(route.query[k]));
  if (typeof route.query.trends === "string") params.set("metrics", route.query.trends);
  try {
    const result = await api.request<OverviewResponse>(
      `/api/projects/${encodeURIComponent(String(route.params.projectId))}/overview?${params}`,
      { signal: controller.signal },
    );
    if (id !== generation || key !== signature.value) return;
    if (data.value?.identity !== result.identity) drill.value = "";
    data.value = result;
    dataRequest.value = key;
  } catch (e) {
    if (id !== generation) return;
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      data.value = null;
      drill.value = "";
    }
    error.value =
      e instanceof ApiError
        ? `${e.code} · 请求 ID ${e.requestId ?? "—"}`
        : "读取失败，请检查连接后重试。";
  } finally {
    if (id === generation) loading.value = false;
  }
}
function dims(type: string) {
  const text = route.query[type + "Radar"];
  return typeof text === "string" && text.length ? text.split(",") : [];
}
async function selection(type: string, value: string[]) {
  await router.push({
    query: {
      ...route.query,
      [type + "Radar"]: value.length ? value.join(",") : undefined,
    },
  });
}
async function trend(metric: OverviewMetric, checked: boolean) {
  const selected = data.value?.metrics.selected ?? [],
    key = metric.definition.metricKey,
    next = checked ? [...selected, key] : selected.filter((k) => k !== key);
  await router.push({ query: { ...route.query, trends: next.join(",") } });
}
function limit(metric: OverviewMetric) {
  if (!data.value || data.value.metrics.selected.includes(metric.definition.metricKey))
    return false;
  return (
    data.value.metrics.selected.length >= 16 ||
    data.value.metrics.cards.filter(
      (c) =>
        data.value!.metrics.selected.includes(c.definition.metricKey) &&
        c.definition.unit === metric.definition.unit,
    ).length >= 4
  );
}
function configure(tab: string) {
  void router.push({
    name: "project-metrics",
    params: route.params,
    query: { ...route.query, tab },
  });
}
const time = (s: string | null) =>
  s
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: data.value?.query.timezone ?? "UTC",
        dateStyle: "medium",
        timeStyle: "long",
      }).format(new Date(s))
    : "—";
watch(signature, () => void load(), { immediate: true });
onMounted(() => window.addEventListener("focus", load));
onBeforeUnmount(() => {
  generation++;
  controller?.abort();
  window.removeEventListener("focus", load);
});
</script>
<template>
  <div class="overview">
    <header class="overview-heading">
      <div>
        <h1>项目概览</h1>
        <p>从当前证据了解项目运行情况</p>
      </div>
      <button :disabled="loading" @click="load">
        {{ loading ? "正在刷新…" : "刷新数据" }}
      </button>
    </header>
    <p v-if="loading && !data" role="status">正在加载项目概览…</p>
    <p v-if="error" role="alert">
      概览读取失败：{{ error }} <button @click="load">重试</button>
    </p>
    <p v-if="stale" class="notice" role="status">
      {{
        loading ? "正在刷新，暂保留上次数据" : "刷新失败，保留上次数据"
      }}（stale）。数据身份 {{ data?.identity }}；运营版本
      {{ data?.operational.version?.id ?? "无" }}，质量版本
      {{ data?.quality.version?.id ?? "无" }}。不代表最新激活版本。
    </p>
    <template v-if="data"
      ><section class="panel" aria-label="链路与数据状态">
        <h2>
          {{ projectStateLabels[data.state] ?? data.state }} ·
          {{ pipelineLabels[data.pipeline.state] ?? data.pipeline.state }}
        </h2>
        <p>
          项目 {{ data.project.name }} · {{ data.query.env }} ·
          {{ data.query.timezone }} · 状态作用范围
          {{ data.pipeline.scope === "project" ? "项目级" : "当前环境" }}；环境健康{{
            data.pipeline.envVerified ? "已验证" : "未验证"
          }}
        </p>
        <p>
          最近数据更新时间：{{ time(data.lastDataAt) }}；当前环境保留数据起点：{{
            time(data.availableFrom)
          }}
        </p>
        <p>
          {{ entryReason(data.data.reason) }}。{{
            data.pipeline.reasons.map(entryReason).join("；")
          }}
        </p>
        <details>
          <summary>范围、来源与版本身份</summary>
          <p>
            {{ data.query.from }} — {{ data.query.to }}（结束不含），{{
              data.query.granularity
            }}，共{{ data.query.buckets.length }}桶。
          </p>
          <p>
            {{ data.lastDataSource }}。配置保留
            {{ data.project.retentionDays }} 天，当前存储物理 TTL
            {{ data.diagnostics.physicalRetentionDays }} 天。
          </p>
          <p>数据身份 {{ data.identity }}</p>
        </details>
      </section>
      <div class="score-grid">
        <OverviewScore
          :score="data.operational"
          label="运营分数"
          :selection="dims('operational')"
          @selection="selection('operational', $event)"
          @explain="drill = 'operational'"
        /><OverviewScore
          :score="data.quality"
          label="质量分数"
          :selection="dims('quality')"
          @selection="selection('quality', $event)"
          @explain="drill = 'quality'"
        />
      </div>
      <p>
        <button @click="configure('scores')">
          {{ canWrite ? "在指标管理创建草稿并修改公式" : "查看分数定义和版本" }}
        </button>
      </p>
      <section class="panel" aria-label="运营指标">
        <h2>运营指标</h2>
        <p v-if="data.metrics.status === 'missing_active'">缺少已激活运营指标版本。</p>
        <p v-else-if="data.metrics.status === 'missing_bindings'">
          当前版本没有概览展示绑定。{{
            canWrite
              ? "请在指标管理设置展示指标并激活新版本。"
              : "请联系项目管理员配置。"
          }}
        </p>
        <button @click="configure('operational-metrics')">
          {{ canWrite ? "配置概览展示指标" : "查看指标定义" }}
        </button>
        <div
          class="metric-scroll"
          tabindex="0"
          role="region"
          aria-label="运营指标卡片，可用左右方向键滚动"
        >
          <article
            v-for="m in data.metrics.cards"
            :key="m.definition.metricKey"
            class="metric-card"
          >
            <h3>{{ m.definition.displayName }}</h3>
            <strong>{{ m.value ?? "—" }}</strong> {{ m.definition.unit }}
            <p>{{ m.definition.businessDescription }}</p>
            <p>样本 {{ m.sampleSize ?? "—" }} · {{ m.status }}</p>
            <p>
              {{ entryReason(m.reason ?? "") }} {{ m.definition.unavailableReason }}
            </p>
            <p>数据时间 {{ time(m.dataAt) }}</p>
            <p v-if="m.rawValue !== null">
              已观测原始值 {{ m.rawValue }}（完整性未验证）
            </p>
            <button @click="drill = 'metric:' + m.definition.metricKey">
              查看{{ m.definition.displayName }}定义与证据
            </button>
          </article>
        </div>
      </section>
      <section class="panel" aria-label="指标变化趋势">
        <h2>指标变化趋势</h2>
        <p>
          同单位最多4条，混合单位分图。缺口不补0、不跨版本连线；整个窗口由同一公式独立求值。
        </p>
        <div class="trend-selection">
          <label v-for="m in data.metrics.cards" :key="m.definition.metricKey"
            ><input
              type="checkbox"
              :checked="data.metrics.selected.includes(m.definition.metricKey)"
              :disabled="limit(m)"
              @change="trend(m, ($event.target as HTMLInputElement).checked)"
            />{{ m.definition.displayName }}（{{ m.definition.unit }}）</label
          >
        </div>
        <p v-for="b in data.metrics.boundaries" :key="b.at">
          版本分界：{{ time(b.at) }} · {{ b.versionId }}；分界前不回标为当前版本。
        </p>
        <OverviewTrends :metrics="data.metrics" />
      </section>
      <section class="panel" aria-label="固定告警摘要">
        <h2>固定告警摘要</h2>
        <p>
          {{
            ["unavailable", "insufficient_sample"].includes(data.alerts.status)
              ? "告警无法评估"
              : data.alerts.items.length
                ? "已观测到固定规则触发"
                : "所查样本未触发固定规则"
          }}。{{ entryReason(data.alerts.reason) }}；不能据此断言整个环境无告警或健康。
        </p>
        <p v-if="data.alerts.truncated">达到摘要上限，当前仅显示部分证据。</p>
        <article v-for="a in data.alerts.items" :key="a.id">
          <h3>{{ a.title }} · {{ a.severity }}</h3>
          <p>{{ a.evidence }}</p>
          <button @click="drill = 'alert:' + a.id">查看告警证据</button>
        </article>
        <details>
          <summary>规则和评估范围</summary>
          <p v-for="(rule, key) in data.alerts.rules" :key="key">
            {{ key }}：{{ rule }}
          </p>
          <p>
            {{ data.query.env }} / {{ data.query.from }} —
            {{ data.query.to }}。沿用固定诊断规则，不代替规范质量指标。
          </p>
        </details>
      </section>
      <ElDrawer
        :model-value="Boolean(drill)"
        title="概览解释与证据"
        size="min(960px, 95vw)"
        @close="drill = ''"
        destroy-on-close
        ><ScoreExplanation v-if="selectedScore" :result="selectedScore" />
        <section v-if="selectedMetric">
          <h2>{{ selectedMetric.definition.displayName }}</h2>
          <p>
            指标版本 {{ data.metrics.version?.id }} / 定义版本
            {{ selectedMetric.definition.definitionVersion }}
          </p>
          <p>{{ selectedMetric.definition.businessDescription }}</p>
          <p>
            公式 {{ selectedMetric.definition.formulaDescription }}；单位
            {{ selectedMetric.definition.unit }}；去重
            {{ selectedMetric.definition.deduplicationKey }}
          </p>
          <p>
            上游：{{
              selectedMetric.upstream.join("、") || "受代码保护的原子来源；不猜测依赖"
            }}
          </p>
          <p>
            当前值 {{ selectedMetric.value ?? "—" }}，样本
            {{ selectedMetric.sampleSize ?? "—" }}，最低样本
            {{ selectedMetric.definition.minimumSample }}
          </p>
          <p>
            已观测原始值 {{ selectedMetric.rawValue ?? "—" }}。{{
              selectedMetric.rawScope
            }}
          </p>
          <p>
            {{ selectedMetric.definition.missingPolicy }}
            {{ selectedMetric.definition.unavailableReason }}
            {{ selectedMetric.reason }}
          </p>
          <p>所属交付阶段 {{ selectedMetric.definition.milestone }}</p>
        </section>
        <section v-if="selectedAlert">
          <h2>{{ selectedAlert.title }}</h2>
          <p>{{ data.alerts.rules?.[selectedAlert.ruleKey] }}</p>
          <p>
            {{ selectedAlert.evidence }}；样本
            {{ selectedAlert.sample ?? "—" }}；规则版本
            {{ selectedAlert.definitionVersion }}
          </p>
          <p>
            项目 {{ selectedAlert.scope.projectId }}，{{
              selectedAlert.scope.env == null
                ? "项目级链路证据，未验证当前环境健康"
                : `环境 ${selectedAlert.scope.env}`
            }}；{{ selectedAlert.scope.from }} — {{ selectedAlert.scope.to }}；触发观察
            {{ selectedAlert.triggeredAt }}
          </p>
          <pre>{{ JSON.stringify(selectedAlert.detail, null, 2) }}</pre>
        </section></ElDrawer
      >
    </template>
  </div>
</template>
<style scoped>
.overview {
  display: grid;
  gap: 20px;
}
.overview-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.overview-heading h1 {
  margin: 0;
}
.panel {
  padding: 22px;
  border: 1px solid #dbe3ec;
  border-radius: 12px;
  background: white;
}
.score-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.metric-scroll {
  display: flex;
  gap: 16px;
  overflow-x: auto;
  padding: 16px 2px;
}
.metric-card {
  flex: 0 0 290px;
  padding: 16px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
}
.metric-card strong {
  font-size: 28px;
}
.trend-selection {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.trend-selection label {
  display: flex;
  gap: 5px;
}
p,
pre {
  overflow-wrap: anywhere;
}
p {
  font-size: 14px;
  color: #536477;
  line-height: 1.7;
}
button {
  padding: 8px 12px;
  border: 1px solid #a8bbcc;
  border-radius: 6px;
  background: white;
  color: #164970;
  cursor: pointer;
}
button:disabled {
  opacity: 0.6;
  cursor: wait;
}
button:focus-visible,
input:focus-visible,
summary:focus-visible,
.metric-scroll:focus-visible {
  outline: 3px solid #2563eb;
  outline-offset: 3px;
}
.notice {
  padding: 14px;
  background: #fff4ce;
  border-radius: 8px;
}
pre {
  white-space: pre-wrap;
}
summary {
  cursor: pointer;
}
@media (max-width: 900px) {
  .score-grid {
    grid-template-columns: 1fr;
  }
}
</style>
