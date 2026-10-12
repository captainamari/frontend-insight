<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { api, ApiError } from "../api";
const props = defineProps<{
  projectId: string;
  env: string;
  from: string;
  to: string;
  release?: string;
  category?: string;
  groupId?: string;
  pageRoute?: string;
}>();
const emit = defineEmits<{ select: [eventId: string] }>();
const term = ref(""),
  field = ref("raw"),
  error = ref(""),
  allowed = ref(false),
  loading = ref(false);
interface Results {
  items: {
    eventId: string;
    timestamp: string;
    category: string;
    context: { release: string | null };
  }[];
  total: number;
  nextOffset: number | null;
  asOf: number;
  candidates: number;
  searchable: number;
}
const result = ref<Results | null>(null);
let generation = 0,
  abort: AbortController | undefined,
  timer: ReturnType<typeof setTimeout> | undefined;
function clear() {
  ++generation;
  abort?.abort();
  clearTimeout(timer);
  result.value = null;
  loading.value = false;
}
async function access() {
  const id = generation;
  try {
    const value = await api.request<{ read: boolean }>(
      `/api/projects/${props.projectId}/diagnostics/capabilities`,
      { cache: "no-store" },
    );
    if (id !== generation) return;
    allowed.value = value.read;
    if (!value.read) {
      clear();
      term.value = "";
      error.value = "无诊断原文搜索权限；质量统计仍可使用。";
    } else timer = setTimeout(() => void access(), 1000);
  } catch {
    if (id === generation) {
      clear();
      allowed.value = false;
      term.value = "";
    }
  }
}
async function search(offset = 0) {
  const asOf = offset ? result.value?.asOf : undefined;
  clear();
  abort = new AbortController();
  const id = generation;
  loading.value = true;
  error.value = "";
  try {
    const { projectId, ...scope } = props;
    const value = await api.request<Results>(
      `/api/projects/${projectId}/diagnostics/search`,
      {
        method: "POST",
        body: JSON.stringify({
          ...scope,
          category: props.category ?? "all",
          term: term.value,
          field: field.value,
          offset,
          limit: 25,
          asOf,
        }),
        cache: "no-store",
        signal: abort.signal,
      },
    );
    if (id === generation) {
      result.value = value;
      void access();
    }
  } catch (e) {
    if (id !== generation) return;
    error.value =
      e instanceof ApiError && [401, 403].includes(e.status)
        ? "无诊断原文搜索权限；请联系项目管理员。"
        : e instanceof ApiError && e.code === "DIAGNOSTICS_SEARCH_TIMEOUT"
          ? "搜索执行超时，请缩短范围后重试。"
          : e instanceof ApiError && e.code === "DIAGNOSTICS_SEARCH_UNAVAILABLE"
            ? "搜索存储暂不可用，请稍后重试；这不是空结果。"
            : "搜索超出预算：限7天、2–128字符、500候选实例、32MiB原文；扫描超限时请缩短范围。";
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      term.value = "";
      allowed.value = false;
    }
  } finally {
    if (id === generation) loading.value = false;
  }
}
watch(
  [term, field],
  () => {
    clear();
    error.value = "";
  },
  { flush: "sync" },
);
const blur = () => {
  clear();
  term.value = "";
  error.value = "";
};
const focus = () => void access();
window.addEventListener("blur", blur);
window.addEventListener("focus", focus);
window.addEventListener("fi:auth-expired", blur);
watch(
  () => JSON.stringify(props),
  () => {
    clear();
    term.value = "";
    error.value = "";
    allowed.value = false;
    void access();
  },
  { immediate: true, flush: "sync" },
);
onBeforeUnmount(() => {
  clear();
  window.removeEventListener("blur", blur);
  window.removeEventListener("focus", focus);
  window.removeEventListener("fi:auth-expired", blur);
});
</script>
<template>
  <section aria-label="授权原文搜索">
    <h3>授权原文搜索</h3>
    <p v-if="!allowed">
      原文搜索需要当前项目 diagnostics.read；普通 viewer 仍可使用上方质量统计。
    </p>
    <form v-else @submit.prevent="search()">
      <label
        >搜索字段
        <select v-model="field">
          <option value="raw">已存诊断原文的全部字符串值</option>
          <option value="message">错误消息</option>
        </select></label
      >
      <label
        >搜索词
        <input
          v-model="term"
          type="search"
          minlength="2"
          maxlength="128"
          required
          autocomplete="off"
      /></label>
      <button :disabled="loading" type="submit">搜索原文</button>
    </form>
    <p>
      服务端字面子串匹配、忽略大小写；覆盖所选项目、环境、版本、类别、路径、错误组与时间范围内的保留原文，最多7天/500候选。未采集、过期、尚未入库的内容不参与。搜索词不保存在链接中。
    </p>
    <p v-if="loading" role="status">正在搜索…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="result">
      <p role="status">
        命中 {{ result.total }} 个实例；范围内 {{ result.candidates }} 个基础实例，其中
        {{ result.searchable }} 个有保留原文。不是全部错误次数。
      </p>
      <ul>
        <li v-for="item in result.items" :key="item.eventId">
          <button type="button" @click="emit('select', item.eventId)">
            查看命中实例 {{ item.timestamp }} · {{ item.category }} ·
            {{ item.context.release ?? "未知 release" }}
          </button>
        </li>
      </ul>
      <button
        type="button"
        :disabled="result.nextOffset === null"
        @click="search(result.nextOffset!)"
      >
        下一页搜索结果
      </button>
    </div>
  </section>
</template>
<style scoped>
section {
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 8px;
}
input,
select,
button {
  min-height: 36px;
}
li {
  margin: 0.5rem 0;
}
</style>
