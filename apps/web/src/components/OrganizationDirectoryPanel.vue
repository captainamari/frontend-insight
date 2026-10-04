<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { api, ApiError } from "../api";
const props = defineProps<{ projectId: string; canWrite: boolean }>();
interface Version {
  id: string;
  env: string;
  sourceKey: string;
  coverage: string;
  status: string;
  from: string | null;
  until: string;
  entryCount: number;
}
const versions = ref<Version[]>([]),
  input = ref(""),
  error = ref(""),
  feedback = ref(""),
  busy = ref(false);
let generation = 0;
let controller: AbortController | undefined;
const example = JSON.stringify(
  {
    env: "dev",
    sourceKey: "isolated_fixture",
    coverage: "unknown",
    validUntil: "2027-01-01T00:00:00Z",
    entries: [
      {
        userId: "u_isolated_opaque_0001",
        deptId: "dept_fixture",
        roleId: "role_fixture",
        eligible: true,
      },
    ],
  },
  null,
  2,
);
async function load() {
  controller?.abort();
  controller = new AbortController();
  const g = ++generation;
  versions.value = [];
  error.value = "";
  if (!props.canWrite || !props.projectId) return;
  try {
    const rows = await api.request<Version[]>(
      `/api/projects/${props.projectId}/directory`,
      { signal: controller.signal },
    );
    if (g === generation) versions.value = rows;
  } catch (cause) {
    if (g === generation) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status))
        input.value = "";
      error.value =
        cause instanceof ApiError
          ? `${cause.code} (${cause.requestId ?? ""})`
          : "目录读取失败，请重试";
    }
  }
}
async function mutate(id?: string) {
  if (busy.value || !props.canWrite) return;
  const project = props.projectId,
    g = generation;
  busy.value = true;
  error.value = "";
  feedback.value = "";
  try {
    let body: unknown;
    if (!id) {
      if (new TextEncoder().encode(input.value).length > 60 * 1024)
        throw new Error("IMPORT_TOO_LARGE");
      body = JSON.parse(input.value);
    }
    await api.request(
      `/api/projects/${project}/directory${id ? `/${id}/publish` : ""}`,
      { method: "POST", ...(id ? {} : { body: JSON.stringify(body) }) },
    );
    if (g !== generation || project !== props.projectId) return;
    input.value = "";
    await load();
    if (generation !== g + 1 || project !== props.projectId || !props.canWrite) return;
    feedback.value = id
      ? "版本已发布，从现在起生效；历史归属不变。"
      : "草稿已保存。核对来源、环境、人数及有效期后发布。";
  } catch (cause) {
    if (g === generation) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        versions.value = [];
        input.value = "";
      }
      error.value =
        cause instanceof ApiError
          ? `${cause.code} (${cause.requestId ?? ""})`
          : "导入失败：请检查 JSON 格式与60KiB大小限制";
    }
  } finally {
    busy.value = false;
  }
}
watch(
  () => [props.projectId, props.canWrite],
  () => {
    input.value = "";
    feedback.value = "";
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  controller?.abort();
  input.value = "";
  versions.value = [];
});
</script>
<template>
  <section aria-labelledby="directory-title">
    <h2 id="directory-title">组织目录</h2>
    <p>
      业务系统编制目录，与平台登录成员分开。只导入受控标识，不填姓名、邮箱、原始工号或部门/角色名称。发布后不可修改；人员变化请导入新版本。
    </p>
    <p>
      仅从发布时刻向后生效，不补写历史。每项目最多100版本、每版本500人；超限会拒绝。当前只支持单角色，多角色需要另行确定归属口径。
    </p>
    <p v-if="!canWrite">只有项目管理员可以管理目录；viewer只读受保护聚合。</p>
    <template v-else>
      <details>
        <summary>导入格式（隔离示例，非生产组织资料）</summary>
        <pre>{{ example }}</pre>
        <p>
          userId由业务可信系统生成不透明引用，并与SDK
          setUser一致。coverage=complete需管理员核实完整eligible名册；它不证明使用事件完整。示例有效期需自行更新。
        </p>
      </details>
      <label for="directory-json">受控目录 JSON</label>
      <textarea
        id="directory-json"
        v-model="input"
        rows="10"
        maxlength="61440"
        autocomplete="off"
        spellcheck="false"
        :disabled="busy"
      />
      <button :disabled="busy || !input.trim()" @click="mutate()">
        校验并保存草稿
      </button>
      <button :disabled="busy" @click="load">刷新版本</button>
      <p v-if="error" role="alert">{{ error }}</p>
      <p role="status">{{ feedback }}</p>
      <table>
        <caption>
          不可变目录版本（不返回个人行）
        </caption>
        <thead>
          <tr>
            <th>版本</th>
            <th>环境/来源</th>
            <th>覆盖/人数</th>
            <th>生效至失效</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in versions" :key="v.id">
            <td>{{ v.id }}</td>
            <td>{{ v.env }} / {{ v.sourceKey }}</td>
            <td>{{ v.coverage }} / {{ v.entryCount }}</td>
            <td>{{ v.from ?? "尚未发布" }} — {{ v.until }}</td>
            <td>{{ v.status }}</td>
            <td>
              <button
                v-if="v.status === 'draft'"
                :disabled="busy"
                @click="mutate(v.id)"
              >
                发布此目录版本
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
<style scoped>
textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  font: inherit;
  margin: 1rem 0;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
table {
  width: 100%;
  table-layout: fixed;
}
td,
th {
  overflow-wrap: anywhere;
  padding: 0.5rem;
  text-align: left;
}
button {
  margin: 0.4rem;
}
</style>
