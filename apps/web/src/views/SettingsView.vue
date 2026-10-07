<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { auth } from "../auth";
import { projects } from "../projects";
import { useDashboardContext } from "../context";
import DataStatusBanner from "../components/DataStatusBanner.vue";
import type { DataStatus, Project } from "../types";
const location = window.location,
  navigator = window.navigator;
const route = useRoute(),
  router = useRouter(),
  context = useDashboardContext();
const projectId = computed(() => String(route.params.projectId)),
  root = computed(() => `/api/projects/${projectId.value}`);
const canWrite = computed(
  () =>
    auth.state.user?.globalRole === "admin" &&
    ["owner", "admin"].includes(context.project.value?.role ?? ""),
);
const tab = computed(() =>
  ["integration", "probes", "interfaces", "abnormal", "audit"].includes(
    String(route.query.tab),
  )
    ? String(route.query.tab)
    : "integration",
);
const env = computed(() =>
  ["dev", "staging", "prod"].includes(String(route.query.env))
    ? String(route.query.env)
    : "prod",
);
const range = computed(() =>
  new URLSearchParams(
    Object.fromEntries([
      ...["range", "from", "to"].flatMap((k) =>
        typeof route.query[k] === "string" ? [[k, String(route.query[k])]] : [],
      ),
      ["env", env.value],
    ]),
  ).toString(),
);
interface Integration {
  project: Project;
  endpoint: string;
  sdk: { version: string | null; contractVersion: number; moduleUrl: string | null };
  status: DataStatus;
  privacy: string;
}
interface Probe {
  version: string;
  status: string;
  contractVersion: number;
  releaseNotes: string;
  upgradeAdvice: string;
}
interface ProbeData {
  denominator: number;
  denominatorDefinition: string;
  policies: Probe[];
  items: {
    version: string;
    contractVersion: number;
    count: number;
    share: number;
    lastObservedAt: string;
  }[];
}
interface ExportItem {
  id: string;
  kind: string;
  enabled: boolean;
  scope: {
    env: string;
    from: string;
    to: string;
    maxRangeDays: number;
    expiresAt: string;
  };
  rateLimit: number;
  lastCalledAt: string | null;
  lastStatus: string | null;
}
interface Rule {
  id: string;
  ruleKey: string;
  status: string;
  config: Record<string, unknown>;
  approval: Record<string, unknown> | null;
}
const integration = ref<Integration | null>(null),
  probeData = ref<ProbeData | null>(null),
  interfaces = ref<ExportItem[]>([]),
  rules = ref<Rule[]>([]),
  evidence = ref<unknown>(null),
  audit = ref<unknown>(null),
  members = ref<{ userId: string; displayName: string; role: string }[]>([]);
const loading = ref(false),
  busy = ref(false),
  error = ref(""),
  notice = ref(""),
  token = ref(""),
  receipt = ref<{
    state: string;
    ingested: boolean;
    queryable: boolean;
    requestId?: string;
    reason?: string;
  } | null>(null),
  interfacePage = ref(1),
  auditPage = ref(1);
const edit = reactive({
  name: "",
  timezone: "",
  origins: "",
  retentionDays: 90,
  status: "active",
});
const member = reactive({ userId: "", role: "viewer" });
const probe = reactive({
  version: "0.8.0",
  status: "recommended",
  contractVersion: 3,
  releaseNotes: "",
  upgradeAdvice: "",
  confirmBlocked: false,
});
const editingInterface = ref("");
const exportForm = reactive({
  kind: "metric_snapshot",
  from: "",
  to: "",
  expiresAt: "",
  maxRangeDays: 7,
  rateLimit: 60,
});
const ruleKey = ref("outside_hours"),
  ruleConfig = ref(
    JSON.stringify(
      {
        env: "prod",
        threshold: 100,
        minimumSample: 20,
        baselineDays: 14,
        minimumBaselineDays: 7,
        multiplier: 3,
        workStart: 9,
        workEnd: 18,
        workDays: [1, 2, 3, 4, 5],
        visibleRoles: ["owner", "admin"],
        sharedSubjects: [],
        exceptions: [],
      },
      null,
      2,
    ),
  );
const approval = reactive({
  versionId: "",
  managementApprover: "",
  securityApprover: "",
  approvedAt: "",
  source: "",
  attested: false,
});
let generation = 0;
const endpoint = computed(() =>
  integration.value ? new URL(integration.value.endpoint, location.origin).href : "",
);
const snippet = computed(() =>
  integration.value?.sdk.moduleUrl
    ? `import { createTracker } from ${JSON.stringify(new URL(integration.value.sdk.moduleUrl, location.origin).href)};\n\nconst tracker = createTracker({\n  appId: ${JSON.stringify(integration.value.project.appId)},\n  env: ${JSON.stringify(env.value)},\n  release: "app-1.0.0",\n  endpoint: ${JSON.stringify(endpoint.value)},\n  normalizePageRoute: () => "/your-normalized-page"\n});\n// 可选：tracker.setUser("u_<业务后端提供的不透明引用>");\n// 禁止传入 token、邮箱、手机号或其他业务身份。\nawait tracker.flush();`
    : "当前没有可用推荐版本，请管理员配置已提供的 SDK 版本。",
);
async function load() {
  const g = ++generation,
    r = root.value,
    q = range.value;
  loading.value = true;
  error.value = "";
  token.value = "";
  receipt.value = null;
  integration.value = null;
  probeData.value = null;
  interfaces.value = [];
  rules.value = [];
  members.value = [];
  evidence.value = null;
  audit.value = null;
  try {
    const [i, p, x, m, a, e, logs] = await Promise.all([
      api.request<Integration>(r + "/settings/integration"),
      api.request<ProbeData>(r + "/settings/probe-versions?" + q),
      api.request<{ items: ExportItem[] }>(
        r + `/settings/export-interfaces?page=${interfacePage.value}`,
      ),
      canWrite.value
        ? api.request<typeof members.value>(r + "/members")
        : Promise.resolve([]),
      canWrite.value
        ? api.request<Rule[]>(r + "/settings/abnormal-rules")
        : Promise.resolve([]),
      api.request(r + "/settings/abnormal-evidence?" + q),
      canWrite.value
        ? api.request(r + `/settings/audit?page=${auditPage.value}`)
        : Promise.resolve(null),
    ]);
    if (g !== generation) return;
    integration.value = i;
    probeData.value = p;
    interfaces.value = x.items;
    members.value = m;
    rules.value = a;
    evidence.value = e;
    audit.value = logs;
    Object.assign(edit, {
      name: i.project.name,
      timezone: i.project.timezone,
      origins: i.project.origins.join("\n"),
      retentionDays: i.project.retentionDays,
      status: i.project.status,
    });
  } catch (e) {
    if (g === generation) error.value = e instanceof Error ? e.message : "载入失败";
  } finally {
    if (g === generation) loading.value = false;
  }
}
async function mutate(path: string, body: unknown, method = "POST") {
  const g = generation,
    r = root.value;
  busy.value = true;
  error.value = "";
  notice.value = "";
  token.value = "";
  try {
    const result = await api.request<{ token?: string }>(r + path, {
      method,
      body: JSON.stringify(body),
    });
    if (g !== generation) return;
    await projects.refresh();
    if (g !== generation) return;
    const expectedGeneration = generation + 1;
    await load();
    if (generation === expectedGeneration && root.value === r) {
      token.value = result?.token ?? "";
      notice.value = "操作已保存";
    }
  } catch (e) {
    if (g === generation) error.value = e instanceof Error ? e.message : "保存失败";
  } finally {
    busy.value = false;
  }
}
async function saveProject() {
  await mutate(
    "",
    { ...edit, origins: edit.origins.split(/\s+/).filter(Boolean) },
    "PATCH",
  );
}
async function removeMember(id: string) {
  await mutate("/members/" + encodeURIComponent(id), undefined, "DELETE");
}
async function saveProbe() {
  await mutate("/settings/probe-versions", probe, "PUT");
}
async function createInterface() {
  try {
    await mutate(
      "/settings/export-interfaces" +
        (editingInterface.value ? "/" + editingInterface.value : ""),
      {
        ...(editingInterface.value ? {} : { kind: exportForm.kind }),
        scope: {
          env: env.value,
          from: new Date(exportForm.from).toISOString(),
          to: new Date(exportForm.to).toISOString(),
          expiresAt: new Date(exportForm.expiresAt).toISOString(),
          maxRangeDays: exportForm.maxRangeDays,
          rateLimit: exportForm.rateLimit,
        },
      },
      editingInterface.value ? "PUT" : "POST",
    );
  } catch {
    error.value = "请填写有效的授权起止时间和凭证有效期。";
  }
}
async function createRule() {
  try {
    await mutate("/settings/abnormal-rules", {
      ruleKey: ruleKey.value,
      config: JSON.parse(ruleConfig.value),
    });
  } catch {
    error.value = "规则配置必须是有效 JSON。";
  }
}
async function approveRule() {
  try {
    await mutate(`/settings/abnormal-rules/${approval.versionId}/approve`, {
      managementApprover: approval.managementApprover,
      securityApprover: approval.securityApprover,
      approvedAt: new Date(approval.approvedAt).toISOString(),
      source: approval.source,
      attested: approval.attested,
    });
  } catch {
    error.value = "请填写真实审批记录和有效时间。";
  }
}
async function sendTest() {
  if (!integration.value || !canWrite.value) return;
  const g = generation,
    r = root.value,
    testEnv = env.value,
    version = integration.value.sdk.version;
  if (!version) return;
  busy.value = true;
  error.value = "";
  receipt.value = { state: "sending", ingested: false, queryable: false };
  try {
    const body = await api.request<{ eventId: string; requestId: string }>(
      r + "/settings/test-event",
      { method: "POST", body: JSON.stringify({ env: testEnv }) },
    );
    if (g !== generation) return;
    const eventId = body.eventId;
    receipt.value = {
      state: "accepted",
      ingested: false,
      queryable: false,
      requestId: body.requestId,
    };
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (g !== generation) return;
      const result = await api.request<{
        state: string;
        ingested: boolean;
        queryable: boolean;
        requestId?: string;
        reason?: string;
      }>(
        r +
          "/settings/test-receipt?" +
          new URLSearchParams({ env: testEnv, eventId, requestId: body.requestId }),
      );
      if (g !== generation) return;
      receipt.value = result;
      if (result.queryable) break;
    }
  } catch (e) {
    if (g === generation)
      error.value =
        (e instanceof Error ? e.message : "测试失败") +
        "；请检查 Origin、探针策略、CSP 和服务状态。";
  } finally {
    busy.value = false;
  }
}
async function exportEvidence() {
  const g = generation;
  try {
    const result = await api.request(
      root.value + "/settings/abnormal-evidence?" + range.value + "&export=json",
    );
    if (g !== generation) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "abnormal-evidence.json";
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    if (g === generation) error.value = String(e);
  }
}
function changeTab(value: string | number) {
  void router.replace({ query: { ...route.query, tab: String(value) } });
}
watch(
  () => [
    projectId.value,
    range.value,
    canWrite.value,
    interfacePage.value,
    auditPage.value,
  ],
  () => {
    notice.value = "";
    approval.versionId = "";
    editingInterface.value = "";
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  token.value = "";
});
</script>
<template>
  <section class="settings-r7">
    <h1>设置</h1>
    <p>
      接入、探针策略、外部接口和异常访问调查。创建项目请前往<router-link to="/projects"
        >全部项目</router-link
      >。
    </p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" role="alert" />
    <p v-if="notice" role="status">{{ notice }}</p>
    <el-button :disabled="loading || busy" @click="load">刷新设置</el-button>
    <p v-if="loading" role="status">正在载入当前项目设置…</p>
    <template v-if="integration && !loading">
      <DataStatusBanner :status="integration.status" />
      <p v-if="!canWrite">当前账号只读，配置修改、测试事件和凭证签发仅限项目管理员。</p>
      <el-tabs :model-value="tab" @update:model-value="changeTab">
        <el-tab-pane name="integration" label="接入指南">
          <h2>最小接入代码</h2>
          <p>
            推荐版本：{{ integration.sdk.version ?? "无" }} · contract
            {{ integration.sdk.contractVersion }}。固定版本 ESM
            由当前部署提供；业务项目自行评估和升级。
          </p>
          <p>
            Release notes：部署内置 0.8.0 包含 contract
            v3、质量采集与页面时长分段；详细功能见接入验收指南。升级建议：业务方先验证新版本，再显式调整依赖与接入地址。
          </p>
          <p>
            appId：<code data-testid="settings-app-id">{{
              integration.project.appId
            }}</code>
          </p>
          <p>
            接收 endpoint：<code>{{ endpoint }}</code>
          </p>
          <pre class="code-block" data-testid="settings-snippet">{{ snippet }}</pre>
          <el-button @click="navigator.clipboard.writeText(snippet)"
            >复制接入代码</el-button
          >
          <p>
            CSP：<code
              >script-src 'self' {{ location.origin }}; connect-src 'self'
              {{ location.origin }}</code
            >
          </p>
          <p>Origin：{{ integration.project.origins.join("、") }}</p>
          <p>{{ integration.privacy }}</p>
          <el-button
            v-if="canWrite"
            :disabled="busy || !integration.sdk.version"
            @click="sendTest"
            >发送测试事件</el-button
          >
          <div v-if="receipt" role="status" data-testid="test-receipt">
            <p>链路状态：{{ receipt.state }}；请求 ID：{{ receipt.requestId }}</p>
            <p>
              异步入库：{{ receipt.ingested ? "已证实" : "待证实" }}；可查询：{{
                receipt.queryable ? "已证实" : "待证实"
              }}
            </p>
            <p>{{ receipt.reason }}</p>
          </div>
          <h2>项目配置与 Origin</h2>
          <el-form label-position="top" :disabled="!canWrite || busy">
            <el-form-item label="项目名称"
              ><el-input v-model="edit.name" /></el-form-item
            ><el-form-item label="项目时区"
              ><el-input v-model="edit.timezone"
            /></el-form-item>
            <el-form-item label="事件保留天数"
              ><el-input-number v-model="edit.retentionDays" :min="1" :max="365"
            /></el-form-item>
            <el-form-item label="允许 Origin（每行一个完整 scheme + host + port）"
              ><el-input v-model="edit.origins" type="textarea"
            /></el-form-item>
            <el-form-item label="采集状态"
              ><el-select v-model="edit.status"
                ><el-option value="active" label="启用" /><el-option
                  value="disabled"
                  label="停用" /></el-select
            ></el-form-item>
            <el-button v-if="canWrite" @click="saveProject">保存项目配置</el-button>
          </el-form>
          <template v-if="canWrite"
            ><h2>项目成员</h2>
            <el-table :data="members" empty-text="暂无成员"
              ><el-table-column prop="displayName" label="成员" /><el-table-column
                prop="userId"
                label="用户 ID"
              /><el-table-column prop="role" label="角色" /><el-table-column
                label="操作"
                ><template #default="{ row }"
                  ><el-button :disabled="busy" @click="removeMember(row.userId)"
                    >移除</el-button
                  ></template
                ></el-table-column
              ></el-table
            >
            <el-form inline
              ><el-form-item label="已注册用户 ID"
                ><el-input v-model="member.userId" /></el-form-item
              ><el-form-item label="角色"
                ><el-select v-model="member.role"
                  ><el-option
                    v-for="role in ['owner', 'admin', 'viewer']"
                    :key="role"
                    :value="role" /></el-select></el-form-item
              ><el-button
                :disabled="busy"
                @click="
                  mutate(
                    '/members/' + encodeURIComponent(member.userId),
                    { role: member.role },
                    'PUT',
                  )
                "
                >保存成员</el-button
              ></el-form
            >
          </template>
        </el-tab-pane>
        <el-tab-pane name="probes" label="探针版本">
          <p>
            {{ probeData?.denominatorDefinition }}。分母：{{
              probeData?.denominator
            }}。窗口和环境沿用顶部筛选；未配置版本显示 unknown 策略。
          </p>
          <el-table :data="probeData?.items ?? []" empty-text="当前范围无真实事件"
            ><el-table-column prop="version" label="实际观测版本" /><el-table-column
              prop="policyStatus"
              label="策略（unknown 仍计入分母）" /><el-table-column
              prop="contractVersion"
              label="契约" /><el-table-column
              prop="count"
              label="事件数" /><el-table-column label="占比"
              ><template #default="{ row }"
                >{{ (row.share * 100).toFixed(2) }}%</template
              ></el-table-column
            ><el-table-column prop="lastObservedAt" label="最后观测时间"
          /></el-table>
          <el-table
            :data="probeData?.policies ?? []"
            empty-text="未配置项目策略；当前部署 SDK 作为初始推荐"
            ><el-table-column prop="version" label="版本" /><el-table-column
              prop="status"
              label="策略"
            /><el-table-column
              prop="releaseNotes"
              label="Release notes"
            /><el-table-column prop="upgradeAdvice" label="升级建议" /><el-table-column
              v-if="canWrite"
              label="操作"
              ><template #default="{ row }"
                ><el-button
                  @click="
                    Object.assign(probe, {
                      version: row.version,
                      status: row.status,
                      contractVersion: 3,
                      releaseNotes: row.releaseNotes,
                      upgradeAdvice: row.upgradeAdvice,
                      confirmBlocked: false,
                    })
                  "
                  >编辑</el-button
                ><el-button
                  :disabled="busy"
                  @click="
                    mutate(
                      '/settings/probe-versions/' + row.version,
                      undefined,
                      'DELETE',
                    )
                  "
                  >删除策略</el-button
                ></template
              ></el-table-column
            ></el-table
          >
          <el-form v-if="canWrite" label-position="top" :disabled="busy"
            ><el-form-item label="探针版本"
              ><el-input v-model="probe.version" /></el-form-item
            ><el-form-item label="策略"
              ><el-select v-model="probe.status"
                ><el-option
                  v-for="s in ['recommended', 'supported', 'deprecated', 'blocked']"
                  :key="s"
                  :value="s" /></el-select></el-form-item
            ><el-form-item label="Release notes"
              ><el-input v-model="probe.releaseNotes" type="textarea" /></el-form-item
            ><el-form-item label="升级建议"
              ><el-input v-model="probe.upgradeAdvice" type="textarea"
            /></el-form-item>
            <p>
              契约版本：3。recommended 仅允许当前已提供的
              0.8.0；不远程升级业务依赖。删除策略恢复未配置行为。
            </p>
            <el-checkbox
              v-if="probe.status === 'blocked'"
              v-model="probe.confirmBlocked"
              >明确确认：立即拒绝此版本的新事件批次，历史数据不变</el-checkbox
            ><el-button @click="saveProbe">保存探针策略</el-button></el-form
          >
        </el-tab-pane>
        <el-tab-pane name="interfaces" label="接口管理">
          <p>
            默认关闭。启用或轮换仅显示一次凭证；关闭后立即拒绝新请求，轮换立即撤销旧凭证。凭证有效期最多
            90 天。
          </p>
          <el-alert
            v-if="token"
            type="warning"
            title="仅此一次显示，请立即保存；切换上下文或刷新即清除"
            :closable="false"
          />
          <pre v-if="token" data-testid="issued-token">{{ token }}</pre>
          <el-button v-if="token" @click="token = ''">隐藏凭证</el-button>
          <el-table :data="interfaces" empty-text="未创建外部接口，全部关闭"
            ><el-table-column prop="kind" label="接口" /><el-table-column label="参数"
              ><template #default="{ row }"
                ><el-tooltip :content="JSON.stringify(row.scope)"
                  ><span>env / from / to（固定 scope）</span></el-tooltip
                ></template
              ></el-table-column
            ><el-table-column label="状态"
              ><template #default="{ row }">{{
                row.enabled ? "启用" : "停用"
              }}</template></el-table-column
            ><el-table-column prop="lastCalledAt" label="最近调用" /><el-table-column
              prop="lastStatus"
              label="最近状态"
            /><el-table-column v-if="canWrite" label="操作" min-width="240"
              ><template #default="{ row }"
                ><el-button
                  :disabled="busy"
                  @click="
                    editingInterface = row.id;
                    Object.assign(exportForm, row.scope, {
                      kind: row.kind,
                      rateLimit: row.rateLimit,
                    });
                  "
                  >修改授权</el-button
                ><el-button
                  v-for="a in ['enable', 'disable', 'rotate', 'revoke']"
                  :key="a"
                  :disabled="busy"
                  @click="mutate('/settings/export-interfaces/' + row.id + '/' + a, {})"
                  >{{
                    { enable: "启用", disable: "停用", rotate: "轮换", revoke: "撤销" }[
                      a
                    ]
                  }}</el-button
                ></template
              ></el-table-column
            ></el-table
          >
          <el-pagination
            v-model:current-page="interfacePage"
            layout="prev,pager,next"
            :page-size="10"
            :total="
              interfaces.length === 10
                ? interfacePage * 10 + 1
                : (interfacePage - 1) * 10 + interfaces.length
            "
          />
          <p>
            访问地址：<code
              >{{ location.origin }}/api/external/projects/{{
                projectId
              }}/{接口}?env=…&amp;from=…&amp;to=…</code
            >，使用独立 Bearer 凭证。quality_summary 支持 cursor；其余接口固定字段。
          </p>
          <el-form v-if="canWrite" label-position="top" :disabled="busy"
            ><el-form-item label="接口类型"
              ><el-select v-model="exportForm.kind"
                ><el-option
                  v-for="k in [
                    'metric_snapshot',
                    'metric_trend',
                    'quality_summary',
                    'prometheus',
                  ]"
                  :key="k"
                  :value="k" /></el-select></el-form-item
            ><el-form-item label="允许查询起点（ISO 带时区）"
              ><el-input
                v-model="exportForm.from"
                placeholder="2026-10-01T00:00:00Z" /></el-form-item
            ><el-form-item label="允许查询终点（ISO 带时区）"
              ><el-input v-model="exportForm.to" /></el-form-item
            ><el-form-item label="凭证过期时间（ISO 带时区）"
              ><el-input v-model="exportForm.expiresAt" /></el-form-item
            ><el-form-item label="单次最长天数"
              ><el-input-number
                v-model="exportForm.maxRangeDays"
                :min="1"
                :max="90" /></el-form-item
            ><el-form-item label="每接口每分钟请求上限（所有凭证共享）"
              ><el-input-number
                v-model="exportForm.rateLimit"
                :min="1"
                :max="600" /></el-form-item
            ><el-button @click="createInterface">{{
              editingInterface ? "更新范围并撤销旧凭证" : "创建关闭的接口"
            }}</el-button></el-form
          >
        </el-tab-pane>
        <el-tab-pane name="abnormal" label="异常访问">
          <el-alert
            title="真实规则未获批准时默认关闭。仅供调查，不生成个人评分或绩效排名。多 IP、无权限拦截缺少事实，明确不可计算。"
            type="warning"
            :closable="false"
          />
          <h2>调查证据</h2>
          <pre>{{ JSON.stringify(evidence, null, 2) }}</pre>
          <el-button @click="exportEvidence">导出可见调查证据（记录审计）</el-button>
          <template v-if="canWrite"
            ><h2>版本化规则</h2>
            <el-table :data="rules" empty-text="尚无规则版本"
              ><el-table-column prop="id" label="版本" /><el-table-column
                prop="ruleKey"
                label="规则"
              /><el-table-column prop="status" label="状态" /><el-table-column
                label="操作"
                ><template #default="{ row }"
                  ><el-button
                    @click="
                      ruleKey = row.ruleKey;
                      ruleConfig = JSON.stringify(row.config, null, 2);
                    "
                    >复制为新草稿</el-button
                  ><el-button
                    v-if="row.status === 'draft'"
                    @click="approval.versionId = row.id"
                    >登记评审</el-button
                  ><el-button
                    :disabled="busy || row.status === 'draft'"
                    @click="
                      mutate('/settings/abnormal-rules/' + row.id + '/enable', {})
                    "
                    >启用</el-button
                  ><el-button
                    :disabled="busy"
                    @click="
                      mutate('/settings/abnormal-rules/' + row.id + '/disable', {})
                    "
                    >停用</el-button
                  ></template
                ></el-table-column
              ></el-table
            >
            <el-form label-position="top" :disabled="busy"
              ><el-form-item label="规则"
                ><el-select v-model="ruleKey"
                  ><el-option
                    v-for="k in [
                      'outside_hours',
                      'historical_volume',
                      'multi_device',
                      'multi_ip',
                      'permission_denied',
                    ]"
                    :key="k"
                    :value="k" /></el-select></el-form-item
              ><el-form-item
                label="配置草稿（示例阈值未批准；创建后不可改写，修改须新建版本）"
                ><el-input v-model="ruleConfig" type="textarea" :rows="16"
              /></el-form-item>
              <p>
                env 环境；threshold ≥ 边界；minimumSample 样本数；baselineDays
                历史窗口；minimumBaselineDays 有操作日下限；multiplier
                相对历史倍数；workStart/workEnd 项目时区整点；workDays
                周日=0；visibleRoles 可见角色；sharedSubjects
                共享账号调查引用；exceptions 使用
                subject/from/to/reason（travel/on_call/shared_account）。
              </p>
              <el-button @click="createRule">创建待评审草稿</el-button></el-form
            >
            <el-form v-if="approval.versionId" label-position="top" :disabled="busy"
              ><h3>登记真实管理层与安全评审：{{ approval.versionId }}</h3>
              <p>仅项目 owner 可登记，管理员身份本身不代表规则已获管理层/安全批准。</p>
              <el-form-item label="管理层批准者"
                ><el-input v-model="approval.managementApprover" /></el-form-item
              ><el-form-item label="安全批准者"
                ><el-input v-model="approval.securityApprover" /></el-form-item
              ><el-form-item label="批准时间（ISO 带时区）"
                ><el-input v-model="approval.approvedAt" /></el-form-item
              ><el-form-item label="审批来源或工单链接"
                ><el-input v-model="approval.source" /></el-form-item
              ><el-checkbox v-model="approval.attested"
                >确认已取得覆盖此版本全部规则、阈值、范围、角色和例外的真实评审</el-checkbox
              ><el-button :disabled="!approval.attested" @click="approveRule"
                >登记批准记录</el-button
              ></el-form
            >
          </template>
        </el-tab-pane>
        <el-tab-pane v-if="canWrite" name="audit" label="审计">
          <pre>{{ JSON.stringify(audit, null, 2) }}</pre>
          <el-button :disabled="auditPage === 1" @click="auditPage--">上一页</el-button
          ><span>第 {{ auditPage }} 页</span
          ><el-button @click="auditPage++">下一页</el-button></el-tab-pane
        >
      </el-tabs>
    </template>
  </section>
</template>
<style scoped>
.settings-r7 {
  display: grid;
  gap: 16px;
}
.settings-r7 pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 16px;
  background: var(--el-fill-color-light);
  max-height: 560px;
  overflow: auto;
}
.settings-r7 :deep(.el-form) {
  max-width: 850px;
  margin: 24px 0;
}
.settings-r7 :deep(.el-select) {
  min-width: 180px;
}
.settings-r7 h2 {
  margin-top: 28px;
}
</style>
