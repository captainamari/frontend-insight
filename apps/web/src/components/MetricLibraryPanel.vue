<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import {
  ElCollapse,
  ElCollapseItem,
  ElMessage,
  ElMessageBox,
  ElRadioButton,
  ElRadioGroup,
  ElStep,
  ElSteps,
} from "element-plus";
import "element-plus/es/components/collapse/style/css";
import "element-plus/es/components/radio-button/style/css";
import "element-plus/es/components/radio-group/style/css";
import "element-plus/es/components/steps/style/css";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api";
import MetricDefinitionDrawer from "./MetricDefinitionDrawer.vue";
import MetricLineageDrawer from "./MetricLineageDrawer.vue";

type LibraryType = "operational" | "quality";
type VersionStatus = "draft" | "active" | "superseded" | "abandoned";
type ImplementationStatus = "implemented" | "partial" | "not_collected";
type Category = "usage" | "operation" | "performance" | "stability" | "organization";
type EntityScope = "project" | "module" | "page" | "workflow";
type TimeGranularity = "5m" | "hour" | "day" | "week" | "month";

interface Version {
  id: string;
  libraryType: LibraryType;
  version: number;
  status: VersionStatus;
  sourceVersionId: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  entityScopes: EntityScope[];
  timeGranularities: TimeGranularity[];
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

interface FormulaPreview {
  valid: boolean;
  inferredUnit: string | null;
  requiredMinimumSample: number | null;
  dependencies: string[];
  nodeCount: number | null;
  depth: number | null;
  formulaDescription: string | null;
  implementationStatus: ImplementationStatus | null;
  errors: Array<{
    code: string;
    path: string;
    details?: Record<string, unknown>;
  }>;
}

interface MetricLineage {
  metricKey: string;
  versionId: string;
  formulaAst: unknown;
  formulaDescription: string;
  nodes: Array<{
    metricKey: string;
    displayName: string;
    origin: "system" | "business";
    unit: string;
    minimumSample: number;
    missingPolicy: string;
    implementationStatus: ImplementationStatus;
  }>;
  edges: Array<{ from: string; to: string }>;
  directUpstream: string[];
  directDownstream: string[];
  validation: {
    valid: boolean;
    errors: Array<{ code: string; metricKey: string | null; path: string }>;
  };
}

interface MetricDiff {
  versionId: string;
  sourceVersionId: string | null;
  added: string[];
  removed: string[];
  changed: Array<{ metricKey: string; fields: string[] }>;
}

interface MetricImpact {
  versionId: string;
  metricKey: string | null;
  downstreamMetrics: string[];
  displayBindings: Array<{ metricKey: string; routeName: string; surfaceKey: string }>;
  scoreReferences: Array<{ metricKey: string; scoreKey: string }>;
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
const versionFilter = ref<LibraryType | "all">("all");
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const catalog = ref<CatalogResponse | null>(null);
const versions = ref<Version[]>([]);
const visibleVersions = computed(() =>
  versions.value.filter(
    (version) =>
      !props.versionsOnly ||
      versionFilter.value === "all" ||
      version.libraryType === versionFilter.value,
  ),
);
let loadSequence = 0;
let snapshotSequence = 0;
const selectedVersionId = ref("");
const snapshot = ref<VersionResponse | null>(null);
const validation = ref<ValidationReport | null>(null);
const diff = ref<MetricDiff | null>(null);
const impact = ref<MetricImpact | null>(null);
const definitionOpen = ref(false);
const definitionItem = ref<MetricDefinition | null>(null);
const lineageOpen = ref(false);
const lineage = ref<MetricLineage | null>(null);
const editorOpen = ref(false);
const editingMetricKey = ref<string | null>(null);
const editorStep = ref(0);
const editorAttempted = ref(false);
const keyTouched = ref(false);
const previewing = ref(false);
const formulaPreview = ref<FormulaPreview | null>(null);
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewSequence = 0;

const form = reactive({
  metricKey: "",
  displayName: "",
  businessDescription: "",
  category: "usage" as Category,
  inputA: "",
  inputB: "",
  operandBType: "metric" as "metric" | "scalar",
  scalarOperand: 1,
  operator: "/" as
    "+" | "-" | "*" | "/" | "min" | "max" | "clamp" | "weighted_mean" | "normalize",
  scalarA: 0,
  scalarB: 100,
  targetMin: 40,
  targetMax: 60,
  weightA: 1,
  weightB: 1,
  direction: "higher_better" as "higher_better" | "lower_better" | "target_range",
  unit: "",
  entityScope: "project" as EntityScope,
  timeGranularity: "day" as TimeGranularity,
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
const selectedInputs = computed(() =>
  [form.inputA, form.operandBType === "metric" ? form.inputB : ""]
    .filter(Boolean)
    .map((key) => inputOptions.value.find((item) => item.metricKey === key))
    .filter((item): item is MetricDefinition => Boolean(item)),
);
const needsMetricB = computed(
  () =>
    ["+", "-", "min", "max", "weighted_mean"].includes(form.operator) ||
    (["*", "/"].includes(form.operator) && form.operandBType === "metric"),
);
const compatibleScopes = computed(() => {
  if (!selectedInputs.value.length)
    return ["project", "module", "page", "workflow"] as const;
  return selectedInputs.value[0]!.entityScopes.filter((scope) =>
    selectedInputs.value.every((item) => item.entityScopes.includes(scope)),
  );
});
const compatibleGranularities = computed(() => {
  if (!selectedInputs.value.length)
    return ["5m", "hour", "day", "week", "month"] as const;
  return selectedInputs.value[0]!.timeGranularities.filter((granularity) =>
    selectedInputs.value.every((item) => item.timeGranularities.includes(granularity)),
  );
});
const basicHints = computed(() => {
  const hints: string[] = [];
  if (
    (keyTouched.value || editorAttempted.value) &&
    !/^[a-z][a-z0-9_]{2,63}$/.test(form.metricKey)
  )
    hints.push("key 只能使用小写字母、数字和下划线，且以字母开头。");
  if (
    form.metricKey !== editingMetricKey.value &&
    inputOptions.value.some((item) => item.metricKey === form.metricKey)
  )
    hints.push("该 key 已存在或属于系统保留 key。");
  if (editorAttempted.value && !form.displayName.trim()) hints.push("请填写中文名。");
  if (editorAttempted.value && !form.businessDescription.trim())
    hints.push("请说明这个指标回答的业务问题。");
  return hints;
});
const formulaHints = computed(() => {
  const hints: string[] = [];
  if (!form.inputA) hints.push("请选择至少一个已注册输入指标。");
  if (needsMetricB.value && !form.inputB) hints.push("当前运算需要第二个输入指标。");
  if (
    form.inputA &&
    (!needsMetricB.value || form.inputB) &&
    !formulaPreview.value &&
    !previewing.value
  )
    hints.push("正在等待服务端公式预校验。");
  if (formulaPreview.value)
    hints.push(
      ...formulaPreview.value.errors.map((item) =>
        formulaErrorMessage(item.code, item.details),
      ),
    );
  return hints;
});
const semanticHints = computed(() => {
  const hints: string[] = [];
  if (!compatibleScopes.value.includes(form.entityScope))
    hints.push("当前输入指标没有共同的适用对象。");
  if (!compatibleGranularities.value.includes(form.timeGranularity))
    hints.push("当前输入指标没有共同的时间粒度。");
  if (
    formulaPreview.value?.requiredMinimumSample !== null &&
    formulaPreview.value?.requiredMinimumSample !== undefined &&
    form.minimumSample < formulaPreview.value.requiredMinimumSample
  )
    hints.push(
      `最小有效样本数不能低于依赖要求 ${formulaPreview.value.requiredMinimumSample}。`,
    );
  return hints;
});
const localHints = computed(() => [
  ...basicHints.value,
  ...formulaHints.value,
  ...semanticHints.value,
]);
const categoryOptions = computed<Category[]>(() =>
  libraryType.value === "quality"
    ? ["performance", "stability"]
    : ["usage", "operation", "organization"],
);
const operatorOptions = [
  { value: "/", label: "比例或换算（A ÷ B）" },
  { value: "+", label: "相加（单位必须相同）" },
  { value: "-", label: "相减（单位必须相同）" },
  { value: "*", label: "乘以系数" },
  { value: "min", label: "取较小值" },
  { value: "max", label: "取较大值" },
  { value: "clamp", label: "限制在上下界内" },
  { value: "weighted_mean", label: "加权平均" },
  { value: "normalize", label: "归一化为 0–100 得分" },
] as const;
const versionContext = computed(() => {
  const version = selectedVersion.value;
  if (!version) return "当前尚无指标版本。";
  const label = `${version.libraryType === "quality" ? "质量" : "运营"} v${version.version}`;
  if (version.status === "draft")
    return `正在编辑 ${label} 草稿；草稿内可多次保存，不会增加版本号。`;
  if (version.status === "active")
    return `正在查看 ${label} 已激活快照；开始编辑时会创建或进入工作草稿。`;
  if (version.status === "superseded")
    return `正在查看历史快照 ${label}；可重新激活，历史内容不会被修改。`;
  return `正在查看已废弃草稿 ${label}。`;
});
const activeStepHints = computed(() => {
  if (editorStep.value === 0) return basicHints.value;
  if (editorStep.value === 1) return formulaHints.value;
  if (editorStep.value === 2) return [...formulaHints.value, ...semanticHints.value];
  return localHints.value;
});
const formulaExplanation = computed(() => {
  const option = operatorOptions.find((item) => item.value === form.operator);
  if (!form.inputA) return "选择输入指标后，这里会显示自然语言公式和服务端推导结果。";
  if (formulaPreview.value?.formulaDescription)
    return formulaPreview.value.formulaDescription;
  return option?.label ?? form.operator;
});

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

function categoryLabel(category: Category): string {
  return {
    usage: "使用情况",
    operation: "业务操作",
    performance: "性能",
    stability: "稳定性",
    organization: "组织维度",
  }[category];
}

function scopeLabel(scope: string): string {
  return (
    { project: "项目", module: "功能模块", page: "页面", workflow: "工作流" }[scope] ??
    scope
  );
}

function granularityLabel(granularity: string): string {
  return (
    { "5m": "5 分钟", hour: "小时", day: "天", week: "周", month: "月" }[granularity] ??
    granularity
  );
}

function formulaErrorMessage(code: string, details?: Record<string, unknown>): string {
  const inferred = String(details?.inferred ?? "公式推导单位");
  const declared = String(details?.declared ?? "所填单位");
  const messages: Record<string, string> = {
    FORMULA_OUTPUT_UNIT_MISMATCH: `当前公式输出单位为 ${inferred}，不能声明为 ${declared}。`,
    FORMULA_UNIT_INCOMPATIBLE: "输入指标单位不兼容，请更换输入或运算方式。",
    FORMULA_SCOPE_INCOMPATIBLE: "输入指标不支持当前适用对象。",
    FORMULA_GRANULARITY_INCOMPATIBLE: "输入指标不支持当前时间粒度。",
    FORMULA_MINIMUM_SAMPLE_TOO_LOW: `最小有效样本数至少为 ${String(details?.required ?? "依赖要求")}。`,
    FORMULA_DEPENDENCY_MISSING: `找不到依赖指标 ${String(details?.metricKey ?? "")}。`,
    FORMULA_DEPENDENCY_CYCLE: "当前公式会形成循环依赖。",
    FORMULA_TARGET_INVALID: "目标值顺序无效，请检查下界、目标和上界。",
    FORMULA_INPUT_REQUIRED: "公式至少需要一个已注册输入指标。",
  };
  return messages[code] ?? `服务端校验未通过：${code}`;
}

function apiMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    const details =
      cause.details && typeof cause.details === "object"
        ? (cause.details as Record<string, unknown>)
        : undefined;
    const message = cause.code.startsWith("FORMULA_")
      ? formulaErrorMessage(cause.code, details)
      : cause.message && cause.message !== cause.code
        ? cause.message
        : cause.code;
    return `${message}${cause.requestId ? ` · 请求 ${cause.requestId}` : ""}`;
  }
  return cause instanceof Error ? cause.message : "请求失败";
}

async function load(): Promise<void> {
  const sequence = ++loadSequence;
  if (!props.projectId) return;
  loading.value = true;
  error.value = null;
  try {
    const type = libraryType.value;
    const types: LibraryType[] = props.versionsOnly
      ? ["operational", "quality"]
      : [type];
    const [catalogResult, versionResult] = await Promise.all([
      api.request<CatalogResponse>(
        `/api/projects/${props.projectId}/metrics/catalog?type=${type}`,
      ),
      Promise.all(
        types.map((versionType) =>
          api.request<Version[]>(
            `/api/projects/${props.projectId}/metrics/versions?type=${versionType}`,
          ),
        ),
      ),
    ]);
    if (sequence !== loadSequence) return;
    catalog.value = catalogResult;
    versions.value = versionResult.flat();
    selectVisibleVersion();
    await loadVersion();
  } catch (cause) {
    if (sequence === loadSequence) error.value = apiMessage(cause);
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

function selectVisibleVersion(): void {
  if (visibleVersions.value.some((item) => item.id === selectedVersionId.value)) return;
  selectedVersionId.value =
    visibleVersions.value.find((item) => item.status === "draft")?.id ??
    visibleVersions.value.find((item) => item.status === "active")?.id ??
    visibleVersions.value[0]?.id ??
    "";
}

async function loadVersion(): Promise<void> {
  const sequence = ++snapshotSequence;
  validation.value = null;
  diff.value = null;
  impact.value = null;
  if (!selectedVersionId.value) {
    snapshot.value = null;
    return;
  }
  snapshot.value = null;
  try {
    const result = await api.request<VersionResponse>(
      `/api/projects/${props.projectId}/metrics/versions/${selectedVersionId.value}`,
    );
    if (sequence === snapshotSequence) snapshot.value = result;
  } catch (cause) {
    if (sequence === snapshotSequence) error.value = apiMessage(cause);
  }
}

async function createDraft(sourceVersionId?: string): Promise<void> {
  if (selectedVersion.value?.status === "draft") {
    showMessage({
      type: "success",
      message: `已进入 v${selectedVersion.value.version} 工作草稿；继续保存不会增加版本号`,
    });
    return;
  }
  saving.value = true;
  try {
    const created = await api.request<Version>(
      `/api/projects/${props.projectId}/metrics/versions`,
      {
        method: "POST",
        body: JSON.stringify({
          type: selectedVersion.value?.libraryType ?? libraryType.value,
          sourceVersionId: sourceVersionId ?? null,
        }),
      },
    );
    selectedVersionId.value = created.id;
    showMessage({
      type: "success",
      message: `已进入 v${created.version} 工作草稿；草稿内可多次保存`,
    });
    await load();
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === "METRIC_LIBRARY_DRAFT_EXISTS") {
      const details = cause.details as { draftId?: string; draftVersion?: number };
      if (details?.draftId) {
        selectedVersionId.value = details.draftId;
        await loadVersion();
        showMessage({
          type: "warning",
          message: `已有 v${details.draftVersion ?? ""} 工作草稿，已为你切换；请先完成或废弃它`,
        });
        return;
      }
    }
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

const scoreRoute = useRoute();
const scoreRouter = useRouter();
async function activate(version: Version): Promise<void> {
  try {
    const score = await api.request<{ score: unknown }>(
      `/api/projects/${props.projectId}/score-management/versions/${version.id}`,
    );
    if (score.score) {
      await scoreRouter.push({
        query: {
          ...scoreRoute.query,
          tab: "scores",
          scoreType: version.libraryType,
          scoreVersion: version.id,
        },
      });
      return;
    }
    const [diffResult, impactResult] = await Promise.all([
      api.request<MetricDiff>(
        `/api/projects/${props.projectId}/metrics/versions/${version.id}/diff`,
      ),
      api.request<MetricImpact>(
        `/api/projects/${props.projectId}/metrics/versions/${version.id}/impact`,
      ),
    ]);
    await ElMessageBox.confirm(
      `即将激活${version.libraryType === "quality" ? "质量" : "运营"}指标 v${version.version}。当前已激活版本将变为“已取代”，历史快照不会被修改。\n${diffSummary(diffResult)}\n${impactSummary(impactResult)}`,
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

function versionSourceLabel(version: Version): string {
  if (!version.sourceVersionId) return "系统基线";
  const source = versions.value.find((item) => item.id === version.sourceVersionId);
  return source ? `复制自 v${source.version}` : "复制自历史快照";
}

function diffSummary(value: MetricDiff): string {
  return `变更：新增 ${value.added.length}、删除 ${value.removed.length}、修改 ${value.changed.length}`;
}

function impactSummary(value: MetricImpact): string {
  return `影响：下游指标 ${value.downstreamMetrics.length}、展示位置 ${value.displayBindings.length}、分数引用 ${value.scoreReferences.length}`;
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
    api.request<MetricDiff>(
      `/api/projects/${props.projectId}/metrics/versions/${version.id}/diff`,
    ),
    api.request<MetricImpact>(
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
    lineage.value = await api.request<MetricLineage>(
      `/api/projects/${props.projectId}/metrics/versions/${selectedVersionId.value}/lineage/${item.metricKey}`,
    );
    lineageOpen.value = true;
  } catch (cause) {
    showMessage({ type: "error", message: apiMessage(cause) });
  }
}

function resetEditor(): void {
  editingMetricKey.value = null;
  editorStep.value = 0;
  editorAttempted.value = false;
  keyTouched.value = false;
  formulaPreview.value = null;
  Object.assign(form, {
    metricKey: "",
    displayName: "",
    businessDescription: "",
    category: categoryOptions.value[0],
    inputA: "",
    inputB: "",
    operandBType: "metric",
    scalarOperand: 1,
    operator: "/",
    scalarA: 0,
    scalarB: 100,
    targetMin: 40,
    targetMax: 60,
    weightA: 1,
    weightB: 1,
    direction: "higher_better",
    unit: "",
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
    const right = ast.right as Record<string, unknown>;
    if (right.type === "literal") {
      form.operandBType = "scalar";
      form.scalarOperand = Number(right.value ?? 1);
    } else {
      form.operandBType = "metric";
      form.inputB = String(right.metricKey ?? "");
    }
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
    form.targetMin = target.targetMin ?? 40;
    form.targetMax = target.targetMax ?? 60;
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
  const right =
    ["*", "/"].includes(form.operator) && form.operandBType === "scalar"
      ? { type: "literal", value: form.scalarOperand }
      : metricNode(form.inputB);
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
            targetMin: form.targetMin,
            targetMax: form.targetMax,
            toleranceMax: form.scalarB,
          };
  return { type: "normalize", direction: form.direction, input: left, target };
}

function canPreviewFormula(): boolean {
  return Boolean(
    editorOpen.value &&
    selectedVersion.value &&
    /^[a-z][a-z0-9_]{2,63}$/.test(form.metricKey) &&
    form.displayName.trim() &&
    form.businessDescription.trim() &&
    form.inputA &&
    (!needsMetricB.value || form.inputB) &&
    compatibleScopes.value.includes(form.entityScope) &&
    compatibleGranularities.value.includes(form.timeGranularity),
  );
}

async function previewFormula(): Promise<void> {
  if (!canPreviewFormula() || !selectedVersion.value) {
    formulaPreview.value = null;
    form.unit = "";
    return;
  }
  const sequence = ++previewSequence;
  previewing.value = true;
  try {
    const result = await api.request<FormulaPreview>(
      `/api/projects/${props.projectId}/metrics/versions/${selectedVersion.value.id}/definitions/preview`,
      {
        method: "POST",
        body: JSON.stringify({
          metricKey: form.metricKey,
          displayName: form.displayName,
          businessDescription: form.businessDescription,
          category: form.category,
          numeratorDescription: form.numeratorDescription || null,
          denominatorDescription: form.denominatorDescription || null,
          deduplicationKey: form.deduplicationKey,
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
    if (sequence !== previewSequence) return;
    formulaPreview.value = result;
    form.unit = result.inferredUnit ?? "";
    if (
      result.requiredMinimumSample !== null &&
      form.minimumSample < result.requiredMinimumSample
    ) {
      form.minimumSample = result.requiredMinimumSample;
    }
  } catch (cause) {
    if (sequence !== previewSequence) return;
    const details =
      cause instanceof ApiError && cause.details && typeof cause.details === "object"
        ? (cause.details as Record<string, unknown>)
        : undefined;
    formulaPreview.value = {
      valid: false,
      inferredUnit: null,
      requiredMinimumSample: null,
      dependencies: [],
      nodeCount: null,
      depth: null,
      formulaDescription: null,
      implementationStatus: null,
      errors: [
        {
          code: cause instanceof ApiError ? cause.code : "FORMULA_PREVIEW_FAILED",
          path: String(details?.path ?? "$"),
          ...(details ? { details } : {}),
        },
      ],
    };
  } finally {
    if (sequence === previewSequence) previewing.value = false;
  }
}

function scheduleFormulaPreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  ++previewSequence;
  previewing.value = false;
  formulaPreview.value = null;
  previewTimer = setTimeout(() => void previewFormula(), 250);
}

function nextEditorStep(): void {
  editorAttempted.value = true;
  if (editorStep.value === 0 && basicHints.value.length) return;
  if (editorStep.value === 1) {
    if (formulaHints.value.length || previewing.value || !formulaPreview.value?.valid)
      return;
  }
  if (editorStep.value === 2 && activeStepHints.value.length) return;
  editorAttempted.value = false;
  editorStep.value = Math.min(3, editorStep.value + 1);
}

function previousEditorStep(): void {
  editorAttempted.value = false;
  editorStep.value = Math.max(0, editorStep.value - 1);
}

async function saveMetric(): Promise<void> {
  editorAttempted.value = true;
  if (
    localHints.value.length ||
    !selectedVersion.value ||
    !formulaPreview.value?.valid ||
    !form.unit
  )
    return;
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
    showMessage({
      type: "success",
      message: `业务指标已保存到 v${result.version.version} 草稿；继续编辑不会增加版本号`,
    });
    await load();
    validation.value = result.validation;
  } catch (cause) {
    showMessage({ type: "error", message: apiMessage(cause) });
  } finally {
    saving.value = false;
  }
}

watch(
  () => [props.projectId, props.initialType, props.versionsOnly],
  () => {
    libraryType.value = props.initialType;
    versionFilter.value = "all";
    selectedVersionId.value = "";
    versions.value = [];
    catalog.value = null;
    snapshot.value = null;
    ++snapshotSequence;
    editorOpen.value = false;
    void load();
  },
  { immediate: true },
);
watch(versionFilter, selectVisibleVersion);
watch(selectedVersionId, () => void loadVersion());
watch(
  () => [
    editorOpen.value,
    form.metricKey,
    form.displayName,
    form.businessDescription,
    form.category,
    form.inputA,
    form.inputB,
    form.operandBType,
    form.scalarOperand,
    form.operator,
    form.scalarA,
    form.scalarB,
    form.targetMin,
    form.targetMax,
    form.weightA,
    form.weightB,
    form.direction,
    form.entityScope,
    form.timeGranularity,
    form.minimumSample,
  ],
  () => {
    if (
      compatibleScopes.value.length &&
      !compatibleScopes.value.includes(form.entityScope)
    )
      form.entityScope = compatibleScopes.value[0]!;
    if (
      compatibleGranularities.value.length &&
      !compatibleGranularities.value.includes(form.timeGranularity)
    )
      form.timeGranularity = compatibleGranularities.value[0]!;
    scheduleFormulaPreview();
  },
);
onBeforeUnmount(() => {
  ++loadSequence;
  ++snapshotSequence;
  if (previewTimer) clearTimeout(previewTimer);
});
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
      <el-select
        v-if="versionsOnly"
        v-model="versionFilter"
        data-testid="version-type-filter"
        aria-label="版本类型"
        style="width: 150px"
      >
        <el-option label="全部类型" value="all" />
        <el-option label="运营" value="operational" />
        <el-option label="质量" value="quality" />
      </el-select>
      <el-select
        v-model="selectedVersionId"
        data-testid="version-selector"
        aria-label="选择版本"
        placeholder="选择版本"
        style="width: 210px"
      >
        <el-option
          v-for="version in visibleVersions"
          :key="version.id"
          :value="version.id"
          :label="`${version.libraryType === 'quality' ? '质量' : '运营'} v${version.version} · ${versionStatusLabel(version.status)}`"
        />
      </el-select>
      <el-button :loading="loading" @click="load">刷新</el-button>
      <el-button
        v-if="canWrite && selectedVersion && selectedVersion.status !== 'abandoned'"
        type="primary"
        :loading="saving"
        @click="createDraft(selectedVersion?.id)"
        >{{
          selectedVersion?.status === "draft"
            ? `继续编辑 v${selectedVersion.version} 草稿`
            : `从 v${selectedVersion?.version ?? 1} 创建工作草稿`
        }}</el-button
      >
    </div>
    <el-alert
      v-if="selectedVersion"
      type="info"
      :closable="false"
      show-icon
      :title="versionContext"
    />

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
      <el-table
        :data="visibleVersions"
        data-testid="metric-versions"
        row-key="id"
        size="small"
      >
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
            versionSourceLabel(row)
          }}</template></el-table-column
        >
        <el-table-column prop="updatedAt" label="最后更新时间" min-width="190" />
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
        <section v-if="diff" class="read-model-card" data-testid="metric-diff">
          <h3>版本变更</h3>
          <p>{{ diffSummary(diff) }}</p>
          <dl>
            <template v-if="diff.added.length"
              ><dt>新增</dt>
              <dd>{{ diff.added.join("、") }}</dd></template
            >
            <template v-if="diff.removed.length"
              ><dt>删除</dt>
              <dd>{{ diff.removed.join("、") }}</dd></template
            >
            <template v-for="item in diff.changed" :key="item.metricKey"
              ><dt>{{ item.metricKey }}</dt>
              <dd>修改：{{ item.fields.join("、") }}</dd></template
            >
          </dl>
        </section>
        <section v-if="impact" class="read-model-card" data-testid="metric-impact">
          <h3>影响范围</h3>
          <p>{{ impactSummary(impact) }}</p>
          <dl>
            <dt>下游指标</dt>
            <dd>{{ impact.downstreamMetrics.join("、") || "无" }}</dd>
            <dt>展示位置</dt>
            <dd>
              {{
                impact.displayBindings
                  .map((item) => `${item.routeName} / ${item.surfaceKey}`)
                  .join("、") || "无"
              }}
            </dd>
            <dt>分数引用</dt>
            <dd>
              {{
                impact.scoreReferences.map((item) => item.scoreKey).join("、") || "无"
              }}
            </dd>
          </dl>
        </section>
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

    <MetricDefinitionDrawer v-model="definitionOpen" :item="definitionItem" />
    <MetricLineageDrawer v-model="lineageOpen" :lineage="lineage" />

    <el-dialog
      v-model="editorOpen"
      :title="editingMetricKey ? '编辑业务指标（保存到草稿）' : '语义化业务指标编辑器'"
      width="min(920px, 96vw)"
      destroy-on-close
      align-center
    >
      <el-alert
        type="info"
        :closable="false"
        title="编辑器不会保存 SQL、代码、任意字段或任意函数。页面只做即时提示，保存和激活以服务端校验为准。"
      />
      <el-steps :active="editorStep" finish-status="success" class="editor-steps">
        <el-step title="基本信息" />
        <el-step title="构建公式" />
        <el-step title="口径规则" />
        <el-step title="检查保存" />
      </el-steps>

      <el-form label-position="top" class="formula-form">
        <section v-if="editorStep === 0" class="wizard-section">
          <div class="wizard-intro">
            <h3>先说明这个指标解决什么业务问题</h3>
            <p>
              key 用于 API 和版本引用，保存后不能改名；中文名和业务说明用于页面解释。
            </p>
          </div>
          <div class="wizard-grid">
            <el-form-item label="指标 key">
              <el-input
                v-model="form.metricKey"
                :disabled="Boolean(editingMetricKey)"
                placeholder="例如 pages_per_visit"
                @blur="keyTouched = true"
              />
            </el-form-item>
            <el-form-item label="中文名">
              <el-input
                v-model="form.displayName"
                placeholder="例如 单次会话浏览页数"
              />
            </el-form-item>
            <el-form-item label="业务说明" class="full-width">
              <el-input
                v-model="form.businessDescription"
                type="textarea"
                :rows="3"
                placeholder="例如：衡量一次会话平均浏览多少个页面。"
              />
            </el-form-item>
            <el-form-item label="分类">
              <el-select v-model="form.category">
                <el-option
                  v-for="item in categoryOptions"
                  :key="item"
                  :label="categoryLabel(item)"
                  :value="item"
                />
              </el-select>
            </el-form-item>
          </div>
        </section>

        <section v-else-if="editorStep === 1" class="wizard-section">
          <div class="wizard-intro">
            <h3>从已注册指标构建受控公式</h3>
            <p>输入指标的单位、适用对象和时间粒度会参与服务端权威校验。</p>
          </div>
          <div class="formula-preview-card">
            <span>公式预览</span>
            <strong>{{ formulaExplanation }}</strong>
            <small v-if="previewing">正在调用服务端校验…</small>
          </div>
          <div class="wizard-grid">
            <el-form-item label="输入指标 A">
              <el-select
                v-model="form.inputA"
                filterable
                placeholder="搜索 key 或中文名"
              >
                <el-option
                  v-for="item in inputOptions"
                  :key="item.metricKey"
                  :label="`${item.metricKey} · ${item.displayName} · ${statusLabel(item.implementationStatus)}`"
                  :value="item.metricKey"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="运算方式">
              <el-select v-model="form.operator">
                <el-option
                  v-for="item in operatorOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
            </el-form-item>

            <template v-if="['*', '/'].includes(form.operator)">
              <el-form-item label="第二个操作数类型">
                <el-radio-group v-model="form.operandBType">
                  <el-radio-button value="metric">指标</el-radio-button>
                  <el-radio-button value="scalar">固定系数</el-radio-button>
                </el-radio-group>
              </el-form-item>
              <el-form-item v-if="form.operandBType === 'scalar'" label="固定系数">
                <el-input-number v-model="form.scalarOperand" />
              </el-form-item>
            </template>

            <el-form-item v-if="needsMetricB" label="输入指标 B">
              <el-select
                v-model="form.inputB"
                filterable
                placeholder="搜索 key 或中文名"
              >
                <el-option
                  v-for="item in inputOptions"
                  :key="item.metricKey"
                  :label="`${item.metricKey} · ${item.displayName} · ${statusLabel(item.implementationStatus)}`"
                  :value="item.metricKey"
                />
              </el-select>
            </el-form-item>

            <template v-if="form.operator === 'clamp'">
              <el-form-item label="下限"
                ><el-input-number v-model="form.scalarA"
              /></el-form-item>
              <el-form-item label="上限"
                ><el-input-number v-model="form.scalarB"
              /></el-form-item>
            </template>

            <template v-if="form.operator === 'normalize'">
              <el-form-item label="目标方向">
                <el-select v-model="form.direction">
                  <el-option label="越高越好" value="higher_better" />
                  <el-option label="越低越好" value="lower_better" />
                  <el-option label="目标区间" value="target_range" />
                </el-select>
              </el-form-item>
              <template v-if="form.direction === 'higher_better'">
                <el-form-item label="零分下界"
                  ><el-input-number v-model="form.scalarA"
                /></el-form-item>
                <el-form-item label="满分目标"
                  ><el-input-number v-model="form.scalarB"
                /></el-form-item>
              </template>
              <template v-else-if="form.direction === 'lower_better'">
                <el-form-item label="满分目标"
                  ><el-input-number v-model="form.scalarA"
                /></el-form-item>
                <el-form-item label="零分上界"
                  ><el-input-number v-model="form.scalarB"
                /></el-form-item>
              </template>
              <template v-else>
                <el-form-item label="容忍下界"
                  ><el-input-number v-model="form.scalarA"
                /></el-form-item>
                <el-form-item label="目标区间下界"
                  ><el-input-number v-model="form.targetMin"
                /></el-form-item>
                <el-form-item label="目标区间上界"
                  ><el-input-number v-model="form.targetMax"
                /></el-form-item>
                <el-form-item label="容忍上界"
                  ><el-input-number v-model="form.scalarB"
                /></el-form-item>
              </template>
            </template>

            <template v-if="form.operator === 'weighted_mean'">
              <el-form-item label="A 权重"
                ><el-input-number v-model="form.weightA" :min="0.001"
              /></el-form-item>
              <el-form-item label="B 权重"
                ><el-input-number v-model="form.weightB" :min="0.001"
              /></el-form-item>
            </template>
          </div>
          <el-alert
            v-if="
              selectedInputs.some(
                (item) => item.implementationStatus === 'not_collected',
              )
            "
            type="warning"
            :closable="false"
            show-icon
            title="所选输入包含未采集指标：可以保存定义，但在依赖能力交付前不会产生伪造数据，也不能加入激活展示或分数。"
          />
        </section>

        <section v-else-if="editorStep === 2" class="wizard-section">
          <div class="wizard-intro">
            <h3>确认输出口径与缺失规则</h3>
            <p>输出单位由服务端公式规则推导，不能手工改成不兼容单位。</p>
          </div>
          <div class="wizard-grid">
            <el-form-item label="输出单位（服务端推导）">
              <el-input :model-value="form.unit || '等待公式校验'" readonly />
            </el-form-item>
            <el-form-item label="最小有效样本数">
              <el-input-number v-model="form.minimumSample" :min="0" />
              <small v-if="formulaPreview?.requiredMinimumSample !== null">
                依赖要求至少 {{ formulaPreview?.requiredMinimumSample }}
              </small>
            </el-form-item>
            <el-form-item label="适用对象">
              <el-select v-model="form.entityScope">
                <el-option
                  v-for="item in compatibleScopes"
                  :key="item"
                  :value="item"
                  :label="scopeLabel(item)"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="时间粒度">
              <el-select v-model="form.timeGranularity">
                <el-option
                  v-for="item in compatibleGranularities"
                  :key="item"
                  :value="item"
                  :label="granularityLabel(item)"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="分子说明"
              ><el-input v-model="form.numeratorDescription"
            /></el-form-item>
            <el-form-item label="分母说明"
              ><el-input v-model="form.denominatorDescription"
            /></el-form-item>
          </div>
          <el-collapse class="advanced-settings">
            <el-collapse-item title="高级治理字段" name="governance">
              <div class="wizard-grid">
                <el-form-item label="去重键"
                  ><el-input v-model="form.deduplicationKey"
                /></el-form-item>
                <el-form-item label="口径负责人"
                  ><el-input v-model="form.owner"
                /></el-form-item>
                <el-form-item label="数据缺失规则" class="full-width">
                  <el-input v-model="form.missingPolicy" type="textarea" :rows="3" />
                </el-form-item>
              </div>
            </el-collapse-item>
          </el-collapse>
        </section>

        <section v-else class="wizard-section">
          <div class="wizard-intro">
            <h3>检查定义并保存到工作草稿</h3>
            <p>{{ versionContext }}</p>
          </div>
          <dl class="review-list">
            <div>
              <dt>指标</dt>
              <dd>{{ form.metricKey }} · {{ form.displayName }}</dd>
            </div>
            <div>
              <dt>业务问题</dt>
              <dd>{{ form.businessDescription }}</dd>
            </div>
            <div>
              <dt>公式</dt>
              <dd>
                <code>{{ formulaExplanation }}</code>
              </dd>
            </div>
            <div>
              <dt>输出单位</dt>
              <dd>{{ form.unit }}</dd>
            </div>
            <div>
              <dt>适用范围</dt>
              <dd>
                {{ scopeLabel(form.entityScope) }} ·
                {{ granularityLabel(form.timeGranularity) }}
              </dd>
            </div>
            <div>
              <dt>最小样本</dt>
              <dd>{{ form.minimumSample }}</dd>
            </div>
            <div>
              <dt>依赖</dt>
              <dd>{{ formulaPreview?.dependencies.join("、") || "等待校验" }}</dd>
            </div>
            <div>
              <dt>预计实施状态</dt>
              <dd>
                {{
                  formulaPreview?.implementationStatus
                    ? statusLabel(formulaPreview.implementationStatus)
                    : "等待校验"
                }}
              </dd>
            </div>
          </dl>
          <el-alert
            :type="formulaPreview?.valid ? 'success' : 'warning'"
            :closable="false"
            show-icon
            :title="
              formulaPreview?.valid
                ? `服务端预校验通过 · ${formulaPreview.nodeCount} 个节点 · 深度 ${formulaPreview.depth}`
                : '服务端预校验尚未通过'
            "
          />
        </section>
      </el-form>
      <el-alert
        v-if="activeStepHints.length"
        type="warning"
        :closable="false"
        show-icon
        :title="activeStepHints.join('；')"
      />
      <template #footer
        ><div class="editor-footer">
          <el-button @click="editorOpen = false">取消</el-button>
          <div>
            <el-button v-if="editorStep > 0" @click="previousEditorStep"
              >上一步</el-button
            >
            <el-button
              v-if="editorStep < 3"
              type="primary"
              :loading="previewing && editorStep === 1"
              @click="nextEditorStep"
              >下一步</el-button
            >
            <el-button v-else type="primary" :loading="saving" @click="saveMetric"
              >保存到工作草稿</el-button
            >
          </div>
        </div></template
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
.read-model-card {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--border-color, #e4e7ed);
  border-radius: 8px;
  background: var(--surface-muted, #f7f8fa);
}
.read-model-card h3,
.read-model-card p {
  margin: 0 0 8px;
}
.read-model-card dl,
.review-list {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 8px 12px;
  margin: 0;
}
.read-model-card dt,
.review-list dt {
  font-weight: 600;
}
.read-model-card dd,
.review-list dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.formula-form {
  margin-top: 16px;
}
.editor-steps {
  margin-top: 16px;
}
.wizard-section {
  display: grid;
  gap: 14px;
  min-height: 360px;
}
.wizard-intro h3,
.wizard-intro p {
  margin: 0 0 6px;
}
.wizard-intro p,
.formula-preview-card span,
.formula-preview-card small {
  color: var(--text-muted, #667085);
}
.wizard-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}
.wizard-grid > * {
  min-width: 0;
}
.wizard-grid .full-width {
  grid-column: 1 / -1;
}
.formula-preview-card {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid #bfdbfe;
  border-radius: 10px;
  background: #eff6ff;
}
.formula-preview-card strong {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}
.advanced-settings {
  border-top: 0;
}
.review-list {
  padding: 14px;
  border: 1px solid var(--border-color, #e4e7ed);
  border-radius: 10px;
}
.review-list > div {
  display: contents;
}
.review-list code {
  overflow-wrap: anywhere;
}
.editor-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.editor-footer > div {
  display: flex;
  gap: 10px;
}
@media (max-width: 760px) {
  .read-models,
  .wizard-grid {
    grid-template-columns: 1fr;
  }
  .wizard-grid .full-width {
    grid-column: auto;
  }
  .section-heading {
    display: grid;
  }
  .editor-steps :deep(.el-step__title) {
    font-size: 12px;
  }
}
</style>
