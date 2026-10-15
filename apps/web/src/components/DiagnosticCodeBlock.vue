<script setup lang="ts">
import { computed, ref } from "vue";
import {
  diagnosticCodeText,
  tokenizeDiagnosticCode,
  type DiagnosticCodeLanguage,
} from "../diagnostic-code";

interface SourceLine {
  line: number;
  text: string;
}

const props = withDefaults(
  defineProps<{
    value?: unknown;
    lines?: SourceLine[];
    language?: DiagnosticCodeLanguage;
    label?: string;
    lineNumbers?: boolean;
    highlightLine?: number | null;
    testId?: string;
  }>(),
  {
    language: "text",
    label: "文本",
    lineNumbers: true,
    highlightLine: null,
  },
);

const wrapped = ref(true);
const renderedLines = computed(() => {
  const lines = props.lines?.length
    ? props.lines
    : diagnosticCodeText(props.value)
        .split("\n")
        .map((text, index) => ({ line: index + 1, text }));
  return lines.map((line) => ({
    ...line,
    tokens: tokenizeDiagnosticCode(line.text, props.language),
  }));
});
</script>

<template>
  <div class="diagnostic-code-viewer" :data-language="language">
    <div class="diagnostic-code-toolbar">
      <span>{{ label }}</span>
      <button
        type="button"
        class="diagnostic-code-wrap"
        :aria-pressed="wrapped"
        @click="wrapped = !wrapped"
      >
        {{ wrapped ? "关闭换行" : "自动换行" }}
      </button>
    </div>
    <pre :class="{ wrapped }"><code
      :data-testid="testId"
      :aria-label="label"
      :class="{ 'with-line-numbers': lineNumbers }"
    ><template v-for="(line, index) in renderedLines" :key="`${line.line}-${index}`"><span
      class="diagnostic-code-line"
      :class="{ active: line.line === highlightLine }"
      :data-line="line.line"
    ><span
      v-for="(part, tokenIndex) in line.tokens"
      :key="tokenIndex"
      class="diagnostic-code-token"
      :class="`token-${part.kind}`"
      :data-token="part.kind"
    >{{ part.text }}</span></span>{{ index + 1 < renderedLines.length ? "\n" : "" }}</template></code></pre>
  </div>
</template>

<style scoped>
.diagnostic-code-viewer {
  margin: 8px 0;
  overflow: hidden;
  color: #dce8f3;
  background: #142536;
  border: 1px solid #2d4358;
  border-radius: 8px;
}

.diagnostic-code-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 0 10px 0 14px;
  color: #9db2c7;
  font:
    600 11px/1.4 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  letter-spacing: 0.04em;
  background: #1b3044;
  border-bottom: 1px solid #2d4358;
}

.diagnostic-code-wrap {
  padding: 4px 7px;
  color: #c7d7e7;
  font: inherit;
  cursor: pointer;
  background: transparent;
  border: 1px solid #496078;
  border-radius: 4px;
}

.diagnostic-code-wrap:hover,
.diagnostic-code-wrap:focus-visible {
  color: #fff;
  border-color: #7fa6c9;
  outline: none;
}

pre {
  max-height: 24rem;
  padding: 12px 0;
  margin: 0;
  overflow: auto;
  font:
    12px/1.65 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  tab-size: 2;
}

code {
  display: block;
  min-width: max-content;
}

pre.wrapped code {
  min-width: 0;
}

.diagnostic-code-line {
  display: block;
  min-height: 1.65em;
  padding: 0 14px;
  white-space: pre;
}

pre.wrapped .diagnostic-code-line {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.diagnostic-code-line.with-line-numbers,
code.with-line-numbers .diagnostic-code-line {
  padding-left: 0;
}

code.with-line-numbers .diagnostic-code-line::before {
  display: inline-block;
  width: 3.5em;
  padding-right: 1em;
  color: #647d94;
  text-align: right;
  content: attr(data-line);
  user-select: none;
}

.diagnostic-code-line.active {
  background: rgb(255 207 86 / 12%);
  box-shadow: inset 3px 0 #ffcf56;
}

.token-comment {
  color: #7f9b91;
  font-style: italic;
}

.token-function {
  color: #82d2ff;
}

.token-keyword {
  color: #d9a7ff;
}

.token-number {
  color: #ffc978;
}

.token-path,
.token-string {
  color: #9fd58f;
}

.token-property {
  color: #7ed7da;
}

.token-punctuation {
  color: #90a4b7;
}
</style>
