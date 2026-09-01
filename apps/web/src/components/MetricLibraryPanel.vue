<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, ApiError } from "../api";

type LibraryType = "operational" | "quality";
type VersionStatus = "draft" | "active" | "superseded" | "abandoned";
type ImplementationStatus = "implemented" | "partial" | "not_collected";
type Category = "usage" | "operation" | "performance" | "stability" | "organization";

interface Version {
  id: string;
  libraryType: LibraryType;
  version: number;
  status: VersionStatus;
  sourceVersionId: string | null;
  activatedAt: string | null;
  createdAt: string;
}

interface MetricDefinition {
  id?: string;
  metricKey: string;
  origin: "system" | "business";
  category: Category;
  displayName: string;
  businessDescription: string;
  formulaDescription: string;
  numeratorDescription: string | null;
  denominatorDescription: string | null;
  deduplicationKey: string;
  unit: string;
  percentiles: string[];
  reportingTiming: string;
  entityScopes: string[];
  timeGranularities: string[];
  minimumSample: number;
  missingPolicy: string;
  owner: string;
  definitionVersion: string;
  implementationStatus: ImplementationStatus;
  formulaAst?: unknown;
  availableFrom: string | null;
  unavailableReason: string | null;
  milestone: string;
  enabled?: boolean;
}

interface CatalogResponse {
  system: MetricDefinition[];
  business: MetricDefinition[];
  activeVersion: Version | null;
}

interface VersionResponse {
  version: Version;
  definitions: MetricDefinition[];
}

interface ValidationReport {
  valid: boolean;
  errors: Array<{ code: string; metricKey: string | null; path: string }>;
  definitions: Array<{
    metricKey: string;
    implementationStatus: ImplementationStatus;
    dependencies: string[];
    formulaDescription: string;
  }>;
}

const props = defineProps<{
  projectId: string;
  canWrite: boolean;
  initialType: LibraryType;
  versionsOnly?: boolean;
}>();
const showMessage = ElMessage as unknown as (options: {
  type: "success" | "error" | "warning";
  message: string;
}) => void;

const libraryType = ref<LibraryType>(props.initialType);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const catalog = ref<CatalogResponse | null>(null);
const versions = ref<Version[]>([]);
const selectedVersionId = ref("");
const snapshot = ref<VersionResponse | null>(null);
const validation = ref<ValidationReport | null>(null);
const diff = ref<Record<string, unknown> | null>(null);
const impact = ref<Record<string, unknown> | null>(null);
const definitionOpen = ref(false);
const definitionItem = ref<MetricDefinition | null>(null);
const lineageOpen = ref(false);
const lineage = ref<Record<string, unknown> | null>(null);
const editorOpen = ref(false);
const editingMetricKey = ref<string | null>(null);

const form = reactive({
  metricKey: "",
  displayName: "",
  businessDescription: "",
  category: "usage" as Category,
  inputA: "",
  inputB: "",
  operator: "/" as
    "+" | "-" | "*" | "/" | "min" | "max" | "clamp" | "weighted_mean" | "normalize",
  scalarA: 0,
  scalarB: 100,
  weightA: 1,
  weightB: 1,
  direction: "higher_better" as "higher_better" | "lower_better" | "target_range",
  unit: "ratio",
  entityScope: "project" as "project" | "module" | "page" | "workflow",
  timeGranularity: "day" as "5m" | "hour" | "day" | "week" | "month",
  minimumSample: 5,
  numeratorDescription: "",
  denominatorDescription: "",
  deduplicationKey: "与输入指标一致",
  missingPolicy: "任一输入缺失、样本不足或数据延迟时传播原状态；分母为 0 时不可用。",
  owner: "product-analytics",
  enabled: true,
});

const selectedVersion = computed(
  () => versions.value.find((item) => item.id === selectedVersionId.value) ?? null,
);
const systemMetrics = computed(() => catalog.value?.system ?? []);
const businessMetrics = computed(() =>
  (snapshot.value?.definitions ?? catalog.value?.business ?? []).filter(
    (item) => item.origin === "business",
  ),
);
const inputOptions = computed(() => [...systemMetrics.value, ...businessMetrics.value]);
const localHints = computed(() => {
  const hints: string[] = [];
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(form.metricKey))
    hints.push("key 只能使用小写字母、数字和下划线，且以字母开头。");
  if (inputOptions.value.some((item) => item.metricKey === form.metricKey))
    hints.push("该 key 已存在或属于系统保留 key。");
  if (!form.inputA) hints.push("请选择至少一个已注册输入指标。");
  if (
    ["+", "-", "*", "/", "min", "max", "weighted_mean"].includes(form.operator) &&
    !form.inputB
  )
    hints.push("当前运算需要第二个输入指标。");
  const first = inputOptions.value.find((item) => item.metricKey === form.inputA);
  const second = inputOptions.value.find((item) => item.metricKey === form.inputB);
  if (
    ["+", "-", "min", "max", "weighted_mean"].includes(form.operator) &&
    first &&
    second &&
    first.unit !== second.unit
  ) {
    hints.push(`输入单位不兼容：${first.unit} 与 ${second.unit}。`);
  }
  return hints;
});
const categoryOptions = computed<Category[]>(() =>
  libraryType.value === "quality"
    ? ["performance", "stability"]
    : ["usage", "operation", "organization"],
);

function statusLabel(status: ImplementationStatus): string {
  return status === "implemented"
    ? "已实现"
    : status === "partial"
      ? "部分实现"
      : "未采集";
}

function versionStatusLabel(status: VersionStatus): string {
  return { draft: "草稿", active: "已激活", superseded: "已取代", abandoned: "已废弃" }[
    status
  ];
}

function apiMessage(cause: unknown): string {
  if (cause instanceof ApiError)
    return `${cause.code}${cause.requestId ? ` · ${cause.requestId}` : ""}`;
  return cause instanceof Error ? cause.message : "请求失败";
}

async function load(): Promise<void> {
  if (!props.projectId) return;
  loading.value = true;
  error.value = null;
  try {
    const type = libraryType.value;
    const [catalogResult, versionResult] = await Promise.all([
      api.request<CatalogResponse>(
        `/api/projects/${props.projectId}/metrics/catalog?type=${type}`,
      ),
      api.request<Version[]>(
        `/api/projects/${props.projectId}/metrics/versions?type=${type}`,
      ),
    ]);
    catalog.value = catalogResult;
    versions.value = versionResult;
    if (!versions.value.some((item) => item.id === selectedVersionId.value)) {
      selectedVersionId.value =
        versions.value.find((item) => item.status === "draft")?.id ??
        catalogResult.activeVersion?.id ??
        versions.value[0]?.id ??
        "";
    }
    await loadVersion();
  } catch (cause) {
    error.value = apiMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function loadVersion(): Promise<void> {
  validation.value = null;
  diff.value = null;
  impact.value = null;
  if (!selectedVersionId.value) {
    snapshot.value = null;
    return;
  }
  snapshot.value = await api.request<VersionResponse>(
    `/api/projects/${props.projectId}/metrics/versions/${selectedVersionId.value}`,
  );
}

async function createDraft(sourceVersionId?: string): Promise<void> {
  saving.value = true;
  try {
    const created = await api.request<Version>(
      `/api/projects/${props.projectId}/metrics/versions`,
      {
        method: "POST",
        body: JSON.stringify({
          type: libraryType.value,
          sourceVersionId: sourceVersionId ?? null,
        }),
      },
    );
    selectedVersionId.value = created.id;
    showMessage({ type: "success", message: "已复制为新草稿" });
    await load();
  } catch (cause) {
    showMessage({ type: "error", message: apiMessage(cause) });
  } finally {
    saving.value = false;
  }
}

async function validateSelected(): Promise<void> {
  if (!selectedVersion.value) return;
  saving.value = true;
  try {
    validation.value = await api.request<ValidationReport>(
      `/api/projects/${props.projectId}/metrics/versions/${selectedVersion.value.id}/validate`,
      { method: "POST" },
    );
    if (validation.value.valid)
      showMessage({ type: "success", message: "服务端权威校验通过" });
    else
      showMessage({
        type: "warning",
        message: `校验发现 ${validation.value.errors.length} 个问题`,
      });
  } catch (cause) {
    showMessage({ type: "error", message: apiMessage(cause) });
  } finally {
    saving.value = false;
  }
}

async function activate(version: Version): Promise<void> {
  try {
    const [diffResult, impactResult] = await Promise.all([
      api.request<Record<string, unknown>>(
        `/api/projects/${props.projectId}/metrics/versions/${version.id}/diff`,
      ),
      api.request<Record<string, unknown>>(
        `/api/projects/${props.projectId}/metrics/versions/${version.id}/impact`,
      ),
    ]);
    await ElMessageBox.confirm(
      `即将激活${version.libraryType === "quality" ? "质量" : "运营"}指标 v${version.version}。当前版本将被 supersede；已激活快照不会被原地修改。\nDiff：${JSON.stringify(diffResult)}\n影响：${JSON.stringify(impactResult)}`,
      "确认激活完整快照",
      { type: "warning", confirmButtonText: "校验并激活", cancelButtonText: "取消" },
    );
    saving.value = true;
    await api.request(
      `/api/projects/${props.projectId}/metrics/versions/${version.id}/activate`,
      { method: "POST" },
    );
    showMessage({
      type: "success",
      message: version.status === "superseded" ? "旧快照已重新激活" : "版本已激活",
    });
    await load();
  } catch (cause) {
    if (cause !== "cancel") showMessage({ type: "error", message: apiMessage(cause) });
  } finally {
    saving.value = false;
  }
}

async function abandon(version: Version): Promise<void> {
  await ElMessageBox.confirm(`确认废弃草稿 v${version.version}？`, "废弃草稿", {
    type: "warning",
  });
  await api.request(`/api/projects/${props.projectId}/metrics/versions/${version.id}`, {
    method: "DELETE",
  });
  showMessage({ type: "success", message: "草稿已废弃" });
  await load();
}

async function loadChangeReadModels(version: Version): Promise<void> {
  [diff.value, impact.value] = await Promise.all([
    api.request<Record<string, unknown>>(
      `/api/projects/${props.projectId}/metrics/versions/${version.id}/diff`,
    ),
    api.request<Record<string, unknown>>(
      `/api/projects/${props.projectId}/metrics/versions/${version.id}/impact`,
    ),
  ]);
}

function openDefinition(item: MetricDefinition): void {
  definitionItem.value = item;
  definitionOpen.value = true;
}

async function openLineage(item: MetricDefinition): Promise<void> {
  if (!selectedVersionId.value) {
    showMessage({ type: "warning", message: "当前类型还没有指标版本" });
    return;
  }
  try {
    lineage.value = await api.request<Record<string, unknown>>(
      `/api/projects/${props.projectId}/metrics/versions/${selectedVersionId.value}/lineage/${item.metricKey}`,
    );
    lineageOpen.value = true;
  } catch (cause) {
    showMessage({ type: "error", message: apiMessage(cause) });
  }
}

function resetEditor(): void {
  editingMetricKey.value = null;
  Object.assign(form, {
    metricKey: "",
    displayName: "",
    businessDescription: "",
    category: categoryOptions.value[0],
    inputA: "",
    inputB: "",
    operator: "/",
    scalarA: 0,
    scalarB: 100,
    weightA: 1,
    weightB: 1,
    direction: "higher_better",
    unit: "ratio",
    entityScope: "project",
    timeGranularity: "day",
    minimumSample: 5,
    numeratorDescription: "",
    denominatorDescription: "",
    deduplicationKey: "与输入指标一致",
    missingPolicy: "任一输入缺失、样本不足或数据延迟时传播原状态；分母为 0 时不可用。",
    owner: "product-analytics",
    enabled: true,
  });
  validation.value = null;
  editorOpen.value = true;
}

function openEdit(item: MetricDefinition): void {
  resetEditor();
  editingMetricKey.value = item.metricKey;
  form.metricKey = item.metricKey;
  form.displayName = item.displayName;
  form.businessDescription = item.businessDescription;
  form.category = item.category;
  form.unit = item.unit;
  form.entityScope = (item.entityScopes[0] ?? "project") as typeof form.entityScope;
  form.timeGranularity = (item.timeGranularities[0] ??
    "day") as typeof form.timeGranularity;
  form.minimumSample = item.minimumSample;
  form.numeratorDescription = item.numeratorDescription ?? "";
  form.denominatorDescription = item.denominatorDescription ?? "";
  form.deduplicationKey = item.deduplicationKey;
  form.missingPolicy = item.missingPolicy;
  form.owner = item.owner;
  form.enabled = item.enabled ?? true;
  const ast = item.formulaAst as Record<string, unknown> | null | undefined;
  if (!ast) return;
  if (ast.type === "binary") {
    form.operator = String(ast.operator) as typeof form.operator;
    form.inputA = String((ast.left as Record<string, unknown>).metricKey ?? "");
    form.inputB = String((ast.right as Record<string, unknown>).metricKey ?? "");
  } else if (ast.type === "call") {
    form.operator = String(ast.function) as typeof form.operator;
    const args = ast.arguments as Array<Record<string, unknown>>;
    form.inputA = String(args[0]?.metricKey ?? "");
    form.inputB = String(args[1]?.metricKey ?? "");
    if (ast.function === "clamp") {
      form.scalarA = Number(args[1]?.value ?? 0);
      form.scalarB = Number(args[2]?.value ?? 100);
    }
  } else if (ast.type === "weighted_mean") {
    form.operator = "weighted_mean";
    const items = ast.items as Array<{
      value: { metricKey?: string };
      weight: number;
    }>;
    form.inputA = items[0]?.value.metricKey ?? "";
    form.inputB = items[1]?.value.metricKey ?? "";
    form.weightA = items[0]?.weight ?? 1;
    form.weightB = items[1]?.weight ?? 1;
  } else if (ast.type === "normalize") {
    form.operator = "normalize";
    form.direction = String(ast.direction) as typeof form.direction;
    form.inputA = String((ast.input as Record<string, unknown>).metricKey ?? "");
    const target = ast.target as Record<string, number>;
    form.scalarA = target.floor ?? target.target ?? target.toleranceMin ?? 0;
    form.scalarB = target.ceiling ?? target.target ?? target.toleranceMax ?? 100;
  }
}

async function deleteMetric(item: MetricDefinition): Promise<void> {
  if (!selectedVersion.value) return;
  await ElMessageBox.confirm(
    `从新草稿中删除 ${item.metricKey}？已激活快照不会被修改。`,
    "删除业务指标",
    { type: "warning" },
  );
  const result = await api.request<{ versionId: string }>(
    `/api/projects/${props.projectId}/metrics/versions/${selectedVersion.value.id}/definitions/${item.metricKey}`,
    { method: "DELETE" },
  );
  selectedVersionId.value = result.versionId;
  showMessage({ type: "success", message: "业务指标已从草稿删除" });
  await load();
}

function metricNode(metricKey: string) {
  return { type: "metric", metricKey };
}

function buildFormulaAst(): unknown {
  const left = metricNode(form.inputA);
  const right = metricNode(form.inputB);
  if (["+", "-", "*", "/"].includes(form.operator)) {
    return { type: "binary", operator: form.operator, left, right };
  }
  if (form.operator === "min" || form.operator === "max") {
    return { type: "call", function: form.operator, arguments: [left, right] };
  }
  if (form.operator === "clamp") {
    return {
      type: "call",
      function: "clamp",
      arguments: [
        left,
        { type: "literal", value: form.scalarA },
        { type: "literal", value: form.scalarB },
      ],
    };
  }
  if (form.operator === "weighted_mean") {
    return {
      type: "weighted_mean",
      items: [
        { value: left, weight: form.weightA },
        { value: right, weight: form.weightB },
      ],
    };
  }
  const target =
    form.direction === "higher_better"
      ? { floor: form.scalarA, target: form.scalarB }
      : form.direction === "lower_better"
        ? { target: form.scalarA, ceiling: form.scalarB }
        : {
            toleranceMin: form.scalarA,
            targetMin: form.scalarA + 1,
            targetMax: form.scalarB - 1,
            toleranceMax: form.scalarB,
          };
  return { type: "normalize", direction: form.direction, input: left, target };
}

async function saveMetric(): Promise<void> {
  if (localHints.value.length || !selectedVersion.value) return;
  saving.value = true;
  try {
    const result = await api.request<{
      version: Version;
      validation: ValidationReport;
    }>(
      `/api/projects/${props.projectId}/metrics/versions/${selectedVersion.value.id}/definitions/${form.metricKey}`,
      {
        method: "PUT",
        body: JSON.stringify({
          metricKey: form.metricKey,
          displayName: form.displayName,
          businessDescription: form.businessDescription,
          category: form.category,
          numeratorDescription: form.numeratorDescription || null,
          denominatorDescription: form.denominatorDescription || null,
          deduplicationKey: form.deduplicationKey,
          unit: form.unit,
          entityScope: form.entityScope,
          timeGranularity: form.timeGranularity,
          minimumSample: form.minimumSample,
          missingPolicy: form.missingPolicy,
          owner: form.owner,
          enabled: form.enabled,
          formulaAst: buildFormulaAst(),
        }),
      },
    );
    selectedVersionId.value = result.version.id;
    editorOpen.value = false;
    showMessage({ type: "success", message: "业务指标已保存；服务端校验结果已更新" });
    await load();
    validation.value = result.validation;
  } catch (cause) {
    showMessage({ type: "error", message: apiMessage(cause) });
  } finally {
    saving.value = false;
  }
}

watch(
  () => [props.projectId, props.initialType],
  () => {
    libraryType.value = props.initialType;
    selectedVersionId.value = "";
    void load();
  },
  { immediate: true },
);
watch(libraryType, () => {
  selectedVersionId.value = "";
  void load();
});
watch(selectedVersionId, () => void loadVersion());
</script>

<template>
  <section class="metric-library" data-testid="metric-library">
    <el-alert
      v-if="!canWrite"
      type="info"
      :closable="false"
      show-icon
      title="当前账号为 viewer：可以查看指标定义、版本 diff 和血缘，但不能创建、修改、激活或废弃。"
    />
    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />

    <div class="library-toolbar">
      <el-segmented
        v-model="libraryType"
        :options="[
          { label: '运营指标', value: 'operational' },
          { label: '质量指标', value: 'quality' },
        ]"
      />
      <el-select
        v-model="selectedVersionId"
        placeholder="选择版本"
        style="width: 210px"
      >
        <el-option
          v-for="version in versions"
          :key="version.id"
          :value="version.id"
          :label="`v${version.version} · ${versionStatusLabel(version.status)}`"
        />
      </el-select>
      <el-button :loading="loading" @click="load">刷新</el-button>
      <el-button
        v-if="canWrite"
        type="primary"
        :loading="saving"
        @click="createDraft(selectedVersion?.id)"
        >复制为草稿</el-button
      >
    </div>

    <section class="panel version-panel">
      <div class="section-heading">
        <div>
          <span class="eyebrow">VERSIONED SNAPSHOT</span>
          <h2>版本库</h2>
          <p>同项目同类型只允许一个 active；激活快照不可原地修改，旧快照可重新激活。</p>
        </div>
        <div v-if="selectedVersion" class="version-actions">
          <el-button @click="loadChangeReadModels(selectedVersion)"
            >查看 diff / 影响</el-button
          >
          <el-button
            v-if="canWrite && selectedVersion.status === 'draft'"
            @click="validateSelected"
            >服务端校验</el-button
          >
          <el-button
            v-if="canWrite && ['draft', 'superseded'].includes(selectedVersion.status)"
            type="primary"
            @click="activate(selectedVersion)"
            >{{
              selectedVersion.status === "superseded" ? "重新激活旧快照" : "激活"
            }}</el-button
          >
          <el-button
            v-if="canWrite && selectedVersion.status === 'draft'"
            type="danger"
            @click="abandon(selectedVersion)"
            >废弃草稿</el-button
          >
        </div>
      </div>
      <el-table :data="versions" row-key="id" size="small">
        <el-table-column label="版本" width="90"
          ><template #default="{ row }">v{{ row.version }}</template></el-table-column
        >
        <el-table-column label="类型" width="110"
          ><template #default="{ row }">{{
            row.libraryType === "quality" ? "质量" : "运营"
          }}</template></el-table-column
        >
        <el-table-column label="状态" width="110"
          ><template #default="{ row }"
            ><el-tag
              :type="
                row.status === 'active'
                  ? 'success'
                  : row.status === 'draft'
                    ? 'warning'
                    : 'info'
              "
              >{{ versionStatusLabel(row.status) }}</el-tag
            ></template
          ></el-table-column
        >
        <el-table-column prop="activatedAt" label="激活时间" min-width="190" />
        <el-table-column label="快照" min-width="160"
          ><template #default="{ row }">{{
            row.sourceVersionId ? "复制自历史版本" : "系统基线"
          }}</template></el-table-column
        >
      </el-table>
      <el-alert
        v-if="validation"
        :type="validation.valid ? 'success' : 'error'"
        :closable="false"
        show-icon
        :title="
          validation.valid
            ? '服务端权威校验通过'
            : `服务端校验失败：${validation.errors.map((item) => item.code).join('、')}`
        "
      />
      <div v-if="diff || impact" class="read-models">
        <pre v-if="diff">Diff {{ JSON.stringify(diff, null, 2) }}</pre>
        <pre v-if="impact">影响范围 {{ JSON.stringify(impact, null, 2) }}</pre>
      </div>
    </section>

    <template v-if="!versionsOnly">
      <section class="panel">
        <div class="section-heading">
          <div>
            <span class="eyebrow">READ-ONLY SYSTEM CATALOG</span>
            <h2>系统默认指标</h2>
            <p>附件保留 key 由代码保护；不能创建、覆盖、删除或改变语义。</p>
          </div>
        </div>
        <el-table
          :data="systemMetrics"
          row-key="metricKey"
          :loading="loading"
          data-testid="system-metrics"
        >
          <el-table-column prop="metricKey" label="规范 key" min-width="185" />
          <el-table-column prop="displayName" label="中文名" min-width="180" />
          <el-table-column prop="category" label="分类" width="125" />
          <el-table-column label="实施状态" width="130"
            ><template #default="{ row }"
              ><el-tag
                :type="
                  row.implementationStatus === 'implemented'
                    ? 'success'
                    : row.implementationStatus === 'partial'
                      ? 'warning'
                      : 'info'
                "
                >{{ statusLabel(row.implementationStatus) }}</el-tag
              ></template
            ></el-table-column
          >
          <el-table-column label="availableFrom / 原因" min-width="300"
            ><template #default="{ row }"
              ><span v-if="row.availableFrom">{{ row.availableFrom }}</span
              ><span v-else>{{ row.unavailableReason }}</span></template
            ></el-table-column
          >
          <el-table-column label="操作" width="150"
            ><template #default="{ row }"
              ><el-button link @click="openDefinition(row)">定义</el-button
              ><el-button link @click="openLineage(row)">血缘</el-button></template
            ></el-table-column
          >
        </el-table>
      </section>

      <section class="panel">
        <div class="section-heading">
          <div>
            <span class="eyebrow">CONTROLLED DAG</span>
            <h2>用户业务指标</h2>
            <p>公式只引用已注册指标，由服务端 AST 校验和 evaluator 权威计算。</p>
          </div>
          <el-button
            v-if="canWrite && selectedVersion"
            type="primary"
            :disabled="selectedVersion.status === 'abandoned'"
            @click="resetEditor"
            >新建业务指标</el-button
          >
        </div>
        <el-table
          :data="businessMetrics"
          row-key="metricKey"
          empty-text="当前快照还没有用户业务指标"
          data-testid="business-metrics"
        >
          <el-table-column prop="metricKey" label="指标 key" min-width="180" />
          <el-table-column prop="displayName" label="中文名" min-width="170" />
          <el-table-column prop="formulaDescription" label="公式" min-width="260" />
          <el-table-column label="状态" width="130"
            ><template #default="{ row }">{{
              statusLabel(row.implementationStatus)
            }}</template></el-table-column
          >
          <el-table-column label="操作" min-width="240"
            ><template #default="{ row }"
              ><el-button link @click="openDefinition(row)">定义</el-button
              ><el-button link @click="openLineage(row)">血缘</el-button
              ><template v-if="canWrite && selectedVersion?.status !== 'abandoned'"
                ><el-button link @click="openEdit(row)">编辑</el-button
                ><el-button link type="danger" @click="deleteMetric(row)"
                  >删除</el-button
                ></template
              ></template
            ></el-table-column
          >
        </el-table>
      </section>
    </template>

    <el-drawer v-model="definitionOpen" title="指标定义" size="min(560px, 94vw)">
      <dl v-if="definitionItem" class="definition-list">
        <template
          v-for="field in [
            'metricKey',
            'displayName',
            'businessDescription',
            'formulaDescription',
            'numeratorDescription',
            'denominatorDescription',
            'deduplicationKey',
            'unit',
            'percentiles',
            'reportingTiming',
            'entityScopes',
            'timeGranularities',
            'minimumSample',
            'missingPolicy',
            'owner',
            'definitionVersion',
            'implementationStatus',
            'availableFrom',
            'unavailableReason',
            'milestone',
          ]"
          :key="field"
          ><dt>{{ field }}</dt>
          <dd>{{ definitionItem[field as keyof MetricDefinition] }}</dd></template
        >
      </dl>
    </el-drawer>

    <el-drawer v-model="lineageOpen" title="指标血缘" size="min(680px, 94vw)">
      <pre>{{ JSON.stringify(lineage, null, 2) }}</pre>
    </el-drawer>

    <el-dialog
      v-model="editorOpen"
      :title="editingMetricKey ? '编辑业务指标（保存到草稿）' : '语义化业务指标编辑器'"
      width="min(860px, 96vw)"
      destroy-on-close
    >
      <el-alert
        type="info"
        :closable="false"
        title="编辑器不会保存 SQL、代码、任意字段或任意函数。页面只做即时提示，保存和激活以服务端校验为准。"
      />
      <el-form label-position="top" class="formula-form">
        <el-form-item label="指标 key"
          ><el-input
            v-model="form.metricKey"
            :disabled="Boolean(editingMetricKey)"
            placeholder="例如 session_value_rate"
        /></el-form-item>
        <el-form-item label="中文名"
          ><el-input v-model="form.displayName"
        /></el-form-item>
        <el-form-item label="业务说明"
          ><el-input v-model="form.businessDescription" type="textarea"
        /></el-form-item>
        <el-form-item label="分类"
          ><el-select v-model="form.category"
            ><el-option
              v-for="item in categoryOptions"
              :key="item"
              :label="item"
              :value="item" /></el-select
        ></el-form-item>
        <el-form-item label="输入指标 A"
          ><el-select v-model="form.inputA" filterable placeholder="搜索已注册指标"
            ><el-option
              v-for="item in inputOptions"
              :key="item.metricKey"
              :label="`${item.metricKey} · ${item.displayName} · ${statusLabel(item.implementationStatus)}`"
              :value="item.metricKey" /></el-select
        ></el-form-item>
        <el-form-item
          v-if="!['clamp', 'normalize'].includes(form.operator)"
          label="输入指标 B"
          ><el-select v-model="form.inputB" filterable placeholder="搜索已注册指标"
            ><el-option
              v-for="item in inputOptions"
              :key="item.metricKey"
              :label="`${item.metricKey} · ${item.displayName}`"
              :value="item.metricKey" /></el-select
        ></el-form-item>
        <el-form-item label="运算符 / 函数"
          ><el-select v-model="form.operator"
            ><el-option
              v-for="item in [
                '+',
                '-',
                '*',
                '/',
                'min',
                'max',
                'clamp',
                'weighted_mean',
                'normalize',
              ]"
              :key="item"
              :label="item"
              :value="item" /></el-select
        ></el-form-item>
        <template v-if="form.operator === 'normalize'"
          ><el-form-item label="目标方向"
            ><el-select v-model="form.direction"
              ><el-option label="越高越好" value="higher_better" /><el-option
                label="越低越好"
                value="lower_better" /><el-option
                label="目标区间"
                value="target_range" /></el-select></el-form-item
        ></template>
        <template v-if="['clamp', 'normalize'].includes(form.operator)"
          ><el-form-item label="目标 / 下界"
            ><el-input-number v-model="form.scalarA" /></el-form-item
          ><el-form-item label="目标 / 上界"
            ><el-input-number v-model="form.scalarB" /></el-form-item
        ></template>
        <template v-if="form.operator === 'weighted_mean'"
          ><el-form-item label="A 权重"
            ><el-input-number v-model="form.weightA" :min="0.001" /></el-form-item
          ><el-form-item label="B 权重"
            ><el-input-number v-model="form.weightB" :min="0.001" /></el-form-item
        ></template>
        <el-form-item label="目标单位"><el-input v-model="form.unit" /></el-form-item>
        <el-form-item label="entity scope"
          ><el-select v-model="form.entityScope"
            ><el-option
              v-for="item in ['project', 'module', 'page', 'workflow']"
              :key="item"
              :value="item"
              :label="item" /></el-select
        ></el-form-item>
        <el-form-item label="时间粒度"
          ><el-select v-model="form.timeGranularity"
            ><el-option
              v-for="item in ['5m', 'hour', 'day', 'week', 'month']"
              :key="item"
              :value="item"
              :label="item" /></el-select
        ></el-form-item>
        <el-form-item label="minimum sample"
          ><el-input-number v-model="form.minimumSample" :min="0"
        /></el-form-item>
        <el-form-item label="分子说明"
          ><el-input v-model="form.numeratorDescription"
        /></el-form-item>
        <el-form-item label="分母说明"
          ><el-input v-model="form.denominatorDescription"
        /></el-form-item>
        <el-form-item label="去重键"
          ><el-input v-model="form.deduplicationKey"
        /></el-form-item>
        <el-form-item label="missing rule"
          ><el-input v-model="form.missingPolicy" type="textarea"
        /></el-form-item>
        <el-form-item label="owner"><el-input v-model="form.owner" /></el-form-item>
      </el-form>
      <el-alert
        v-if="localHints.length"
        type="warning"
        :closable="false"
        :title="localHints.join('；')"
      />
      <template #footer
        ><el-button @click="editorOpen = false">取消</el-button
        ><el-button
          type="primary"
          :loading="saving"
          :disabled="Boolean(localHints.length)"
          @click="saveMetric"
          >保存并由服务端校验</el-button
        ></template
      >
    </el-dialog>
  </section>
</template>

<style scoped>
.metric-library {
  display: grid;
  gap: 16px;
}
.library-toolbar,
.version-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.version-panel {
  margin-top: 0;
}
.section-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: start;
}
.section-heading h2,
.section-heading p {
  margin: 4px 0;
}
.read-models {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
}
pre {
  overflow: auto;
  padding: 12px;
  border-radius: 8px;
  background: var(--surface-muted, #f7f8fa);
  white-space: pre-wrap;
}
.definition-list {
  display: grid;
  grid-template-columns: minmax(130px, 0.35fr) 1fr;
  gap: 10px 14px;
}
.definition-list dt {
  font-weight: 600;
}
.definition-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.formula-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
  margin-top: 16px;
}
.formula-form :deep(.el-form-item:nth-child(3)),
.formula-form :deep(.el-form-item:nth-last-child(2)) {
  grid-column: 1 / -1;
}
@media (max-width: 760px) {
  .read-models,
  .formula-form {
    grid-template-columns: 1fr;
  }
  .section-heading {
    display: grid;
  }
}
</style>
