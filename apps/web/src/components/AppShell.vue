<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { auth } from "../auth";
import { projects } from "../projects";
import { isRangePreset, rangeLabels } from "../range";
import type { RangePreset } from "../types";

const route = useRoute();
const router = useRouter();
const projectId = computed(() =>
  typeof route.params.projectId === "string" ? route.params.projectId : null,
);
const currentProject = computed(() => projects.find(projectId.value));
const isProjectScope = computed(() => Boolean(projectId.value));
const selectedRange = computed<RangePreset>({
  get: () => (isRangePreset(route.query.range) ? route.query.range : "7d"),
  set: (value) => void router.replace({ query: { ...route.query, range: value } }),
});

const navigation = [
  { route: "business-analysis", label: "业务分析", eyebrow: "采用 · 任务 · 效率" },
  { route: "page-usage", label: "页面分析", eyebrow: "使用 · 性能 · 错误" },
  { route: "metrics", label: "指标管理", eyebrow: "定义 · 血缘 · 目标" },
  { route: "settings", label: "设置", eyebrow: "接入 · 资产 · 权限" },
] as const;

function isActive(name: string): boolean {
  const current = String(route.name ?? "");
  if (name === "business-analysis")
    return current.startsWith("business-") || current === "feature-detail";
  if (name === "page-usage") return current.startsWith("page-");
  if (name === "metrics") return current.startsWith("metric");
  return current === "settings" || current === "collector-settings";
}

function navigate(name: string): void {
  if (!projectId.value) return;
  void router.push({
    name,
    params: { projectId: projectId.value },
    query: route.query,
  });
}

function returnToProjects(): void {
  const target =
    typeof route.query.fromProjects === "string" &&
    route.query.fromProjects.startsWith("/projects")
      ? route.query.fromProjects
      : "/projects";
  void router.push(target);
}

async function logout(): Promise<void> {
  await auth.logout();
  projects.reset();
  await router.replace({ name: "login" });
}

onMounted(() => void projects.load());
watch(
  () => auth.isAuthenticated.value,
  (authenticated) => {
    if (!authenticated && auth.state.initialized) {
      projects.reset();
      void router.replace({ name: "login", query: { redirect: route.fullPath } });
    }
  },
);
</script>

<template>
  <div class="app-shell" :class="{ 'platform-scope': !isProjectScope }">
    <aside v-if="isProjectScope" class="sidebar">
      <button class="brand brand-button" type="button" @click="returnToProjects">
        <span class="brand-mark" aria-hidden="true">FI</span>
        <div>
          <strong>Frontend Insight</strong>
          <small>返回全部项目</small>
        </div>
      </button>

      <button
        class="project-home"
        :class="{
          active:
            route.name === 'project-overview' || route.name === 'operational-index',
        }"
        type="button"
        @click="
          router.push({
            name: 'project-overview',
            params: { projectId },
            query: route.query,
          })
        "
      >
        <span>项目概览</span>
        <small>{{ currentProject?.name ?? "加载中" }}</small>
      </button>

      <nav aria-label="项目一级导航" class="primary-nav">
        <button
          v-for="item in navigation"
          :key="item.route"
          class="nav-item"
          :class="{ active: isActive(item.route) }"
          type="button"
          @click="navigate(item.route)"
        >
          <span>{{ item.label }}</span>
          <small>{{ item.eyebrow }}</small>
        </button>
      </nav>
    </aside>

    <div class="main-column">
      <header class="topbar">
        <div class="toolbar-group">
          <button
            v-if="isProjectScope"
            class="breadcrumb-projects"
            type="button"
            @click="returnToProjects"
          >
            全部项目
          </button>
          <span v-if="isProjectScope" aria-hidden="true">/</span>
          <strong v-if="isProjectScope">{{ currentProject?.name ?? "项目" }}</strong>
          <strong v-else>项目入口</strong>

          <label v-if="isProjectScope">
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
          <div
            v-if="isProjectScope"
            class="timezone-chip"
            title="所有图表统一使用项目时区"
          >
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

      <main class="page-container"><RouterView /></main>
    </div>
  </div>
</template>
