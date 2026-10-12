<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import RequestTimeline from "./RequestTimeline.vue";
import { api, ApiError } from "../api";
const props = defineProps<{ projectId: string; eventId: string | null }>();
interface Detail {
  occurrence?: {
    timestamp: string;
    category: string;
    context: { env: string; release: string | null };
  };
  state: string;
  expiresAt: string | null;
  legacy?: boolean;
  capture?: {
    status: string;
    source: string;
    omittedBytes: number;
    suppressed: number;
    policyVersion: string;
  };
  view?: {
    requests?: {
      state: string;
      metadata: unknown;
      records: Record<string, unknown>[];
      actions: Record<string, unknown>[];
    };
    error: Record<string, unknown>;
    extraction: unknown;
    console?: { state: string; metadata: unknown; records: ConsoleRecord[] };
    stack: {
      state: string;
      unparsed: number;
      frames: {
        raw: string;
        function: string | null;
        file: string | null;
        line: number | null;
        column: number | null;
        native: boolean;
        eval: boolean;
        async: boolean;
      }[];
    };
  };
}
interface ConsoleRecord {
  level?: string;
  timestamp?: number;
  relativeMs?: number;
  sequence?: number;
  pageViewId?: string;
  source?: string;
  parameters?: unknown[];
  issues?: string[];
  omittedBytes?: number;
  omittedBytesExact?: boolean;
}
const consoleFilter = ref("all");
const consoleLabels: Record<string, string> = {
  not_enabled: "console 上下文未启用。",
  empty: "回溯窗口内没有匹配配置级别的日志。",
  legacy: "历史记录没有 console 采集状态，无法恢复未采集的日志。",
  scope_conflict:
    "多个项目声明拥有全局 console，已停止采集并清空缓冲。请明确页面归属。",
  unavailable: "此环境的 console 不可访问或不可包装。",
  captured: "已采集异常前的 console 上下文。",
};
const visibleLogs = computed(() =>
  (result.value?.view?.console?.records ?? []).filter(
    (record) => consoleFilter.value === "all" || record?.level === consoleFilter.value,
  ),
);
const labels: Record<string, string> = {
  not_found: "此项目中实例不存在，或基础事实已超过保留期。",
  ready: "诊断详情已就绪",
  complete: "采集完整",
  parsed: "编译栈已解析",
  partial: "部分栈帧无法解析，原文仍保留",
  not_enabled: "该历史事件或接入未启用原文诊断；不能恢复此前删除或脱敏的信息。",
  not_applicable: "不适用 JS 调用栈",
  unavailable: "未获得可用详情或调用栈。",
  parse_failed: "无法解析栈格式，请查看原始编译栈。",
  truncated: "诊断已截断或省略部分内容，请查看采集说明。",
  pending: "诊断正在写入，请稍后重试。",
  expired: "诊断已超过保留期限。",
  forbidden: "无诊断详情权限，或当前项目成员关系已失效。",
  write_failed: "诊断写入失败，服务正在重试；基础错误仍计数。",
  rate_limited: "详情采集已限流，基础错误仍计数。",
  too_large: "详情超过容量限制，基础错误仍计数。",
};
const result = ref<Detail | null>(null),
  status = ref("pending"),
  copied = ref("");
const canExport = ref(false);
let downloadUrl: string | undefined;
let downloadAbort: AbortController | undefined;
let generation = 0,
  abort: AbortController | undefined,
  timer: ReturnType<typeof setTimeout> | undefined;
const timestampText = (value: unknown) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > 8640000000000000
  )
    return "时间未知";
  return new Date(value).toISOString();
};
const issuesFor = (record: ConsoleRecord) =>
  Array.isArray(record?.issues) ? record.issues : [];
const show = (value: unknown) =>
  typeof value === "string"
    ? value
    : value === undefined
      ? "未采集"
      : JSON.stringify(value, null, 2);
function clear() {
  generation++;
  abort?.abort();
  downloadAbort?.abort();
  clearTimeout(timer);
  result.value = null;
  canExport.value = false;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
  copied.value = "";
}
async function load() {
  clear();
  if (!props.eventId) {
    status.value = "not_enabled";
    return;
  }
  const id = generation;
  abort = new AbortController();
  status.value = "pending";
  try {
    const value = await api.request<Detail>(
      `/api/projects/${encodeURIComponent(props.projectId)}/diagnostics/instances/${encodeURIComponent(props.eventId)}`,
      { signal: abort.signal, cache: "no-store" },
    );
    if (id !== generation) return;
    result.value = value;
    status.value = value.state;
    // Renew access without rebuilding expanded content; never cache across scope changes.
    void capabilities(id);
    if (value.view) timer = setTimeout(() => void renew(id), 1000);
    else if (["pending", "write_failed"].includes(value.state))
      timer = setTimeout(() => void load(), 3000);
    return id;
  } catch (e) {
    if (id !== generation) return;
    result.value = null;
    status.value =
      e instanceof ApiError && [401, 403].includes(e.status)
        ? "forbidden"
        : "unavailable";
  }
}
async function renew(id: number) {
  if (result.value?.expiresAt && Date.parse(result.value.expiresAt) <= Date.now()) {
    await load();
    return;
  }
  try {
    const access = await api.request<{ read: boolean; export: boolean }>(
      `/api/projects/${encodeURIComponent(props.projectId)}/diagnostics/capabilities`,
      { cache: "no-store", ...(abort ? { signal: abort.signal } : {}) },
    );
    if (id !== generation) return;
    if (!access.read) {
      clear();
      status.value = "forbidden";
      return;
    }
    canExport.value = access.export;
    if (!access.export) downloadAbort?.abort();
    timer = setTimeout(() => void renew(id), 1000);
  } catch {
    if (id === generation) {
      clear();
      status.value = "forbidden";
    }
  }
}
async function capabilities(id: number) {
  try {
    const access = await api.request<{ read: boolean; export: boolean }>(
      `/api/projects/${props.projectId}/diagnostics/capabilities`,
      { cache: "no-store", ...(abort ? { signal: abort.signal } : {}) },
    );
    if (id !== generation) return;
    canExport.value = access.read && access.export;
    if (!access.read) {
      clear();
      status.value = "forbidden";
    }
  } catch {
    if (id === generation) {
      clear();
      status.value = "forbidden";
    }
  }
}
async function link() {
  const id = await load();
  if (
    id !== generation ||
    !result.value ||
    ["forbidden", "not_found"].includes(status.value)
  )
    return;
  const url = new URL(
    `/projects/${encodeURIComponent(props.projectId)}/diagnostics/${encodeURIComponent(props.eventId!)}`,
    location.origin,
  ).href;
  try {
    await navigator.clipboard.writeText(url);
    if (id === generation) copied.value = "实例链接已复制";
  } catch {
    if (id === generation) copied.value = "链接复制失败";
  }
}
async function download(format: "json" | "text") {
  downloadAbort?.abort();
  downloadAbort = new AbortController();
  const id = generation,
    project = props.projectId,
    event = props.eventId;
  try {
    const blob = await api.download(
      `/api/projects/${project}/diagnostics/instances/${event}/export`,
      {
        method: "POST",
        body: JSON.stringify({ format }),
        cache: "no-store",
        signal: downloadAbort.signal,
      },
    );
    if (id !== generation) return;
    downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `diagnostic-${event}.${format === "json" ? "json" : "txt"}`;
    anchor.click();
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = undefined;
    copied.value = "证据已下载；已交付文件无法远程收回。";
  } catch (e) {
    if (id !== generation) return;
    await load();
    copied.value =
      e instanceof ApiError && e.status === 403
        ? "无导出权限；需要 read 和 export。"
        : "下载失败：实例不存在、已过期或超过预算，请核对状态。";
  }
}
async function copy(kind: "message" | "stack" | "console" | "requests") {
  const id = await load(); // Reauthorize every copy, including after a revoke.
  if (id !== generation || !result.value?.view) return;
  try {
    await navigator.clipboard.writeText(
      kind === "requests"
        ? JSON.stringify(result.value.view.requests, null, 2)
        : kind === "console"
          ? JSON.stringify(
              {
                filter: consoleFilter.value,
                records: visibleLogs.value,
                metadata: result.value.view.console?.metadata,
              },
              null,
              2,
            )
          : show(result.value.view.error[kind]),
    );
    if (id === generation) copied.value = "已复制";
  } catch {
    if (id === generation) copied.value = "复制失败，请选择原文手动复制。";
  }
}
const blur = () => {
  clear();
  status.value = "pending";
};
const focus = () => void load();
window.addEventListener("blur", blur);
window.addEventListener("focus", focus);
window.addEventListener("fi:auth-expired", blur);
watch(() => [props.projectId, props.eventId], load, { immediate: true, flush: "sync" });
onBeforeUnmount(() => {
  clear();
  window.removeEventListener("blur", blur);
  window.removeEventListener("focus", focus);
  window.removeEventListener("fi:auth-expired", blur);
});
</script>
<template>
  <section aria-label="授权错误诊断">
    <h3>错误诊断详情</h3>
    <p role="status">{{ labels[status] ?? status }}</p>
    <button type="button" @click="load">重新授权并读取</button>
    <p v-if="result?.occurrence">
      {{ result.occurrence.timestamp }} · {{ result.occurrence.category }} ·
      {{ result.occurrence.context.env }} ·
      {{ result.occurrence.context.release ?? "未知 release" }}
    </p>
    <div v-if="result && status !== 'not_found'">
      <button type="button" @click="link">复制稳定实例链接</button>
      <button
        type="button"
        :disabled="!canExport || status === 'expired'"
        @click="download('json')"
      >
        下载 JSON 证据
      </button>
      <button
        type="button"
        :disabled="!canExport || status === 'expired'"
        @click="download('text')"
      >
        下载文本证据
      </button>
      <p v-if="!canExport">
        导出需要 diagnostics.read 和 diagnostics.export；只读授权仍可查看详情。
      </p>
    </div>
    <p role="status">{{ copied }}</p>
    <p v-if="result?.legacy">
      历史已存摘要：以下内容可能已脱敏、仅有首帧或不完整，不代表原始完整错误。
    </p>
    <template v-if="result?.capture">
      <p>{{ labels[result.capture.status] ?? result.capture.status }}</p>
      <p>
        来源：{{ result.capture.source }} · 策略：{{ result.capture.policyVersion }} ·
        已省略字节：{{ result.capture.omittedBytes }} · 已抑制详情：{{
          result.capture.suppressed
        }}
      </p>
    </template>
    <template v-if="result?.view">
      <h4>错误名称</h4>
      <pre>{{ show(result.view.error.name) }}</pre>
      <h4>原始错误消息</h4>
      <pre data-testid="diagnostic-message">{{ show(result.view.error.message) }}</pre>
      <button type="button" @click="copy('message')">复制错误消息</button>
      <p>{{ labels[result.view.stack.state] ?? result.view.stack.state }}</p>
      <template v-if="result.view.error.resourceUrl !== undefined"
        ><h4>资源地址</h4>
        <pre>{{ show(result.view.error.resourceUrl) }}</pre>
      </template>
      <details open>
        <summary>原始编译栈</summary>
        <pre data-testid="diagnostic-stack">{{ show(result.view.error.stack) }}</pre>
        <button type="button" @click="copy('stack')">复制编译栈</button>
      </details>
      <table v-if="result.view.stack.frames.length" aria-label="结构化栈帧">
        <thead>
          <tr>
            <th>函数</th>
            <th>文件</th>
            <th>行:列</th>
            <th>类型</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(frame, i) in result.view.stack.frames" :key="i">
            <td>{{ frame.function ?? "匿名函数" }}</td>
            <td>{{ frame.file ?? "native" }}</td>
            <td>{{ frame.line }}:{{ frame.column }}</td>
            <td>
              {{
                [frame.async && "async", frame.eval && "eval", frame.native && "native"]
                  .filter(Boolean)
                  .join(" ")
              }}
            </td>
          </tr>
        </tbody>
      </table>
      <details v-if="result.view.error.cause !== undefined">
        <summary>cause 原因链（有界）</summary>
        <pre>{{ show(result.view.error.cause) }}</pre>
      </details>
      <details v-if="result.view.error.errors !== undefined">
        <summary>AggregateError 子错误（有界）</summary>
        <pre>{{ show(result.view.error.errors) }}</pre>
      </details>
      <details>
        <summary>完整已采集错误与截断说明</summary>
        <pre>{{ show(result.view.error) }}</pre>
        <pre>{{ show(result.view.extraction) }}</pre>
      </details>
      <section aria-label="console 上下文">
        <h4>console 上下文</h4>
        <p>
          {{
            consoleLabels[result.view.console?.state ?? "legacy"] ??
            result.view.console?.state
          }}
        </p>
        <label
          >日志级别过滤
          <select v-model="consoleFilter" aria-label="日志级别过滤">
            <option value="all">全部已采集级别</option>
            <option
              v-for="level in ['error', 'warn', 'log', 'info', 'debug']"
              :key="level"
              :value="level"
            >
              {{ level }}
            </option>
          </select>
        </label>
        <p>
          当前过滤：{{ consoleFilter === "all" ? "全部已采集级别" : consoleFilter }} ·
          显示 {{ visibleLogs.length }} /
          {{ result.view.console?.records.length ?? 0 }} 条
        </p>
        <p v-if="result.view.console?.records.length && !visibleLogs.length">
          当前过滤条件下无结果；其他级别已有日志。
        </p>
        <button type="button" @click="copy('console')">重新授权并复制 console</button>
        <details
          v-for="(record, index) in visibleLogs"
          :key="index"
          open
          data-testid="console-record"
        >
          <summary>
            {{ record?.level ?? "unknown" }} · #{{ record?.sequence ?? index + 1 }} ·
            {{ timestampText(record?.timestamp) }}
            · 相对异常 {{ record?.relativeMs ?? "未知" }} ms
          </summary>
          <p>
            页面：{{ record?.pageViewId ?? "unknown" }} · 来源：{{
              record?.source ?? "unknown"
            }}
          </p>
          <pre>{{ show(record?.parameters ?? record) }}</pre>
          <p v-if="issuesFor(record).length">
            截断 / 省略 / 不可读取：{{ issuesFor(record).join("、") }} · 已知省略字节{{
              record.omittedBytesExact === false ? "下界" : ""
            }}：{{ record.omittedBytes ?? "未知" }}
          </p>
        </details>
        <details>
          <summary>console 采集与窗口淘汰说明</summary>
          <p>
            window：窗口外淘汰；capacity：条数淘汰；bytes：总字节淘汰；scope：归属冲突清空；entry：记录预算不足；envelopeOmitted：信封容量不足。omittedBytesExact=false
            表示仅有省略字节下界，未遍历内容不能精确计量。
          </p>
          <pre>{{ show(result.view.console?.metadata) }}</pre>
        </details>
      </section>
      <RequestTimeline
        :data="result.view.requests"
        :logs="result.view.console?.records ?? []"
        @copy="copy('requests')"
      />
      <p role="status">{{ copied }}</p>
    </template>
  </section>
</template>
<style scoped>
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 24rem;
  overflow: auto;
  padding: 8px;
  background: var(--surface);
}
table {
  width: 100%;
  table-layout: fixed;
}
td {
  overflow-wrap: anywhere;
  vertical-align: top;
}
details,
h4 {
  margin-top: 12px;
}
</style>
