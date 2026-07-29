<script setup lang="ts">
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ChartPoint } from "../range";

echarts.use([
  LineChart,
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const props = defineProps<{
  points: ChartPoint[];
  primaryLabel: string;
  secondaryLabel: string;
}>();
const container = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let observer: ResizeObserver | null = null;

function bucketLabel(value: string): string {
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2})/);
  return match ? `${match[2]}-${match[3]} ${match[4]}时` : value;
}

function render(): void {
  if (!container.value) return;
  chart ??= echarts.init(container.value);
  chart.setOption({
    aria: { enabled: true, decal: { show: true } },
    animationDuration: 240,
    color: ["#2364aa", "#f28e2b"],
    tooltip: { trigger: "axis" },
    legend: { top: 0, left: 0 },
    grid: { top: 48, right: 20, bottom: 36, left: 48 },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: props.points.map((point) => bucketLabel(point.bucket)),
      axisLabel: { hideOverlap: true },
    },
    yAxis: { type: "value", minInterval: 1 },
    series: [
      {
        name: props.primaryLabel,
        type: "line",
        connectNulls: false,
        showSymbol: false,
        data: props.points.map((point) => point.primary),
      },
      {
        name: props.secondaryLabel,
        type: "line",
        connectNulls: false,
        showSymbol: false,
        data: props.points.map((point) => point.secondary),
      },
    ],
  });
}

onMounted(() => {
  render();
  if (container.value) {
    observer = new ResizeObserver(() => chart?.resize());
    observer.observe(container.value);
  }
});
watch(() => [props.points, props.primaryLabel, props.secondaryLabel], render, {
  deep: true,
});
onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.dispose();
});
</script>

<template>
  <div ref="container" class="trend-chart" role="img" aria-label="趋势图"></div>
</template>
