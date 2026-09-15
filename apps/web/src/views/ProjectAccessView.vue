<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
const route = useRoute(),
  router = useRouter();
</script>
<template>
  <main class="page-container">
    <h1>
      {{ route.query.kind === "forbidden" ? "无项目权限" : "暂时无法验证项目权限" }}
    </h1>
    <p>尚未载入项目数据。请返回全部项目，或重试当前访问。</p>
    <el-button @click="router.replace('/projects')">返回全部项目</el-button
    ><el-button
      @click="
        router.replace({
          path: '/projects/' + String(route.params.projectId) + '/metrics',
        })
      "
      >重试</el-button
    >
  </main>
</template>
