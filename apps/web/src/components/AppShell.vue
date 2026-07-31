<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { auth } from "../auth";
import { projects } from "../projects";
import { isRangePreset, rangeLabels } from "../range";
import type { RangePreset } from "../types";

const route = useRoute();
const router = useRouter();
const selectedProject = computed({
  get: () => (typeof route.query.project === "string" ? route.query.project : ""),
  set: (value: string) => {
    void router.replace({
      query: {
        ...route.query,
        project: value,
        range: isRangePreset(route.query.range) ? route.query.range : "7d",
      },
    });
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
  { route: "features", label: "功能采用", eyebrow: "默认首页" },
  { route: "operational-overview", label: "运营概览", eyebrow: "持续使用" },
  { route: "pages", label: "页面访问", eyebrow: "访问证据" },
  { route: "operational-index", label: "项目运营指数", eyebrow: "可解释摘要" },
  { route: "onboarding", label: "项目与接入", eyebrow: "配置和排障" },
] as const;

function navigate(name: string): void {
  void router.push({ name, query: route.query });
}

async function logout(): Promise<void> {
  await auth.logout();
  projects.reset();
  await router.replace({ name: "login" });
}

onMounted(() => void projects.load(true));
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
  () => projects.state.items,
  (items) => {
    if (!items.length) return;
    if (!projects.find(selectedProject.value)) {
      selectedProject.value = items[0]!.id;
    }
  },
  { deep: true, immediate: true },
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
              (item.route === 'operational-index' &&
                route.name === 'operational-config'),
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
