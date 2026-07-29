<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { auth } from "../auth";
import DataStatusBanner from "../components/DataStatusBanner.vue";
import OperationalRadar from "../components/OperationalRadar.vue";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import { useDashboardContext } from "../context";
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatScore,
} from "../range";
import { useRemoteData } from "../remote";
import type {
  MetricDefinition,
  MetricLineage,
  OperationalIndexResponse,
  OperationalMetricItemResult,
} from "../types";

const route = useRoute();
const router = useRouter();
const context = useDashboardContext();
const resource = useRemoteData<OperationalIndexResponse>();
const drawerOpen = ref(false);
const definitionLoading = ref(false);
const definition = ref<MetricDefinition | null>(null);
const lineage = ref<MetricLineage | null>(null);
const canWrite = computed(
  () =>
    auth.state.user?.globalRole === "admin" &&
    ["owner", "admin"].includes(context.project.value?.role ?? ""),
);
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
const leaves = computed(
  () =>
    resource.data.value?.index.dimensions.flatMap((dimension) =>
      dimension.items.map((item) => ({
        ...item,
        dimensionName: dimension.displayName,
      })),
    ) ?? [],
);

const reasonLabels: Record<string, string> = {
  DATA_DELAYED: "数据链路延迟，保留分项但不生成总分",
  DATA_BROKEN: "数据链路异常，不能把缺失事实视为 0",
  DATA_NO_DATA: "尚无可查询数据",
  ELIGIBLE_DIMENSIONS_BELOW_3: "可评分一级维度少于 3 个",
  WEIGHT_COVERAGE_BELOW_70_PERCENT: "可评分叶子权重覆盖不足 70%",
  METRIC_PROFILE_NOT_CONFIGURED: "尚未激活指标 profile",
};
const statusLabels: Record<string, string> = {
  available: "可评分",
  insufficient_sample: "样本不足",
  missing_target: "缺少目标",
  metric_not_available: "指标不可用",
  data_delayed: "数据延迟",
};

function targetLabel(item: OperationalMetricItemResult): string {
  const target = item.target;
  if (target.targetMin !== null && target.targetMax !== null) {
    return `${target.targetMin}–${target.targetMax}（容忍 ${target.toleranceMin ?? "—"}–${target.toleranceMax ?? "—"}）`;
  }
  if (target.targetValue !== null && target.floorValue !== null) {
    return `达标 ${target.targetValue} / 下界 ${target.floorValue}`;
  }
  if (target.targetValue !== null && target.ceilingValue !== null) {
    return `达标 ${target.targetValue} / 上界 ${target.ceilingValue}`;
  }
  if (target.targetValue !== null) return String(target.targetValue);
  return "未配置";
}

function rawLabel(item: OperationalMetricItemResult): string {
  if (item.rawValue === null) return "—";
  if (item.metricKey === "page_visible_duration_fit") {
    return formatPercent(item.rawValue);
  }
  if (
    item.metricKey.includes("rate") ||
    item.metricKey.includes("coverage") ||
    item.metricKey.includes("attainment") ||
    item.metricKey.includes("continuity")
  ) {
    return formatPercent(item.rawValue);
  }
  if (item.metricKey.includes("duration")) return formatDuration(item.rawValue);
  return formatNumber(item.rawValue);
}

async function load(): Promise<void> {
  if (!context.projectId.value || !context.search.value) return;
  await resource.load(() =>
    api.request<OperationalIndexResponse>(
      `/api/projects/${context.projectId.value}/operational-index?${context.search.value}`,
    ),
  );
}

async function openDefinition(metricKey: string): Promise<void> {
  if (!context.projectId.value) return;
  drawerOpen.value = true;
  definitionLoading.value = true;
  definition.value = null;
  lineage.value = null;
  try {
    [definition.value, lineage.value] = await Promise.all([
      api.request<MetricDefinition>(
        `/api/projects/${context.projectId.value}/metrics/${metricKey}/definition`,
      ),
      api.request<MetricLineage>(
        `/api/projects/${context.projectId.value}/metrics/${metricKey}/lineage`,
      ),
    ]);
  } finally {
    definitionLoading.value = false;
  }
}

watch(
  () => [context.projectId.value, context.search.value],
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <div>
    <PageHeader
      eyebrow="OPERATIONAL INDEX V1"
      title="项目运营指数"
      description="汇总使用覆盖、持续使用与访问深度、任务达成和使用效率；总分始终可以下钻到原始值。"
    >
      <el-button
        v-if="canWrite"
        plain
        @click="router.push({ name: 'operational-config', query: route.query })"
      >
        配置目标与权重
      </el-button>
      <el-button type="primary" @click="load">刷新数据</el-button>
    </PageHeader>

    <DataStatusBanner :status="resource.data.value?.dataStatus ?? null" />

    <StatePanel
      :state="viewState"
      title="项目运营指数暂不可用"
      :message="resource.error.value?.message"
      :request-id="resource.error.value?.requestId"
      @retry="load"
    >
      <template v-if="resource.data.value">
        <section class="index-hero panel">
          <div class="index-score">
            <span class="eyebrow">PROJECT OPERATIONAL INDEX</span>
            <strong>{{ formatScore(resource.data.value.index.value) }}</strong>
            <span>/ 100</span>
            <small v-if="resource.data.value.profile">
              {{ resource.data.value.profile.name }} · profile v{{
                resource.data.value.profile.version
              }}
            </small>
            <small v-else>尚未激活 profile</small>
          </div>
          <div class="index-gates">
            <div>
              <span>可评分维度</span>
              <strong>{{ resource.data.value.index.eligibleDimensions }} / 4</strong>
              <small>至少需要 3 个</small>
            </div>
            <div>
              <span>叶子权重覆盖</span>
              <strong>{{
                formatPercent(resource.data.value.index.weightCoverage)
              }}</strong>
              <small>至少需要 70%</small>
            </div>
            <div>
              <span>定义版本</span>
              <strong>{{ resource.data.value.index.definitionVersion }}</strong>
              <small>
                v2 数据起点：{{ resource.data.value.availableFrom ?? "尚无" }}
                ·
                {{
                  resource.data.value.availabilityStatus === "partial"
                    ? "范围部分可用"
                    : resource.data.value.availabilityStatus === "full"
                      ? "范围完整可用"
                      : "尚无 v2"
                }}
              </small>
            </div>
          </div>
        </section>

        <el-alert
          v-if="resource.data.value.configurationAvailabilityStatus === 'partial'"
          type="info"
          :closable="false"
          show-icon
          :title="`所选范围跨越配置或 profile 生效边界；指数仅使用 ${formatDateTime(resource.data.value.evaluationRange.from)} 之后、同一配置语义下的数据。`"
        />

        <el-alert
          v-if="resource.data.value.availabilityStatus === 'partial'"
          type="info"
          :closable="false"
          show-icon
          title="当前时间范围跨越 v1/v2 数据边界；任务实例、取消、近似放弃和耗时只计算边界后的数据。"
        />

        <el-alert
          v-if="resource.data.value.index.value === null"
          type="warning"
          :closable="false"
          show-icon
          title="当前不展示总分；已有原始指标与分项仍保留。"
        >
          <ul class="compact-list">
            <li v-for="reason in resource.data.value.index.reasons" :key="reason">
              {{ reasonLabels[reason] ?? reason }}
            </li>
          </ul>
        </el-alert>

        <section
          v-if="resource.data.value.index.dimensions.length"
          class="index-layout"
        >
          <article class="panel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">NORMALIZED DIMENSIONS</span>
                <h2>四维雷达</h2>
                <p>仅使用归一化后的 0–100 分，不混放原始单位。</p>
              </div>
            </div>
            <OperationalRadar :dimensions="resource.data.value.index.dimensions" />
          </article>

          <article class="panel">
            <div class="section-heading">
              <div>
                <span class="eyebrow">ACCESSIBLE EQUIVALENT</span>
                <h2>四维等价明细</h2>
                <p>本表与雷达使用同一后端读模型。</p>
              </div>
            </div>
            <el-table :data="resource.data.value.index.dimensions">
              <el-table-column prop="displayName" label="维度" min-width="170" />
              <el-table-column label="权重" width="90">
                <template #default="{ row }">
                  {{ formatPercent(row.weight) }}
                </template>
              </el-table-column>
              <el-table-column label="得分" width="90">
                <template #default="{ row }">
                  {{ formatScore(row.score) }}
                </template>
              </el-table-column>
              <el-table-column label="加权贡献" width="110">
                <template #default="{ row }">
                  {{ formatScore(row.contribution) }}
                </template>
              </el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="row.eligible ? 'success' : 'warning'">
                    {{ row.eligible ? "可评分" : "不可用" }}
                  </el-tag>
                </template>
              </el-table-column>
            </el-table>
          </article>
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">LEAF CONTRIBUTIONS</span>
              <h2>指数构成</h2>
              <p>缺失值不按 0 计分；样本、目标、权重和贡献全部可见。</p>
            </div>
          </div>
          <el-table :data="leaves" empty-text="尚未配置指标 profile">
            <el-table-column prop="dimensionName" label="维度" min-width="155" />
            <el-table-column label="指标" min-width="210">
              <template #default="{ row }">
                <button
                  type="button"
                  class="table-link"
                  @click="openDefinition(row.metricKey)"
                >
                  <strong>{{ row.displayName }}</strong>
                  <small>{{ row.metricKey }}</small>
                </button>
              </template>
            </el-table-column>
            <el-table-column label="原始值" width="125">
              <template #default="{ row }">{{ rawLabel(row) }}</template>
            </el-table-column>
            <el-table-column label="目标" min-width="220">
              <template #default="{ row }">{{ targetLabel(row) }}</template>
            </el-table-column>
            <el-table-column label="样本" width="90">
              <template #default="{ row }">
                {{ row.sampleSize ?? "—" }}
              </template>
            </el-table-column>
            <el-table-column label="得分" width="90">
              <template #default="{ row }">
                {{ formatScore(row.score) }}
              </template>
            </el-table-column>
            <el-table-column label="叶子权重" width="105">
              <template #default="{ row }">
                {{ formatPercent(row.leafConfiguredWeight) }}
              </template>
            </el-table-column>
            <el-table-column label="贡献" width="90">
              <template #default="{ row }">
                {{ formatScore(row.contribution) }}
              </template>
            </el-table-column>
            <el-table-column label="状态" min-width="160">
              <template #default="{ row }">
                <el-tag :type="row.status === 'available' ? 'success' : 'warning'">
                  {{ statusLabels[row.status] ?? row.status }}
                </el-tag>
                <small v-if="row.reason" class="cell-reason">
                  {{ row.reason }}
                </small>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section
          v-if="resource.data.value.configurationGaps.length"
          class="panel warning-panel"
        >
          <span class="eyebrow">CONFIGURATION GAPS</span>
          <h2>仍需补齐的配置</h2>
          <ul class="compact-list">
            <li v-for="gap in resource.data.value.configurationGaps" :key="gap">
              {{ gap }}
            </li>
          </ul>
        </section>
      </template>
    </StatePanel>

    <el-drawer v-model="drawerOpen" size="min(620px, 92vw)" title="指标定义与血缘">
      <el-skeleton v-if="definitionLoading" :rows="8" animated />
      <template v-else-if="definition">
        <section class="definition-block">
          <span class="eyebrow">{{ definition.metricKey }}</span>
          <h2>{{ definition.displayName }}</h2>
          <p>{{ definition.businessQuestion }}</p>
          <dl class="definition-list">
            <div>
              <dt>计算公式</dt>
              <dd>{{ definition.formulaDescription }}</dd>
            </div>
            <div>
              <dt>分母</dt>
              <dd>{{ definition.denominatorDescription }}</dd>
            </div>
            <div>
              <dt>去重键</dt>
              <dd>{{ definition.deduplicationKey }}</dd>
            </div>
            <div>
              <dt>缺失语义</dt>
              <dd>{{ definition.missingValuePolicy }}</dd>
            </div>
            <div>
              <dt>计分方向 / 最小样本</dt>
              <dd>
                {{ definition.scoreDirection }} /
                {{ definition.minimumSample }}
              </dd>
            </div>
            <div>
              <dt>版本 / 生效</dt>
              <dd>
                {{ definition.definitionVersion }} /
                {{ definition.effectiveFrom }}
              </dd>
            </div>
            <div>
              <dt>负责人</dt>
              <dd>{{ definition.owner }}</dd>
            </div>
          </dl>
        </section>
        <section v-if="lineage" class="definition-block">
          <h3>血缘 DAG（只读）</h3>
          <p>节点按事实、原子、派生和复合层区分；布局不参与计算。</p>
          <el-table :data="lineage.nodes" size="small">
            <el-table-column prop="label" label="节点" min-width="170" />
            <el-table-column prop="layer" label="层级" width="100" />
            <el-table-column prop="id" label="metricKey" min-width="210" />
          </el-table>
          <h4>依赖边</h4>
          <ul class="lineage-edges">
            <li v-for="edge in lineage.edges" :key="`${edge.from}-${edge.to}`">
              <code>{{ edge.from }}</code>
              <span aria-label="依赖到">→</span>
              <code>{{ edge.to }}</code>
            </li>
          </ul>
        </section>
      </template>
    </el-drawer>
  </div>
</template>
