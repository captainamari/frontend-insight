<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount } from "vue";
import {
  createTracker,
  type Tracker,
  type WorkflowDefinition,
} from "@frontend-insight/web-tracker";
const appId = ref(new URLSearchParams(location.search).get("workflowAppId") ?? "");
const state = ref("填写专用示例项目appId并加载已激活定义"),
  rendered = ref<number | null>(null),
  ready = ref(false);
let tracker: Tracker | null = null;
const downloads = new Set<AbortController>();
async function install() {
  ready.value = false;
  tracker?.destroy();
  try {
    const response = await fetch("/v1/events/workflow-config", {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: appId.value, env: "dev" }),
    });
    if (!response.ok) throw new Error("CONFIG_UNAVAILABLE");
    const config = (await response.json()) as {
      definitions: WorkflowDefinition[];
      operationKeys: string[];
    };
    tracker = createTracker({
      appId: appId.value,
      env: "dev",
      release: "r4b-demo",
      endpoint: location.origin + "/v1/events",
      registeredFeatures: config.operationKeys,
      workflowDefinitions: config.definitions,
      flushIntervalMs: 1000,
    });
    tracker.setUser("demo-workflow-reference");
    ready.value = true;
    state.value = "示例SDK已就绪";
  } catch {
    state.value = "配置加载失败：检查项目、Origin及激活定义";
  }
}
async function property() {
  const workflow = tracker?.startWorkflow("dashboard_property_view");
  if (!workflow) return;
  try {
    workflow.reachStep("property_selected");
    const response = await fetch("/workflow-demo-data.json");
    if (!response.ok) throw new Error();
    const data = (await response.json()) as { value?: number };
    if (!Number.isFinite(data.value)) throw new Error();
    workflow.reachStep("data_loaded");
    rendered.value = data.value!;
    await nextTick();
    workflow.reachStep("property_rendered");
    state.value = "属性数据已校验并渲染";
  } catch {
    workflow.fail();
    state.value = "属性加载或渲染失败";
  }
  await tracker?.flush();
}
async function download() {
  const workflow = tracker?.startWorkflow("admin_model_download");
  if (!workflow) return;
  const abort = new AbortController();
  downloads.add(abort);
  const operation = workflow.startOperation("model_download");
  try {
    workflow.reachStep("download_requested");
    const response = await fetch("/workflow-demo-model.txt", { signal: abort.signal });
    if (!response.ok || !response.body) throw new Error();
    workflow.reachStep("request_accepted");
    const reader = response.body.getReader();
    let started = false,
      bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!started) {
        started = true;
        workflow.reachStep("transfer_started");
      }
      bytes += chunk.value.byteLength;
    }
    if (!bytes) throw new Error();
    operation.succeed();
    state.value = "响应流已全部接收；不代表浏览器保存或操作系统落盘";
  } catch {
    if (abort.signal.aborted) {
      operation.cancel();
      workflow.cancel();
      state.value = "用户主动取消";
    } else {
      operation.fail("transfer_failed");
      workflow.fail();
      state.value = "传输失败";
    }
  } finally {
    downloads.delete(abort);
    await tracker?.flush();
  }
}
function cancel() {
  for (const abort of downloads) abort.abort();
}
onBeforeUnmount(() => {
  cancel();
  tracker?.destroy();
});
</script>
<template>
  <section aria-label="R4-B受控工作流示例">
    <h2>多阶段工作流示例</h2>
    <p>
      管理员先配置 dashboard_property_view 与
      admin_model_download；事件发送到填写的专用项目。到业务分析选择所属模块查看。
    </p>
    <label>工作流示例appId <input v-model="appId" aria-label="工作流示例appId" /></label
    ><button @click="install">加载工作流配置</button>
    <p role="status">{{ state }}</p>
    <button :disabled="!ready" @click="property">选择属性并加载渲染</button
    ><output aria-label="属性渲染结果">{{ rendered ?? "尚未加载" }}</output>
    <button :disabled="!ready" @click="download">开始受控模型传输</button
    ><button
      :disabled="!ready"
      @click="
        () => {
          void download();
          void download();
          void download();
        }
      "
    >
      并发三个传输</button
    ><button @click="cancel">主动取消传输</button>
  </section>
</template>
