<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api } from "../api";
import { auth } from "../auth";
import { useDashboardContext } from "../context";
import type { ProjectOperationalSettings } from "../types";
const context = useDashboardContext(),
  route = useRoute();
const targetUsers = ref<number | null>(null),
  weekdays = ref<number[]>([]),
  versions = ref<ProjectOperationalSettings[]>([]),
  error = ref(""),
  notice = ref(""),
  busy = ref(false);
let generation = 0;
const canWrite = computed(
  () =>
    auth.state.user?.globalRole === "admin" &&
    ["owner", "admin"].includes(context.project.value?.role ?? ""),
);
async function load() {
  const current = ++generation;
  if (!context.projectId.value) return;
  try {
    const data = await api.request<{
      active: ProjectOperationalSettings | null;
      versions: ProjectOperationalSettings[];
    }>(`/api/projects/${context.projectId.value}/operational-settings`);
    if (current !== generation) return;
    targetUsers.value = data.active?.targetUsers ?? null;
    weekdays.value = data.active?.expectedActiveWeekdays ?? [1, 2, 3, 4, 5];
    versions.value = data.versions;
  } catch (e) {
    if (current === generation) error.value = String(e);
  }
}
async function save() {
  const current = generation;
  busy.value = true;
  error.value = "";
  try {
    await api.request(
      `/api/projects/${context.projectId.value}/operational-settings/versions`,
      {
        method: "POST",
        body: JSON.stringify({
          targetUsers: targetUsers.value,
          expectedActiveWeekdays: weekdays.value,
        }),
      },
    );
    if (current === generation) {
      notice.value = "业务配置新版本已保存；请在分数工作草稿中确认适用。";
      await load();
    }
  } catch (e) {
    if (current === generation) error.value = String(e);
  } finally {
    busy.value = false;
  }
}
watch(context.projectId, () => void load(), { immediate: true });
</script>
<template>
  <section class="panel">
    <h1>运营业务配置</h1>
    <p>复用项目目标和预期星期；已激活分数保留自己的依赖快照。</p>
    <router-link
      :to="{
        name: 'project-metrics',
        params: { projectId: context.projectId.value },
        query: { ...route.query, tab: 'scores', scoreType: 'operational' },
      }"
      >返回分数管理</router-link
    >
    <p v-if="error" role="alert">{{ error }}；输入已保留。</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <fieldset :disabled="!canWrite || busy">
      <label
        >目标用户数 <input v-model.number="targetUsers" type="number" min="1"
      /></label>
      <p>预期活跃星期</p>
      <label v-for="(day, i) in ['一', '二', '三', '四', '五', '六', '日']" :key="day"
        ><input v-model="weekdays" type="checkbox" :value="i + 1" />星期{{ day }}
      </label>
      <p><button v-if="canWrite" @click="save">保存业务配置版本</button></p>
    </fieldset>
    <details>
      <summary>历史业务配置版本</summary>
      <pre>{{ JSON.stringify(versions, null, 2) }}</pre>
    </details>
  </section>
</template>
