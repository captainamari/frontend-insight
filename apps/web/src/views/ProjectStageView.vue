<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
const route = useRoute();
const stage = computed(() =>
  route.name === "project-business"
    ? ["业务分析", "R4-A/R4-B/R4-C"]
    : route.name === "project-pages"
      ? ["页面分析", "R5-B/R6"]
      : ["设置", "R7"],
);
</script>
<template>
  <section class="panel">
    <h1>{{ stage[0] }}</h1>
    <p>本模块将在 {{ stage[1] }} 交付，当前阶段尚未开放正文功能。</p>
    <p>
      当前项目、环境和时间范围已保留。请通过项目概览查看可用事实与证据，或进入指标管理维护定义。
    </p>
  </section>
</template>
