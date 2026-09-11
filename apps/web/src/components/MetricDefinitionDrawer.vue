<script setup lang="ts">
import { computed } from "vue";

type ImplementationStatus = "implemented" | "partial" | "not_collected";

interface MetricDefinition {
  metricKey: string;
  origin: "system" | "business";
  category: string;
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
  availableFrom: string | null;
  unavailableReason: string | null;
  milestone: string;
}

const props = defineProps<{
  modelValue: boolean;
  item: MetricDefinition | null;
}>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

const statusLabel = (status: ImplementationStatus): string =>
  status === "implemented" ? "已实现" : status === "partial" ? "部分实现" : "未采集";

const categoryLabel = (category: string): string =>
  ({
    usage: "使用情况",
    operation: "业务操作",
    performance: "性能",
    stability: "稳定性",
    organization: "组织维度",
  })[category] ?? category;

const scopeLabel = (scope: string): string =>
  ({ project: "项目", module: "功能模块", page: "页面", workflow: "工作流" })[scope] ??
  scope;

const granularityLabel = (granularity: string): string =>
  ({ "5m": "5 分钟", hour: "小时", day: "天", week: "周", month: "月" })[granularity] ??
  granularity;
</script>

<template>
  <el-drawer v-model="open" title="指标定义" size="min(720px, 96vw)">
    <article v-if="item" class="metric-definition" data-testid="metric-definition">
      <header class="definition-summary">
        <div>
          <span class="definition-key">{{ item.metricKey }}</span>
          <h2>{{ item.displayName }}</h2>
          <p>{{ item.businessDescription }}</p>
        </div>
        <el-tag
          :type="
            item.implementationStatus === 'implemented'
              ? 'success'
              : item.implementationStatus === 'partial'
                ? 'warning'
                : 'info'
          "
        >
          {{ statusLabel(item.implementationStatus) }}
        </el-tag>
      </header>

      <el-alert
        v-if="item.implementationStatus !== 'implemented'"
        :type="item.implementationStatus === 'partial' ? 'warning' : 'info'"
        :closable="false"
        show-icon
        :title="item.unavailableReason || '当前指标尚不能提供完整数据。'"
      />

      <section class="definition-section">
        <h3>计算口径</h3>
        <div class="formula-box">
          <span>公式</span>
          <code>{{ item.formulaDescription }}</code>
        </div>
        <dl class="definition-list">
          <div class="definition-row">
            <dt>分子</dt>
            <dd>{{ item.numeratorDescription || "不适用" }}</dd>
          </div>
          <div class="definition-row">
            <dt>分母</dt>
            <dd>{{ item.denominatorDescription || "不适用" }}</dd>
          </div>
          <div class="definition-row">
            <dt>去重键</dt>
            <dd>{{ item.deduplicationKey }}</dd>
          </div>
          <div class="definition-row">
            <dt>单位</dt>
            <dd>
              <el-tag effect="plain">{{ item.unit }}</el-tag>
            </dd>
          </div>
          <div class="definition-row">
            <dt>分位数</dt>
            <dd class="tag-list">
              <template v-if="item.percentiles.length">
                <el-tag v-for="value in item.percentiles" :key="value" effect="plain">
                  {{ value }}
                </el-tag>
              </template>
              <span v-else>不适用</span>
            </dd>
          </div>
          <div class="definition-row">
            <dt>上报/计算时机</dt>
            <dd>{{ item.reportingTiming }}</dd>
          </div>
        </dl>
      </section>

      <section class="definition-section">
        <h3>适用范围与数据规则</h3>
        <dl class="definition-list">
          <div class="definition-row">
            <dt>适用对象</dt>
            <dd class="tag-list">
              <el-tag v-for="value in item.entityScopes" :key="value" effect="plain">
                {{ scopeLabel(value) }}
              </el-tag>
            </dd>
          </div>
          <div class="definition-row">
            <dt>时间粒度</dt>
            <dd class="tag-list">
              <el-tag
                v-for="value in item.timeGranularities"
                :key="value"
                effect="plain"
              >
                {{ granularityLabel(value) }}
              </el-tag>
            </dd>
          </div>
          <div class="definition-row">
            <dt>最小有效样本数</dt>
            <dd>{{ item.minimumSample }}</dd>
          </div>
          <div class="definition-row">
            <dt>数据缺失规则</dt>
            <dd>{{ item.missingPolicy }}</dd>
          </div>
        </dl>
      </section>

      <section class="definition-section">
        <h3>治理与交付</h3>
        <dl class="definition-list">
          <div class="definition-row">
            <dt>来源</dt>
            <dd>{{ item.origin === "system" ? "系统只读指标" : "用户业务指标" }}</dd>
          </div>
          <div class="definition-row">
            <dt>分类</dt>
            <dd>{{ categoryLabel(item.category) }}</dd>
          </div>
          <div class="definition-row">
            <dt>口径负责人</dt>
            <dd>{{ item.owner }}</dd>
          </div>
          <div class="definition-row">
            <dt>定义版本</dt>
            <dd>{{ item.definitionVersion }}</dd>
          </div>
          <div class="definition-row">
            <dt>可用起点</dt>
            <dd>{{ item.availableFrom || "尚不可用" }}</dd>
          </div>
          <div class="definition-row">
            <dt>计划阶段</dt>
            <dd>{{ item.milestone }}</dd>
          </div>
        </dl>
      </section>
    </article>
  </el-drawer>
</template>

<style scoped>
.metric-definition {
  display: grid;
  gap: 20px;
  min-width: 0;
}
.definition-summary {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  min-width: 0;
}
.definition-summary > div {
  min-width: 0;
}
.definition-key {
  color: var(--text-muted, #667085);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}
.definition-summary h2 {
  margin: 6px 0;
}
.definition-summary p {
  margin: 0;
  line-height: 1.65;
}
.definition-section {
  min-width: 0;
}
.definition-section h3 {
  margin: 0 0 10px;
  font-size: 16px;
}
.formula-box {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--surface-muted, #f7f8fa);
}
.formula-box span {
  color: var(--text-muted, #667085);
  font-size: 13px;
}
.formula-box code {
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.definition-list {
  display: grid;
  margin: 0;
  border-top: 1px solid var(--border-color, #e4e7ed);
}
.definition-row {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 14px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border-color, #e4e7ed);
  min-width: 0;
}
.definition-row dt,
.definition-row dd {
  min-width: 0;
  overflow-wrap: anywhere;
}
.definition-row dt {
  color: var(--text-muted, #667085);
  font-weight: 600;
}
.definition-row dd {
  margin: 0;
  line-height: 1.6;
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
@media (max-width: 560px) {
  .definition-summary {
    display: grid;
  }
  .definition-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
