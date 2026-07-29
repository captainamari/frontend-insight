<script setup lang="ts">
import * as echarts from "echarts/core";
import { RadarChart } from "echarts/charts";
import { AriaComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

echarts.use([
  RadarChart,
  AriaComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const props = defineProps<{
  dimensions: Array<{ displayName: string; score: number | null }>;
}>();
const container = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let observer: ResizeObserver | null = null;

function render(): void {
  if (!container.value) return;
  chart ??= echarts.init(container.value);
  chart.setOption({
    aria: {
      enabled: true,
      description:
        "项目运营指数四维雷达图。缺少数据的维度不以零分替代，详细数值见下方表格。",
    },
    animationDuration: 240,
    color: ["#2364aa"],
    tooltip: { trigger: "item" },
    radar: {
      radius: "68%",
      splitNumber: 5,
      indicator: props.dimensions.map((item) => ({
        name: item.displayName,
        max: 100,
      })),
      axisName: { color: "#314456", fontSize: 12 },
      splitArea: {
        areaStyle: { color: ["#f8fafc", "#f1f5f8"] },
      },
    },
    series: [
      {
        name: "四维得分",
        type: "radar",
        data: [
          {
            value: props.dimensions.map((item) => item.score),
            name: "项目运营指数",
            areaStyle: { opacity: 0.18 },
          },
        ],
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
watch(() => props.dimensions, render, { deep: true });
onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.dispose();
});
</script>

<template>
  <div
    ref="container"
    class="operational-radar"
    role="img"
    aria-label="项目运营指数四维雷达图"
  ></div>
</template>
