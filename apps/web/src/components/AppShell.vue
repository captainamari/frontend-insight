<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  resolveProjectCalendar,
  localDateTime,
  projectLocalInstant,
  type ProjectRangeKey,
} from "@frontend-insight/event-contract/project-range";
import {
  CANONICAL_ENVIRONMENTS,
  CANONICAL_RANGES,
} from "@frontend-insight/event-contract/canonical";
import { auth } from "../auth";
import { projects } from "../projects";
import { projectRangeLabels, safeRedirectTarget } from "../project-entry";
const route = useRoute(),
  router = useRouter();
const project = computed(() => projects.find(String(route.params.projectId)));
const env = computed(
  () => CANONICAL_ENVIRONMENTS.find((e) => e === route.query.env) ?? "prod",
);
const preset = computed(
  () => CANONICAL_RANGES.find((r) => r.key === route.query.range)?.key ?? "7d",
);
const range = computed(() => {
  try {
    return resolveProjectCalendar(
      {
        range: preset.value,
        env: env.value,
        ...(typeof route.query.from === "string" ? { from: route.query.from } : {}),
        ...(typeof route.query.to === "string" ? { to: route.query.to } : {}),
      },
      project.value?.timezone ?? "UTC",
    );
  } catch {
    return null;
  }
});
const customFrom = ref(""),
  customTo = ref(""),
  error = ref("");
const nav = [
  ["overview", "项目概览"],
  ["business", "业务分析"],
  ["pages", "页面分析"],
  ["metrics", "指标管理"],
  ["settings", "设置"],
];
async function navigate(module: string) {
  await router.push({
    name: "project-" + module,
    params: route.params,
    query: route.query,
  });
}
async function changeEnv(value: string) {
  await router.push({ query: { ...route.query, env: value } });
}
async function changeRange(value: ProjectRangeKey) {
  if (value === "custom") {
    customFrom.value = range.value
      ? localDateTime(range.value.from, project.value?.timezone ?? "UTC")
      : "";
    customTo.value = range.value
      ? localDateTime(range.value.to, project.value?.timezone ?? "UTC")
      : "";
    await router.push({ query: { ...route.query, range: "custom" } });
    return;
  }
  const next = resolveProjectCalendar(
    { range: value, env: env.value },
    project.value?.timezone ?? "UTC",
  );
  await router.push({
    query: {
      ...route.query,
      range: value,
      from: next.from,
      to: next.to,
      scoreFrom: undefined,
      scoreTo: undefined,
    },
  });
}
async function custom() {
  try {
    const next = resolveProjectCalendar(
      {
        range: "custom",
        env: env.value,
        from: projectLocalInstant(customFrom.value, project.value?.timezone ?? "UTC"),
        to: projectLocalInstant(customTo.value, project.value?.timezone ?? "UTC"),
      },
      project.value?.timezone ?? "UTC",
    );
    error.value = "";
    await router.push({
      query: {
        ...route.query,
        range: "custom",
        from: next.from,
        to: next.to,
        scoreFrom: undefined,
        scoreTo: undefined,
      },
    });
  } catch {
    error.value = "请输入有效起止时间，结束不含，最长13个本地日历月。";
  }
}
async function logout() {
  await auth.logout();
  projects.reset();
  await router.replace("/login");
}
watch(
  () => auth.state.user,
  (user) => {
    if (!user) {
      projects.reset();
      void router.replace({ path: "/login", query: { redirect: route.fullPath } });
    }
  },
);
watch(
  () => [
    route.params.projectId,
    route.query.from,
    route.query.to,
    route.query.range,
    route.query.env,
  ],
  () => {
    if (!route.query.from && !route.query.to && range.value)
      void router.replace({
        query: {
          ...route.query,
          range: preset.value,
          env: env.value,
          from:
            typeof route.query.scoreFrom === "string"
              ? route.query.scoreFrom
              : range.value.from,
          to:
            typeof route.query.scoreTo === "string"
              ? route.query.scoreTo
              : range.value.to,
        },
      });
    customFrom.value = range.value
      ? localDateTime(range.value.from, project.value?.timezone ?? "UTC")
      : "";
    customTo.value = range.value
      ? localDateTime(range.value.to, project.value?.timezone ?? "UTC")
      : "";
  },
  { immediate: true },
);
</script>
<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">FI</span>
        <div>
          <strong>{{ project?.name ?? "项目" }}</strong
          ><small>Frontend Insight</small>
        </div>
      </div>
      <button
        class="nav-item"
        @click="
          router.push(
            safeRedirectTarget(
              route.query.entryReturn,
              (p) => p.split('?')[0] === '/projects',
            ),
          )
        "
      >
        返回全部项目
      </button>
      <nav class="primary-nav" aria-label="项目导航">
        <button
          v-for="[module, label] in nav"
          :key="module"
          class="nav-item"
          :class="{ active: route.name === 'project-' + module }"
          :aria-current="route.name === 'project-' + module ? 'page' : undefined"
          @click="navigate(module!)"
        >
          {{ label }}
        </button>
      </nav>
      <div class="sidebar-note">定义、版本与事实均可追溯</div>
    </aside>
    <div class="main-column">
      <header class="topbar">
        <div class="toolbar-group">
          <label
            >时间范围<select
              :value="preset"
              aria-label="选择时间范围"
              @change="
                changeRange(
                  ($event.target as HTMLSelectElement).value as ProjectRangeKey,
                )
              "
            >
              <option
                v-for="(label, key) in projectRangeLabels"
                :key="key"
                :value="key"
              >
                {{ label }}
              </option>
            </select></label
          ><label
            >环境<select
              :value="env"
              aria-label="项目环境"
              @change="changeEnv(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="e in CANONICAL_ENVIRONMENTS" :key="e">{{ e }}</option>
            </select></label
          >
          <div class="timezone-chip">
            项目时区 <strong>{{ project?.timezone }}</strong>
          </div>
        </div>
        <div class="account-menu">
          <div>
            <strong>{{ auth.state.user?.displayName }}</strong
            ><small>{{
              auth.state.user?.globalRole === "admin" ? "管理员" : "只读查看者"
            }}</small>
          </div>
          <button @click="logout">退出</button>
        </div>
      </header>
      <div class="project-window">
        <p v-if="range">
          {{ range.localFrom }} — {{ range.localTo }}（结束不含） ·
          {{ range.granularity }} · {{ env }}
        </p>
        <p v-else role="alert">时间范围无效，请重新选择。</p>
        <form v-if="preset === 'custom'" @submit.prevent="custom">
          <label
            >开始（项目本地时间）<input
              v-model="customFrom"
              type="datetime-local"
              step="0.001"
              required /></label
          ><label
            >结束（项目本地时间，不含）<input
              v-model="customTo"
              type="datetime-local"
              step="0.001"
              required /></label
          ><button>应用自定义范围</button>
          <p>DST 重叠时刻取较早瞬时；不存在的时刻向后调整。</p>
          <p v-if="error" role="alert">{{ error }}</p>
        </form>
      </div>
      <main class="page-container">
        <RouterView :key="String(route.params.projectId)" />
      </main>
    </div>
  </div>
</template>
<style scoped>
select,
input,
button {
  font: inherit;
}
select,
input {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 8px;
  background: white;
  color: #183247;
}
.project-window {
  padding: 0 28px;
  color: #526375;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.project-window form {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.project-window label {
  display: grid;
  gap: 4px;
}
.account-menu button {
  padding: 8px;
  border: 1px solid #dbe3ec;
  border-radius: 6px;
  background: white;
}
.brand strong {
  overflow-wrap: anywhere;
}
</style>
