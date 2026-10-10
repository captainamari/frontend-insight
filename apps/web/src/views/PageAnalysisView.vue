<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import PageQualityView from "./PageQualityView.vue";
import PageOperationsView from "./PageOperationsView.vue";
const route = useRoute(),
  router = useRouter();
function tab(value: string) {
  void router.push({ query: { ...route.query, tab: value, cursor: undefined } });
}
</script>
<template>
  <nav aria-label="页面分析类型" class="panel">
    <button
      type="button"
      :aria-current="route.query.tab !== 'operations' ? 'page' : undefined"
      @click="tab('quality')"
    >
      质量分析
    </button>
    <button
      type="button"
      :aria-current="route.query.tab === 'operations' ? 'page' : undefined"
      @click="tab('operations')"
    >
      运营分析
    </button>
  </nav>
  <PageOperationsView v-if="route.query.tab === 'operations'" />
  <PageQualityView v-else />
</template>
