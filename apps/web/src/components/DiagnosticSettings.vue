<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { api } from "../api";
import { ApiError } from "../api";
import type {
  DiagnosticPolicy,
  PublishedDiagnosticPolicy,
} from "@frontend-insight/event-contract/diagnostic-policy";
const props = defineProps<{ projectId: string; canWrite: boolean }>();
interface Settings extends PublishedDiagnosticPolicy {
  grants: {
    userId: string;
    displayName: string;
    canRead: boolean;
    canExport: boolean;
  }[];
  compatibility: string;
}
interface Maintenance {
  at: string;
  scope: string;
  counts: {
    state: string;
    count: number;
    bytes: number;
    expired: number;
    validBytes: number;
    persistDelayMs: number | null;
  }[];
  health: unknown[];
  maps: unknown[];
  cleanup: unknown[];
  deletions: unknown[];
  diskBytes: null;
  ingestion: unknown;
}
interface Artifact {
  id: string;
  release: string;
  build: string;
  bytes: number;
  state: string;
  expiresAt: string;
}
const settings = ref<Settings | null>(null),
  maintenance = ref<Maintenance | null>(null),
  artifacts = ref<Artifact[]>([]);
const policy = ref<DiagnosticPolicy | null>(null),
  requestRoutes = ref(""),
  successRoutes = ref("");
const error = ref(""),
  notice = ref(""),
  busy = ref(false),
  eventId = ref(""),
  confirmDelete = ref(false),
  credentialId = ref("");
let generation = 0;
const root = () => `/api/projects/${props.projectId}/diagnostics`;
async function load() {
  const g = ++generation;
  error.value = "";
  settings.value = null;
  policy.value = null;
  maintenance.value = null;
  artifacts.value = [];
  if (!props.canWrite) return;
  try {
    const [s, m, a] = await Promise.all([
      api.request<Settings>(root() + "/settings"),
      api.request<Maintenance>(root() + "/maintenance"),
      api.request<Artifact[]>(
        `/api/projects/${props.projectId}/diagnostics/sourcemaps`,
      ),
    ]);
    if (g !== generation) return;
    settings.value = s;
    policy.value = structuredClone(s.policy);
    maintenance.value = m;
    artifacts.value = a;
    requestRoutes.value = s.policy.requestRoutes.join("\n");
    successRoutes.value = s.policy.successBodyRoutes.join("\n");
  } catch (e) {
    if (g === generation)
      error.value = e instanceof ApiError ? e.code : "DIAGNOSTICS_STATUS_UNAVAILABLE";
  }
}
async function action(work: () => Promise<unknown>, message: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  const g = generation;
  try {
    await work();
    if (g === generation) {
      await load();
      notice.value = message;
    }
  } catch (e) {
    if (g === generation)
      error.value = e instanceof ApiError ? e.code : "DIAGNOSTICS_OPERATION_FAILED";
  } finally {
    busy.value = false;
  }
}
function publish() {
  if (!policy.value || !settings.value) return;
  const next = {
    ...policy.value,
    requestRoutes: requestRoutes.value.split("\n").filter(Boolean),
    successBodyRoutes: successRoutes.value.split("\n").filter(Boolean),
  };
  void action(
    () =>
      api.request(root() + "/policy", {
        method: "PUT",
        body: JSON.stringify({ revision: settings.value!.revision, policy: next }),
      }),
    "发布成功；请在客户端查询实际同步状态。已有证据的保留期不变。",
  );
}
function grant(userId: string, read: boolean, exportRaw: boolean) {
  void action(
    () =>
      api.request(root() + `/grants/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ read, export: read && exportRaw }),
      }),
    "能力已更新；服务端立即执行当前权限。",
  );
}
function remove() {
  if (!confirmDelete.value || !/^evt_[A-Za-z0-9_-]{8,64}$/.test(eventId.value)) return;
  const id = eventId.value;
  void action(
    () => api.request(root() + `/instances/${id}`, { method: "DELETE" }),
    `实例 ${id} 已逻辑删除；物理清理由后台重试。基础统计不变。`,
  );
  confirmDelete.value = false;
}
function removeMap(a: Artifact) {
  if (
    !window.confirm(
      `项目 ${props.projectId}\nSourceMap ${a.id}\n只删除此制品；不删除错误原文。确认？`,
    )
  )
    return;
  void action(
    () =>
      api.request(`/api/projects/${props.projectId}/diagnostics/sourcemaps/${a.id}`, {
        method: "DELETE",
      }),
    "SourceMap 已删除，原始编译栈不变。",
  );
}
watch(
  () => [props.projectId, props.canWrite],
  () => {
    eventId.value = "";
    confirmDelete.value = false;
    notice.value = "";
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => generation++);
</script>
<template>
  <section aria-label="诊断策略与维护">
    <h2>诊断策略与维护</h2>
    <p v-if="!canWrite">
      仅管理员可管理诊断策略、授权和历史证据。获 diagnostics.read 的 viewer
      保持业务只读。
    </p>
    <template v-else>
      <button :disabled="busy" @click="load">重新读取策略与维护状态</button>
      <p v-if="error" role="alert">
        {{ error }}。状态读取失败时容量未知；版本冲突请重新读取后编辑。
      </p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <form v-if="policy && settings" @submit.prevent="publish">
        <p>
          已发布版本 {{ settings.version }} · revision {{ settings.revision }} ·
          更新时间 {{ settings.updatedAt ?? "兼容默认配置" }}。{{
            settings.compatibility
          }}
        </p>
        <label><input v-model="policy.enabled" type="checkbox" />启用诊断采集</label>
        <label
          >采集级别<select v-model="policy.level">
            <option value="errors">错误原文</option>
            <option value="context">错误与已接入上下文</option>
          </select></label
        >
        <fieldset>
          <legend>允许的 console 级别（与应用本地授权取交集）</legend>
          <label v-for="level in ['error', 'warn', 'log', 'info', 'debug']" :key="level"
            ><input v-model="policy.consoleLevels" type="checkbox" :value="level" />{{
              level
            }}</label
          >
        </fieldset>
        <label
          >请求 pathname 范围（每行一条）<textarea v-model="requestRoutes" rows="3" />
        </label>
        <label
          >成功请求正文 pathname 范围（仍需本地授权）<textarea
            v-model="successRoutes"
            rows="3"
          />
        </label>
        <p>
          只支持精确 /path 或 /prefix/** 子树；最多32条，每条256字符，不匹配
          query/origin，不使用正则。页面规范 route 与完整请求 URL 是不同字段。
        </p>
        <label
          >单信封字节上限<input
            v-model.number="policy.envelopeBytes"
            type="number"
            min="1024"
            max="65536"
        /></label>
        <label
          >每页面每分钟详情上限<input
            v-model.number="policy.envelopesPerMinute"
            type="number"
            min="1"
            max="20"
        /></label>
        <label
          >新证据保留天数<input
            v-model.number="policy.retentionDays"
            type="number"
            min="1"
            max="90"
        /></label>
        <p>
          关闭采集不撤销读取、不删除历史。离线客户端不会立即同步；服务端仍约束后续上传。基础事实和分母保持不变。
        </p>
        <button :disabled="busy" type="submit">保存并发布诊断策略</button>
      </form>
      <section v-if="settings">
        <h3>诊断能力授权</h3>
        <table>
          <thead>
            <tr>
              <th>当前项目成员</th>
              <th>读取</th>
              <th>导出（依赖读取）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in settings.grants" :key="g.userId">
              <td>{{ g.displayName }}</td>
              <td>
                <input
                  type="checkbox"
                  :aria-label="`${g.displayName} 读取`"
                  :checked="Boolean(g.canRead)"
                  :disabled="busy"
                  @change="
                    grant(
                      g.userId,
                      ($event.target as HTMLInputElement).checked,
                      Boolean(g.canExport),
                    )
                  "
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  :aria-label="`${g.displayName} 导出`"
                  :checked="Boolean(g.canExport)"
                  :disabled="busy || !g.canRead"
                  @change="
                    grant(
                      g.userId,
                      Boolean(g.canRead),
                      ($event.target as HTMLInputElement).checked,
                    )
                  "
                />
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <section v-if="maintenance">
        <h3>容量与链路状态</h3>
        <p>统计时间：{{ maintenance.at }}。{{ maintenance.scope }}</p>
        <table>
          <thead>
            <tr>
              <th>接收状态</th>
              <th>事件数</th>
              <th>逻辑字节</th>
              <th>仍可读逻辑字节</th>
              <th>已过期数</th>
              <th>首次准入到持久化平均毫秒</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in maintenance.counts" :key="c.state">
              <td>{{ c.state }}</td>
              <td>{{ c.count }}</td>
              <td>{{ c.bytes }}</td>
              <td>{{ c.validBytes }}</td>
              <td>{{ c.expired }}</td>
              <td>{{ c.persistDelayMs ?? "未知" }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!maintenance.counts.length">
          暂无接收观测；不能据此推断客户端无错误。
        </p>
        <details>
          <summary>接收拒绝与Kafka发送状态（当前API进程启动以来，所有项目）</summary>
          <pre>{{ JSON.stringify(maintenance.ingestion, null, 2) }}</pre>
          <p>
            rejectionCodes按请求计数；accepted/rejectedEvents按事件尝试计数，重试会再次计入，不等于去重后的业务事实。
          </p>
        </details>
        <details open>
          <summary>客户端健康：当前实例累计计数，服务端按实例/序号去重</summary>
          <pre>{{
            maintenance.health.length
              ? JSON.stringify(maintenance.health, null, 2)
              : "暂无观测；旧SDK不支持"
          }}</pre>
        </details>
        <details>
          <summary>SourceMap 配额账面值 / 清理状态（全服务）</summary>
          <pre>{{
            JSON.stringify(
              { maps: maintenance.maps, cleanup: maintenance.cleanup },
              null,
              2,
            )
          }}</pre>
        </details>
        <details>
          <summary>最近50项删除任务</summary>
          <pre>{{ JSON.stringify(maintenance.deletions, null, 2) }}</pre>
        </details>
      </section>
      <section>
        <h3>主动删除单个原始证据</h3>
        <p>
          项目：<code>{{ projectId }}</code
          >。范围仅为下列 eventId，基础事实、评分及 SourceMap
          均保留。不能撤回已下载文件。
        </p>
        <label>实例 eventId<input v-model="eventId" placeholder="evt_…" /></label
        ><label
          ><input
            v-model="confirmDelete"
            type="checkbox"
          />确认删除此项目此实例的原文</label
        ><button :disabled="busy || !confirmDelete" @click="remove">
          删除指定原始证据
        </button>
      </section>
      <section>
        <h3>SourceMap 制品</h3>
        <p>每个制品沿用上传时设置的1–90天保留期（默认30天），不会随错误策略调整。</p>
        <table>
          <thead>
            <tr>
              <th>release/build</th>
              <th>状态/到期</th>
              <th>字节</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in artifacts" :key="a.id">
              <td>
                {{ a.release }} / {{ a.build }}<br /><code>{{ a.id }}</code>
              </td>
              <td>{{ a.state }} / {{ a.expiresAt }}</td>
              <td>{{ a.bytes }}</td>
              <td>
                <button :disabled="busy || a.state !== 'ready'" @click="removeMap(a)">
                  删除此 SourceMap
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          签发/上传沿用受限
          <code>node tools/sourcemaps.mjs issue|upload</code
          >（D5指南）；凭证不进入普通设置响应。
        </p>
        <label>待撤销的上传凭证 UUID<input v-model="credentialId" /></label
        ><button
          :disabled="busy || !credentialId"
          @click="
            action(
              () =>
                api.request(
                  `/api/projects/${projectId}/diagnostics/sourcemaps/credentials/${credentialId}`,
                  { method: 'DELETE' },
                ),
              '上传凭证已撤销',
            )
          "
        >
          撤销指定上传凭证
        </button>
      </section>
      <section>
        <h3>备份与恢复入口</h3>
        <p>
          维护者在受限运维终端执行
          <code>./scripts/production backup NAME</code>。恢复按指南使用
          <code>restore NAME --confirm-replace-data</code
          >，先停写、核验备份和保留卷。恢复旧备份可能恢复旧权限、凭证及已删除数据；开放服务前重新核对并撤销。页面不执行数据库破坏性恢复。
        </p>
      </section>
    </template>
  </section>
</template>
<style scoped>
label {
  display: block;
  margin: 0.7rem 0;
}
input,
select,
textarea,
button {
  margin: 0.3rem;
}
textarea {
  display: block;
  min-width: 25rem;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 1rem 0;
}
td,
th {
  padding: 0.5rem;
  text-align: left;
  border-bottom: 1px solid #ddd;
}
pre,
code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
section {
  margin: 1rem 0;
}
[role="alert"] {
  color: #b42318;
}
</style>
