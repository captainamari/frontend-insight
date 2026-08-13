<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import { projects } from "../projects";

const route = useRoute();
const router = useRouter();
const search = ref(typeof route.query.q === "string" ? route.query.q : "");
const status = ref(typeof route.query.status === "string" ? route.query.status : "all");
const rows = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return projects.state.items.filter(
    (project) =>
      (status.value === "all" || project.status === status.value) &&
      (!needle ||
        project.name.toLowerCase().includes(needle) ||
        project.projectKey.toLowerCase().includes(needle)),
  );
});

function syncFilters(): void {
  void router.replace({
    query: {
      ...(search.value ? { q: search.value } : {}),
      ...(status.value !== "all" ? { status: status.value } : {}),
    },
  });
}

function openProject(projectId: string): void {
  void router.push({
    name: "project-overview",
    params: { projectId },
    query: { range: "7d", fromProjects: route.fullPath },
  });
}

onMounted(() => void projects.load());
</script>

<template>
  <div>
    <PageHeader
      eyebrow="PROJECT ENTRY"
      title="全部项目"
      description="先查看当前账号有权访问的全部已接入项目，再进入单个项目概览。"
    />

    <section class="project-entry-summary">
      <div>
        <span>已授权项目</span><strong>{{ projects.state.items.length }}</strong>
      </div>
      <div>
        <span>启用中</span><strong>{{ projects.active.value.length }}</strong>
      </div>
      <div>
        <span>当前结果</span><strong>{{ rows.length }}</strong>
      </div>
    </section>

    <section class="panel project-filters" aria-label="项目筛选">
      <el-input
        v-model="search"
        clearable
        aria-label="搜索项目"
        placeholder="按项目名称或项目标识搜索"
        @input="syncFilters"
      />
      <el-select v-model="status" aria-label="项目状态" @change="syncFilters">
        <el-option label="全部状态" value="all" />
        <el-option label="启用" value="active" />
        <el-option label="已停用" value="disabled" />
      </el-select>
    </section>

    <StatePanel
      :state="projects.state.loading ? 'loading' : 'ready'"
      title="项目列表暂不可用"
      @retry="projects.refresh"
    >
      <section v-if="rows.length" class="project-grid" aria-label="已接入项目">
        <button
          v-for="project in rows"
          :key="project.id"
          class="project-card"
          type="button"
          @click="openProject(project.id)"
        >
          <div class="project-card-heading">
            <span
              class="status-dot"
              :class="{ disabled: project.status === 'disabled' }"
            />
            <strong>{{ project.name }}</strong>
            <el-tag size="small" effect="plain">{{ project.role ?? "viewer" }}</el-tag>
          </div>
          <dl>
            <div>
              <dt>项目状态</dt>
              <dd>{{ project.status === "active" ? "启用" : "已停用" }}</dd>
            </div>
            <div>
              <dt>项目时区</dt>
              <dd>{{ project.timezone }}</dd>
            </div>
            <div>
              <dt>数据保留</dt>
              <dd>{{ project.retentionDays }} 天</dd>
            </div>
            <div>
              <dt>接入 Origin</dt>
              <dd>{{ project.origins.length }}</dd>
            </div>
          </dl>
          <span class="project-card-action">进入项目概览 →</span>
        </button>
      </section>
      <section v-else class="empty-projects">
        <h2>没有符合条件的项目</h2>
        <p>调整搜索或状态筛选；当前页面不会自动进入最近项目或第一个项目。</p>
      </section>
    </StatePanel>
  </div>
</template>
