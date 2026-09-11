<script setup lang="ts">
import { computed } from "vue";
import { formatDateTime } from "../range";
import type { DataStatus } from "../types";

const props = defineProps<{ status: DataStatus | null }>();
const content = computed(() => {
  if (!props.status) {
    return { label: "状态未知", detail: "尚未取得链路状态", tone: "neutral" };
  }
  const states = {
    healthy: {
      label: "链路正常",
      detail: `最近可查询：${formatDateTime(props.status.lastQueryableAt)}`,
      tone: "success",
    },
    delayed: {
      label: "数据延迟",
      detail: `已接收但尚未完全可查询，最近请求：${props.status.lastRequestId ?? "未知"}`,
      tone: "warning",
    },
    no_data: {
      label: "尚未收到数据",
      detail: "请完成接入并发送测试事件",
      tone: "neutral",
    },
    broken: {
      label: "链路异常",
      detail: `存在无法查询的数据，拒绝码：${props.status.lastRejectionCode ?? "未知"}`,
      tone: "danger",
    },
  } as const;
  return states[props.status.state];
});
</script>

<template>
  <div class="data-status" :class="`tone-${content.tone}`" role="status">
    <span class="status-dot" aria-hidden="true"></span>
    <strong>{{ content.label }}</strong>
    <span>{{ content.detail }}</span>
  </div>
</template>
