<script setup lang="ts">
defineProps<{
  state: "loading" | "empty" | "stale" | "error" | "forbidden" | "ready";
  title?: string | undefined;
  message?: string | undefined;
  requestId?: string | null | undefined;
}>();

defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="state === 'loading'" class="state-panel loading-state" role="status">
    <el-skeleton :rows="4" animated />
    <span class="sr-only">正在加载</span>
  </div>

  <div
    v-else-if="state !== 'ready' && state !== 'stale'"
    class="state-panel"
    :class="`state-${state}`"
    :role="state === 'error' || state === 'forbidden' ? 'alert' : 'status'"
  >
    <span class="state-symbol" aria-hidden="true">
      {{ state === "forbidden" ? "!" : state === "error" ? "×" : "○" }}
    </span>
    <div>
      <h3>{{ title }}</h3>
      <p>{{ message }}</p>
      <p v-if="requestId" class="request-id">请求 ID：{{ requestId }}</p>
      <el-button v-if="state === 'error'" type="primary" plain @click="$emit('retry')">
        重新请求
      </el-button>
      <slot />
    </div>
  </div>

  <div v-else>
    <div v-if="state === 'stale'" class="stale-banner" role="alert">
      <strong>当前请求失败，正在保留上一次可用数据。</strong>
      <span>{{ message }}</span>
      <span v-if="requestId">请求 ID：{{ requestId }}</span>
      <el-button size="small" plain @click="$emit('retry')">重试</el-button>
    </div>
    <slot />
  </div>
</template>
