<script setup lang="ts">
import { createTracker } from "@frontend-insight/web-tracker";
import type { Tracker, TrackerEvent } from "@frontend-insight/web-tracker";
import { computed, onBeforeUnmount, reactive, ref } from "vue";

type Scene = "data" | "action" | "wallboard" | "observability";
type ResultKind = "success" | "cancel" | "failure";

interface EventEntry {
  id: number;
  at: string;
  eventName: string;
  featureKey: string | null;
  reasonCode: string | null;
  detail: string;
}

const tokenKey = "fi-demo.simulated-token";
const analyticsRef = "demo-operator-001";
const projectKey = import.meta.env.VITE_PROJECT_KEY ?? "fi_public_m1demo001";
const acceptanceFast =
  new URLSearchParams(window.location.search).get("acceptance") === "fast";
const loginForm = reactive({ username: "demo.operator", password: "" });
const authenticated = ref(Boolean(sessionStorage.getItem(tokenKey)));
const scene = ref<Scene>(sceneFromPath());
const busy = ref(false);
const eventLog = ref<EventEntry[]>([]);
const wallboardSeconds = ref(0);
const wallboardActive = ref(false);
let tracker: Tracker | null = null;
let stopLongView: (() => void) | null = null;
let wallboardTimer: number | null = null;
let nextEventId = 1;

const scenes: Array<{ key: Scene; label: string; description: string }> = [
  { key: "data", label: "数据与图表", description: "请求成功且渲染完成" },
  { key: "action", label: "业务操作", description: "开始、取消、失败与成功" },
  { key: "wallboard", label: "持续展示", description: "前台可见阈值与心跳" },
  {
    key: "observability",
    label: "错误与性能",
    description: "M8 脱敏与版本证据",
  },
];
const simulatedToken = computed(() => sessionStorage.getItem(tokenKey) ?? "");
const maskedToken = computed(() => {
  const token = simulatedToken.value;
  return token ? `${token.slice(0, 8)}••••${token.slice(-4)}` : "未创建";
});
const diagnostics = computed(() => tracker?.getDiagnostics());

function sceneFromPath(): Scene {
  if (window.location.pathname.includes("action")) return "action";
  if (window.location.pathname.includes("wallboard")) return "wallboard";
  if (window.location.pathname.includes("observability"))
    return "observability";
  return "data";
}

function describe(event: Readonly<TrackerEvent>): string {
  if (event.eventName === "feature_started")
    return "只表示开始，不计入成功使用";
  if (event.eventName === "feature_succeeded") {
    return event.properties.visibleDurationMs
      ? `达到前台可见阈值，累计 ${event.properties.visibleDurationMs} ms`
      : "业务成功条件已确认";
  }
  if (event.eventName === "feature_failed") {
    return `未计入成功，原因：${event.reasonCode ?? "unknown"}`;
  }
  if (event.eventName === "feature_canceled") {
    return `用户明确取消，原因：${event.reasonCode ?? "user_cancelled"}`;
  }
  if (event.eventName === "feature_long_view_heartbeat") {
    return `前台可见心跳 ${event.properties.visibleDurationMs ?? 0} ms`;
  }
  if (event.eventName === "feature_long_view_ended") {
    return `持续展示结束，累计 ${event.properties.visibleDurationMs ?? 0} ms`;
  }
  if (event.eventName === "feature_exposed") return "功能入口已实际呈现";
  if (event.eventName === "page_view") return "归一化页面访问";
  if (event.eventName === "page_leave") return "前台可见停留结算";
  if (event.eventName === "error_js") return "JS 错误已裁剪并按稳定首帧聚类";
  if (event.eventName === "error_api") return "API 路径已去参数并归一化动态 ID";
  if (event.eventName === "error_resource")
    return "资源失败只保留类型和脱敏路径";
  if (event.eventName === "web_vital") return "性能样本按固定阈值标记等级";
  return "标准事件";
}

function record(event: Readonly<TrackerEvent>): void {
  eventLog.value.unshift({
    id: nextEventId++,
    at: new Date().toISOString(),
    eventName: event.eventName,
    featureKey: event.featureKey ?? null,
    reasonCode: event.reasonCode ?? null,
    detail: describe(event),
  });
  if (eventLog.value.length > 80) eventLog.value.pop();
}

function initializeTracker(): void {
  if (tracker) return;
  tracker = createTracker({
    projectKey,
    endpoint: `${window.location.origin}/v1/events`,
    releaseVersion: "2026.08.1-demo",
    deploymentEnvironment: "production",
    projectTimezone: "UTC",
    registeredFeatures: [
      "sales_dashboard",
      "report_export",
      "data_import",
      "settings_save",
      "command_dispatch",
      "operations_wallboard",
    ],
    staticProperties: { demo: true },
    longViewSuccessAfterMs: acceptanceFast ? 1_000 : 30_000,
    longViewHeartbeatMs: acceptanceFast ? 1_000 : 60_000,
    flushIntervalMs: 2_000,
    development: true,
    observability: {
      enabled: true,
      captureJsErrors: true,
      captureResourceErrors: true,
      captureWebVitals: true,
      captureApiErrors: false,
    },
    collectors: {
      api: { enabled: true, sampleRate: 1 },
      resources: { enabled: true, sampleRate: 1 },
      firstScreen: { enabled: true, sampleRate: 1 },
      listRender: { enabled: true, sampleRate: 1 },
      longTasks: { enabled: true, sampleRate: 1 },
      blankScreen: { enabled: true, sampleRate: 1 },
      breadcrumbs: {
        enabled: true,
        sampleRate: 1,
        allowedActionKeys: ["demo_action"],
      },
    },
    beforeSend: ({ event }) => {
      record(event);
      return {
        ...event,
        properties: { ...event.properties },
      };
    },
  });
  tracker.setAccount(analyticsRef);
  exposeForTests();
  window.setTimeout(() => exposeScene(scene.value), 0);
}

function exposeForTests(): void {
  Object.assign(window, {
    __fiDemo: {
      get events() {
        return eventLog.value;
      },
      get diagnostics() {
        return tracker?.getDiagnostics();
      },
      flush: () => tracker?.flush(),
      simulatedToken: sessionStorage.getItem(tokenKey),
      analyticsRef,
    },
  });
}

function login(): void {
  if (!loginForm.username || !loginForm.password) return;
  sessionStorage.setItem(
    tokenKey,
    `demo_session_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  authenticated.value = true;
  initializeTracker();
}

function logout(): void {
  stopWallboard();
  tracker?.destroy();
  tracker = null;
  sessionStorage.removeItem(tokenKey);
  authenticated.value = false;
  eventLog.value = [];
}

function exposeScene(value: Scene): void {
  if (!tracker) return;
  if (value === "data") tracker.featureExposed("sales_dashboard");
  if (value === "action") {
    for (const key of [
      "report_export",
      "data_import",
      "settings_save",
      "command_dispatch",
    ]) {
      tracker.featureExposed(key);
    }
  }
  if (value === "wallboard") tracker.featureExposed("operations_wallboard");
}

async function captureObservability(
  kind: "js" | "api" | "resource" | "vital" | "readiness" | "list",
): Promise<void> {
  if (!tracker || busy.value) return;
  busy.value = true;
  try {
    if (kind === "js") {
      const error = new TypeError(
        "Chart render failed for operator@example.invalid with Bearer private-token",
      );
      error.stack =
        "TypeError: chart render failed\n    at renderChart (https://park.invalid/assets/app.js:10:20?token=secret)";
      tracker.captureException(error);
    }
    if (kind === "api") {
      const details = {
        method: "GET",
        url: "https://park.invalid/api/budgets/984321?token=secret",
        statusCode: 503,
        durationMs: 850,
      } as const;
      tracker.captureApiError(details);
      tracker.captureApiRequest(details);
    }
    if (kind === "resource") {
      tracker.captureResourceError({
        resourceType: "script",
        url: "https://park.invalid/assets/energy-chunk.js?signature=secret",
      });
      tracker.captureResourceRequest({
        resourceType: "script",
        url: "https://park.invalid/assets/energy-chunk.js?signature=secret",
        succeeded: false,
        durationMs: 420,
      });
    }
    if (kind === "vital") {
      tracker.captureWebVital({
        name: "LCP",
        value: 4_200,
        navigationType: "navigate",
      });
    }
    if (kind === "readiness") {
      tracker.markPageReady({
        templateKey: "analysis_view",
        blankCandidate: false,
      });
    }
    if (kind === "list") {
      const finish = tracker.startListRender("demo-list", 1_200);
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      finish();
    }
    await tracker.flush();
  } finally {
    busy.value = false;
  }
}

function changeScene(value: Scene): void {
  if (scene.value === "wallboard") stopWallboard();
  scene.value = value;
  history.pushState({}, "", `/${value}${window.location.search}`);
  exposeScene(value);
}

async function runData(kind: "success" | "api_failure" | "render_failure") {
  if (!tracker) return;
  busy.value = true;
  tracker.featureExposed("sales_dashboard", { scenario: kind });
  await new Promise((resolve) => window.setTimeout(resolve, 450));
  if (kind === "success") {
    tracker.featureSucceeded("sales_dashboard", { rows: 24 });
  } else {
    tracker.featureFailed("sales_dashboard", kind, { retryable: true });
  }
  await tracker.flush();
  busy.value = false;
}

async function runAction(
  featureKey:
    "report_export" | "data_import" | "settings_save" | "command_dispatch",
  result: ResultKind,
) {
  if (!tracker) return;
  busy.value = true;
  const operation = tracker.startOperation(
    featureKey,
    { scenario: result },
    "click",
  );
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  if (result === "success") {
    operation.succeed({ source: "controlled_demo" });
  } else if (result === "cancel") {
    operation.cancel({ reason: "user_cancelled" });
  } else {
    operation.fail("operation_failed");
  }
  await tracker.flush();
  busy.value = false;
}

function startWallboard(): void {
  if (!tracker || wallboardActive.value) return;
  wallboardSeconds.value = 0;
  wallboardActive.value = true;
  stopLongView = tracker.startLongView("operations_wallboard");
  wallboardTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") wallboardSeconds.value += 1;
  }, 1_000);
}

function stopWallboard(): void {
  stopLongView?.();
  stopLongView = null;
  if (wallboardTimer) window.clearInterval(wallboardTimer);
  wallboardTimer = null;
  wallboardActive.value = false;
  void tracker?.flush();
}

async function flush(): Promise<void> {
  await tracker?.flush();
}

if (authenticated.value) initializeTracker();
onBeforeUnmount(() => {
  stopWallboard();
  tracker?.destroy();
});
</script>

<template>
  <main v-if="!authenticated" class="demo-login">
    <section>
      <span class="lab-mark">LAB / 03</span>
      <p class="eyebrow">CONTROLLED ADOPTION SCENARIOS</p>
      <h1>三种真实使用场景，<br />一条可解释事件链。</h1>
      <p>这里不是业务系统，而是用于学习、验收和排障的受控实验环境。</p>
    </section>
    <form class="demo-login-card" @submit.prevent="login">
      <span class="eyebrow">模拟登录</span>
      <h2>创建独立的 token 与 analyticsRef</h2>
      <p>token 仅用于模拟登录状态；SDK 只接收不透明的 analyticsRef。</p>
      <label>
        用户名
        <input v-model="loginForm.username" autocomplete="username" />
      </label>
      <label>
        模拟密码
        <input
          v-model="loginForm.password"
          type="password"
          autocomplete="current-password"
          placeholder="输入任意非空值"
        />
      </label>
      <button
        :disabled="!loginForm.username || !loginForm.password"
        type="submit"
      >
        进入场景实验室
      </button>
    </form>
  </main>

  <div v-else class="demo-shell">
    <header class="demo-header">
      <div>
        <span class="lab-mark">FI / SCENARIO LAB</span>
        <strong>采用事件实验室</strong>
      </div>
      <div class="identity-strip">
        <span
          >模拟 token：<code>{{ maskedToken }}</code></span
        >
        <span
          >analyticsRef：<code>{{ analyticsRef }}</code></span
        >
        <button type="button" @click="logout">退出</button>
      </div>
    </header>

    <div class="demo-body">
      <aside class="scene-nav">
        <p class="eyebrow">SCENARIOS</p>
        <button
          v-for="item in scenes"
          :key="item.key"
          type="button"
          :class="{ active: scene === item.key }"
          @click="changeScene(item.key)"
        >
          <strong>{{ item.label }}</strong>
          <small>{{ item.description }}</small>
        </button>
        <div class="privacy-proof">
          <strong>隐私校验</strong>
          <p>事件日志只展示标准字段摘要，不展示 token 或 accountRef 原值。</p>
        </div>
      </aside>

      <section class="scenario-stage">
        <div v-if="scene === 'data'" class="scene-content">
          <div class="scene-title">
            <span class="scene-index">01</span>
            <div>
              <p class="eyebrow">DATA / CHART RENDER</p>
              <h1>数据和图表查看</h1>
              <p>只有主要请求成功且数据区完成渲染，才算成功使用。</p>
            </div>
          </div>
          <div class="data-preview">
            <div class="preview-bars" aria-label="模拟柱状图">
              <span
                v-for="height in [42, 66, 53, 81, 72, 91, 77]"
                :key="height"
                :style="{ height: `${height}%` }"
              ></span>
            </div>
            <dl>
              <div>
                <dt>今日订单</dt>
                <dd>1,284</dd>
              </div>
              <div>
                <dt>履约率</dt>
                <dd>97.4%</dd>
              </div>
              <div>
                <dt>待处理</dt>
                <dd>16</dd>
              </div>
            </dl>
          </div>
          <div class="outcome-grid">
            <button type="button" :disabled="busy" @click="runData('success')">
              <strong>请求成功 + 渲染成功</strong>
              <small>预期：feature_succeeded</small>
            </button>
            <button
              type="button"
              :disabled="busy"
              @click="runData('api_failure')"
            >
              <strong>主要接口失败</strong>
              <small>预期：feature_failed / api_failure</small>
            </button>
            <button
              type="button"
              :disabled="busy"
              @click="runData('render_failure')"
            >
              <strong>数据成功但渲染失败</strong>
              <small>预期：feature_failed / render_failure</small>
            </button>
          </div>
        </div>

        <div v-else-if="scene === 'action'" class="scene-content">
          <div class="scene-title">
            <span class="scene-index">02</span>
            <div>
              <p class="eyebrow">BUSINESS OPERATIONS</p>
              <h1>导出、导入、配置与指令</h1>
              <p>点击只记 started；收到明确业务结果后才决定成功或失败。</p>
            </div>
          </div>
          <div class="operations-table">
            <div
              v-for="operation in [
                {
                  key: 'report_export',
                  name: '导出月度报告',
                  detail: '下载真正开始后才成功',
                },
                {
                  key: 'data_import',
                  name: '导入库存数据',
                  detail: '服务端处理完成后才成功',
                },
                {
                  key: 'settings_save',
                  name: '保存告警配置',
                  detail: '持久化成功后才成功',
                },
                {
                  key: 'command_dispatch',
                  name: '下发同步指令',
                  detail: '服务端接受指令后才成功',
                },
              ]"
              :key="operation.key"
              class="operation-row"
            >
              <div>
                <strong>{{ operation.name }}</strong>
                <small>{{ operation.detail }}</small>
              </div>
              <div>
                <button
                  type="button"
                  :disabled="busy"
                  @click="
                    runAction(
                      operation.key as
                        | 'report_export'
                        | 'data_import'
                        | 'settings_save'
                        | 'command_dispatch',
                      'success',
                    )
                  "
                >
                  成功
                </button>
                <button
                  type="button"
                  :disabled="busy"
                  @click="
                    runAction(
                      operation.key as
                        | 'report_export'
                        | 'data_import'
                        | 'settings_save'
                        | 'command_dispatch',
                      'cancel',
                    )
                  "
                >
                  取消
                </button>
                <button
                  type="button"
                  :disabled="busy"
                  @click="
                    runAction(
                      operation.key as
                        | 'report_export'
                        | 'data_import'
                        | 'settings_save'
                        | 'command_dispatch',
                      'failure',
                    )
                  "
                >
                  失败
                </button>
              </div>
            </div>
          </div>
        </div>

        <div
          v-else-if="scene === 'wallboard'"
          class="scene-content wallboard-scene"
        >
          <div class="scene-title">
            <span class="scene-index">03</span>
            <div>
              <p class="eyebrow">VISIBLE LONG VIEW</p>
              <h1>持续展示大屏</h1>
              <p>
                前台累计 30 秒后成功；后台标签页暂停，之后按 60 秒心跳累计。
              </p>
            </div>
          </div>
          <div class="wallboard">
            <div class="wallboard-metric">
              <small>当前前台可见累计</small>
              <strong>{{ wallboardSeconds }}</strong>
              <span>秒</span>
            </div>
            <div class="wallboard-ring" :class="{ active: wallboardActive }">
              <span>{{ wallboardActive ? "正在累计" : "尚未开始" }}</span>
              <small>
                {{
                  acceptanceFast
                    ? "自动验收加速：1 秒阈值 / 1 秒心跳"
                    : "正式口径：30 秒阈值 / 60 秒心跳"
                }}
              </small>
            </div>
            <div class="wallboard-actions">
              <button
                type="button"
                :disabled="wallboardActive"
                @click="startWallboard"
              >
                开始持续展示
              </button>
              <button
                type="button"
                :disabled="!wallboardActive"
                @click="stopWallboard"
              >
                结束并结算
              </button>
            </div>
          </div>
          <p class="visibility-note">
            验收方法：开始后切到其他标签页，计时应暂停；返回后继续。关闭或切换场景会发送
            ended 结算。
          </p>
        </div>

        <div v-else class="scene-content">
          <div class="scene-title">
            <span class="scene-index">04</span>
            <div>
              <p class="eyebrow">OBSERVABILITY / PRIVACY</p>
              <h1>错误、性能与发布证据</h1>
              <p>
                受控生成四类 M8 事件；SDK 会先删除凭据、URL 参数、邮箱和动态路径
                ID。
              </p>
            </div>
          </div>
          <div class="outcome-grid observability-lab-grid">
            <button
              type="button"
              :disabled="busy"
              @click="captureObservability('js')"
            >
              <strong>模拟 JS 异常</strong>
              <small>error_js · TypeError + 脱敏首帧</small>
            </button>
            <button
              type="button"
              :disabled="busy"
              @click="captureObservability('api')"
            >
              <strong>模拟 API 503</strong>
              <small>error_api · /api/budgets/:id</small>
            </button>
            <button
              type="button"
              :disabled="busy"
              @click="captureObservability('resource')"
            >
              <strong>模拟资源失败</strong>
              <small>error_resource · script</small>
            </button>
            <button
              type="button"
              :disabled="busy"
              @click="captureObservability('vital')"
            >
              <strong>模拟 LCP poor</strong>
              <small>web_vital · 4200 ms</small>
            </button>
            <button
              type="button"
              :disabled="busy"
              @click="captureObservability('readiness')"
            >
              <strong>标记首屏就绪</strong>
              <small>page_readiness · analysis_view</small>
            </button>
            <button
              type="button"
              :disabled="busy"
              @click="captureObservability('list')"
            >
              <strong>模拟列表渲染</strong>
              <small>list_render · &gt;1000 行桶</small>
            </button>
          </div>
          <div class="privacy-proof">
            <strong>发布边界</strong>
            <p>
              所有事件显式关联 2026.08.1-demo / production；SourceMap
              不上传，运营指数 v1 不受影响。
            </p>
          </div>
        </div>
      </section>

      <aside class="event-console">
        <div class="console-heading">
          <div>
            <p class="eyebrow">EXPECTED EVENT STREAM</p>
            <h2>事件解释</h2>
          </div>
          <button type="button" @click="flush">立即发送</button>
        </div>
        <div class="diagnostic-row">
          <span>SDK：{{ diagnostics?.state ?? "initializing" }}</span>
          <span>队列：{{ diagnostics?.queueSize ?? 0 }}</span>
          <span>丢弃：{{ diagnostics?.droppedEvents ?? 0 }}</span>
        </div>
        <ol class="event-list">
          <li v-for="entry in eventLog" :key="entry.id">
            <time>{{ new Date(entry.at).toLocaleTimeString("zh-CN") }}</time>
            <div>
              <strong>{{ entry.eventName }}</strong>
              <code v-if="entry.featureKey">{{ entry.featureKey }}</code>
              <p>{{ entry.detail }}</p>
            </div>
          </li>
        </ol>
        <div v-if="!eventLog.length" class="console-empty">
          操作场景后显示预期事件。
        </div>
      </aside>
    </div>
  </div>
</template>
