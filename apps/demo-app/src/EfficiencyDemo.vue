<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
import { createTracker, type Tracker } from "@frontend-insight/web-tracker";
const appId = ref(new URLSearchParams(location.search).get("efficiencyAppId") ?? ""),
  state = ref("未安装"),
  objectReference = ref("");
let tracker: Tracker | null = null;
function install() {
  tracker?.destroy();
  tracker = createTracker({
    appId: appId.value,
    env: "dev",
    release: "r4c-demo",
    endpoint: location.origin + "/v1/events",
    registeredFeatures: ["save"],
    forms: { enabled: true, definitions: [{ formId: "edit", fieldKeys: ["status"] }] },
    initialUserId: "u_isolated_opaque_0001",
    usageCoverage: { enabled: true },
    businessOperations: { enabled: true, operationKeys: ["save"] },
    repeatedOperations: { enabled: true },
    flushIntervalMs: 1000,
  });
  tracker.setUser("u_isolated_opaque_0001");
  state.value = "R4-C SDK已就绪";
}
async function loadReference() {
  try {
    const response = await fetch("http://127.0.0.1:4180/reference");
    if (!response.ok) throw new Error("REFERENCE_UNAVAILABLE");
    objectReference.value = (await response.json()).reference;
    state.value = "短期引用已加载；秘密只在隔离后端";
  } catch {
    state.value = "隔离引用后端未启动或未授权";
  }
}
async function singleOperation() {
  if (!tracker) return;
  await tracker.observeBusiness(
    "save",
    async () => true,
    () => "success",
    objectReference.value || undefined,
  );
  await tracker.flush();
  state.value = "单次受控操作已发送";
}
async function run() {
  if (!tracker) return;
  const form = tracker.trackForm("edit");
  form.change("status");
  form.change("status");
  form.change("status");
  form.reset();
  form.submit().validationFailed();
  form.submit();
  form.destroy();
  const response = new Response(null, { status: 200 });
  await tracker.observeBusiness(
    "save",
    async () => response,
    () => "rejected",
    objectReference.value || undefined,
  );
  await tracker.observeBusiness(
    "save",
    async () => response,
    () => "success",
    objectReference.value || undefined,
  );
  try {
    await tracker.observeBusiness(
      "save",
      async () => {
        throw new Error("isolated_network");
      },
      () => "rejected",
      objectReference.value || undefined,
    );
  } catch {
    /* Preserve the expected host failure; do not upload its message. */
  }
  await tracker.flush();
  state.value = "R4-C受控场景已发送";
}
onBeforeUnmount(() => tracker?.destroy());
</script>
<template>
  <section aria-label="R4-C真实SDK示例">
    <h2>R4-C 操作效率示例</h2>
    <p>
      仅隔离验收：登记action类型edit表单、启用operation
      lifecycle的save，目录使用u_isolated_opaque_0001。不输入真实业务资料。
    </p>
    <button @click="loadReference">从隔离后端获取引用</button>
    <label
      >可信后端短期对象引用（可选）<input v-model="objectReference" autocomplete="off"
    /></label>
    <label>效率示例appId<input v-model="appId" /></label
    ><button @click="install">安装效率SDK</button
    ><button @click="run">执行表单与业务结果</button>
    <button @click="singleOperation">执行一次受控操作</button>
    <p role="status">{{ state }}</p>
  </section>
</template>
