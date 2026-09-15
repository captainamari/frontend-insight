<script setup lang="ts">
import { computed } from "vue";
import type { OverviewResponse } from "../overview-types";
const props = defineProps<{ metrics: OverviewResponse["metrics"] }>();
const groups = computed(() => {
  const units = new Map<string, typeof props.metrics.cards>();
  for (const m of props.metrics.cards.filter((c) =>
    props.metrics.selected.includes(c.definition.metricKey),
  )) {
    const unit = m.definition.unit;
    units.set(unit, [...(units.get(unit) ?? []), m]);
  }
  return [...units].map(([unit, cards]) => ({ unit, cards }));
});
const colors = ["#1d4ed8", "#9d174d", "#0f766e", "#92400e"];
function paths(key: string, max: number, min: number) {
  const lines: string[] = [],
    buckets = props.metrics.trends;
  let points: string[] = [],
    segment: string | null = null;
  const flush = () => {
    if (points.length) lines.push(points.join(" "));
    points = [];
  };
  buckets.forEach((b, i) => {
    const v = b.metrics.find((m) => m.metricKey === key)?.value;
    if (v == null) {
      flush();
      return;
    }
    if (segment !== b.segment) {
      flush();
      segment = b.segment;
    }
    points.push(
      `${30 + (i / Math.max(1, buckets.length - 1)) * 690},${190 - (170 * (v - min)) / (max - min)}`,
    );
  });
  flush();
  return lines;
}
function maximum(keys: string[]) {
  return Math.max(
    1,
    ...props.metrics.trends.flatMap((b) =>
      b.metrics
        .filter((m) => keys.includes(m.metricKey) && m.value !== null)
        .map((m) => m.value!),
    ),
  );
}
function minimum(keys: string[]) {
  return Math.min(
    0,
    ...props.metrics.trends.flatMap((b) =>
      b.metrics
        .filter((m) => keys.includes(m.metricKey) && m.value !== null)
        .map((m) => m.value!),
    ),
  );
}
</script>
<template>
  <div v-for="g in groups" :key="g.unit" class="trend-group">
    <h3>{{ g.unit }}</h3>
    <p>
      <span
        v-for="(card, i) in g.cards"
        :key="card.definition.metricKey"
        :style="{ color: colors[i] }"
        >{{ i + 1 }}. {{ card.definition.displayName }}　</span
      >
    </p>
    <svg
      viewBox="0 0 760 225"
      role="img"
      :aria-label="g.unit + '非堆叠趋势，下方可展开等价数据表'"
    >
      <line x1="30" y1="190" x2="720" y2="190" stroke="#94a3b8" />
      <text x="0" y="22" font-size="12">
        {{ maximum(g.cards.map((c) => c.definition.metricKey)).toFixed(1) }}
      </text>
      <text x="8" y="193" font-size="12">
        {{ minimum(g.cards.map((c) => c.definition.metricKey)).toFixed(1) }}
      </text>
      <template v-for="(c, i) in g.cards" :key="c.definition.metricKey">
        <g
          v-for="(line, n) in paths(
            c.definition.metricKey,
            maximum(g.cards.map((c) => c.definition.metricKey)),
            minimum(g.cards.map((c) => c.definition.metricKey)),
          )"
          :key="n"
        >
          <polyline
            :points="line"
            fill="none"
            :stroke="colors[i]"
            :stroke-dasharray="i ? `${i * 3} 3` : undefined"
            stroke-width="2"
          />
          <circle
            v-for="point in line.split(' ')"
            :key="point"
            :cx="point.split(',')[0]"
            :cy="point.split(',')[1]"
            r="3"
            :fill="colors[i]"
          />
        </g>
      </template>
      <text x="30" y="218" font-size="12">{{ metrics.trends[0]?.localStart }}</text>
      <text x="720" y="218" text-anchor="end" font-size="12">
        {{ metrics.trends.at(-1)?.localStart }}
      </text>
    </svg>
    <p
      v-if="
        metrics.trends.every((b) =>
          b.metrics
            .filter((m) => g.cards.some((c) => c.definition.metricKey === m.metricKey))
            .every((m) => m.value === null),
        )
      "
    >
      该单位组无可绘制的可信数值。缺口为 null，不补零、不连线。
    </p>
    <details>
      <summary>{{ g.unit }} 趋势等价表与缺口原因</summary>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>本地桶</th>
              <th>实际瞬时窗口</th>
              <th>版本</th>
              <th v-for="c in g.cards" :key="c.definition.metricKey">
                {{ c.definition.displayName }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in metrics.trends" :key="b.from">
              <td>{{ b.localStart }}{{ b.partial ? "（部分桶）" : "" }}</td>
              <td>{{ b.from }} — {{ b.to }}</td>
              <td>
                {{ b.versionId ?? "无版本" }}<small>{{ b.reason }}</small>
              </td>
              <td v-for="c in g.cards" :key="c.definition.metricKey">
                {{
                  b.metrics.find((m) => m.metricKey === c.definition.metricKey)
                    ?.value ?? "—"
                }}<small>{{
                  b.metrics.find((m) => m.metricKey === c.definition.metricKey)?.reason
                }}</small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </div>
</template>
<style scoped>
svg {
  width: 100%;
  max-height: 260px;
}
.trend-group {
  border-top: 1px solid #dbe3ec;
  padding: 12px 0;
}
.scroll {
  overflow: auto;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}
td,
th {
  padding: 8px;
  text-align: left;
  border-bottom: 1px solid #dbe3ec;
  overflow-wrap: anywhere;
}
small {
  display: block;
}
p {
  font-size: 13px;
  color: #536477;
}
</style>
