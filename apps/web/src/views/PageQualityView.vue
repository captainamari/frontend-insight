<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElDrawer } from "element-plus";
import "element-plus/es/components/drawer/style/css";
import { api, ApiError } from "../api";
interface Occurrence {
  occurrenceId: string;
  groupId: string;
  timestamp: string;
  category: string;
  pageRoute: string;
  stackFrames: string[];
  occurrences: number;
  context: {
    pageRoute: string | null;
    release: string | null;
    env: string;
    browser: string;
    os: string;
    viewport: string;
    navigation: string;
    requestMethod: string;
    requestPath: string | null;
    statusCode: number | null;
    sdkVersion: string | null;
    schemaVersion: string | null;
    workflowStep: string | null;
    breadcrumbs: string[];
  };
}
interface Response {
  items: Occurrence[];
  nextCursor: string | null;
  routes: string[];
  availableFrom: string | null;
  asOf: string;
  totalOccurrences: number;
  totalGroups: number;
  mode: string;
  dataState: string;
  timezone: string;
  pipeline: { state: string; reason: string };
}
const route = useRoute(),
  router = useRouter();
const data = ref<Response | null>(null),
  loading = ref(false),
  error = ref("");
const selected = ref<Occurrence | null>(null),
  open = ref(false),
  pathSearch = ref("");
const categories = [
  ["all", "全部类别"],
  ["api", "API / Ajax"],
  ["resource", "Resource"],
  ["vue", "Vue"],
  ["react", "React"],
  ["promise", "Promise"],
  ["js", "JS"],
  ["other", "Other"],
];
const paths = computed(() =>
  [
    ...new Set([
      ...(data.value?.routes ?? []),
      ...(typeof route.query.pageRoute === "string" ? [route.query.pageRoute] : []),
    ]),
  ].filter((p) => p.toLowerCase().includes(pathSearch.value.toLowerCase())),
);
const signature = computed(() =>
  JSON.stringify([
    route.params.projectId,
    ...[
      "env",
      "range",
      "from",
      "to",
      "pageRoute",
      "category",
      "mode",
      "groupId",
      "cursor",
    ].map((k) => route.query[k]),
  ]),
);
const filterScope = computed(() =>
  JSON.stringify([
    route.params.projectId,
    ...["env", "range", "from", "to", "pageRoute", "category", "mode", "groupId"].map(
      (k) => route.query[k],
    ),
  ]),
);
let generation = 0,
  controller: AbortController | null = null;
async function load() {
  const id = ++generation;
  controller?.abort();
  controller = new AbortController();
  data.value = null;
  open.value = false;
  selected.value = null;
  loading.value = true;
  error.value = "";
  const q = new URLSearchParams();
  for (const key of [
    "env",
    "range",
    "from",
    "to",
    "pageRoute",
    "category",
    "mode",
    "groupId",
    "cursor",
  ])
    if (typeof route.query[key] === "string") q.set(key, String(route.query[key]));
  try {
    const result = await api.request<Response>(
      `/api/projects/${encodeURIComponent(String(route.params.projectId))}/observability/occurrences?${q}`,
      { signal: controller.signal },
    );
    if (id === generation) data.value = result;
  } catch (e) {
    if (id !== generation) return;
    error.value =
      e instanceof ApiError && e.code.includes("CURSOR")
        ? "分页已过期或筛选已改变，请回到第一页。"
        : e instanceof ApiError && e.code.includes("BUDGET")
          ? "所选范围错误量超出查询预算，请缩短时间范围。"
          : "暂时无法读取，请重试或检查访问权限。";
    if (e instanceof ApiError && e.status === 403)
      void router.replace({
        name: "project-access-error",
        params: route.params,
        query: { kind: "forbidden" },
      });
  } finally {
    if (id === generation) loading.value = false;
  }
}
let filterNavigation = Promise.resolve();
function change(key: string, value?: string) {
  // Read the route only after the preceding navigation commits, so rapid
  // changes compose instead of overwriting each other with stale query values.
  filterNavigation = filterNavigation.then(async () => {
    await router.push({
      query: {
        ...route.query,
        [key]: value || undefined,
        cursor: undefined,
        ...(key === "groupId"
          ? { mode: value ? "all" : "latest" }
          : key !== "mode"
            ? { groupId: undefined }
            : {}),
      },
    });
  });
}
function detail(item: Occurrence) {
  selected.value = item;
  open.value = true;
}
function time(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: data.value?.timezone ?? "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(new Date(value))
    : "暂无";
}
const contextLabels: Record<string, string> = {
  pageRoute: "页面路径",
  release: "发布版本",
  env: "环境",
  browser: "浏览器家族",
  os: "操作系统",
  viewport: "视口档位",
  navigation: "导航类型",
  requestMethod: "API 方法",
  requestPath: "API 路径",
  statusCode: "状态码",
  sdkVersion: "SDK 版本",
  schemaVersion: "Schema 版本",
  workflowStep: "最近工作流步骤",
};
const crumbLabels: Record<string, string> = {
  navigation: "页面跳转",
  action: "已追踪操作",
  api_success: "API 技术成功",
  api_failure: "API 技术失败",
  visible: "页面可见",
  hidden: "页面隐藏",
};
watch(filterScope, () => {
  if (route.query.cursor)
    void router.replace({ query: { ...route.query, cursor: undefined } });
});
watch(signature, load, { immediate: true });
onBeforeUnmount(() => {
  ++generation;
  controller?.abort();
});
</script>
<template>
  <section class="panel page-quality" aria-labelledby="quality-title">
    <h1 id="quality-title">页面分析</h1>

    <p>按页面、时间和错误类别定位问题。时间使用项目时区；上方可选择自定义日期。</p>
    <div class="quality-filters">
      <label
        >查找路径<input v-model="pathSearch" type="search" placeholder="输入部分路径"
      /></label>
      <label
        >页面路径<select
          aria-label="页面路径"
          :value="route.query.pageRoute ?? ''"
          @change="change('pageRoute', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">全部页面</option>
          <option v-for="p in paths" :key="p" :value="p">{{ p }}</option>
        </select></label
      >
      <label
        >错误类别<select
          aria-label="错误类别"
          :value="route.query.category ?? 'all'"
          @change="change('category', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="c in categories" :key="c[0]" :value="c[0]">{{ c[1] }}</option>
        </select></label
      >
      <label
        >实例范围<select
          aria-label="实例范围"
          :value="route.query.mode ?? 'latest'"
          @change="change('mode', ($event.target as HTMLSelectElement).value)"
        >
          <option value="latest">每组最新一次</option>
          <option value="all">全部实例</option>
        </select></label
      >
      <button v-if="route.query.groupId" type="button" @click="change('groupId')">
        返回全部错误组
      </button>
      <button
        type="button"
        :disabled="loading"
        @click="route.query.cursor ? change('cursor') : load()"
      >
        刷新
      </button>
    </div>
    <p v-if="loading" role="status">正在读取错误实例…</p>
    <div v-if="error" role="alert">
      <p>{{ error }}</p>
      <button type="button" @click="change('cursor')">回到第一页</button
      ><button type="button" @click="load">重试</button>
    </div>
    <template v-if="data">
      <div class="quality-status" role="status">
        <strong>{{
          data.dataState === "no_data" ? "所选范围暂无错误实例" : "已观测错误"
        }}</strong>
        <span>
          · {{ data.totalGroups }} 组 / {{ data.totalOccurrences }} 次 ·
          {{ data.timezone }}</span
        >
        <p>
          所选范围最早可用实例：{{ time(data.availableFrom) }} · 查询快照：{{
            time(data.asOf)
          }}
        </p>
        <p>当前记录仅覆盖实际接入并收到的错误；没有记录不表示没有错误。</p>
        <p v-if="data.pipeline.state !== 'healthy'">
          采集链路：{{ data.pipeline.state }} · {{ data.pipeline.reason }}
        </p>
      </div>
      <div class="quality-table-wrap">
        <table class="data-table" aria-label="质量错误实例">
          <thead>
            <tr>
              <th>错误组</th>
              <th>路径</th>
              <th>时间</th>
              <th>堆栈信息</th>
              <th>复现条件</th>
              <th>类别</th>
              <th>Release</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in data.items" :key="item.occurrenceId">
              <td>
                <details>
                  <summary>
                    {{ item.groupId.slice(0, 10) }} · {{ item.occurrences }} 次
                  </summary>
                  <p>稳定错误组：{{ item.groupId }}</p>
                  <button type="button" @click="change('groupId', item.groupId)">
                    查看此组全部实例
                  </button>
                </details>
              </td>
              <td>{{ item.pageRoute }}</td>
              <td>{{ time(item.timestamp) }}</td>
              <td>
                <code>{{ item.stackFrames.join("\n") || "未采集安全堆栈" }}</code>
              </td>
              <td>
                <button
                  type="button"
                  :aria-label="'打开复现条件 ' + item.occurrenceId.slice(0, 8)"
                  @click="detail(item)"
                >
                  复现条件
                </button>
              </td>
              <td>{{ item.category }}</td>
              <td>{{ item.context.release ?? "未提供" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="quality-pagination">
        <button type="button" :disabled="!route.query.cursor" @click="change('cursor')">
          第一页</button
        ><button
          type="button"
          :disabled="!data.nextCursor"
          @click="
            router.push({
              query: { ...route.query, cursor: data.nextCursor ?? undefined },
            })
          "
        >
          下一页</button
        ><small>分页快照保留一小时；刷新可读取新到达事件。</small>
      </div>
    </template>
    <ElDrawer
      v-model="open"
      title="安全复现条件"
      size="min(560px, 94vw)"
      :close-on-press-escape="true"
      destroy-on-close
    >
      <template v-if="selected">
        <p>{{ time(selected.timestamp) }} · {{ selected.category }}</p>
        <dl class="quality-context">
          <template v-for="(label, key) in contextLabels" :key="key"
            ><dt>{{ label }}</dt>
            <dd>
              {{ selected.context[key as keyof typeof selected.context] ?? "未采集" }}
            </dd></template
          >
        </dl>
        <h3>最近安全操作</h3>
        <ol v-if="selected.context.breadcrumbs.length">
          <li v-for="(crumb, i) in selected.context.breadcrumbs" :key="i">
            {{ crumbLabels[crumb] ?? "未知" }}
          </li>
        </ol>
        <p v-else>未采集安全操作记录。</p>
        <p>上下文只展示已采集的安全字段。工作流步骤尚未关联时保持未采集。</p>
      </template>
    </ElDrawer>
  </section>
</template>
<style scoped>
.page-quality button,
.page-quality input,
.page-quality select {
  min-height: 36px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--ink);
  background: var(--surface);
}
.page-quality button:hover:not(:disabled) {
  border-color: var(--blue);
  color: var(--blue);
}
.page-quality button:disabled {
  color: var(--muted);
  background: var(--canvas);
}
.quality-tabs button[aria-current="page"] {
  color: var(--blue);
  border-color: var(--blue);
  font-weight: 600;
}

.quality-tabs,
.quality-filters,
.quality-pagination {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: end;
  margin: 1rem 0;
}
.quality-filters label {
  display: grid;
  gap: 0.4rem;
  flex: 1;
  min-width: 160px;
}
.quality-status {
  padding: 1rem;
  background: var(--surface-muted, #f6f7f8);
  border-radius: 8px;
  margin: 1rem 0;
}
.quality-table-wrap {
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
td,
th {
  text-align: left;
  padding: 0.8rem;
  border-bottom: 1px solid #ddd;
  vertical-align: top;
}
code,
details p {
  overflow-wrap: anywhere;
}
details {
  max-width: 260px;
}
.quality-context {
  display: grid;
  grid-template-columns: 8rem 1fr;
  gap: 0.75rem;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
button,
summary {
  cursor: pointer;
}
button:disabled {
  cursor: default;
}
</style>
