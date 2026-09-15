<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { auth } from "../auth";
import { projects } from "../projects";
import { isRangePreset, rangeLabels } from "../range";
import { safeRedirectTarget } from "../project-entry";
import type { RangePreset } from "../types";

const route = useRoute();
const router = useRouter();
const selectedProject = computed({
  get: () => {
    if (typeof route.params.projectId === "string") return route.params.projectId;
    return typeof route.query.project === "string" ? route.query.project : "";
  },
  set: (value: string) => {
    if (route.name === "project-metrics") {
      void router.replace({
        name: "project-metrics",
        params: { ...route.params, projectId: value },
        query: {
          ...route.query,
          range: isRangePreset(route.query.range) ? route.query.range : "7d",
          tab: "analysis-objects",
        },
      });
    } else {
      void router.replace({
        query: {
          ...route.query,
          project: value,
          range: isRangePreset(route.query.range) ? route.query.range : "7d",
        },
      });
    }
  },
});
const selectedRange = computed<RangePreset>({
  get: () => (isRangePreset(route.query.range) ? route.query.range : "7d"),
  set: (value) => {
    void router.replace({ query: { ...route.query, range: value } });
  },
});
const currentProject = computed(() => projects.find(selectedProject.value));

const navigation = [
  { route: "features", label: "功能采用", eyebrow: "历史页面" },
  { route: "operational-overview", label: "运营概览", eyebrow: "持续使用" },
  { route: "pages", label: "页面访问", eyebrow: "访问证据" },
  { route: "observability", label: "前端可观测性", eyebrow: "错误与性能" },
  { route: "project-metrics", label: "指标管理", eyebrow: "分析对象" },
  { route: "onboarding", label: "项目与接入", eyebrow: "配置和排障" },
] as const;

function navigate(name: string): void {
  if (name === "project-metrics" && selectedProject.value) {
    void router.push({
      name,
      params: { projectId: selectedProject.value },
      query: { range: selectedRange.value, tab: "analysis-objects" },
    });
  } else {
    void router.push({ name, query: route.query });
  }
}

async function logout(): Promise<void> {
  await auth.logout();
  projects.reset();
  await router.replace({ name: "login" });
}

onMounted(() => {
  if (!route.params.projectId) void projects.load(true);
});
watch(
  () => auth.isAuthenticated.value,
  (authenticated) => {
    if (!authenticated && auth.state.initialized) {
      projects.reset();
      void router.replace({ name: "login", query: { redirect: route.fullPath } });
    }
  },
);
watch(
  () => projects.state.items.map((project) => project.id).join(","),
  () => {
    const items = projects.state.items;
    if (!items.length || route.params.projectId) return;
    if (!projects.find(selectedProject.value)) {
      selectedProject.value = items[0]!.id;
    }
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
          <strong>Frontend Insight</strong>
          <small>功能采用分析</small>
        </div>
      </div>

      <nav aria-label="主导航" class="primary-nav">
        <button
          type="button"
          class="nav-item"
          @click="
            router.push(
              safeRedirectTarget(
                route.query.entryReturn,
                (path) => path.split('?')[0] === '/projects',
              ),
            )
          "
        >
          返回全部项目
        </button>
        <button
          v-for="item in navigation"
          :key="item.route"
          class="nav-item"
          :class="{
            active:
              route.name === item.route ||
              (item.route === 'features' &&
                route.name === 'feature-detail' &&
                route.query.evidence !== 'task') ||
              (item.route === 'operational-overview' &&
                route.name === 'feature-detail' &&
                route.query.evidence === 'task') ||
              (item.route === 'operational-overview' && route.name === 'page-detail') ||
              (item.route === 'project-metrics' && route.name === 'project-metrics'),
          }"
          type="button"
          @click="navigate(item.route)"
        >
          <span>{{ item.label }}</span>
          <small>{{ item.eyebrow }}</small>
        </button>
      </nav>

      <div class="sidebar-note">
        <span class="status-dot" aria-hidden="true"></span>
        <div>
          <strong>运营指数可下钻</strong>
          <small>不替代技术 SLO 或人员绩效</small>
        </div>
      </div>
    </aside>

    <div class="main-column">
      <header class="topbar">
        <div class="toolbar-group">
          <label>
            <span>项目</span>
            <el-select
              v-model="selectedProject"
              :loading="projects.state.loading"
              class="project-select"
              aria-label="选择项目"
              placeholder="选择项目"
            >
              <el-option
                v-for="project in projects.state.items"
                :key="project.id"
                :label="project.name"
                :value="project.id"
              >
                <span>{{ project.name }}</span>
                <small class="option-meta">{{
                  project.status === "active" ? "启用" : "已停用"
                }}</small>
              </el-option>
            </el-select>
          </label>

          <label>
            <span>时间范围</span>
            <el-select
              v-model="selectedRange"
              class="range-select"
              aria-label="选择时间范围"
            >
              <el-option
                v-for="(label, value) in rangeLabels"
                :key="value"
                :label="label"
                :value="value"
              />
            </el-select>
          </label>

          <div class="timezone-chip" title="所有图表统一使用项目时区">
            <span>项目时区</span>
            <strong>{{ currentProject?.timezone ?? "—" }}</strong>
          </div>
        </div>

        <div class="account-menu">
          <div>
            <strong>{{ auth.state.user?.displayName }}</strong>
            <small>{{
              auth.state.user?.globalRole === "admin" ? "管理员" : "只读查看者"
            }}</small>
          </div>
          <el-button text @click="logout">退出</el-button>
        </div>
      </header>

      <main class="page-container">
        <RouterView />
      </main>
    </div>
  </div>
</template>
