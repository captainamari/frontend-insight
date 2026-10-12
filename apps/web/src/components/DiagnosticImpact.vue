<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { api } from "../api";
const props = defineProps<{
  projectId: string;
  groupId: string;
  env: string;
  from: string;
  to: string;
  release?: string;
  category?: string;
  pageRoute?: string;
}>();
interface Impact {
  release: string | null;
  occurrences: number;
  affectedUsers: number;
  affectedBrowsers: number;
  affectedPages: number;
  firstSeen: string | null;
  lastSeen: string | null;
}
const result = ref<{
  selected: Impact | null;
  history: Impact | null;
  releases: Impact[];
  historyReleases: Impact[];
  historyFrom: string;
} | null>(null);
const error = ref("");
let generation = 0;
let abort: AbortController | undefined;
watch(
  () => JSON.stringify(props),
  async () => {
    const id = ++generation;
    abort?.abort();
    abort = new AbortController();
    result.value = null;
    error.value = "";
    const q = new URLSearchParams({ env: props.env, from: props.from, to: props.to });
    for (const k of ["release", "category", "pageRoute"] as const)
      if (props[k]) q.set(k, props[k]!);
    try {
      const value = await api.request<NonNullable<typeof result.value>>(
        `/api/projects/${props.projectId}/observability/groups/${props.groupId}/impact?${q}`,
        { signal: abort.signal },
      );
      if (id === generation) result.value = value;
    } catch {
      if (id === generation) error.value = "影响统计暂不可用或超出预算，请缩短范围。";
    }
  },
  { immediate: true, flush: "sync" },
);
onBeforeUnmount(() => {
  ++generation;
  abort?.abort();
});
</script>
<template>
  <section aria-label="版本与影响统计">
    <h3>版本与影响统计</h3>
    <p>
      基础事实按 eventId 去重；详情采样、限流和过期不减少次数。消息搜索不改变本组统计。
    </p>
    <p>
      范围：{{ env }} · {{ from }} 至 {{ to }}（结束不含）·
      {{ release || "全部版本" }}。未知 release 单独列出。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="result">
      <p>
        所选窗口及版本：{{ result.selected?.occurrences ?? 0 }} 次；首次
        {{ result.selected?.firstSeen ?? "无记录" }}；最近
        {{ result.selected?.lastSeen ?? "无记录" }}。
      </p>
      <p>
        系统可追溯保留历史（自 {{ result.historyFrom }} 起，最多90天）：首次
        {{ result.history?.firstSeen ?? "无记录" }}；最近
        {{ result.history?.lastSeen ?? "无记录" }}。不是永久全历史首次。
      </p>
      <table aria-label="版本影响比较">
        <thead>
          <tr>
            <th>Release</th>
            <th>次数</th>
            <th>影响账号数</th>
            <th>浏览器实例数</th>
            <th>规范页面数</th>
            <th>窗口首次 / 最近</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in result.releases" :key="r.release ?? '__unknown__'">
            <td>{{ r.release ?? "未知 release" }}</td>
            <td>{{ r.occurrences }}</td>
            <td>{{ r.affectedUsers }}</td>
            <td>{{ r.affectedBrowsers }}</td>
            <td>{{ r.affectedPages }}</td>
            <td>{{ r.firstSeen }} / {{ r.lastSeen }}</td>
          </tr>
        </tbody>
      </table>
      <p>
        比较表保留相同环境、时间、路径、类别，列出所有 release；账号按 user_id、浏览器按
        device_id、页面按 page_route 去重，空账号不计。
      </p>
    </template>
  </section>
</template>
<style scoped>
table {
  width: 100%;
  border-collapse: collapse;
}
td,
th {
  padding: 0.5rem;
  text-align: left;
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}
section {
  overflow: auto;
}
</style>
