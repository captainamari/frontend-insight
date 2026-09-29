<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
import { createTracker, type Tracker } from "@frontend-insight/web-tracker";
const appId = ref(new URLSearchParams(location.search).get("efficiencyAppId") ?? ""),
  state = ref("未安装");
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
    businessOperations: { enabled: true, operationKeys: ["save"] },
    flushIntervalMs: 1000,
  });
  tracker.setUser("u_isolated_opaque_0001");
  state.value = "R4-C SDK已就绪";
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
  );
  await tracker.observeBusiness(
    "save",
    async () => response,
    () => "success",
  );
  try {
    await tracker.observeBusiness(
      "save",
      async () => {
        throw new Error("isolated_network");
      },
      () => "rejected",
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
    <label>效率示例appId<input v-model="appId" /></label
    ><button @click="install">安装效率SDK</button
    ><button @click="run">执行表单与业务结果</button>
    <p role="status">{{ state }}</p>
  </section>
</template>
