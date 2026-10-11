<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { api, ApiError } from "../api";
const props = defineProps<{ projectId: string; eventId: string | null }>();
interface Detail {
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
    error: Record<string, unknown>;
    extraction: unknown;
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
const labels: Record<string, string> = {
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
let generation = 0,
  abort: AbortController | undefined,
  timer: ReturnType<typeof setTimeout> | undefined;
const show = (value: unknown) =>
  typeof value === "string"
    ? value
    : value === undefined
      ? "未采集"
      : JSON.stringify(value, null, 2);
function clear() {
  generation++;
  abort?.abort();
  clearTimeout(timer);
  result.value = null;
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
    if (value.view) timer = setTimeout(() => void renew(id), 1000);
    else if (["pending", "write_failed"].includes(value.state))
      timer = setTimeout(() => void load(), 3000);
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
    const access = await api.request<{ read: boolean }>(
      `/api/projects/${encodeURIComponent(props.projectId)}/diagnostics/capabilities`,
      { cache: "no-store", ...(abort ? { signal: abort.signal } : {}) },
    );
    if (id !== generation) return;
    if (!access.read) {
      clear();
      status.value = "forbidden";
      return;
    }
    timer = setTimeout(() => void renew(id), 1000);
  } catch {
    if (id === generation) {
      clear();
      status.value = "forbidden";
    }
  }
}
async function copy(kind: "message" | "stack") {
  await load(); // Reauthorize every copy, including after a revoke.
  if (!result.value?.view) return;
  try {
    await navigator.clipboard.writeText(show(result.value.view.error[kind]));
    copied.value = "已复制";
  } catch {
    copied.value = "复制失败，请选择原文手动复制。";
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
