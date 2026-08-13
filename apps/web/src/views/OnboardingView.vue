<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError, api } from "../api";
import { auth } from "../auth";
import DataStatusBanner from "../components/DataStatusBanner.vue";
import PageHeader from "../components/PageHeader.vue";
import StatePanel from "../components/StatePanel.vue";
import { useDashboardContext } from "../context";
import { projects } from "../projects";
import { formatDateTime } from "../range";
import { useRemoteData } from "../remote";
import type {
  DataStatus,
  Feature,
  FeatureType,
  OnboardingResponse,
  Project,
} from "../types";

const route = useRoute();
const router = useRouter();
const appOrigin = window.location.origin;
const context = useDashboardContext();
const resource = useRemoteData<{
  onboarding: OnboardingResponse;
  status: DataStatus;
  features: Feature[];
}>();
const createOpen = ref(false);
const featureOpen = ref(false);
const saving = ref(false);
const testLoading = ref(false);
const testResult = ref<{
  ok: boolean;
  requestId: string | null;
  code: string;
  at: string;
} | null>(null);
const createForm = reactive({
  name: "",
  timezone: "Asia/Shanghai",
  retentionDays: 90,
  origins: appOrigin,
});
const editForm = reactive({
  name: "",
  timezone: "UTC",
  retentionDays: 90,
  origins: "",
  status: "active" as "active" | "disabled",
});
const featureForm = reactive({
  featureKey: "",
  name: "",
  description: "",
  featureType: "data_view" as FeatureType,
  longViewSuccessAfterMs: 30_000,
  heartbeatIntervalMs: 60_000,
});

const canWrite = computed(
  () =>
    auth.state.user?.globalRole === "admin" &&
    ["owner", "admin"].includes(context.project.value?.role ?? ""),
);
const canCreate = computed(() => auth.state.user?.globalRole === "admin");
const snippet = computed(() => {
  const integration = resource.data.value?.onboarding.integration;
  if (!integration) return "";
  return `import { createTracker } from "${integration.package}";

const tracker = createTracker({
  projectKey: "${integration.projectKey}",
  endpoint: "${appOrigin}/v1/events",
  projectTimezone: "${context.project.value?.timezone ?? "UTC"}",
});

// 仅传业务生成的不透明引用；不要传 token、邮箱或手机号
tracker.setAccount(currentUser.analyticsRef);`;
});
const troubleshooting = computed(() => {
  const code = testResult.value?.code;
  if (!code || testResult.value?.ok) return null;
  const suggestions: Record<string, string> = {
    PROJECT_ORIGIN_FORBIDDEN:
      "当前页面 Origin 不在项目白名单。请保存完整的 scheme + host + port。",
    PROJECT_DISABLED: "项目已停用，请先由管理员重新启用采集。",
    PROJECT_NOT_FOUND: "project key 无效或已被替换，请重新复制接入代码。",
    SCHEMA_INVALID: "事件字段与当前 schema 不兼容，请升级 SDK 并检查自定义字段。",
    KAFKA_UNAVAILABLE: "接收服务暂时无法写入队列，请稍后重试并联系运维。",
    NETWORK_ERROR: "浏览器无法到达接收地址，请检查网络与 CSP connect-src。",
  };
  return suggestions[code] ?? "请保留请求 ID，并在服务日志中按请求 ID 排查。";
});
const viewState = computed(() => {
  if (!context.projectId.value && projects.state.loaded) return "empty" as const;
  if (resource.loading.value && !resource.data.value) return "loading" as const;
  if (resource.error.value && !resource.data.value) {
    return resource.error.value.status === 403
      ? ("forbidden" as const)
      : ("error" as const);
  }
  return resource.stale.value ? ("stale" as const) : ("ready" as const);
});

function id(prefix: "evt" | "vis" | "ses" | "pv"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function syncEditForm(project: Project): void {
  editForm.name = project.name;
  editForm.timezone = project.timezone;
  editForm.retentionDays = project.retentionDays;
  editForm.origins = project.origins.join("\n");
  editForm.status = project.status;
}

async function load(): Promise<void> {
  if (!context.projectId.value) return;
  const projectId = context.projectId.value;
  const result = await resource.load(async () => {
    const [onboarding, status, features] = await Promise.all([
      api.request<OnboardingResponse>(`/api/projects/${projectId}/onboarding/status`),
      api.request<DataStatus>(`/api/projects/${projectId}/data-status`),
      api.request<Feature[]>(`/api/projects/${projectId}/features`),
    ]);
    return { onboarding, status, features };
  });
  if (result) syncEditForm(result.onboarding.project);
}

function parseOrigins(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

async function createProject(): Promise<void> {
  saving.value = true;
  try {
    const project = await api.request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: createForm.name,
        timezone: createForm.timezone,
        retentionDays: createForm.retentionDays,
        origins: parseOrigins(createForm.origins),
      }),
    });
    await projects.refresh();
    createOpen.value = false;
    await router.replace({
      query: { ...route.query, project: project.id, range: "7d" },
    });
  } finally {
    saving.value = false;
  }
}

async function saveProject(): Promise<void> {
  if (!context.projectId.value) return;
  saving.value = true;
  try {
    await api.request<Project>(`/api/projects/${context.projectId.value}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: editForm.name,
        timezone: editForm.timezone,
        retentionDays: editForm.retentionDays,
        origins: parseOrigins(editForm.origins),
        status: editForm.status,
      }),
    });
    await projects.refresh();
    await load();
  } finally {
    saving.value = false;
  }
}

async function createFeature(): Promise<void> {
  if (!context.projectId.value) return;
  saving.value = true;
  try {
    await api.request<Feature>(`/api/projects/${context.projectId.value}/features`, {
      method: "POST",
      body: JSON.stringify({
        ...featureForm,
        description: featureForm.description || undefined,
      }),
    });
    featureOpen.value = false;
    featureForm.featureKey = "";
    featureForm.name = "";
    featureForm.description = "";
    await load();
  } finally {
    saving.value = false;
  }
}

async function toggleFeature(feature: Feature): Promise<void> {
  if (!context.projectId.value) return;
  await api.request(`/api/projects/${context.projectId.value}/features/${feature.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: feature.status === "active" ? "disabled" : "active",
    }),
  });
  await load();
}

async function sendTestEvent(): Promise<void> {
  const projectKey = resource.data.value?.onboarding.integration.projectKey;
  if (!projectKey) return;
  testLoading.value = true;
  testResult.value = null;
  const now = new Date().toISOString();
  try {
    const response = await fetch("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        projectKey,
        sentAt: now,
        sdk: { name: "onboarding-test", version: "0.1.0" },
        events: [
          {
            eventId: id("evt"),
            eventName: "page_view",
            eventTime: now,
            visitorId: id("vis"),
            sessionId: id("ses"),
            pageViewId: id("pv"),
            route: "/frontend-insight-onboarding-test",
            timezoneOffsetMinutes: new Date().getTimezoneOffset(),
            properties: { source: "onboarding" },
          },
        ],
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      requestId?: string;
      code?: string;
    };
    testResult.value = {
      ok: response.ok,
      requestId: body.requestId ?? response.headers.get("x-request-id"),
      code: response.ok ? "EVENT_ACCEPTED" : (body.code ?? `HTTP_${response.status}`),
      at: now,
    };
    if (response.ok) window.setTimeout(() => void load(), 1500);
  } catch {
    testResult.value = {
      ok: false,
      requestId: null,
      code: "NETWORK_ERROR",
      at: now,
    };
  } finally {
    testLoading.value = false;
  }
}

async function copy(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

watch(
  () => context.projectId.value,
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <div>
    <PageHeader
      eyebrow="PROJECT ONBOARDING"
      title="设置"
      description="管理项目资料、资产、Origin、SDK、成员权限、隐私、保留和审计。"
    >
      <el-button v-if="canCreate" type="primary" @click="createOpen = true">
        创建项目
      </el-button>
    </PageHeader>

    <DataStatusBanner :status="resource.data.value?.status ?? null" />

    <StatePanel
      :state="viewState"
      :title="
        viewState === 'empty'
          ? '还没有可访问项目'
          : viewState === 'forbidden'
            ? '无项目访问权限'
            : '项目信息暂不可用'
      "
      :message="
        viewState === 'empty'
          ? canCreate
            ? '创建第一个项目后即可获得接入代码。'
            : '请联系管理员将你加入项目。'
          : resource.error.value?.message
      "
      :request-id="resource.error.value?.requestId"
      @retry="load"
    >
      <el-button v-if="viewState === 'empty' && canCreate" @click="createOpen = true">
        创建第一个项目
      </el-button>

      <template v-if="resource.data.value">
        <section class="onboarding-grid">
          <article class="panel integration-card">
            <div class="step-number">01</div>
            <span class="eyebrow">INSTALL & INITIALIZE</span>
            <h2>复制最小接入代码</h2>
            <p>npm ESM 是 MVP 唯一保证的接入方式。</p>

            <div class="copy-row">
              <div>
                <small>Project key</small>
                <code>{{ resource.data.value.onboarding.integration.projectKey }}</code>
              </div>
              <el-button
                plain
                @click="copy(resource.data.value.onboarding.integration.projectKey)"
              >
                复制
              </el-button>
            </div>
            <div class="copy-row">
              <div>
                <small>Endpoint</small>
                <code>{{ appOrigin }}/v1/events</code>
              </div>
              <el-button plain @click="copy(`${appOrigin}/v1/events`)">
                复制
              </el-button>
            </div>

            <pre class="code-block"><code>{{ snippet }}</code></pre>
            <el-button plain @click="copy(snippet)">复制完整代码</el-button>
          </article>

          <article class="panel integration-card">
            <div class="step-number">02</div>
            <span class="eyebrow">ORIGIN & CSP</span>
            <h2>配置浏览器安全边界</h2>
            <p>Origin 必须是完整的 scheme、host 和可选端口，不包含路径。</p>
            <div class="security-note">
              <strong>允许的 Origin</strong>
              <code v-for="origin in context.project.value?.origins" :key="origin">
                {{ origin }}
              </code>
            </div>
            <div class="security-note">
              <strong>CSP 提示</strong>
              <code>connect-src 'self' {{ appOrigin }}</code>
            </div>
            <el-alert
              title="SDK 不读取 Authorization、Cookie、Local Storage、表单或 URL query。"
              type="info"
              :closable="false"
              show-icon
            />
          </article>

          <article class="panel integration-card">
            <div class="step-number">03</div>
            <span class="eyebrow">VERIFY FIRST EVENT</span>
            <h2>发送测试事件</h2>
            <p>测试事件只包含归一化路由和随机匿名标识，不包含当前登录 token。</p>
            <el-button type="primary" :loading="testLoading" @click="sendTestEvent">
              发送测试事件
            </el-button>
            <div
              v-if="testResult"
              class="test-result"
              :class="{ success: testResult.ok, failure: !testResult.ok }"
              role="status"
            >
              <strong>{{ testResult.ok ? "接收成功" : "接收失败" }}</strong>
              <span>状态：{{ testResult.code }}</span>
              <span>请求 ID：{{ testResult.requestId ?? "未生成" }}</span>
              <span>时间：{{ formatDateTime(testResult.at) }}</span>
              <p v-if="troubleshooting">{{ troubleshooting }}</p>
            </div>
          </article>
        </section>

        <section class="panel settings-panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">PROJECT SETTINGS</span>
              <h2>项目配置</h2>
              <p v-if="!canWrite">当前账号为只读权限；设置由项目管理员维护。</p>
            </div>
          </div>
          <el-form class="settings-form" label-position="top">
            <el-form-item label="项目名称">
              <el-input v-model="editForm.name" :disabled="!canWrite" />
            </el-form-item>
            <el-form-item label="项目时区">
              <el-input v-model="editForm.timezone" :disabled="!canWrite" />
            </el-form-item>
            <el-form-item label="原始事件保留天数">
              <el-input-number
                v-model="editForm.retentionDays"
                :min="1"
                :max="365"
                :disabled="!canWrite"
              />
            </el-form-item>
            <el-form-item label="采集状态">
              <el-select v-model="editForm.status" :disabled="!canWrite">
                <el-option label="启用" value="active" />
                <el-option label="停用（保留历史数据）" value="disabled" />
              </el-select>
            </el-form-item>
            <el-form-item class="wide-field" label="允许的 Origin（每行一个）">
              <el-input
                v-model="editForm.origins"
                type="textarea"
                :rows="3"
                :disabled="!canWrite"
              />
            </el-form-item>
          </el-form>
          <el-button
            v-if="canWrite"
            type="primary"
            :loading="saving"
            @click="saveProject"
          >
            保存项目配置
          </el-button>
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">FEATURE REGISTRY</span>
              <h2>功能定义</h2>
              <p>成功规则按数据查看、操作完成和持续展示三类固定。</p>
            </div>
            <el-button v-if="canWrite" @click="featureOpen = true">新增功能</el-button>
          </div>
          <el-table :data="resource.data.value.features" empty-text="尚未创建功能">
            <el-table-column prop="name" label="名称" min-width="180" />
            <el-table-column prop="featureKey" label="featureKey" min-width="180" />
            <el-table-column prop="featureType" label="类型" width="130" />
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                {{ row.status === "active" ? "启用" : "停用" }}
              </template>
            </el-table-column>
            <el-table-column v-if="canWrite" label="操作" width="110">
              <template #default="{ row }">
                <el-button text @click="toggleFeature(row)">
                  {{ row.status === "active" ? "停用" : "启用" }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>
      </template>
    </StatePanel>

    <el-dialog v-model="createOpen" title="创建项目" width="560px">
      <el-form label-position="top">
        <el-form-item label="项目名称">
          <el-input v-model="createForm.name" placeholder="例如：运营管理后台" />
        </el-form-item>
        <el-form-item label="项目时区">
          <el-input v-model="createForm.timezone" placeholder="Asia/Shanghai" />
        </el-form-item>
        <el-form-item label="原始事件保留天数">
          <el-input-number v-model="createForm.retentionDays" :min="1" :max="365" />
        </el-form-item>
        <el-form-item label="允许的 Origin（每行一个）">
          <el-input v-model="createForm.origins" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="!createForm.name || !parseOrigins(createForm.origins).length"
          @click="createProject"
        >
          创建并生成 project key
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="featureOpen" title="新增功能" width="600px">
      <el-form label-position="top">
        <el-form-item label="功能名称">
          <el-input v-model="featureForm.name" />
        </el-form-item>
        <el-form-item label="featureKey">
          <el-input
            v-model="featureForm.featureKey"
            placeholder="小写字母开头，只使用小写字母、数字和下划线"
          />
        </el-form-item>
        <el-form-item label="功能类型">
          <el-select v-model="featureForm.featureType">
            <el-option label="数据/图表查看" value="data_view" />
            <el-option label="操作完成" value="action" />
            <el-option label="持续展示/大屏" value="long_view" />
          </el-select>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="featureForm.description" type="textarea" :rows="3" />
        </el-form-item>
        <template v-if="featureForm.featureType === 'long_view'">
          <el-form-item label="成功阈值（毫秒）">
            <el-input-number
              v-model="featureForm.longViewSuccessAfterMs"
              :min="1000"
              :max="3600000"
            />
          </el-form-item>
          <el-form-item label="心跳间隔（毫秒）">
            <el-input-number
              v-model="featureForm.heartbeatIntervalMs"
              :min="5000"
              :max="3600000"
            />
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="featureOpen = false">取消</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="!featureForm.name || !featureForm.featureKey"
          @click="createFeature"
        >
          创建功能
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
