<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
import { createTracker, type Tracker } from "@frontend-insight/web-tracker";
import { createDiagnosticPolicy } from "@frontend-insight/web-tracker/policy";
const appId = ref(new URLSearchParams(location.search).get("d6AppId") ?? "");
const state = ref<unknown>("填写隔离项目appId，再初始化"),
  events = ref<string[]>([]),
  offline = ref(false);
let tracker: Tracker | undefined,
  policy: ReturnType<typeof createDiagnosticPolicy> | undefined;
function snapshot() {
  return { ...policy?.status(), transport: tracker?.getDiagnostics() };
}
function install() {
  tracker?.destroy();
  policy?.destroy();
  events.value = [];
  policy = createDiagnosticPolicy({
    appId: appId.value,
    env: "dev",
    endpoint: location.origin + "/v1/events",
    console: { levels: ["error", "warn", "info"] },
    requests: { successBodyRoutes: ["/api/demo/controlled"] },
  });
  tracker = createTracker({
    appId: appId.value,
    env: "dev",
    release: "d6-lab",
    endpoint: location.origin + "/v1/events",
    errorDiagnostics: policy.errorDiagnostics,
    observability: { enabled: true, captureWebVitals: false },
    runtime: {
      window,
      document,
      navigator: {
        userAgent: navigator.userAgent,
        sendBeacon: navigator.sendBeacon.bind(navigator),
      },
      crypto: globalThis.crypto,
      now: Date.now,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      fetch: async (input, init) => {
        if (offline.value && String(input).endsWith("/workflow-config"))
          throw new Error("SYNTHETIC_CONFIG_OFFLINE");
        return fetch(input, init);
      },
    },
    beforeSend({ event }) {
      if (event.diagnostic) events.value = [...events.value, event.eventId].slice(-25);
      return event;
    },
  });
  if (tracker.getDiagnostics().state !== "active") policy.destroy();
  state.value = snapshot();
}
async function sync() {
  await policy?.sync();
  state.value = snapshot();
}
async function capture(stress = false) {
  if (!tracker) return;
  console.warn("D6 synthetic context token=fixture");
  for (let i = 0; i < (stress ? 25 : 1); i++)
    tracker.captureException(
      new Error(stress ? "D6 " + "大".repeat(20000) : "D6 policy synthetic error"),
    );
  await tracker.flush();
  state.value = snapshot();
}
onBeforeUnmount(() => {
  tracker?.destroy();
  policy?.destroy();
});
</script>
<template>
  <section class="panel" aria-label="D6 策略实验室">
    <h2>D6 策略与运行维护实验</h2>
    <p>
      使用独立测试项目，Origin包含本页地址。管理端“设置 →
      诊断策略与维护”发布策略，再在此同步并触发真实错误。
    </p>
    <label>实验项目 appId<input v-model="appId" /></label
    ><button @click="install">初始化 D6 SDK</button
    ><button @click="sync">同步 D6 策略</button
    ><label
      ><input
        v-model="offline"
        type="checkbox"
      />模拟策略网络失败（只影响本实例配置请求）</label
    >
    <button @click="capture()">D6 日志后错误</button
    ><button @click="capture(true)">D6 截断与限流</button
    ><button
      @click="
        tracker?.destroy();
        policy?.destroy();
        state = snapshot();
      "
    >
      销毁 D6 SDK
    </button>
    <pre data-testid="d6-policy-state">{{ JSON.stringify(state, null, 2) }}</pre>
    <p>
      关闭/开启在管理端发布；此处只显示本客户端实际观测。断网失败保持最后有效配置。撤权、单实例删除和过期在管理页验证；D5源码定位沿用下方真实压缩场景。
    </p>
    <ol>
      <li v-for="id in events" :key="id">
        <code>{{ id }}</code>
      </li>
    </ol>
  </section>
</template>
