<script setup lang="ts">
import { computed } from "vue";
import type { ScoreResult } from "../score-types";
const props = defineProps<{ result: ScoreResult; fixture?: boolean }>();
const show = (n: number | null | undefined) =>
  n == null ? "—" : Number(n.toFixed(6)).toString();
const point = (index: number, value: number) => {
  const angle = (2 * Math.PI * index) / props.result.radar.length - Math.PI / 2;
  return `${150 + 110 * (value / 100) * Math.cos(angle)},${150 + 110 * (value / 100) * Math.sin(angle)}`;
};
const polygon = computed(() =>
  props.result.radar.every((d) => d.value !== null)
    ? props.result.radar.map((d, i) => point(i, d.value!)).join(" ")
    : null,
);
</script>
<template>
  <section
    class="score-explanation"
    :data-source="fixture ? 'fixed_fixture' : 'project_query'"
  >
    <p v-if="fixture" class="notice">
      固定手算示例 · 合成输入 · 不代表真实项目，不写入项目历史
    </p>
    <h3>
      {{ result.displayName }}：<strong data-testid="score-value">{{
        show(result.value)
      }}</strong>
      {{ result.displayUnit === "percent" ? "%" : "分" }} ·
      {{ result.value === null ? "不可参与计算" : "可参与计算" }}
    </h3>
    <p>
      可参与维度 {{ result.eligibleDimensions }} · 叶子权重覆盖
      {{ show(result.coverage * 100) }}% · 配置状态
      {{ result.configurationStatus ?? "固定配置" }} · 事实状态 {{ result.status }}
    </p>
    <p v-if="result.reasons.length" role="status">{{ result.reasons.join("；") }}</p>
    <p>
      分数 {{ result.scoreKey }} · 项目 {{ result.context.projectId }} /
      {{ result.context.env }} / 范围 {{ result.context.scopeId }} /
      {{ result.context.timezone }} / {{ result.context.from }} —
      {{ result.context.to }}（结束不含）/
      {{ result.context.granularity }}
    </p>
    <p>
      指标集版本 {{ result.context.metricSetVersion }} · 定义版本
      {{ result.context.definitionVersion }} ·
      {{ result.mode === "historical_trial" ? "独立历史试算" : "当前查询" }} · 生效时间
      {{ result.effectiveAt ?? "尚未激活" }}
    </p>
    <svg
      viewBox="0 0 300 300"
      role="img"
      aria-label="维度分雷达，范围 0–100，与维度表一致"
    >
      <polygon
        v-for="level in [20, 40, 60, 80, 100]"
        :key="level"
        :points="result.radar.map((_, i) => point(i, level)).join(' ')"
        fill="none"
        stroke="#cbd5e1"
      />
      <line
        v-for="(_, i) in result.radar"
        :key="i"
        x1="150"
        y1="150"
        :x2="point(i, 100).split(',')[0]"
        :y2="point(i, 100).split(',')[1]"
        stroke="#cbd5e1"
      />
      <polygon v-if="polygon" :points="polygon" fill="#2563eb33" stroke="#2563eb" />
      <template v-for="(dim, i) in result.radar" :key="dim.key">
        <circle
          v-if="dim.value !== null"
          :cx="point(i, dim.value).split(',')[0]"
          :cy="point(i, dim.value).split(',')[1]"
          r="4"
          fill="#2563eb"
        />
        <text
          :x="point(i, 118).split(',')[0]"
          :y="point(i, 118).split(',')[1]"
          text-anchor="middle"
          font-size="8"
        >
          {{ dim.displayName }}
        </text>
      </template>
    </svg>
    <p v-if="!polygon">部分维度不可参与计算，雷达不将缺项画成 0。</p>
    <table aria-label="维度分等价表">
      <thead>
        <tr>
          <th>维度</th>
          <th>分数（0–100）</th>
          <th>配置权重</th>
          <th>实际贡献</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="dim in result.dimensions" :key="dim.key">
          <td>{{ dim.displayName }}</td>
          <td>{{ show(dim.score) }}</td>
          <td>{{ show(dim.weight * 100) }}%</td>
          <td>{{ show(dim.contribution) }}</td>
        </tr>
      </tbody>
    </table>
    <div class="scroll">
      <table aria-label="分数解释明细">
        <thead>
          <tr>
            <th>指标</th>
            <th>原始值 / 单位</th>
            <th>方向 / 目标</th>
            <th>总样本 / 有效 / 排除 / 最低样本</th>
            <th>得分</th>
            <th>配置权重 / 实际权重</th>
            <th>实际贡献</th>
            <th>计算状态及原因</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="dim in result.dimensions" :key="dim.key"
            ><tr v-for="leaf in dim.leaves" :key="leaf.key">
              <td>
                {{ leaf.metricKey }}<small>{{ leaf.definitionVersion }}</small>
              </td>
              <td>
                {{ show(leaf.rawValue) }} {{ leaf.unit
                }}<small
                  >分子 {{ show(leaf.numerator) }} / 分母
                  {{ show(leaf.denominator) }}</small
                >
              </td>
              <td>
                {{ leaf.direction }}<small>{{ JSON.stringify(leaf.target) }}</small>
              </td>
              <td>
                {{ show(leaf.totalSampleSize) }} / {{ show(leaf.sampleSize) }} /
                {{ show(leaf.excludedSampleSize) }} / {{ leaf.minimumSample }}
              </td>
              <td>{{ show(leaf.score) }}</td>
              <td>
                {{ show(leaf.configuredWeight * 100) }}% /
                {{
                  leaf.effectiveWeight === null
                    ? "—"
                    : show(leaf.effectiveWeight * 100) + "%"
                }}
              </td>
              <td>{{ show(leaf.contribution) }}</td>
              <td>
                {{ leaf.score === null ? "不可参与计算" : "可参与计算"
                }}<small>{{ leaf.status }} {{ leaf.reason }}</small>
              </td>
            </tr></template
          >
        </tbody>
      </table>
    </div>
    <p v-if="result.samples">
      总样本 {{ show(result.samples.total) }} / 有效 {{ show(result.samples.valid) }} /
      排除 {{ show(result.samples.excluded) }} / 未识别
      {{ show(result.samples.unidentified) }}。{{ result.samples.reason }}
    </p>
    <p v-if="result.observation">
      预期日期：{{ result.observation.expectedDates.join("、") || "无" }}；活跃日期
      {{ result.observation.activeDates?.join("、") ?? "未知" }}；分子
      {{ show(result.observation.numerator) }} / 分母
      {{ show(result.observation.denominator) }}。{{ result.observation.reason }}
    </p>
    <details v-if="result.definitionLineage?.length">
      <summary>定义依赖血缘与分子、分母</summary>
      <table>
        <thead>
          <tr>
            <th>指标 / 版本</th>
            <th>公式 / 分子 / 分母</th>
            <th>事实能力</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="metric in result.definitionLineage" :key="metric.metricKey">
            <td>
              {{ metric.displayName }} / {{ metric.metricKey
              }}<small>{{ metric.definitionVersion }}</small>
            </td>
            <td>
              {{ metric.formulaDescription
              }}<small
                >分子：{{ metric.numeratorDescription }}；分母：{{
                  metric.denominatorDescription
                }}</small
              >
            </td>
            <td>
              {{ metric.implementationStatus }} · {{ metric.milestone
              }}<small>{{ metric.unavailableReason }}</small>
            </td>
          </tr>
        </tbody>
      </table>
    </details>
    <details v-if="result.dependencySnapshot">
      <summary>分析对象、模板和样本策略快照</summary>
      <pre>{{ JSON.stringify(result.dependencySnapshot, null, 2) }}</pre>
    </details>
    <details v-if="result.activationPeriods">
      <summary>版本生效区间</summary>
      <p v-if="!result.activationPeriods.length">查询范围没有已记录的激活区间。</p>
      <p v-for="(p, i) in result.activationPeriods" :key="i">
        {{ p.versionId }}：{{ p.effectiveFrom }} — {{ p.effectiveTo ?? "当前" }}
      </p>
    </details>
  </section>
</template>
<style scoped>
.score-explanation {
  margin-top: 1rem;
  padding: 1rem;
  background: #fff;
  border: 1px solid #dbe3ec;
  border-radius: 8px;
}
svg {
  width: 300px;
  max-width: 100%;
  display: block;
  margin: auto;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
th,
td {
  text-align: left;
  padding: 8px;
  border-bottom: 1px solid #dbe3ec;
  vertical-align: top;
}
small {
  display: block;
  color: #536477;
}
p {
  overflow-wrap: anywhere;
}
pre {
  white-space: pre-wrap;
  max-height: 400px;
  overflow: auto;
  font-size: 12px;
}
.scroll {
  overflow: auto;
}
.notice {
  background: #fff3cd;
  padding: 10px;
}
details {
  margin-top: 12px;
}
summary {
  cursor: pointer;
}
</style>
