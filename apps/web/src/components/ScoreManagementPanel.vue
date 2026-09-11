<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api";
import ScoreExplanation from "./ScoreExplanation.vue";
import type {
  ScoreType,
  ScoreConfiguration,
  ScoreVersion,
  ScoreOptions,
  ScoreBusiness,
  ScoreSnapshot,
  ScoreTemplate,
  ScorePreview,
  ScoreResult,
  ScoreTrial,
  ScoreLeaf,
} from "../score-types";
const props = defineProps<{ projectId: string; canWrite: boolean }>();
const route = useRoute(),
  router = useRouter();
const type = computed<ScoreType>(() =>
  route.query.scoreType === "quality" ? "quality" : "operational",
);
const versions = ref<ScoreVersion[]>([]),
  snapshot = ref<ScoreSnapshot | null>(null),
  options = ref<ScoreOptions | null>(null),
  template = ref<ScoreTemplate | null>(null),
  configuration = ref<ScoreConfiguration | null>(null),
  business = ref<ScoreBusiness | null>(null),
  result = ref<ScoreResult | null>(null),
  preview = ref<ScorePreview | null>(null),
  review = ref<ScorePreview | null>(null),
  trials = ref<ScoreTrial[]>([]);
const openedTrials = ref<Record<string, boolean>>({});
const error = ref(""),
  notice = ref(""),
  busy = ref(false),
  step = ref(1),
  editing = ref(false),
  fixtureChoice = ref<
    "normal" | "partial" | "gateFailure" | "healthyZeroErrors" | "noData"
  >("normal");
const env = ref("prod"),
  from = ref(""),
  to = ref("");
let generation = 0;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const base = () => `/api/projects/${props.projectId}/score-management`;
const metricBase = () => `/api/projects/${props.projectId}/metrics`;
const mutable = computed(
  () => props.canWrite && snapshot.value?.version.status === "draft" && editing.value,
);
const fixture = computed(() => preview.value?.fixtures[fixtureChoice.value] ?? null);
const scopedWorkflows = computed(
  () =>
    options.value?.workflows.filter(
      (w) =>
        configuration.value?.scope === "project" ||
        w.moduleId === business.value?.scopeId,
    ) ?? [],
);
function query() {
  return {
    env: env.value,
    from: new Date(from.value + "Z").toISOString(),
    to: new Date(to.value + "Z").toISOString(),
    granularity: configuration.value?.granularity ?? "day",
  };
}
function message(e: unknown) {
  return e instanceof ApiError
    ? `${e.code}：${e.message}`
    : e instanceof Error
      ? e.message
      : String(e);
}
async function select(typeValue: ScoreType, versionId?: string) {
  await router.replace({
    query: {
      ...route.query,
      tab: "scores",
      scoreType: typeValue,
      scoreVersion: versionId,
    },
  });
}
async function load() {
  const current = ++generation;
  busy.value = true;
  error.value = "";
  notice.value = "";
  snapshot.value = null;
  configuration.value = null;
  business.value = null;
  preview.value = null;
  review.value = null;
  result.value = null;
  editing.value = false;
  step.value = 1;
  trials.value = [];
  openedTrials.value = {};
  env.value = typeof route.query.env === "string" ? route.query.env : "prod";
  to.value =
    typeof route.query.scoreTo === "string"
      ? route.query.scoreTo
      : new Date().toISOString().slice(0, 16);
  from.value =
    typeof route.query.scoreFrom === "string"
      ? route.query.scoreFrom
      : new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 16);
  if (!props.projectId) {
    busy.value = false;
    return;
  }
  const scoreBase = base(),
    libraryBase = metricBase(),
    requestedType = type.value;
  try {
    const [v, o, t] = await Promise.all([
      api.request<ScoreVersion[]>(libraryBase + "/versions?type=" + requestedType),
      api.request<ScoreOptions>(scoreBase + "/business-options"),
      api.request<ScoreTemplate>(scoreBase + "/templates?type=" + requestedType),
    ]);
    if (current !== generation) return;
    versions.value = v;
    options.value = o;
    template.value = t;
    const requested =
      typeof route.query.scoreVersion === "string" ? route.query.scoreVersion : null;
    const selected = requested
      ? v.find((x) => x.id === requested)
      : (v.find((x) => x.status === "active") ?? v.find((x) => x.status === "draft"));
    if (requested && !selected) throw new Error("所选版本不属于当前项目和分数类型。");
    if (!selected) return;
    if (!requested) {
      await select(requestedType, selected.id);
      return;
    }
    const data = await api.request<ScoreSnapshot>(
      scoreBase + "/versions/" + selected.id,
    );
    if (current !== generation) return;
    snapshot.value = data;
    configuration.value = data.score ? copy(data.score.configuration) : null;
    if (data.score) {
      business.value = {
        templateVersion: data.score.dependencies.template.version,
        confirmed:
          data.score.dependencies.optionsDigest === o.optionsDigest &&
          data.score.dependencies.confirmed,
        scopeId: data.score.dependencies.scopeId,
        optionsDigest: o.optionsDigest,
        workflowWeights: copy(data.score.dependencies.workflowWeights),
        durationMinimumSample: data.score.dependencies.durationMinimumSample,
      };
      const q = new URLSearchParams(query());
      const [r, h] = await Promise.all([
        api.request<ScoreResult>(
          scoreBase + "/versions/" + selected.id + "/result?" + q,
        ),
        api.request<ScoreTrial[]>(scoreBase + "/versions/" + selected.id + "/trials"),
      ]);
      if (current !== generation) return;
      result.value = r;
      trials.value = h;
    }
  } catch (e) {
    if (current === generation) error.value = message(e);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function run(action: (current: number) => Promise<void>) {
  const current = generation;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action(current);
  } catch (e) {
    if (current === generation) error.value = message(e);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function draft() {
  await run(async (current) => {
    const data = await api.request<ScoreVersion>(metricBase() + "/versions", {
      method: "POST",
      body: JSON.stringify({
        type: type.value,
        sourceVersionId: snapshot.value?.version.id ?? null,
      }),
    });
    if (current !== generation) return;
    if (data.id !== snapshot.value?.version.id) {
      await select(type.value, data.id);
    } else editing.value = true;
  });
}
function beginEdit() {
  editing.value = true;
  step.value = 1;
}
function adoptTemplate() {
  if (!template.value || !options.value) return;
  configuration.value = copy(template.value.configuration);
  business.value = {
    templateVersion: template.value.version,
    confirmed: false,
    scopeId: props.projectId,
    optionsDigest: options.value.optionsDigest,
    workflowWeights: Object.fromEntries(options.value.workflows.map((w) => [w.id, 1])),
    durationMinimumSample: 5,
  };
  preview.value = null;
}
function changeScope() {
  if (!business.value) return;
  business.value.scopeId =
    configuration.value?.scope === "project"
      ? props.projectId
      : (options.value?.modules.find((m) => m.status === "active")?.id ?? "");
  resetWorkflowWeights();
}
function resetWorkflowWeights() {
  if (business.value) {
    business.value.confirmed = false;
    business.value.workflowWeights = Object.fromEntries(
      scopedWorkflows.value.map((w) => [
        w.id,
        business.value?.workflowWeights[w.id] ?? 1,
      ]),
    );
  }
}
function directionChanged(leaf: ScoreLeaf) {
  leaf.target =
    leaf.direction === "higher_better"
      ? { floor: 0, target: 1 }
      : leaf.direction === "lower_better"
        ? { target: 1, ceiling: 2 }
        : { toleranceMin: 0, targetMin: 1, targetMax: 2, toleranceMax: 3 };
}
function addDimension() {
  const config = configuration.value;
  if (!config || config.dimensions.length >= 6) return;
  const key = "dimension_" + Date.now();
  config.dimensions.push({
    key,
    displayName: "新维度",
    weight: 1,
    leaves: [copy(config.dimensions[0]!.leaves[0]!)],
  });
  config.dimensions.at(-1)!.leaves[0]!.key = "leaf_" + Date.now();
  config.dimensions.forEach((d) => (d.weight = 1 / config.dimensions.length));
  config.radarDimensions.push(key);
}
function removeDimension(index: number) {
  const c = configuration.value;
  if (!c || c.dimensions.length <= 3) return;
  const removed = c.dimensions.splice(index, 1)[0]!;
  c.dimensions.forEach((d) => (d.weight = 1 / c.dimensions.length));
  c.radarDimensions = c.radarDimensions.filter((k) => k !== removed.key);
}
function addLeaf(index: number) {
  const d = configuration.value!.dimensions[index]!;
  if (d.leaves.length >= 20) return;
  d.leaves.push({ ...copy(d.leaves[0]!), key: "leaf_" + Date.now() });
  d.leaves.forEach((l) => (l.weight = 1 / d.leaves.length));
}
function removeLeaf(dim: number, index: number) {
  const d = configuration.value!.dimensions[dim]!;
  if (d.leaves.length <= 1) return;
  d.leaves.splice(index, 1);
  d.leaves.forEach((l) => (l.weight = 1 / d.leaves.length));
}
async function validate() {
  await run(async (current) => {
    const data = await api.request<ScorePreview>(
      base() + "/versions/" + snapshot.value!.version.id + "/preview",
      { method: "POST", body: JSON.stringify(configuration.value) },
    );
    if (current === generation) {
      preview.value = data;
      step.value = 4;
    }
  });
}
async function save() {
  await run(async (current) => {
    const data = await api.request<ScoreSnapshot>(
      base() + "/versions/" + snapshot.value!.version.id,
      {
        method: "PUT",
        body: JSON.stringify({
          configuration: configuration.value,
          business: business.value,
        }),
      },
    );
    if (current === generation) {
      snapshot.value = data;
      notice.value = "草稿已保存；配置保存不代表事实可计算。";
      editing.value = false;
      preview.value = null;
      result.value = null;
    }
  });
}
async function prepare() {
  await run(async (current) => {
    const data = await api.request<ScorePreview>(
      base() + "/versions/" + snapshot.value!.version.id + "/review",
      { method: "POST", body: JSON.stringify(query()) },
    );
    if (current === generation) {
      review.value = data;
    }
  });
}
async function activate() {
  await run(async (current) => {
    await api.request(
      metricBase() + "/versions/" + snapshot.value!.version.id + "/activate",
      { method: "POST" },
    );
    if (current === generation) await load();
  });
}
async function abandon() {
  await run(async (current) => {
    await api.request(metricBase() + "/versions/" + snapshot.value!.version.id, {
      method: "DELETE",
    });
    if (current === generation) await select(type.value);
  });
}
async function trial() {
  await run(async (current) => {
    const data = await api.request<{ id: string; result: ScoreResult }>(
      base() + "/versions/" + snapshot.value!.version.id + "/trials",
      { method: "POST", body: JSON.stringify(query()) },
    );
    if (current === generation) {
      trials.value.unshift({
        id: data.id,
        createdAt: new Date().toISOString(),
        result: data.result,
      });
      notice.value = "历史试算已独立保存；原事实和旧结果未改写。";
    }
  });
}
async function refresh() {
  await router.replace({
    query: { ...route.query, env: env.value, scoreFrom: from.value, scoreTo: to.value },
  });
  await load();
}
watch(
  () => [
    props.projectId,
    route.query.scoreType,
    route.query.scoreVersion,
    route.query.env,
    route.query.scoreFrom,
    route.query.scoreTo,
  ],
  () => void load(),
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
});
</script>
<template>
  <section class="score-management" aria-label="分数管理">
    <h2>分数管理</h2>
    <p>
      运营与质量分别保存和激活。业务配置确认后可复用模板；真实事实不足时保留具体不可用原因。
    </p>
    <nav class="row" aria-label="分数类型">
      <button :aria-pressed="type === 'operational'" @click="select('operational')">
        运营分数</button
      ><button :aria-pressed="type === 'quality'" @click="select('quality')">
        质量分数
      </button>
    </nav>
    <p v-if="!canWrite">只读角色：可查看配置、版本、解释和血缘。</p>
    <p v-if="busy" role="status">正在加载或保存…</p>
    <p v-if="error" role="alert" class="error">{{ error }}（编辑输入已保留）</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <label
      >分数版本
      <select
        aria-label="分数版本"
        :value="snapshot?.version.id ?? ''"
        :disabled="busy"
        @change="select(type, ($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>选择版本</option>
        <option v-for="v in versions" :key="v.id" :value="v.id">
          v{{ v.version }} · {{ v.status }} · {{ v.id }}
        </option>
      </select></label
    >
    <div v-if="canWrite" class="row">
      <button
        v-if="snapshot?.version.status === 'draft'"
        :disabled="busy"
        @click="beginEdit"
      >
        编辑工作草稿</button
      ><button
        v-else-if="snapshot?.version.status !== 'abandoned'"
        :disabled="busy"
        @click="draft"
      >
        {{ snapshot ? "复制为工作草稿" : "创建工作草稿" }}</button
      ><button
        v-if="snapshot?.version.status === 'draft'"
        :disabled="busy"
        @click="abandon"
      >
        废弃工作草稿</button
      ><button
        v-if="
          snapshot?.score &&
          ['draft', 'superseded'].includes(snapshot.version.status) &&
          !editing
        "
        :disabled="busy"
        @click="prepare"
      >
        {{ snapshot.version.status === "superseded" ? "重新激活前检查" : "激活前检查" }}
      </button>
    </div>
    <template v-if="mutable">
      <nav class="row" aria-label="编辑步骤">
        <button
          v-for="(label, i) in ['模板与名称', '业务配置', '维度与指标', '校验与预览']"
          :key="label"
          :aria-current="step === i + 1 ? 'step' : undefined"
          @click="step = i + 1"
        >
          {{ i + 1 }}. {{ label }}
        </button>
      </nav>
      <section v-if="step === 1">
        <h3>选择版本化系统模板</h3>
        <p v-if="template">
          {{ template.version }} · 业务 owner {{ template.approval.owner }} · 批准日期
          {{ template.approval.approvedAt }}<br />{{ template.approval.source }}
        </p>
        <button :disabled="busy" @click="adoptTemplate">采用系统默认模板</button>
        <p>采用模板会替换本次编辑的维度与参数；已激活快照不随模板升级变化。</p>
        <template v-if="configuration"
          ><label
            >分数 key
            <input
              v-model="configuration.scoreKey"
              aria-label="分数 key"
              maxlength="64" /></label
          ><label
            >中文名称
            <input
              v-model="configuration.displayName"
              aria-label="中文名称"
              maxlength="120" /></label
          ><label
            >业务 owner
            <input v-model="configuration.owner" aria-label="业务 owner" /></label
          ><label
            >展示单位
            <select v-model="configuration.displayUnit" aria-label="展示单位">
              <option value="points">分</option>
              <option value="percent">%</option>
            </select></label
          >
          <p>底层分数统一为 0–100；单位只影响展示。</p></template
        >
      </section>
      <section v-if="step === 2 && configuration && business && options">
        <h3>确认业务范围</h3>
        <p>项目时区：{{ options.timezone }}。{{ options.businessScope }}</p>
        <label
          >范围
          <select
            v-model="configuration.scope"
            aria-label="分数范围"
            @change="changeScope"
          >
            <option value="project">整个项目</option>
            <option value="module">功能模块</option>
          </select></label
        ><label v-if="configuration.scope === 'module'"
          >模块
          <select
            v-model="business.scopeId"
            aria-label="分数模块"
            @change="resetWorkflowWeights"
          >
            <option
              v-for="m in options.modules.filter((m) => m.status === 'active')"
              :key="m.id"
              :value="m.id"
            >
              {{ m.name }}
            </option>
          </select></label
        >
        <template v-if="type === 'operational'"
          ><p>
            目标用户：{{ options.settings?.targetUsers ?? "未配置" }}；预期星期：{{
              options.settings?.expectedActiveWeekdays.join("、") ?? "未配置"
            }}（1–7，7 为星期日）。配置版本 {{ options.settings?.version ?? "无" }}
          </p>
          <router-link
            :to="{
              name: 'operational-config',
              params: { projectId },
              query: route.query,
            }"
            >修改目标用户和预期星期</router-link
          >
          <p>
            核心页面覆盖只表示同范围 pv &gt; 0，按关键度加权，不代表理解或任务成功。
          </p>
          <table>
            <thead>
              <tr>
                <th>核心页面</th>
                <th>模板</th>
                <th>关键度 / revision</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in options.pages.filter(
                  (p) =>
                    p.isCore &&
                    p.status === 'active' &&
                    (configuration!.scope === 'project' ||
                      p.moduleId === business!.scopeId),
                )"
                :key="p.id"
              >
                <td>{{ p.name }}</td>
                <td>{{ p.templateKey }}</td>
                <td>{{ p.criticalityWeight }} / {{ p.revisionId }}</td>
              </tr>
            </tbody>
          </table>
          <p>
            任务使用正式 workflow instance；任务类型权重如下，不包含步骤部分完成度。
          </p>
          <label v-for="w in scopedWorkflows" :key="w.id"
            >{{ w.name }} · v{{ w.version }}
            <input
              v-model.number="business.workflowWeights[w.id]"
              type="number"
              min="0.001"
              max="1000"
              step="0.1"
              :aria-label="'任务权重 ' + w.name" /></label
          ><label
            >页面时长最低有效样本
            <input
              v-model.number="business.durationMinimumSample"
              type="number"
              min="1"
          /></label>
          <details>
            <summary>页面模板时长目标（毫秒）</summary>
            <pre>{{ JSON.stringify(options.pageTargets, null, 2) }}</pre>
          </details></template
        >
        <p>{{ options.sessionPolicy }}</p>
        <p>{{ options.percentilePolicy }}</p>
        <p>
          窗口跨日持续：至少两个项目本地日期活跃用户 / 同范围规范
          UV；单日窗口不可参与计算。
        </p>
        <label
          ><input
            v-model="business.confirmed"
            type="checkbox"
            aria-label="确认业务配置"
          />我已确认当前业务范围、目标、分析对象及样本策略适用</label
        >
      </section>
      <section v-if="step === 3 && configuration && snapshot">
        <h3>分步编辑维度与指标</h3>
        <p>默认参数可直接复用。高级配置中的维度权重及各维度叶子权重分别合计为 1。</p>
        <details open>
          <summary>高级配置：权重、目标、样本和 gate</summary>
          <label
            >时间粒度
            <select v-model="configuration.granularity">
              <option v-for="g in ['5m', 'hour', 'day', 'week', 'month']" :key="g">
                {{ g }}
              </option>
            </select></label
          >
          <fieldset v-for="(dim, i) in configuration.dimensions" :key="i">
            <legend>{{ i + 1 }}. {{ dim.displayName }}</legend>
            <label>维度名称 <input v-model="dim.displayName" /></label
            ><label
              >维度权重
              <input
                v-model.number="dim.weight"
                type="number"
                step="0.01"
                min="0.000001"
                max="1" /></label
            ><button
              :disabled="configuration.dimensions.length <= 3"
              @click="removeDimension(i)"
            >
              删除维度
            </button>
            <div v-for="(leaf, j) in dim.leaves" :key="j" class="leaf">
              <label
                >指标
                <select
                  v-model="leaf.metricKey"
                  :aria-label="'指标 ' + (i + 1) + '-' + (j + 1)"
                >
                  <option
                    v-for="m in snapshot.definitions"
                    :key="m.metricKey"
                    :value="m.metricKey"
                  >
                    {{ m.displayName }} · {{ m.metricKey }} · {{ m.unit }}
                  </option>
                </select></label
              ><label>叶子 key <input v-model="leaf.key" /></label
              ><label
                >叶子权重
                <input
                  v-model.number="leaf.weight"
                  type="number"
                  min="0.000001"
                  max="1"
                  step="0.01" /></label
              ><label
                >方向
                <select v-model="leaf.direction" @change="directionChanged(leaf)">
                  <option value="higher_better">越高越好</option>
                  <option value="lower_better">越低越好</option>
                  <option value="target_range">目标区间</option>
                </select></label
              ><template v-if="leaf.target"
                ><label v-for="(_, key) in leaf.target" :key="key"
                  >{{ key }}
                  <input
                    v-model.number="leaf.target[key]"
                    type="number"
                    step="any" /></label></template
              ><button v-else @click="directionChanged(leaf)">填写目标</button
              ><label
                >最低有效样本
                <input
                  v-model.number="leaf.minimumSample"
                  type="number"
                  min="1" /></label
              ><label><input v-model="leaf.enabled" type="checkbox" />启用</label
              ><button :disabled="dim.leaves.length <= 1" @click="removeLeaf(i, j)">
                删除指标
              </button>
            </div>
            <button :disabled="dim.leaves.length >= 20" @click="addLeaf(i)">
              添加指标
            </button>
          </fieldset>
          <button
            :disabled="configuration.dimensions.length >= 6"
            @click="addDimension"
          >
            添加维度</button
          ><label
            >最低可参与维度
            <input
              v-model.number="configuration.gate.minimumEligibleDimensions"
              type="number"
              min="3"
              :max="configuration.dimensions.length" /></label
          ><label
            >最低叶子权重覆盖
            <input
              v-model.number="configuration.gate.minimumLeafWeightCoverage"
              type="number"
              min="0"
              max="1"
              step="0.01" /></label
          ><label
            >绿色起点
            <input
              v-model.number="configuration.colorBands.greenMinimum"
              type="number"
              min="0"
              max="100" /></label
          ><label
            >黄色起点
            <input
              v-model.number="configuration.colorBands.yellowMinimum"
              type="number"
              min="0"
              max="100" /></label
          ><label v-for="dim in configuration.dimensions" :key="dim.key"
            ><input
              v-model="configuration.radarDimensions"
              type="checkbox"
              :value="dim.key"
            />雷达显示 {{ dim.displayName }}</label
          >
        </details>
      </section>
      <section v-if="step === 4">
        <h3>校验与解释预览</h3>
        <button :disabled="busy || !configuration" @click="validate">
          校验配置并预览</button
        ><template v-if="preview"
          ><p>
            配置完整性：{{
              preview.configurationReady ? "通过" : "待补充"
            }}；真实事实：不可用。{{ preview.fixtures.reason }}
          </p>
          <p v-for="r in preview.readiness" :key="r.key + r.reason">
            {{ r.key }}：{{ r.reason }}
          </p>
          <label
            >固定示例
            <select v-model="fixtureChoice" aria-label="固定示例">
              <option value="normal">正常手算</option>
              <option value="partial">部分缺失</option>
              <option value="gateFailure">缺失且未通过 gate</option>
              <option value="healthyZeroErrors">健康零错误</option>
              <option value="noData">无数据</option>
            </select></label
          ><ScoreExplanation v-if="fixture" :result="fixture" fixture />
          <details open>
            <summary>变更与影响</summary>
            <pre>{{
              JSON.stringify(
                {
                  diff: preview.diff,
                  impact: preview.impact,
                  metricDiff: preview.metricDiff,
                },
                null,
                2,
              )
            }}</pre>
          </details></template
        >
      </section>
      <div class="row">
        <button :disabled="step <= 1" @click="step--">上一步</button
        ><button :disabled="step >= 4 || !configuration" @click="step++">下一步</button
        ><button :disabled="busy || !configuration || !business" @click="save">
          保存草稿
        </button>
      </div>
    </template>
    <template v-else-if="snapshot?.score"
      ><details open>
        <summary>已保存的分数配置</summary>
        <p>
          {{ snapshot.score.configuration.displayName }} ·
          {{ snapshot.score.configuration.scoreKey }} ·
          {{ snapshot.score.configuration.libraryType }} · {{ snapshot.version.status }}
        </p>
        <p>
          模板 {{ snapshot.score.dependencies.template.version }} · owner
          {{ snapshot.score.configuration.owner }} · 项目范围
          {{ snapshot.score.dependencies.scopeId }}
        </p>
        <p>
          显示单位：{{
            snapshot.score.configuration.displayUnit === "percent" ? "%" : "分"
          }}； 最低可参与维度：{{
            snapshot.score.configuration.gate.minimumEligibleDimensions
          }}； 最低叶子权重覆盖：{{
            snapshot.score.configuration.gate.minimumLeafWeightCoverage * 100
          }}%。 绿色起点
          {{ snapshot.score.configuration.colorBands.greenMinimum }}，黄色起点
          {{ snapshot.score.configuration.colorBands.yellowMinimum }}。
        </p>
        <details
          v-for="dimension in snapshot.score.configuration.dimensions"
          :key="dimension.key"
        >
          <summary>
            {{ dimension.displayName }} · 配置权重 {{ dimension.weight * 100 }}%
          </summary>
          <ul>
            <li v-for="leaf in dimension.leaves" :key="leaf.key">
              {{ leaf.metricKey }} · {{ leaf.enabled ? "启用" : "停用" }} · 维度内权重
              {{ leaf.weight * 100 }}% · 最低有效样本 {{ leaf.minimumSample }}
            </li>
          </ul>
        </details>
      </details>
      <div class="row">
        <label
          >环境
          <select v-model="env" :disabled="busy" aria-label="分数环境">
            <option>prod</option>
            <option>staging</option>
            <option>dev</option>
          </select></label
        ><label
          >开始（UTC）<input
            v-model="from"
            :disabled="busy"
            type="datetime-local"
            aria-label="分数开始时间" /></label
        ><label
          >结束（UTC，不含）<input
            v-model="to"
            :disabled="busy"
            type="datetime-local"
            aria-label="分数结束时间" /></label
        ><button :disabled="busy" @click="refresh">刷新查询</button
        ><button v-if="canWrite" :disabled="busy" @click="trial">保存历史试算</button>
      </div>
      <ScoreExplanation v-if="result" :result="result" data-testid="current-score" />
      <details>
        <summary>独立历史试算记录（{{ trials.length }}）</summary>
        <p v-if="!trials.length">尚无历史试算记录；不会伪造历史计算或趋势。</p>
        <details
          v-for="item in trials"
          :key="item.id"
          @toggle="openedTrials[item.id] = ($event.target as HTMLDetailsElement).open"
        >
          <summary>
            {{ item.createdAt }} · {{ item.id }} · {{ item.result.context.env }} ·
            {{ item.result.status }}
          </summary>
          <ScoreExplanation v-if="openedTrials[item.id]" :result="item.result" />
        </details></details
    ></template>
    <p v-else-if="snapshot && !mutable && !busy">
      当前版本尚未保存分数配置。管理员可创建或编辑工作草稿，并选择默认模板。
    </p>
    <dialog v-if="review" open aria-label="分数激活检查">
      <h3>确认激活此完整快照</h3>
      <p>
        配置完整性
        {{
          review.configurationReady && review.businessConfirmed ? "通过" : "待补充"
        }}。激活配置不会使缺失的事实变为可用。
      </p>
      <p v-for="r in review.readiness" :key="r.key + r.reason">
        {{ r.key }}：{{ r.reason }}
      </p>
      <h4>配置变更与影响</h4>
      <pre>{{
        JSON.stringify(
          {
            diff: review.diff,
            impact: review.impact,
            metricDiff: review.metricDiff,
            templateChanged: review.templateChanged,
          },
          null,
          2,
        )
      }}</pre>
      <ScoreExplanation
        v-if="review.fixtures.normal"
        :result="review.fixtures.normal"
        fixture
      />
      <h4>适用范围历史试算</h4>
      <ScoreExplanation v-if="review.trial" :result="review.trial.result" /><button
        :disabled="busy || !review.configurationReady || !review.businessConfirmed"
        @click="activate"
      >
        确认激活快照</button
      ><button :disabled="busy" @click="review = null">取消</button>
    </dialog>
  </section>
</template>
<style scoped>
.score-management {
  padding: 20px;
  background: #f8fafc;
  border: 1px solid #dbe3ec;
  border-radius: 12px;
}
.row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  margin: 14px 0;
}
button {
  padding: 8px 14px;
  border: 1px solid #94a3b8;
  border-radius: 6px;
  background: white;
  color: #193652;
  cursor: pointer;
}
button[aria-pressed="true"],
button[aria-current="step"] {
  background: #193652;
  color: white;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
label {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  margin: 8px 16px 8px 0;
  max-width: 100%;
}
input,
select {
  padding: 7px;
  border: 1px solid #94a3b8;
  border-radius: 4px;
  max-width: 100%;
  background: white;
}
input[type="number"] {
  width: 110px;
}
select {
  max-width: 550px;
}
fieldset {
  margin: 15px 0;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
}
.leaf {
  padding: 10px 0;
  border-top: 1px solid #cbd5e1;
}
pre {
  white-space: pre-wrap;
  overflow: auto;
  max-height: 300px;
  font-size: 12px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  text-align: left;
  padding: 6px;
  border-bottom: 1px solid #cbd5e1;
}
.error {
  color: #b91c1c;
}
dialog {
  position: fixed;
  inset: 5vh 5vw;
  width: 90vw;
  max-height: 90vh;
  overflow: auto;
  z-index: 2200;
  border: 1px solid #94a3b8;
  border-radius: 12px;
  box-shadow: 0 0 0 100vmax #0008;
  padding: 24px;
}
summary {
  cursor: pointer;
  margin: 12px 0;
}
</style>
