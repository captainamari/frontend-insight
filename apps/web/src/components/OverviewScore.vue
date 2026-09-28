<script setup lang="ts">
import { computed } from "vue";
import type { OverviewScore } from "../overview-types";
import { entryReason } from "../project-entry";
const props = defineProps<{
  score: OverviewScore;
  label: string;
  selection: string[];
}>();
const emit = defineEmits<{ selection: [string[]]; explain: [] }>();
const dims = computed(() => props.score.result?.dimensions ?? []);
const chosen = computed(() => {
  const keys = props.selection.length
    ? props.selection
    : (props.score.result?.radar.map((d) => d.key) ?? []);
  return dims.value.filter((d) => keys.includes(d.key));
});
const invalidSelection = computed(
  () =>
    props.selection.length > 0 &&
    (new Set(props.selection).size !== props.selection.length ||
      props.selection.some((k) => !dims.value.some((d) => d.key === k))),
);
const point = (i: number, n: number) => {
  const angle = (Math.PI * 2 * i) / chosen.value.length - Math.PI / 2;
  return `${150 + ((100 * n) / 100) * Math.cos(angle)},${150 + ((100 * n) / 100) * Math.sin(angle)}`;
};
function select(key: string, checked: boolean) {
  const current = chosen.value.map((d) => d.key),
    next = checked ? [...current, key] : current.filter((k) => k !== key);
  emit("selection", next);
}
const show = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(2));
</script>
<template>
  <section class="overview-score panel" :aria-label="label">
    <h2>
      {{ label }}
      <strong :data-color="score.result?.color ?? 'gray'">{{
        show(score.result?.value)
      }}</strong>
    </h2>
    <p>
      {{
        score.version
          ? `v${score.version.version} · ${score.version.id}`
          : "缺少激活版本"
      }}
    </p>
    <p v-if="score.reason">{{ entryReason(score.reason) }}</p>
    <template v-if="score.result"
      ><p>
        {{ score.result.value === null ? "总分不可用" : "分数范围 0–100" }} ·
        {{ score.result.color }} · 可参与维度 {{ score.result.eligibleDimensions }}
      </p>
      <p v-if="score.result.reasons.length">
        {{ score.result.reasons.map(entryReason).join("；") }}
      </p>
      <svg
        v-if="chosen.length >= 3 && chosen.length <= 6 && !invalidSelection"
        viewBox="0 0 300 300"
        role="img"
        :aria-label="label + '维度雷达，0至100分，与下方表格一致'"
      >
        <polygon
          v-for="n in [25, 50, 75, 100]"
          :key="n"
          :points="chosen.map((_, i) => point(i, n)).join(' ')"
          fill="none"
          stroke="#cad5e1"
        />
        <polygon
          v-if="chosen.every((d) => d.score !== null)"
          :points="chosen.map((d, i) => point(i, d.score!)).join(' ')"
          fill="#2563eb22"
          stroke="#2563eb"
        />
        <g v-for="(d, i) in chosen" :key="d.key">
          <circle
            v-if="d.score !== null"
            :cx="point(i, d.score).split(',')[0]"
            :cy="point(i, d.score).split(',')[1]"
            r="4"
            fill="#2563eb"
          />
          <text
            :x="point(i, 119).split(',')[0]"
            :y="point(i, 119).split(',')[1]"
            text-anchor="middle"
            font-size="9"
          >
            {{ d.displayName }}
          </text>
        </g>
      </svg>
      <p v-else-if="dims.length < 3">实际定义不足3维，无法形成雷达；保留可得维度表。</p>
      <p v-else role="status">
        URL中的展示选择不适用于此版本，请选择3–6个实际维度或<button
          @click="emit('selection', [])"
        >
          恢复默认展示</button
        >。维度表与公式不受影响。
      </p>
      <table :aria-label="label + '维度等价表'">
        <thead>
          <tr>
            <th>维度</th>
            <th>分数</th>
            <th>实际贡献</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in dims" :key="d.key">
            <td>{{ d.displayName }}</td>
            <td>{{ show(d.score) }}</td>
            <td>{{ show(d.contribution) }}</td>
          </tr>
        </tbody>
      </table>
      <p>
        {{
          score.lowest
            ? `实际可判断最低维度：${score.lowest.displayName}（${show(score.lowest.score)}）`
            : "可用维度不足，无法判断最低维度。"
        }}
      </p>
      <details>
        <summary>雷达展示设置</summary>
        <p>只保存到当前URL，可分享；不改变公式、权重或激活版本。</p>
        <label v-for="d in dims" :key="d.key"
          ><input
            type="checkbox"
            :checked="chosen.some((c) => c.key === d.key)"
            :disabled="
              chosen.some((c) => c.key === d.key)
                ? chosen.length <= 3
                : chosen.length >= 6
            "
            @change="select(d.key, ($event.target as HTMLInputElement).checked)"
          />{{ d.displayName }}</label
        >
      </details>
      <button @click="emit('explain')">查看{{ label }}解释与血缘</button></template
    >
  </section>
</template>
<style scoped>
.overview-score {
  min-width: 0;
}
.overview-score h2 {
  display: flex;
  justify-content: space-between;
}
strong {
  font-size: 30px;
}
strong[data-color="green"] {
  color: #166534;
}
strong[data-color="yellow"] {
  color: #92400e;
}
strong[data-color="red"] {
  color: #991b1b;
}
svg {
  display: block;
  width: 280px;
  max-width: 100%;
  margin: auto;
}
p {
  font-size: 13px;
  color: #536477;
  overflow-wrap: anywhere;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  text-align: left;
  padding: 7px;
  border-bottom: 1px solid #e2e8f0;
}
label {
  display: inline-flex;
  gap: 4px;
  margin: 6px;
}
button {
  margin-top: 12px;
  padding: 8px 12px;
  border: 1px solid #becbd8;
  background: white;
  border-radius: 6px;
  color: #164970;
}
summary {
  cursor: pointer;
}
</style>
