<script setup lang="ts">
defineProps<{
  label: string;
  value: string;
  comparison?: string;
  definition: string;
}>();
</script>

<template>
  <article class="metric-card">
    <div class="metric-heading">
      <span>{{ label }}</span>
      <el-tooltip :content="definition" placement="top">
        <button
          class="definition-trigger"
          type="button"
          :aria-label="`${label}指标定义`"
        >
          ?
        </button>
      </el-tooltip>
    </div>
    <strong>{{ value }}</strong>
    <small v-if="comparison">{{ comparison }}</small>
  </article>
</template>
