<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api";
import { auth } from "../auth";
import { projects } from "../projects";
import {
  entryReason,
  entryRangeDays,
  pipelineLabels,
  projectRangeLabels,
  projectStateLabels,
  type EntryCard,
  type EntrySummary,
  type ProjectRange,
} from "../project-entry";
import type { Project } from "../types";
import type { ScoreTemplate } from "../score-types";
const route = useRoute(),
  router = useRouter();
const data = ref<EntrySummary | null>(null),
  loading = ref(false),
  error = ref("");
const search = ref(""),
  env = ref("prod"),
  range = ref<ProjectRange>("7d"),
  pageSize = ref(12),
  from = ref(""),
  to = ref("");
let generation = 0,
  abort: AbortController | null = null,
  timer: ReturnType<typeof setTimeout> | undefined;
const admin = computed(() => auth.state.user?.globalRole === "admin");
const forbidden = ref(false),
  notice = ref("");
const dialog = ref(false),
  saving = ref(false),
  createError = ref(""),
  templates = ref<{ operational: ScoreTemplate; quality: ScoreTemplate } | null>(null),
  templateLoading = ref(false);
const form = reactive({
  name: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  origins: "http://localhost:5173",
  retentionDays: 90,
  operational: "",
  quality: "",
});
let creationId = crypto.randomUUID(),
  lastBody = "";
let createdLocateId: string | null = null;
const nameInput = ref<HTMLInputElement | null>(null),
  createButton = ref<HTMLButtonElement | null>(null);
const invalidate = () => {
  generation++;
  abort?.abort();
  loading.value = false;
};
function queryString() {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(route.query))
    if (typeof value === "string") q.set(key, value);
  return q;
}
async function change(values: Record<string, string | undefined>, replace = false) {
  invalidate();
  clearTimeout(timer);
  const query = { ...route.query, search: search.value.trim(), ...values };
  await router[replace ? "replace" : "push"]({ path: "/projects", query });
}
function searchChanged() {
  invalidate();
  clearTimeout(timer);
  timer = setTimeout(
    () => void change({ search: search.value.trim(), page: "1", locate: undefined }),
    300,
  );
}
async function load() {
  clearTimeout(timer);
  invalidate();
  const current = generation;
  const q = queryString();
  search.value = q.get("search") ?? "";
  env.value = q.get("env") ?? "prod";
  range.value = (q.get("range") ?? "7d") as ProjectRange;
  pageSize.value = Number(q.get("pageSize") ?? 12);
  const missing =
    !q.has("from") ||
    !q.has("to") ||
    !q.has("page") ||
    !q.has("pageSize") ||
    !q.has("env") ||
    !q.has("range") ||
    !q.has("search");
  if (
    missing &&
    range.value !== "custom" &&
    Number.isFinite(Date.parse(q.get("to") ?? new Date().toISOString())) &&
    projectRangeLabels[range.value]
  ) {
    const end = q.get("to") ?? new Date().toISOString(),
      days = entryRangeDays(range.value);
    await change(
      {
        search: search.value,
        env: env.value,
        range: range.value,
        page: q.get("page") ?? "1",
        pageSize: String(pageSize.value),
        from:
          q.get("from") ?? new Date(Date.parse(end) - days * 86400000).toISOString(),
        to: end,
      },
      true,
    );
    return;
  }
  from.value = (q.get("from") ?? "").replace(/Z$/, "");
  to.value = (q.get("to") ?? "").replace(/Z$/, "");
  loading.value = true;
  error.value = "";
  forbidden.value = false;
  data.value = null;
  abort = new AbortController();
  try {
    const response = await api.request<EntrySummary>(
      "/api/projects/summary?" + q.toString(),
      { signal: abort.signal },
    );
    if (current !== generation) return;
    if (String(response.page) !== q.get("page")) {
      await change({ page: String(response.page) }, true);
      return;
    }
    data.value = response;
    if (response.located) {
      await nextTick();
      document.getElementById("project-" + response.located)?.focus();
    }
  } catch (cause) {
    if (current !== generation) return;
    forbidden.value = cause instanceof ApiError && cause.status === 403;
    error.value =
      cause instanceof ApiError
        ? `${cause.code} · 请求 ID：${cause.requestId ?? "—"}`
        : "无法连接到服务，请重试。";
  } finally {
    if (current === generation) loading.value = false;
  }
}
function setRange() {
  if (range.value === "custom") return;
  const end = new Date().toISOString();
  void change({
    range: range.value,
    from: new Date(
      Date.parse(end) - entryRangeDays(range.value) * 86400000,
    ).toISOString(),
    to: end,
    page: "1",
    locate: undefined,
  });
}
function customRange() {
  try {
    void change({
      range: "custom",
      from: new Date(from.value + "Z").toISOString(),
      to: new Date(to.value + "Z").toISOString(),
      page: "1",
      locate: undefined,
    });
  } catch {
    error.value = "请输入有效的 UTC 起止时间。";
  }
}
function focusAfterCreate() {
  if (createdLocateId) document.getElementById("project-" + createdLocateId)?.focus();
  else createButton.value?.focus();
}
async function openCreate() {
  createdLocateId = null;
  dialog.value = true;
  createError.value = "";
  templateLoading.value = true;
  try {
    templates.value = await api.request("/api/projects/templates");
    if (!form.operational) form.operational = templates.value!.operational.version;
    if (!form.quality) form.quality = templates.value!.quality.version;
  } catch {
    createError.value = "无法加载初始模板，请关闭后重试；已填内容保留。";
  } finally {
    templateLoading.value = false;
  }
}
async function create() {
  if (saving.value || !templates.value) return;
  createError.value = "";
  const origins = form.origins
    .split(/\n|,/)
    .map((v) => v.trim())
    .filter(Boolean);
  try {
    if (/^[+-]/.test(form.timezone)) throw Error();
    new Intl.DateTimeFormat("en", { timeZone: form.timezone });
    if (!form.name.trim() || !origins.length) throw Error();
    for (const value of origins) {
      const u = new URL(value);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.origin !== value ||
        value.includes("*")
      )
        throw Error();
    }
  } catch {
    createError.value =
      "请填写名称、有效 IANA 时区及精确 Origin（协议、域名、端口；不能包含路径、查询、片段或 *）。";
    return;
  }
  const body = {
    name: form.name.trim(),
    timezone: form.timezone,
    origins,
    retentionDays: form.retentionDays,
    templates: { operational: form.operational, quality: form.quality },
  };
  const serialized = JSON.stringify(body);
  if (lastBody && lastBody !== serialized) creationId = crypto.randomUUID();
  lastBody = serialized;
  saving.value = true;
  try {
    const project = await api.request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ ...body, creationId }),
    });
    createdLocateId = project.id;
    dialog.value = false;
    projects.reset();
    notice.value = `已创建“${project.name}”。已按名称搜索并定位新项目；两类模板已保存为待确认草稿。`;
    form.name = "";
    creationId = crypto.randomUUID();
    lastBody = "";
    await change({ search: project.name, page: "1", locate: project.id });
  } catch (cause) {
    createError.value =
      cause instanceof ApiError
        ? `创建失败：${cause.code}，请求 ID：${cause.requestId ?? "—"}。输入已保留，可修正后重试。`
        : "网络响应未确认。输入已保留；保持内容重试不会重复创建项目。";
  } finally {
    saving.value = false;
  }
}
async function enter(card: EntryCard) {
  await router.push({
    path: card.entry.path,
    query: {
      tab: "scores",
      env: card.range.env,
      range: range.value,
      from: card.range.from,
      to: card.range.to,
      scoreFrom: card.range.from.replace(/Z$/, ""),
      scoreTo: card.range.to.replace(/Z$/, ""),
      entryReturn: route.fullPath,
    },
  });
}
async function logout() {
  invalidate();
  await auth.logout();
  projects.reset();
  await router.replace("/login");
}
function date(value: string | null, zone: string) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: zone,
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(value))
    : "—";
}
watch(
  () => route.fullPath,
  () => void load(),
  { immediate: true },
);
watch(
  () => auth.isAuthenticated.value,
  (value) => {
    if (!value) {
      invalidate();
      void router.replace("/login");
    }
  },
);
onBeforeUnmount(() => {
  invalidate();
  clearTimeout(timer);
});
</script>
<template>
  <div class="projects-page">
    <header class="projects-top">
      <a href="/projects" aria-label="全部项目首页">FI · Frontend Insight</a>
      <div>
        {{ auth.state.user?.displayName }} · {{ admin ? "管理员" : "只读查看者" }}
        <el-button text @click="logout">退出</el-button>
      </div>
    </header>
    <main class="projects-content">
      <div class="projects-heading">
        <div>
          <p class="eyebrow">项目资产</p>
          <h1>全部项目</h1>
          <p>查看运营、质量与接入状态，找到需要关注的项目。</p>
        </div>
        <button
          v-if="admin"
          ref="createButton"
          class="entry-primary"
          @click="openCreate"
        >
          新建项目
        </button>
      </div>
      <p v-if="notice" role="status" class="entry-notice">{{ notice }}</p>
      <section class="entry-filters" aria-label="项目筛选">
        <label class="entry-search"
          >项目名称<input
            v-model="search"
            type="search"
            maxlength="120"
            placeholder="搜索项目名称"
            @input="searchChanged"
        /></label>
        <button
          v-if="search"
          @click="change({ search: '', page: '1', locate: undefined })"
        >
          清空搜索
        </button>
        <label
          >环境<select
            v-model="env"
            @change="change({ env, page: '1', locate: undefined })"
          >
            <option value="prod">生产 prod</option>
            <option value="staging">预发 staging</option>
            <option value="dev">开发 dev</option>
          </select></label
        >
        <label
          >时间范围<select v-model="range" @change="setRange">
            <option v-for="(label, key) in projectRangeLabels" :key="key" :value="key">
              {{ label }}
            </option>
          </select></label
        >
        <button @click="load">刷新列表</button>
      </section>
      <div v-if="range === 'custom'" class="entry-filters">
        <label
          >开始时间（UTC）<input
            v-model="from"
            type="datetime-local"
            step="0.001" /></label
        ><label
          >结束时间（UTC，不含）<input
            v-model="to"
            type="datetime-local"
            step="0.001" /></label
        ><button @click="customRange">应用自定义范围</button>
      </div>
      <p class="entry-hint">
        告警优先，再按最近数据更新时间排序。每张卡片按自己的项目时区解释同一 UTC
        查询窗口；更新时间是当前环境保留数据的实际接收时间。
      </p>
      <p v-if="loading" role="status" aria-live="polite">正在加载项目…</p>
      <section v-else-if="error" role="alert" class="entry-empty">
        <h2>{{ forbidden ? "无权查看项目" : "项目加载失败" }}</h2>
        <p>{{ error }}</p>
        <button @click="load">重试</button>
      </section>
      <template v-else-if="data">
        <p role="status">
          共 {{ data.total }} 个项目 · 第 {{ data.page }} 页 · {{ data.query.env }}
        </p>
        <section v-if="!data.total" class="entry-empty">
          <h2>{{ data.search ? "没有符合条件的项目" : "暂无可访问的项目" }}</h2>
          <p>
            {{
              data.search
                ? "搜索条件已保留，请尝试其他名称。"
                : admin
                  ? "创建第一个项目开始接入。"
                  : "请联系管理员授予项目访问权限。"
            }}
          </p>
          <button
            v-if="data.search"
            @click="change({ search: '', page: '1', locate: undefined })"
          >
            清空搜索
          </button>
        </section>
        <section v-else class="project-grid" aria-label="项目列表">
          <article
            v-for="card in data.items"
            :id="'project-' + card.id"
            :key="card.id"
            class="project-entry-card"
            :class="{ located: data.located === card.id }"
            tabindex="-1"
            :aria-label="card.name"
          >
            <div class="entry-card-title">
              <h2>{{ card.name }}</h2>
              <span :class="'project-state ' + card.state">{{
                projectStateLabels[card.state]
              }}</span>
            </div>
            <p v-if="card.projectStatus === 'disabled'">项目已停用</p>
            <div class="entry-scores">
              <div
                v-for="score in [card.operational, card.quality]"
                :key="score.scoreKey"
                :class="'entry-score ' + score.color"
              >
                <span>{{
                  score.scoreKey === "operational_score" ? "运营分数" : "质量分数"
                }}</span
                ><strong>{{
                  score.value === null ? "—" : score.value.toFixed(2)
                }}</strong
                ><small>{{
                  score.value === null
                    ? "不可用"
                    : score.value >= 85
                      ? "良好（≥85）"
                      : score.value >= 60
                        ? "关注（60–<85）"
                        : "较低（<60）"
                }}</small
                ><small>{{
                  score.versionId ? `v${score.version}` : "未激活配置"
                }}</small>
                <p v-if="score.reasons.length">{{ entryReason(score.reasons[0]!) }}</p>
              </div>
            </div>
            <dl class="entry-facts">
              <dt>链路状态</dt>
              <dd>
                {{ pipelineLabels[card.pipeline.state]
                }}<small v-if="card.pipeline.scope === 'project'">（项目级证据）</small>
              </dd>
              <dt>最近数据更新</dt>
              <dd>{{ date(card.lastDataAt, card.timezone) }}</dd>
              <dt>项目时区</dt>
              <dd>{{ card.timezone }}</dd>
              <dt>查询范围</dt>
              <dd>
                {{ card.range.localFrom }} 至 {{ card.range.localTo }}（不含结束）
              </dd>
            </dl>
            <p>{{ entryReason(card.data.reason) }}</p>
            <details>
              <summary>全部状态原因与分数版本</summary>
              <ul>
                <li
                  v-for="reason in [...new Set(card.reasons.map(entryReason))]"
                  :key="reason"
                >
                  {{ reason }}
                </li>
              </ul>
              <p
                v-for="score in [card.operational, card.quality]"
                :key="score.scoreKey"
              >
                {{ score.scoreKey === "operational_score" ? "运营" : "质量" }}版本：{{
                  score.versionId ?? "—"
                }}<br />生效时间：{{ date(score.availableFrom, card.timezone) }}
                <br />计算环境：{{ score.context.env }} · 时区：{{
                  score.context.timezone
                }}
                <br />计算范围：{{ score.context.from }} 至
                {{ score.context.to }}（不含结束）
              </p>
            </details>
            <button class="entry-primary enter-project" @click="enter(card)">
              进入项目</button
            ><small>当前进入指标管理；项目概览将在 R3 交付。</small>
          </article>
        </section>
        <nav class="entry-pagination" aria-label="项目分页">
          <label
            >每页项目数<select
              v-model="pageSize"
              @change="
                change({ pageSize: String(pageSize), page: '1', locate: undefined })
              "
            >
              <option :value="12">12</option>
              <option :value="24">24</option>
              <option :value="48">48</option>
            </select></label
          ><button
            :disabled="data.page <= 1"
            @click="change({ page: String(data.page - 1), locate: undefined })"
          >
            上一页</button
          ><span
            >第 {{ data.page }} /
            {{ Math.max(1, Math.ceil(data.total / data.pageSize)) }} 页</span
          ><button
            :disabled="data.page * data.pageSize >= data.total"
            @click="change({ page: String(data.page + 1), locate: undefined })"
          >
            下一页
          </button>
        </nav>
      </template>
    </main>
    <el-dialog
      v-model="dialog"
      title="新建项目"
      width="min(620px, 94vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @opened="nameInput?.focus()"
      @closed="focusAfterCreate"
    >
      <form class="entry-create-form" @submit.prevent="create">
        <p>运营与质量模板分别保存为草稿。创建后还需确认业务配置、评审并激活。</p>
        <label
          >项目名称<input ref="nameInput" v-model="form.name" required maxlength="120"
        /></label>
        <label
          >IANA 时区<input
            v-model="form.timezone"
            required
            maxlength="64"
            placeholder="Asia/Shanghai"
        /></label>
        <label
          >允许 Origin<textarea
            v-model="form.origins"
            required
            rows="3"
            aria-describedby="origin-help"
          /></label
        ><small id="origin-help"
          >每行一个精确来源，例如 https://example.com 或
          http://localhost:5173。不能包含路径、query、hash 或通配符。</small
        >
        <label
          >数据保留时间（天）<input
            v-model.number="form.retentionDays"
            required
            type="number"
            min="1"
            max="365"
        /></label>
        <p v-if="templateLoading" role="status">正在加载初始指标模板…</p>
        <template v-if="templates"
          ><label
            >初始运营指标模板<select v-model="form.operational">
              <option :value="templates.operational.version">
                默认运营 · {{ templates.operational.version }}
              </option>
            </select></label
          ><label
            >初始质量指标模板<select v-model="form.quality">
              <option :value="templates.quality.version">
                默认质量 · {{ templates.quality.version }}
              </option>
            </select></label
          ><small
            >模板负责人：{{
              templates.quality.approval.owner
            }}；已批准参数不会使项目自动获得分数。</small
          ></template
        >
        <p v-if="createError" role="alert" class="entry-error">{{ createError }}</p>
        <div class="entry-actions">
          <button type="button" :disabled="saving" @click="dialog = false">取消</button
          ><button
            type="submit"
            class="entry-primary"
            :disabled="saving || !templates || templateLoading"
          >
            {{ saving ? "正在创建…" : "创建项目" }}
          </button>
        </div>
      </form>
    </el-dialog>
  </div>
</template>
<style scoped>
.projects-page {
  min-height: 100vh;
  background: var(--bg, #f5f7fa);
  color: var(--text, #1e293b);
}
.projects-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 4%;
  border-bottom: 1px solid #dce3e9;
  background: white;
  gap: 16px;
}
.projects-top a {
  font-weight: 700;
  color: inherit;
  text-decoration: none;
}
.projects-content {
  max-width: 1440px;
  margin: auto;
  padding: 36px 4%;
}
.projects-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.projects-heading h1 {
  font-size: 32px;
  margin: 8px 0;
}
.entry-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: end;
  margin: 22px 0;
}
.entry-filters label,
.entry-create-form label {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.entry-search {
  flex: 1;
  min-width: 220px;
}
input,
select,
textarea,
button {
  font: inherit;
  border: 1px solid #b9c6d2;
  border-radius: 8px;
  padding: 10px 12px;
  background: white;
  color: inherit;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.entry-primary {
  background: #174ea6;
  color: white;
  border-color: #174ea6;
}
.entry-hint,
small {
  color: #596b7c;
  font-size: 12px;
  line-height: 1.6;
}
.project-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
}
.project-entry-card {
  background: white;
  border: 1px solid #dce3e9;
  border-radius: 14px;
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-wrap: anywhere;
}
.entry-card-title {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 10px;
}
.entry-card-title h2 {
  font-size: 20px;
  margin: 0;
}
.project-state {
  white-space: nowrap;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 5px;
  background: #edf1f5;
}
.alert {
  color: #a52622;
  background: #ffefee;
}
.normal {
  color: #166534;
  background: #eefbf0;
}
.entry-scores {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.entry-score {
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  padding: 14px;
  background: #f4f6f8;
}
.entry-score strong {
  font-size: 32px;
  font-variant-numeric: tabular-nums;
}
.entry-score p {
  font-size: 12px;
  margin-bottom: 0;
}
.green strong {
  color: #157238;
}
.yellow strong {
  color: #946200;
}
.red strong {
  color: #b32928;
}
.gray strong {
  color: #69798a;
}
.entry-facts {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 9px;
  font-size: 12px;
  margin: 0;
}
.entry-facts dd {
  margin: 0;
}
.entry-facts dt {
  color: #596b7c;
}
.enter-project {
  margin-top: auto;
}
.entry-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 16px;
  padding: 28px;
}
.entry-pagination label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.entry-empty {
  text-align: center;
  padding: 60px 20px;
  background: white;
  border-radius: 12px;
}
.entry-create-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.entry-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
.entry-error {
  color: #a52622;
}
.entry-notice {
  padding: 14px;
  background: #eaf4ff;
  border-radius: 8px;
}
.located {
  outline: 3px solid #174ea6;
}
details {
  font-size: 12px;
}
summary {
  cursor: pointer;
}
button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 3px solid #488df6;
  outline-offset: 3px;
}
@media (max-width: 1100px) {
  .project-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 700px) {
  .project-grid {
    grid-template-columns: 1fr;
  }
  .projects-top,
  .projects-heading {
    align-items: start;
    flex-direction: column;
  }
  .projects-content {
    padding: 24px 16px;
  }
}
</style>
