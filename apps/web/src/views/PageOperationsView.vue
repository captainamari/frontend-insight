<script setup lang="ts">
import { ref, watch, onBeforeUnmount, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api";
import TrendChart from "../components/TrendChart.vue";
interface Card {
  key: string;
  name: string;
  unit: string;
  value: number | null;
  reason: string | null;
  definitionVersion: string | null;
}
interface Response {
  timezone: string;
  canConfigure: boolean;
  routes: string[];
  availableFrom: string | null;
  dataState: string;
  observationNotice: string;
  version: { id: string; version: number; status: string } | null;
  cards: Card[];
  identity: { identified: number; anonymous: number; missing: number };
  diagnostics: {
    totalPageViews: number;
    validDurationSamples: number;
    missingPageLeave: number;
    coverage: number | null;
    visibleDuration: Record<string, number | null>;
    pageDepthP50: number | null;
    moduleBreadthP50: number | null;
    moduleSamples: number;
    excludedUnclassifiedSessions: number;
  };
  hourly: { hour: number; pv: number | null; uv: number | null }[];
  calendar: Record<string, { period: string; value: number; partial: boolean }[]>;
  trend: { localStart: string; from: string; cards: Card[] }[];
  pages: {
    id: string;
    pageRoute: string;
    revisionId: string;
    name: string;
    module: string | null;
    template: string;
    isCore: boolean;
    status: string;
    expectedFrequency: string;
    criticalityWeight: number;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
  workflows: {
    versionId: string;
    name: string;
    version: number;
    sampleState: string;
    [key: string]: unknown;
  }[];
}
const route = useRoute(),
  router = useRouter(),
  data = ref<Response | null>(null),
  loading = ref(false),
  error = ref("");
let generation = 0,
  controller: AbortController | null = null,
  navigation = Promise.resolve();
const signature = computed(() =>
  JSON.stringify([
    route.params.projectId,
    ...["env", "range", "from", "to", "pageRoute", "versionId"].map(
      (k) => route.query[k],
    ),
  ]),
);
async function load() {
  const id = ++generation;
  controller?.abort();
  controller = new AbortController();
  data.value = null;
  loading.value = true;
  error.value = "";
  const q = new URLSearchParams();
  for (const k of ["env", "range", "from", "to", "pageRoute", "versionId"])
    if (typeof route.query[k] === "string") q.set(k, String(route.query[k]));
  try {
    const r = await api.request<Response>(
      `/api/projects/${encodeURIComponent(String(route.params.projectId))}/page-operations?${q}`,
      { signal: controller.signal },
    );
    if (id === generation) data.value = r;
  } catch (e) {
    if (id === generation)
      error.value =
        e instanceof ApiError
          ? e.status === 403
            ? "无权访问此项目"
            : e.code.includes("BUDGET")
              ? "超出查询预算，请缩短时间范围"
              : e.code
          : "读取失败，请重试";
  } finally {
    if (id === generation) loading.value = false;
  }
}
function select(value: string) {
  navigation = navigation.then(async () => {
    await router.push({
      query: { ...route.query, pageRoute: value || undefined, cursor: undefined },
    });
  });
}
const paths = computed(() =>
  [
    ...new Set([
      ...(data.value?.routes ?? []),
      ...(data.value?.pages.map((p) => p.pageRoute) ?? []),
      ...(typeof route.query.pageRoute === "string" ? [route.query.pageRoute] : []),
    ]),
  ].sort(),
);
const points = computed(
  () =>
    data.value?.trend.map((t) => ({
      bucket: t.localStart,
      primary: t.cards.find((c) => c.key === "pv")?.value ?? null,
      secondary: t.cards.find((c) => c.key === "uv")?.value ?? null,
    })) ?? [],
);
const display = (v: number | null) =>
  v === null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(3);
watch(signature, load, { immediate: true });
onBeforeUnmount(() => {
  generation++;
  controller?.abort();
});
</script>
<template>
  <section class="panel page-operations" aria-labelledby="operations-title">
    <h1 id="operations-title">页面运营分析</h1>
    <label
      >页面路径<select
        aria-label="页面路径"
        :value="route.query.pageRoute ?? ''"
        @change="select(($event.target as HTMLSelectElement).value)"
      >
        <option value="">全部页面</option>
        <option v-for="path in paths" :key="path">{{ path }}</option>
      </select></label
    >
    <button type="button" :disabled="loading" @click="load">刷新</button>
    <p v-if="loading" role="status">正在读取页面运营…</p>
    <p v-if="error" role="alert">{{ error }} <button @click="load">重试</button></p>
    <template v-if="data">
      <p role="status">
        {{ data.dataState === "no_data" ? "所选范围无页面事实" : "已观测页面事实" }} ·
        {{ data.timezone }} ·
        {{
          data.version
            ? `指标版本 v${data.version.version} (${data.version.status})`
            : "尚未激活指标版本"
        }}
      </p>
      <p>
        {{ data.observationNotice }} 当前窗口最早事实：{{
          data.availableFrom ?? "暂无"
        }}
      </p>
      <p>
        UV 构成：已识别 {{ data.identity.identified }} · 匿名设备
        {{ data.identity.anonymous }} · 缺失身份
        {{ data.identity.missing }}。登录前后不推断为同一人。
      </p>
      <div class="usage-cards">
        <article
          v-for="card in data.cards"
          :key="card.key"
          class="panel"
          :data-testid="`usage-${card.key}`"
        >
          <h2>{{ card.name }}</h2>
          <strong>{{ display(card.value) }}</strong> {{ card.unit }}
          <p>{{ card.key }} · {{ card.definitionVersion }}</p>
          <small v-if="card.reason">{{ card.reason }}</small>
        </article>
      </div>
      <p>
        跳出率（单页会话率）只用于诊断，不默认告警。空白值表示无数据或口径不可用，非真实零值。
      </p>
      <h2>同源趋势</h2>
      <TrendChart :points="points" primary-label="PV" secondary-label="UV" />
      <details>
        <summary>全部绑定指标趋势及缺失原因</summary>
        <table>
          <thead>
            <tr>
              <th>周期</th>
              <th v-for="c in data.cards" :key="c.key">{{ c.name }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in data.trend" :key="t.from">
              <td>{{ t.localStart }}</td>
              <td v-for="c in t.cards" :key="c.key">
                {{ display(c.value) }} {{ c.reason }}
              </td>
            </tr>
          </tbody>
        </table>
      </details>
      <h2>自然周期活跃用户</h2>
      <p>
        按筛选窗口与项目自然日、周一开始的周、月相交统计；部分周期不外推，跨周期不相加。
      </p>
      <div v-for="(rows, key) in data.calendar" :key="key">
        <h3>{{ key }}</h3>
        <p v-if="!rows.length">无数据</p>
        <span v-for="r in rows" :key="r.period">{{ r.period }}：{{ r.value }} · </span>
      </div>
      <h2>本地小时分布</h2>
      <p>DST 重复小时合并去重；未观测小时保留空白。</p>
      <table aria-label="时段分布">
        <thead>
          <tr>
            <th>小时</th>
            <th>PV</th>
            <th>UV</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in data.hourly" :key="h.hour">
            <td>{{ h.hour }}</td>
            <td>{{ display(h.pv) }}</td>
            <td>{{ display(h.uv) }}</td>
          </tr>
        </tbody>
      </table>
      <h2>扩展诊断</h2>
      <p>
        时长有效样本 {{ data.diagnostics.validDurationSamples }} /
        {{ data.diagnostics.totalPageViews }}；缺失 page_leave
        {{ data.diagnostics.missingPageLeave }}；coverage
        {{ display(data.diagnostics.coverage) }}
      </p>
      <p>
        页面可见时长（毫秒）：<span
          v-for="(v, k) in data.diagnostics.visibleDuration"
          :key="k"
          >{{ k }} {{ display(v) }} ·
        </span>
      </p>
      <p>
        会话页面深度 P50 {{ display(data.diagnostics.pageDepthP50) }}；模块广度 P50
        {{ display(data.diagnostics.moduleBreadthP50) }}；有效模块样本
        {{ data.diagnostics.moduleSamples }}；纯未归类排除
        {{ data.diagnostics.excludedUnclassifiedSessions }}
      </p>
      <h2>页面配置及目标</h2>
      <p v-if="!data.pages.length">
        此窗口尚无页面配置。未归类 route 可由管理员在指标管理中配置。
      </p>
      <article v-for="p in data.pages" :key="p.revisionId">
        <h3>{{ p.name }} · {{ p.pageRoute }}</h3>
        <p>
          模板 {{ p.template }} · 模块 {{ p.module ?? "未归类" }} ·
          {{ p.isCore ? "核心页面" : "非核心页面" }} · {{ p.status }}
        </p>
        <p>
          使用目标频率 {{ p.expectedFrequency }} · 重要性权重
          {{ p.criticalityWeight }} · 生效 {{ p.effectiveFrom }} —
          {{ p.effectiveTo ?? "当前" }}
        </p>
      </article>
      <RouterLink
        v-if="data.canConfigure"
        :to="{
          name: 'project-metrics',
          params: route.params,
          query: { ...route.query, pageRoute: route.query.pageRoute },
        }"
        >配置页面、目标与展示绑定</RouterLink
      >
      <p v-else>viewer 只读；页面与绑定配置由管理员维护。</p>
      <h2>页面工作流 / 任务</h2>
      <p v-if="!data.workflows.length">没有关联当前页面的工作流定义或任务事实。</p>
      <article v-for="w in data.workflows" :key="w.versionId">
        <h3>{{ w.name }} v{{ w.version }}</h3>
        <p>{{ w.sampleState }}</p>
        <pre>{{ JSON.stringify(w, null, 2) }}</pre>
      </article>
    </template>
  </section>
</template>
<style scoped>
.usage-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
}
.usage-cards strong {
  font-size: 1.6rem;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  padding: 6px;
  text-align: left;
  border-bottom: 1px solid #ddd;
}
select,
button {
  margin: 8px;
  padding: 6px;
}
small {
  overflow-wrap: anywhere;
}
pre {
  white-space: pre-wrap;
}
</style>
