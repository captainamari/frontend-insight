<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElDrawer } from "element-plus";
import "element-plus/es/components/drawer/style/css";
import { api, ApiError } from "../api";
import { projects } from "../projects";
import OverviewTrends from "../components/OverviewTrends.vue";
import type { BusinessResponse } from "../business-types";
import type { OverviewMetric } from "../overview-types";
const route = useRoute(),
  router = useRouter();
const data = ref<BusinessResponse | null>(null),
  loading = ref(false),
  error = ref(""),
  drill = ref(""),
  dataRequest = ref("");
let generation = 0,
  controller: AbortController | null = null;
const signature = computed(() =>
  JSON.stringify([
    route.params.projectId,
    ...[
      "env",
      "range",
      "from",
      "to",
      "moduleId",
      "businessTrends",
      "businessVersion",
      "workflowPage",
    ].map((k) => route.query[k]),
  ]),
);
const selectedMetric = computed(() =>
  data.value?.metrics.cards.find((m) => m.definition.metricKey === drill.value),
);
const observedTrends = computed(() => route.query.businessValues === "observed");
const trendMetrics = computed(() => {
  const metrics = data.value?.metrics;
  if (!metrics || !observedTrends.value) return metrics;
  return {
    ...metrics,
    trends: metrics.trends.map((b) => ({
      ...b,
      metrics: b.metrics.map((m) => ({
        ...m,
        value: m.rawValue,
        reason: m.rawValue === null ? m.reason : "OBSERVED_ONLY_NOT_FORMAL",
      })),
    })),
  };
});
function showObserved(event: Event) {
  void router.push({
    query: {
      ...route.query,
      businessValues: (event.target as HTMLInputElement).checked
        ? "observed"
        : undefined,
    },
  });
}
const penetrationLabels: Record<string, string> = {
  PENETRATION_SOURCE_MISSING: "缺少可信完整业务活动来源",
  PENETRATION_RANGE_INCOMPATIBLE: "分子范围未被90日观察窗口包含，或来源窗口不一致",
  PENETRATION_SCOPE_INCOMPATIBLE: "项目或环境范围不一致",
  PENETRATION_IDENTITY_SCOPE_INCOMPATIBLE: "身份或业务活动范围不一致",
  PENETRATION_SOURCE_INCOMPATIBLE: "来源或来源版本不一致",
  PENETRATION_COVERAGE_UNKNOWN: "覆盖未知",
  PENETRATION_COVERAGE_INSUFFICIENT: "时间覆盖不足",
  PENETRATION_SOURCE_INCONSISTENT: "来源人数不一致",
  PENETRATION_DENOMINATOR_ZERO: "分母为0，比例不可用",
  PENETRATION_ACTIVE_POPULATION_ESTIMATE: "可用的活跃用户近似（estimated）",
};
const labels: Record<string, string> = {
  no_modules: "所选范围无功能模块配置",
  no_active_module: "所选范围没有启用的模块版本",
  missing_active: "尚无激活的运营指标版本",
  missing_bindings: "当前版本未配置业务分析展示指标",
  configured: "当前版本已配置",
  no_data: "所选范围无事实",
  partial: "部分数据：身份、业务活动及环境完整性尚未验证",
};
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
  for (const k of ["env", "range", "from", "to", "moduleId", "workflowPage"])
    if (typeof route.query[k] === "string") params.set(k, String(route.query[k]));
  if (typeof route.query.businessTrends === "string")
    params.set("metrics", route.query.businessTrends);
  if (typeof route.query.businessVersion === "string")
    params.set("versionId", route.query.businessVersion);
  try {
    const r = await api.request<BusinessResponse>(
      `/api/projects/${encodeURIComponent(String(route.params.projectId))}/business?${params}`,
      { signal: controller.signal },
    );
    if (id !== generation || key !== signature.value) return;
    if (data.value?.identity !== r.identity) drill.value = "";
    data.value = r;
    dataRequest.value = key;
    if (!route.query.moduleId && r.moduleId) {
      await router.replace({ query: { ...route.query, moduleId: r.moduleId } });
      return;
    }
  } catch (e) {
    if (id !== generation) return;
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      data.value = null;
      drill.value = "";
      projects.reset();
      if (e.status === 403)
        void router.replace({
          name: "project-access-error",
          params: route.params,
          query: { kind: "forbidden", retry: route.fullPath },
        });
    }
    error.value =
      e instanceof ApiError
        ? `${e.code} · 请求 ID ${e.requestId ?? "—"}`
        : "读取失败，请重试";
  } finally {
    if (id === generation) loading.value = false;
  }
}
function moduleChange(event: Event) {
  void router.push({
    query: {
      ...route.query,
      moduleId: (event.target as HTMLSelectElement).value,
      workflowVersion: undefined,
      workflowPage: undefined,
    },
  });
}
function trend(m: OverviewMetric, checked: boolean) {
  const keys = data.value?.metrics.selected ?? [];
  void router.push({
    query: {
      ...route.query,
      businessTrends: (checked
        ? [...keys, m.definition.metricKey]
        : keys.filter((k) => k !== m.definition.metricKey)
      ).join(","),
    },
  });
}
function limit(m: OverviewMetric) {
  return (
    !data.value?.metrics.selected.includes(m.definition.metricKey) &&
    ((data.value?.metrics.selected.length ?? 0) >= 16 ||
      (data.value?.metrics.cards.filter(
        (c) =>
          data.value?.metrics.selected.includes(c.definition.metricKey) &&
          c.definition.unit === m.definition.unit,
      ).length ?? 0) >= 4)
  );
}
function configure(metric?: string) {
  void router.push({
    name: "project-metrics",
    params: route.params,
    query: {
      ...route.query,
      tab: "operational-metrics",
      metricVersion: data.value?.metrics.version?.id,
      metricKey: metric,
      analysisReturn: route.fullPath,
    },
  });
}
function scroll(event: KeyboardEvent) {
  if (
    event.target !== event.currentTarget ||
    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  )
    return;
  event.preventDefault();
  const e = event.currentTarget as HTMLElement;
  if (event.key === "Home") e.scrollTo({ left: 0 });
  else if (event.key === "End") e.scrollTo({ left: e.scrollWidth });
  else e.scrollBy({ left: event.key === "ArrowRight" ? 320 : -320 });
}
function followActive() {
  void router.replace({
    query: { ...route.query, businessVersion: undefined, businessTrends: undefined },
  });
}
const selectedWorkflow = computed(() =>
  data.value?.workflowAnalysis?.definitions.find(
    (w) => w.versionId === route.query.workflowVersion,
  ),
);
function showWorkflow(versionId?: string) {
  void router.push({ query: { ...route.query, workflowVersion: versionId } });
}
function workflowPage(page: number) {
  void router.push({
    query: { ...route.query, workflowPage: String(page), workflowVersion: undefined },
  });
}
function workflowDefinition() {
  if (!selectedWorkflow.value) return;
  void router.push({
    name: "project-metrics",
    params: route.params,
    query: {
      ...route.query,
      tab: "objects",
      object: "workflows",
      workflowId: selectedWorkflow.value.id,
      workflowDefinitionVersion: selectedWorkflow.value.versionId,
      analysisReturn: route.fullPath,
    },
  });
}
watch(signature, () => void load(), { immediate: true });
onMounted(() => window.addEventListener("focus", load));
onBeforeUnmount(() => {
  generation++;
  controller?.abort();
  window.removeEventListener("focus", load);
});
</script>
<template>
  <div class="business-analysis">
    <header>
      <div>
        <h1>业务分析</h1>
        <p>功能模块指标、页面构成与事实解释</p>
      </div>
      <button :disabled="loading" @click="load">
        {{ loading ? "正在刷新…" : "刷新业务分析" }}
      </button>
    </header>
    <p v-if="loading && !data" role="status">正在加载业务分析…</p>
    <p v-if="error" role="alert">
      业务分析读取失败：{{ error }} <button @click="load">重试</button
      ><button
        v-if="error.includes('BUSINESS_ACTIVE_VERSION_CHANGED')"
        @click="followActive"
      >
        读取当前激活版本
      </button>
    </p>
    <p v-if="data && (loading || error)" role="status">
      stale：暂保留上次数据，不代表最新版本。数据身份 {{ data.identity }}
    </p>
    <template v-if="data">
      <section class="panel">
        <label
          >功能模块
          <select
            aria-label="功能模块"
            :value="data.moduleId ?? ''"
            @change="moduleChange"
          >
            <option v-if="!data.modules.length" value="">无模块</option>
            <option v-for="m in data.modules" :key="m.id" :value="m.id">
              {{ m.name }} · {{ m.moduleKey }} ·
              {{ m.status === "active" ? "启用" : "停用"
              }}{{ m.archived ? "（已归档）" : "" }}
            </option>
          </select></label
        >
        <p>
          {{ data.project.name }} · {{ data.query.env }} · {{ data.query.timezone }} ·
          {{ data.query.from }} — {{ data.query.to }}
        </p>
        <p>
          {{ labels[data.metrics.status] ?? data.metrics.status }} ·
          {{ labels[data.data.state] ?? data.data.state }}
        </p>
        <p>
          运营版本 {{ data.metrics.version?.version ?? "—" }} /
          {{ data.metrics.version?.id ?? "—" }} · 所选项目窗口观察起点
          {{ data.availableFrom ?? "未知" }} · 最近数据 {{ data.lastDataAt ?? "—" }}
        </p>
        <button @click="configure()">查看指标配置与版本</button>
      </section>
      <section class="panel">
        <h2>模块指标</h2>
        <p>
          正式值遵守定义与完整性要求。下列观察值仅为已识别、有效归属的页面访问；不代表完整业务活动。
        </p>
        <div
          class="cards"
          role="region"
          aria-label="模块指标卡片"
          tabindex="0"
          @keydown="scroll"
        >
          <article v-for="m in data.metrics.cards" :key="m.definition.metricKey">
            <h3>{{ m.definition.displayName }}</h3>
            <strong>{{ m.value ?? "—" }} {{ m.definition.unit }}</strong>
            <p>{{ m.definition.metricKey }} · {{ m.status }}</p>
            <p>{{ m.reason ?? "可用" }} · 样本 {{ m.sampleSize ?? "未知" }}</p>
            <p>观察值 {{ m.rawValue ?? "—" }}</p>
            <button @click="drill = m.definition.metricKey">
              解释 {{ m.definition.displayName }}</button
            ><label
              ><input
                type="checkbox"
                :checked="data.metrics.selected.includes(m.definition.metricKey)"
                :disabled="limit(m)"
                @change="trend(m, ($event.target as HTMLInputElement).checked)"
              />显示趋势</label
            >
          </article>
        </div>
        <p v-if="!data.metrics.cards.length">
          {{
            labels[data.metrics.status] ?? "尚无可展示指标"
          }}。可在当前运营版本的业务分析展示绑定中配置。
        </p>
      </section>
      <section class="panel">
        <h2>指标变化趋势</h2>
        <p>
          同版本与页面配置快照；日/周/月逐桶使用同一公式，缺口不补零，版本切换处不连线。
        </p>
        <label
          ><input
            type="checkbox"
            :checked="observedTrends"
            @change="showObserved"
          />显示观察值趋势（非正式指标）</label
        >
        <p v-if="observedTrends">
          当前绘制卡片中的观察值：仅已识别页面访问及其同源公式结果，不代表完整业务活动或可信正式指标。
        </p>
        <OverviewTrends v-if="trendMetrics" :metrics="trendMetrics" />
      </section>
      <section class="panel">
        <h2>页面构成与观察证据</h2>
        <p>
          模块去重用户数不能相加页面 UV。以下按事件时间关联
          revision，名称与状态来自对应历史配置。
        </p>
        <p v-if="data.observation">
          模块页面访问观察 PV {{ data.observation.pv ?? "—" }} / UV
          {{ data.observation.uv ?? "—" }}；项目窗口未识别
          {{ data.observation.unidentified }}、未归类
          {{ data.observation.unclassified }}、不属于该模块有效范围
          {{ data.observation.excluded }}。排除原因可重叠，不相加。
        </p>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>页面</th>
                <th>状态与范围</th>
                <th>配置 revision</th>
                <th>PV / UV 观察</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in data.pages" :key="p.pageRevisionId + p.moduleRevisionId">
                <td>
                  {{ p.name }}<small>{{ p.pageRoute }}</small>
                </td>
                <td>
                  {{ p.reason }}<small>{{ p.from }} — {{ p.to }}</small>
                </td>
                <td>
                  {{ p.pageRevisionId }}<small>{{ p.moduleRevisionId }}</small>
                </td>
                <td>{{ p.observation?.pv ?? "—" }} / {{ p.observation?.uv ?? "—" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!data.pages.length">该模块在所选时间内没有页面归属记录。</p>
      </section>
      <section class="panel">
        <h2>模块渗透率的来源</h2>
        <p>{{ data.penetration.explanation }}</p>
        <p>
          运行状态：{{
            penetrationLabels[data.penetration.reason] ?? data.penetration.reason
          }}
        </p>
        <p>
          分母观察窗口（半开区间、项目时区）：{{
            data.penetration.observationWindow?.from
          }}
          至 {{ data.penetration.observationWindow?.to }}
        </p>
        <details>
          <summary>各趋势桶的独立分母窗口与状态</summary>
          <ul>
            <li v-for="bucket in data.metrics.trends" :key="bucket.from + bucket.to">
              {{ bucket.from }} 至 {{ bucket.to }}： 分母窗口
              {{ bucket.penetration?.observationWindow.from }} 至
              {{ bucket.penetration?.observationWindow.to }}；
              {{ penetrationLabels[bucket.penetration?.reason ?? ""] ?? "覆盖未知" }}
            </li>
          </ul>
        </details>
        <p>
          分子页面访问去重观察 {{ data.penetration.numerator ?? "未知" }}；分母
          {{ data.penetration.denominator ?? "未知" }}；比例
          {{ data.penetration.value ?? "—" }}。
        </p>
        <details>
          <summary>分母来源、窗口及覆盖</summary>
          <pre>{{ JSON.stringify(data.penetration, null, 2) }}</pre>
        </details>
      </section>
      <section v-if="data.workflowAnalysis" class="panel" aria-label="工作流追踪">
        <h2>工作流追踪</h2>
        <p>
          按开始时间归属所选窗口；终态观察截至
          {{
            data.workflowAnalysis.context.asOf
          }}。迟到事实可能更新结果，覆盖尚未证明完整。
        </p>
        <p v-if="!data.workflowAnalysis.definitions.length">
          没有已激活过的工作流定义。
        </p>
        <div class="scroll">
          <table v-if="data.workflowAnalysis.definitions.length">
            <thead>
              <tr>
                <th>工作流 / 定义版本</th>
                <th>开始 / 进行中</th>
                <th>成功 / 失败 / 取消 / 近似超时</th>
                <th>成功率</th>
                <th>总耗时 P50 / P90（ms）</th>
                <th>样本 / 未解析</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in data.workflowAnalysis.definitions" :key="w.versionId">
                <td>{{ w.name }} · v{{ w.version }}</td>
                <td>{{ w.started }} / {{ w.inProgress }}</td>
                <td>
                  {{ w.completed }} / {{ w.failed }} / {{ w.canceled }} /
                  {{ w.approximate_abandoned }}
                </td>
                <td>
                  {{
                    w.successRate === null
                      ? "—"
                      : (w.successRate * 100).toFixed(1) + "%"
                  }}
                </td>
                <td>
                  {{ w.task_duration.p50 ?? "—" }} / {{ w.task_duration.p90 ?? "—" }}
                </td>
                <td>{{ w.task_duration.sample }} / {{ w.unresolved }}</td>
                <td>
                  <button @click="showWorkflow(w.versionId)">
                    查看 {{ w.name }} v{{ w.version }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="data.workflowAnalysis.status === 'no_facts'">
          所选开始窗口无工作流事实；不能据此判断已安装兼容SDK或成功率为0。
        </p>
        <button
          :disabled="data.workflowAnalysis.page <= 1"
          @click="workflowPage(data.workflowAnalysis.page - 1)"
        >
          上一页工作流
        </button>
        <button
          :disabled="
            data.workflowAnalysis.page * data.workflowAnalysis.pageSize >=
            data.workflowAnalysis.totalDefinitions
          "
          @click="workflowPage(data.workflowAnalysis.page + 1)"
        >
          下一页工作流
        </button>
      </section>
      <ElDrawer
        :model-value="Boolean(selectedWorkflow)"
        title="工作流详情"
        size="min(900px, 95vw)"
        @update:model-value="
          (value) => {
            if (!value) showWorkflow();
          }
        "
      >
        <template v-if="selectedWorkflow && data.workflowAnalysis">
          <h2>{{ selectedWorkflow.name }} · v{{ selectedWorkflow.version }}</h2>
          <p>
            定义版本 {{ selectedWorkflow.versionId }}；观察截至
            {{ data.workflowAnalysis.context.asOf }}。可用起点
            {{ data.workflowAnalysis.availableFrom ?? "未知" }}
            仅是观察事件起点，不能证明持续覆盖。
          </p>
          <p>
            总耗时 P50 / P90 / P75 / P99（ms）：{{
              selectedWorkflow.task_duration.p50 ?? "—"
            }}
            / {{ selectedWorkflow.task_duration.p90 ?? "—" }} /
            {{ selectedWorkflow.task_duration.p75 ?? "—" }} /
            {{ selectedWorkflow.task_duration.p99 ?? "—" }}。有效成功样本
            {{
              selectedWorkflow.task_duration.sample
            }}；普通分位数为线性插值，与评分池化加权nearest-rank不同。
          </p>
          <h3>阶段漏斗与相邻阶段耗时</h3>
          <table>
            <thead>
              <tr>
                <th>步骤</th>
                <th>到达</th>
                <th>到达率</th>
                <th>相邻流失率</th>
                <th>相邻耗时P50 / P90</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in selectedWorkflow.stages" :key="s.stepKey">
                <td>{{ s.stepOrder }} · {{ s.name }}</td>
                <td>{{ s.reached }}</td>
                <td>{{ s.rate ?? "—" }}</td>
                <td>{{ s.adjacentDropoff ?? "—" }}</td>
                <td>
                  {{ s.adjacentDuration.p50 ?? "—" }} /
                  {{ s.adjacentDuration.p90 ?? "—" }}
                </td>
              </tr>
            </tbody>
          </table>
          <h3>开始cohort趋势（文本等价）</h3>
          <table>
            <thead>
              <tr>
                <th>窗口</th>
                <th>开始</th>
                <th>成功</th>
                <th>成功率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in selectedWorkflow.trends" :key="b.from">
                <td>{{ b.from }} — {{ b.to }}</td>
                <td>{{ b.started }}</td>
                <td>{{ b.completed }}</td>
                <td>{{ b.successRate ?? "—" }}</td>
              </tr>
            </tbody>
          </table>
          <h3>安全实例证据</h3>
          <p>
            实例计数包含未识别身份；未识别
            {{ selectedWorkflow.unidentified }}
            个，不能作为规范用户或评分样本。证据最多{{
              data.workflowAnalysis.evidenceLimit
            }}条{{ data.workflowAnalysis.evidenceTruncated ? "，当前已截断" : "" }}。
          </p>
          <article
            v-for="e in data.workflowAnalysis.evidence.filter(
              (e) => e.versionId === selectedWorkflow?.versionId,
            )"
            :key="e.workflowInstanceId"
          >
            <p>
              {{ e.workflowInstanceId }} · {{ e.state }} · {{ e.startedAt }} →
              {{ e.terminalAt ?? "进行中" }}
            </p>
            <p>{{ e.reasons.join(" / ") }}</p>
            <pre v-if="e.path_steps">{{ JSON.stringify(e.path_steps, null, 2) }}</pre>
          </article>
          <button @click="workflowDefinition">查看工作流定义与版本</button>
        </template>
      </ElDrawer>
      <section class="panel">
        <h2>当前工作流定义</h2>
        <p>{{ data.workflowFacts.reason }}</p>
        <p>以下为当前激活定义，不是所查历史窗口的实例、漏斗或耗时事实。</p>
        <table>
          <thead>
            <tr>
              <th>工作流与版本</th>
              <th>步骤</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in data.workflows" :key="w.versionId + String(w.stepOrder)">
              <td>{{ w.name }} · {{ w.workflowKey }} · v{{ w.version }}</td>
              <td>{{ w.stepOrder }}. {{ w.stepName }} / {{ w.stepKey }}</td>
              <td>{{ w.status }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!data.workflows.length">当前模块没有激活的工作流定义。</p>
      </section>
      <ElDrawer
        :model-value="Boolean(selectedMetric)"
        title="模块指标解释"
        size="min(720px,95vw)"
        @update:model-value="
          (v) => {
            if (!v) drill = '';
          }
        "
        ><template v-if="selectedMetric"
          ><h3>
            {{ selectedMetric.definition.displayName }} ·
            {{ selectedMetric.definition.metricKey }}
          </h3>
          <p>{{ selectedMetric.definition.businessDescription }}</p>
          <p>{{ selectedMetric.definition.formulaDescription }}</p>
          <p>{{ selectedMetric.rawScope }}</p>
          <p>
            定义 {{ selectedMetric.definition.definitionVersion }} · 样本
            {{ selectedMetric.sampleSize ?? "未知" }} · {{ selectedMetric.reason }}
          </p>
          <p>{{ data.identityPolicy.rule }} / {{ data.identityPolicy.version }}</p>
          <p>{{ data.query.env }} / {{ data.query.from }} — {{ data.query.to }}</p>
          <button @click="configure(selectedMetric.definition.metricKey)">
            进入对应指标定义与版本
          </button></template
        ></ElDrawer
      >
    </template>
  </div>
</template>
<style scoped>
.business-analysis {
  min-width: 0;
  max-width: 100%;
  color: #172b4d;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.panel {
  background: white;
  border: 1px solid #dbe3ec;
  border-radius: 12px;
  padding: 20px;
  margin: 20px 0;
  min-width: 0;
}
p {
  color: #536477;
  line-height: 1.65;
}
button,
select {
  padding: 8px 12px;
}
button {
  cursor: pointer;
}
.cards {
  display: flex;
  gap: 16px;
  overflow: auto;
  max-width: 100%;
  padding: 8px;
}
.cards article {
  flex: 0 0 280px;
  border: 1px solid #dbe3ec;
  border-radius: 10px;
  padding: 16px;
}
.cards label {
  display: block;
  margin-top: 12px;
}
.scroll {
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
td,
th {
  padding: 10px;
  text-align: left;
  border-bottom: 1px solid #dbe3ec;
  overflow-wrap: anywhere;
}
small {
  display: block;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
strong {
  font-size: 24px;
}
:focus-visible {
  outline: 3px solid #2563eb;
  outline-offset: 2px;
}
</style>
