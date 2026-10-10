<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted } from "vue";
import {
  useRoute,
  useRouter,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
} from "vue-router";
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
  dataScope = ref("");
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
      "workflowVersion",
      "workflowEvidencePage",
    ].map((k) => route.query[k]),
  ]),
);
const scopeSignature = computed(() =>
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
    ].map((key) => route.query[key]),
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
  if (dataScope.value !== scopeSignature.value) {
    data.value = null;
    drill.value = "";
  }
  const params = new URLSearchParams();
  for (const k of [
    "env",
    "range",
    "from",
    "to",
    "moduleId",
    "workflowPage",
    "workflowVersion",
    "workflowEvidencePage",
  ])
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
    dataScope.value = scopeSignature.value;
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
const workflowDialog = ref<HTMLDialogElement | null>(null);
let workflowReturnFocus: HTMLElement | null = null;
watch(
  selectedWorkflow,
  (selected) => {
    const dialog = workflowDialog.value;
    if (selected && dialog && !dialog.open) {
      workflowReturnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!selected && dialog?.open) {
      dialog.close();
      if (workflowReturnFocus?.isConnected) workflowReturnFocus.focus();
      workflowReturnFocus = null;
    }
  },
  { flush: "post" },
);
function showWorkflow(versionId?: string) {
  void router.push({
    query: {
      ...route.query,
      workflowVersion: versionId,
      workflowEvidencePage: undefined,
    },
  });
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
// Invalidate reads before the async access guard, not only after unmount.
// A late default-selection/403 response must never supersede user navigation.
function cancelLoad() {
  generation++;
  controller?.abort();
  loading.value = false;
}
onBeforeRouteLeave(cancelLoad);
onBeforeRouteUpdate(cancelLoad);
watch(signature, () => void load(), { immediate: true });
onMounted(() => window.addEventListener("focus", load));
onBeforeUnmount(() => {
  cancelLoad();
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
          正式值遵守定义与完整性要求。页面访问与工作流观察分别按其事实范围解释；观察值不代表完整业务活动。
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
            <template v-if="m.workflowBreakdown?.length">
              <p>按任务类型与定义版本查看（同工作流列表页；覆盖未知）</p>
              <ul>
                <li v-for="w in m.workflowBreakdown" :key="w.versionId">
                  <button @click="showWorkflow(w.versionId)">
                    {{ w.workflowKey }} v{{ w.version }}
                  </button>
                  P50/P90：{{ w.p50 ?? "—" }} / {{ w.p90 ?? "—" }} ms；样本
                  {{ w.sample }}
                </li>
              </ul>
            </template>
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
            (data.penetration.denominatorWindow ?? data.penetration.observationWindow)
              ?.from
          }}
          至
          {{
            (data.penetration.denominatorWindow ?? data.penetration.observationWindow)
              ?.to
          }}
        </p>
        <details>
          <summary>各趋势桶的独立分母窗口与状态</summary>
          <ul>
            <li v-for="bucket in data.metrics.trends" :key="bucket.from + bucket.to">
              {{ bucket.from }} 至 {{ bucket.to }}： 分母窗口
              {{
                (
                  bucket.penetration?.denominatorWindow ??
                  bucket.penetration?.observationWindow
                )?.from
              }}
              至
              {{
                (
                  bucket.penetration?.denominatorWindow ??
                  bucket.penetration?.observationWindow
                )?.to
              }}；
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
      <section class="panel" aria-label="操作效率">
        <h2>操作效率</h2>
        <p>
          表单与业务适配器独立
          opt-in。按已批准的结算与未知结果规则计算观察比率；按受控来源披露覆盖，不生成效率分。
        </p>
        <template v-if="data.efficiency">
          <p>
            asOf：{{ data.efficiency.asOf }} · {{ data.efficiency.definitionVersion }} ·
            覆盖：{{ data.efficiency.coverage }}
          </p>
          <p>
            本范围SDK声明（不是覆盖证明）：表单
            {{ data.efficiency.collectorStates?.forms }} · 业务适配器
            {{ data.efficiency.collectorStates?.business_results }} · 重复操作
            {{ data.efficiency.collectorStates?.repeated_operations }}
          </p>
          <h3>重复操作相关会话占比</h3>
          <p>
            同一治理用户、受控操作、对象类型和对象在滚动24小时内至少3次操作；命中窗口涉及的会话去重计数，分母是本范围有纳入操作的会话。
          </p>
          <p>
            正式值：{{ data.efficiency.repeated_operation_rate.value ?? "—" }} ·
            观察值：{{ data.efficiency.repeated_operation_rate.observedValue ?? "—" }} ·
            {{ data.efficiency.repeated_operation_rate.numerator }} /
            {{ data.efficiency.repeated_operation_rate.denominator }} 相关会话
          </p>
          <p>
            {{ data.efficiency.repeated_operation_rate.reason ?? "已闭合且样本满足" }}
          </p>
          <h3>表单效率</h3>
          <p>
            {{ data.efficiency.form_efficiency.reason ?? "受控未采样表单结果可用" }}
          </p>
          <details>
            <summary>表单公式、来源与缺失原因</summary>
            <p>
              修改次数/提交 = 修改计数 ÷ 提交尝试；重置率 = 重置计数 ÷
              提交尝试；校验报错率 = 校验失败计数 ÷
              提交尝试。三项分别输出，不合成效率分。重置率可能超过100%。
            </p>
            <p>
              来源为显式启用的受控表单适配器，按生命周期结算时间归桶。至少5次提交才计算比率；未采样且计数完整时正式结果可用。未提交生命周期的修改、重置不参与比率。无观察不能区分未安装、关闭采集或尚无操作。
            </p>
            <p>
              未知身份与不匹配页面版本排除；重复投递不重复计数。没有提交和计数超限分别披露，不按正常0值解释。
            </p>
          </details>
          <table>
            <caption>
              已结算生命周期计数（不是完整窗口效率指标）
            </caption>
            <thead>
              <tr>
                <th>formId</th>
                <th>修改</th>
                <th>重置</th>
                <th>提交尝试</th>
                <th>校验失败</th>
                <th>无提交生命周期</th>
                <th>计数超限</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="f in data.efficiency.form_efficiency.observations"
                :key="f.formId"
              >
                <td>{{ f.formId }}</td>
                <td>{{ f.changes }}</td>
                <td>{{ f.resets }}</td>
                <td>{{ f.submits }}</td>
                <td>{{ f.validationFailures }}</td>
                <td>{{ f.noSubmit }}</td>
                <td>{{ f.overflow }}</td>
              </tr>
            </tbody>
          </table>
          <table v-if="data.efficiency.form_efficiency.results.length">
            <caption>
              表单三子指标（仅登记的受控来源）
            </caption>
            <thead>
              <tr>
                <th>formId</th>
                <th>修改/提交</th>
                <th>重置/提交</th>
                <th>校验失败/提交</th>
                <th>缺失原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in data.efficiency.form_efficiency.results" :key="f.formId">
                <td>{{ f.formId }}</td>
                <td>{{ f.changesPerSubmit ?? "—" }}</td>
                <td>{{ f.resetRate ?? "—" }}</td>
                <td>{{ f.validationErrorRate ?? "—" }}</td>
                <td>
                  {{
                    f.reason ??
                    (data.efficiency.form_efficiency.value ? "可用" : "来源覆盖未验证")
                  }}
                </td>
              </tr>
            </tbody>
          </table>
          <h3>业务操作结果</h3>
          <p>
            正式业务失败率：{{ data.efficiency.operation_fail_rate.value ?? "—" }} ·
            观察比率：{{ data.efficiency.operation_fail_rate.observedValue ?? "—" }}
          </p>
          <p>
            {{ data.efficiency.operation_fail_rate.reason ?? "受控未采样业务结果可用" }}
          </p>
          <details>
            <summary>业务失败率公式、来源与缺失原因</summary>
            <p>
              公式为确认业务拒绝数 ÷
              同一显式适配器的全部兼容操作数，正式定义要求至少5个操作。HTTP状态和网络异常不能直接判定业务拒绝。
            </p>
            <p>
              来源是同一随机操作实例的开始及受控业务终态；按开始时间选择范围，终态与接收时间截至上述asOf。存在未知结果时比率不可用；技术失败、取消仍保留在全部操作分母中。缺失、冲突和未知均不当作成功。
            </p>
          </details>
          <dl>
            <dt>全部受控开始</dt>
            <dd>{{ data.efficiency.operation_fail_rate.observations.started }}</dd>
            <dt>业务成功 / 拒绝</dt>
            <dd>
              {{ data.efficiency.operation_fail_rate.observations.success }} /
              {{ data.efficiency.operation_fail_rate.observations.rejected }}
            </dd>
            <dt>技术失败 / 取消 / 未知 / 冲突</dt>
            <dd>
              {{ data.efficiency.operation_fail_rate.observations.technical_failure }} /
              {{ data.efficiency.operation_fail_rate.observations.canceled }} /
              {{ data.efficiency.operation_fail_rate.observations.unknown }} /
              {{ data.efficiency.operation_fail_rate.observations.unresolved }}
            </dd>
          </dl>
          <details>
            <summary>操作效率趋势（同一 asOf 与定义版本）</summary>
            <table>
              <caption>
                业务拒绝观察比率；空值保留具体原因
              </caption>
              <thead>
                <tr>
                  <th>时间桶</th>
                  <th>部分桶</th>
                  <th>业务拒绝观察比率</th>
                  <th>重复操作正式 / 观察比率</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="bucket in data.efficiency.trends" :key="bucket.from">
                  <td>{{ bucket.from }} — {{ bucket.to }}</td>
                  <td>{{ bucket.partialBucket ? "是" : "否" }}</td>
                  <td>{{ bucket.operation_fail_rate.observedValue ?? "—" }}</td>
                  <td>
                    {{ bucket.repeated_operation_rate.value ?? "—" }} /
                    {{ bucket.repeated_operation_rate.observedValue ?? "—" }}
                  </td>
                  <td>
                    {{ bucket.operation_fail_rate.reason }}
                    {{ bucket.repeated_operation_rate.reason }}
                  </td>
                </tr>
              </tbody>
            </table>
            <template
              v-for="bucket in data.efficiency.trends"
              :key="'form-' + bucket.from"
            >
              <table v-if="bucket.form_efficiency.results.length">
                <caption>
                  表单结算桶
                  {{
                    bucket.from
                  }}
                  —
                  {{
                    bucket.to
                  }}
                </caption>
                <thead>
                  <tr>
                    <th>formId</th>
                    <th>修改/提交</th>
                    <th>重置/提交</th>
                    <th>校验失败/提交</th>
                    <th>缺失原因</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="f in bucket.form_efficiency.results" :key="f.formId">
                    <td>{{ f.formId }}</td>
                    <td>{{ f.changesPerSubmit ?? "—" }}</td>
                    <td>{{ f.resetRate ?? "—" }}</td>
                    <td>{{ f.validationErrorRate ?? "—" }}</td>
                    <td>
                      {{
                        f.reason ??
                        (data.efficiency.form_efficiency.value
                          ? "可用"
                          : "来源覆盖未验证")
                      }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </template>
          </details>
          <h3>重复操作率</h3>
          <p>
            24小时滚动相关会话：可信后端引用与受控操作均需接入；未闭合、缺证明或样本不足时保持partial。
          </p>
        </template>
        <p v-else>所选范围暂无可读取的操作效率事实。</p>
        <p>
          任务耗时与操作路径继续使用下方工作流追踪；路径仍为有界会话观察（partial）。
        </p>
      </section>
      <section class="panel" aria-label="组织维度">
        <h2>组织维度</h2>
        <p v-if="data.organization">
          {{ data.organization.status }} · {{ data.organization.reason }}
        </p>
        <p>
          仅对已闭合且迟到期结束的项目日历桶展示组织观察聚合；按历史目录归属，缺完整使用来源时保持
          partial。任一部门、角色或模块分组不足5人时，同一结果族整体隐藏，不提供人员明细。
        </p>
        <template v-for="bucket in data.organization?.values ?? []" :key="bucket.from">
          <p>
            {{ bucket.from }} — {{ bucket.to }} · 目录版本
            {{ bucket.directoryVersionId }} · 接入声明
            {{ bucket.usageSourceVersionId ?? "未发布" }} ·
            {{ bucket.coverageReason ?? data.organization?.coverage }}
          </p>
          <table>
            <caption>
              部门与角色使用（正式值需版本化全量接入声明；否则展示观察值）
            </caption>
            <thead>
              <tr>
                <th>维度</th>
                <th>受控标识</th>
                <th>活跃人数（正式/观察）</th>
                <th>编制人数</th>
                <th>使用率（正式/观察）</th>
                <th>PV</th>
                <th>有效可见时长(ms)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="group in bucket.groups" :key="group.dimension + group.key">
                <td>{{ group.dimension }}</td>
                <td>{{ group.key }}</td>
                <td>{{ group.formalActive ?? group.active }}</td>
                <td>{{ group.eligible }}</td>
                <td>
                  {{ group.value ?? group.observedRatio }} ·
                  {{ group.value == null ? "观察" : "正式" }}
                </td>
                <td>{{ group.pv }}</td>
                <td>{{ group.visibleDurationMs ?? group.durationReason }}</td>
              </tr>
            </tbody>
          </table>
          <table>
            <caption>
              角色 × 模块 PV Top 20（同值按受控标识排序）
            </caption>
            <thead>
              <tr>
                <th>角色</th>
                <th>模块ID</th>
                <th>PV</th>
                <th>有效可见时长(ms)</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in bucket.roleFeatureProfile"
                :key="item.roleId + item.moduleId"
              >
                <td>{{ item.roleId }}</td>
                <td>{{ item.moduleId }}</td>
                <td>{{ item.pv }}</td>
                <td>{{ item.visibleDurationMs ?? "缺有效page_leave" }}</td>
              </tr>
            </tbody>
          </table>
          <table v-if="bucket.roleDurationProfile">
            <caption>
              角色 × 模块有效可见时长 Top 20
            </caption>
            <thead>
              <tr>
                <th>角色</th>
                <th>模块ID</th>
                <th>有效可见时长(ms)</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in bucket.roleDurationProfile"
                :key="item.roleId + item.moduleId"
              >
                <td>{{ item.roleId }}</td>
                <td>{{ item.moduleId }}</td>
                <td>{{ item.visibleDurationMs }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else>有效时长排名不可用：存在缺失或无效的 page_leave。</p>
        </template>
        <p>
          目录可以由项目管理员在指标管理中导入、核对并发布。没有可信目录的项目保持
          not_collected；目录存在不证明业务活动采集完整。
        </p>
        <RouterLink
          :to="{
            path: `/projects/${route.params.projectId}/metrics`,
            query: { ...route.query, directory: '1', analysisReturn: route.fullPath },
          }"
          >查看组织目录配置与版本</RouterLink
        >
      </section>
      <section v-if="data.workflowAnalysis" class="panel" aria-label="工作流追踪">
        <h2>工作流追踪</h2>
        <p>
          按开始时间归属所选窗口；终态观察截至
          {{
            data.workflowAnalysis.context.asOf
          }}。迟到事实可能更新结果，覆盖尚未证明完整。
        </p>
        <p>
          采集状态：{{
            data.workflowAnalysis.collector === "compatible_sdk_observed"
              ? "已观察到兼容SDK；不代表完整覆盖"
              : data.workflowAnalysis.collector === "compatible_sdk_not_observed"
                ? "有访问事实，但未观察到兼容工作流SDK"
                : "尚不能验证SDK安装"
          }}
        </p>
        <p v-if="!data.workflowAnalysis.definitions.length">尚无工作流定义。</p>
        <p v-if="data.workflowAnalysis.configurationStatus === 'no_active_version'">
          已配置工作流，但当前没有可开始新实例的激活版本；历史观察仍保留。
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
                <th>样本 / 未解析 / 状态</th>
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
                <td>
                  {{ w.task_duration.sample }} / {{ w.unresolved }} /
                  {{
                    w.sampleState === "no_facts"
                      ? "无事实"
                      : w.sampleState === "in_progress"
                        ? "进行中"
                        : w.sampleState === "insufficient_sample"
                          ? "不足5个有效耗时样本"
                          : "部分可用，覆盖未验证"
                  }}
                </td>
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
      <dialog
        ref="workflowDialog"
        class="workflow-dialog"
        aria-label="工作流详情"
        @cancel.prevent="showWorkflow()"
      >
        <header>
          <h2>工作流详情</h2>
          <button autofocus aria-label="关闭工作流详情" @click="showWorkflow()">
            关闭
          </button>
        </header>
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
          <button
            :disabled="data.workflowAnalysis.evidencePage <= 1"
            @click="
              router.push({
                query: {
                  ...route.query,
                  workflowEvidencePage: String(data.workflowAnalysis.evidencePage - 1),
                },
              })
            "
          >
            上一页实例
          </button>
          <button
            :disabled="!data.workflowAnalysis.evidenceTruncated"
            @click="
              router.push({
                query: {
                  ...route.query,
                  workflowEvidencePage: String(data.workflowAnalysis.evidencePage + 1),
                },
              })
            "
          >
            下一页实例
          </button>
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
      </dialog>
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
.workflow-dialog {
  box-sizing: border-box;
  width: min(900px, 95vw);
  height: 100dvh;
  max-height: 100dvh;
  margin: 0 0 0 auto;
  padding: 24px;
  border: 0;
  overflow: auto;
}
.workflow-dialog::backdrop {
  background: rgb(0 0 0 / 45%);
}
.workflow-dialog > header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

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
