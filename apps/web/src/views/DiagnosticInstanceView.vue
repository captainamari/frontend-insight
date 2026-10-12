<script setup lang="ts">
import { useRoute, RouterLink } from "vue-router";
import DiagnosticDetail from "../components/DiagnosticDetail.vue";
const route = useRoute();
</script>
<template>
  <section class="panel">
    <h1>稳定错误实例</h1>
    <p>此链接只定位项目与实例，每次访问重新检查当前权限；不授予接收者权限。</p>
    <RouterLink
      :to="{
        name: 'project-pages',
        params: { projectId: route.params.projectId },
        query: { tab: 'quality' },
      }"
      >进入质量分析</RouterLink
    ><DiagnosticDetail
      :key="String(route.params.projectId) + String(route.params.eventId)"
      :project-id="String(route.params.projectId)"
      :event-id="String(route.params.eventId)"
    />
  </section>
</template>
