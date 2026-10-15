<script setup lang="ts">
import { computed, ref } from "vue";
import DiagnosticCodeBlock from "./DiagnosticCodeBlock.vue";
const props = defineProps<{
  data:
    | {
        state: string;
        metadata: unknown;
        records: Record<string, unknown>[];
        actions: Record<string, unknown>[];
      }
    | undefined;
  logs: object[];
}>();
defineEmits<{ copy: [] }>();
const filter = ref("all");
const labels: Record<string, string> = {
  legacy: "历史数据没有请求上下文，无法恢复正文。",
  not_enabled: "请求诊断未启用。",
  empty: "回溯窗口内无匹配请求；配置排除和淘汰数量见采集说明。",
  captured: "已冻结异常时的请求上下文。",
  pending: "异常时请求尚未完成",
  host_text_required: "应用尚未提供已读取的原始文本；SDK 不读取或克隆业务流",
  success_body_disabled: "成功请求正文未启用",
  opaque_cors: "浏览器 opaque/CORS 不可读取",
  request_stream_not_read: "Request 内的流未读取",
  stream_not_read: "流式/SSE/NDJSON 未读取",
  binary_not_read: "二进制响应未读取",
  binary_file_form_or_stream: "文件、二进制、FormData 或流未读取",
  not_provided: "应用未提供",
  captured_field: "已采集",
  truncated: "容量裁剪，未读取字节总数未知",
  unreadable_headers: "headers 不可读取",
  unsupported_headers: "不支持此 headers 对象",
  unavailable: "不可获取",
};
const field = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const codeLanguage = (key: string) =>
  ["requestHeaders", "responseHeaders", "requestBody", "responseBody"].includes(key)
    ? "json"
    : "text";
const rows = computed(() =>
  [
    ...(props.data?.records ?? []),
    ...(props.data?.actions ?? []),
    ...props.logs.map((l) => ({ ...l, kind: "console" })),
  ]
    .map((r, index) => ({ r: r as Record<string, unknown>, index }))
    .sort(
      (a, b) =>
        Number(a.r.timestamp) - Number(b.r.timestamp) ||
        Number(a.r.sequence) - Number(b.r.sequence) ||
        a.index - b.index,
    ),
);
const visible = computed(() =>
  rows.value.filter(
    ({ r }) =>
      filter.value === "all" ||
      (filter.value === "failed"
        ? r.kind === "request" && !["success", "pending"].includes(String(r.result))
        : r.kind === filter.value),
  ),
);
const capturedAt = computed(() => field(props.data?.metadata).capturedAt);
</script>
<template>
  <section aria-label="请求与操作时间线">
    <h4>请求与操作时间线</h4>
    <p>{{ labels[data?.state ?? "legacy"] ?? data?.state }}</p>
    <p>
      异常冻结时点：{{ capturedAt ?? "历史未知" }}。pending 证据不会由异常后的回调改写。
    </p>
    <label
      >时间线过滤
      <select v-model="filter" aria-label="时间线过滤">
        <option value="all">全部</option>
        <option value="request">请求</option>
        <option value="failed">失败请求</option>
        <option value="console">console</option>
        <option value="action">操作</option>
        <option value="navigation">导航</option>
      </select></label
    >
    <p>当前过滤：{{ filter }} · 显示 {{ visible.length }} / {{ rows.length }} 条</p>
    <p v-if="rows.length && !visible.length">当前过滤条件下无结果；不代表未采集。</p>
    <button type="button" @click="$emit('copy')">重新授权并复制请求上下文</button>
    <details
      v-for="{ r, index } in visible"
      :key="index"
      :data-testid="r.kind === 'request' ? 'request-record' : 'timeline-record'"
    >
      <summary>
        {{ r.kind }} · #{{ r.sequence }} · 相对异常 {{ r.relativeMs }} ms ·
        {{ r.method ?? r.level ?? field(r.name).value }} {{ r.result }}
      </summary>
      <p>时间：{{ r.timestamp }} · 页面实例：{{ r.pageViewId }}</p>
      <template v-if="r.kind === 'request'">
        <p>
          关联依据：{{
            r.basis === "explicit"
              ? "显式关联"
              : r.basis === "temporal"
                ? "时间邻近（不表示因果）"
                : "无法关联"
          }}
          · 本地观察 ID：{{ r.localId }}
        </p>
        <p>
          开始：{{ r.timestamp }} · 结束：{{ r.endedAt ?? "异常时未完成" }} · 耗时：{{
            r.durationMs ?? "未完成"
          }}
          ms · HTTP：{{ r.status ?? "未获得" }}
        </p>
        <p>
          正文提供时点：{{ r.bodyCapturedAt ?? "未提供" }} · 重定向：{{
            r.redirected ?? "未知"
          }}
        </p>
        <div
          v-for="key in [
            'url',
            'responseUrl',
            'requestHeaders',
            'responseHeaders',
            'requestBody',
            'responseBody',
            'failureReason',
          ]"
          :key="key"
        >
          <h5>{{ key }}</h5>
          <p>
            {{ labels[String(field(r[key]).state)] ?? field(r[key]).state }}
            {{ field(r[key]).reason }}
          </p>
          <DiagnosticCodeBlock
            :value="field(r[key]).value ?? '无可用原文'"
            :language="codeLanguage(key)"
            :label="key"
            :line-numbers="!['url', 'responseUrl'].includes(key)"
          />
          <p v-if="field(r[key]).state === 'truncated'">
            已保留 JSON 值字节：{{ field(r[key]).bytes }}；省略字节{{
              field(r[key]).omittedBytesExact === false ? "下界" : ""
            }}：{{ field(r[key]).omittedBytes ?? "未知" }}
          </p>
        </div>
        <h5>request / trace / operation / workflow instance / step / attempt</h5>
        <DiagnosticCodeBlock :value="r.association" language="json" label="关联标识" />
      </template>
      <DiagnosticCodeBlock v-else :value="r" language="json" label="时间线事件" />
    </details>
    <details>
      <summary>请求采集与预算说明</summary>
      <p>
        window：窗口淘汰；capacity：条数或并发上限；bytes：字节淘汰；scope：页面切换；excluded：配置/SDK/上传排除；envelopeOmitted：总信封裁剪。不将这些情况视作基础错误或请求计数减少。
      </p>
      <DiagnosticCodeBlock
        :value="data?.metadata"
        language="json"
        label="请求采集元数据"
      />
    </details>
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
details,
h5 {
  margin-top: 12px;
}
</style>
