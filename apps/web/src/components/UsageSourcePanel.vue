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
  sdkVersion: string;
  releases: string[];
  scope: { pageCount: number; featureCount: number };
}
const versions = ref<Version[]>([]),
  input = ref(""),
  error = ref(""),
  feedback = ref(""),
  busy = ref(false);
const environment = ref("dev"),
  releases = ref(""),
  days = ref(90),
  coverage = ref("complete"),
  confirmed = ref(false);
let generation = 0;
let controller: AbortController | undefined;
const example = JSON.stringify(
  {
    env: "dev",
    sourceKey: "internal_app",
    coverage: "complete",
    sdkVersion: "0.8.0",
    releases: ["your_release"],
    validUntil: new Date(Date.now() + 90 * 86400000).toISOString(),
    attested: true,
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
      `/api/projects/${props.projectId}/usage-sources`,
      { signal: controller.signal },
    );
    if (g === generation) versions.value = rows;
  } catch (cause) {
    if (g === generation) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status))
        input.value = "";
      releases.value = "";
      confirmed.value = false;
      error.value =
        cause instanceof ApiError
          ? `${cause.code} (${cause.requestId ?? ""})`
          : "接入声明读取失败，请重试";
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
      if (!confirmed.value) return;
      body = {
        env: environment.value,
        sourceKey: "internal_app",
        coverage: coverage.value,
        sdkVersion: "0.8.0",
        releases: releases.value.split(",").map((v) => v.trim()),
        validUntil: new Date(Date.now() + Number(days.value) * 86400000).toISOString(),
        attested: true,
      };
    }
    await api.request(
      `/api/projects/${project}/usage-sources${id ? `/${id}/publish` : ""}`,
      { method: "POST", ...(id ? {} : { body: JSON.stringify(body) }) },
    );
    if (g !== generation || project !== props.projectId) return;
    input.value = "";
    await load();
    if (generation !== g + 1 || project !== props.projectId || !props.canWrite) return;
    feedback.value = id
      ? "版本已发布，从现在起生效；历史声明不变。"
      : "草稿已保存。核对来源、环境、发布版本及有效期后发布。";
  } catch (cause) {
    if (g === generation) {
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        versions.value = [];
        input.value = "";
        releases.value = "";
        confirmed.value = false;
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
    releases.value = "";
    confirmed.value = false;
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
  <section aria-labelledby="usage-sources-title">
    <h2 id="usage-sources-title">全量接入声明</h2>
    <p>
      管理员确认当前所有已登记业务页面和功能已全量、未采样接入，业务用户身份一致，且没有已知漏采。系统冻结当前页面/模块
      revision 与功能集合，校验实际 SDK
      和发布版本；这份声明不代表机器证明所有客户端均无丢失。
    </p>
    <p>
      仅从发布时刻生效，历史不回填。增加页面、变更 revision 或
      SDK/发布版本后，请发布新声明。发现接入中断时发布
      coverage=interrupted，旧声明不会在其失效后自动恢复。最多100版本、每版20个发布版本、1000页面及1000功能。
    </p>
    <p v-if="!canWrite">只有项目管理员可以发布接入声明。</p>
    <template v-else>
      <details>
        <summary>声明格式（将 your_release 替换为真实 SDK release）</summary>
        <pre>{{ example }}</pre>
        <p>
          attested=true
          表示管理员已核实上述接入范围。声明和目录分别发布，正式值还需要兼容指标草稿完成
          review 与激活。
        </p>
      </details>
      <label
        >环境
        <select v-model="environment" :disabled="busy">
          <option value="dev">dev</option>
          <option value="staging">staging</option>
          <option value="prod">prod</option>
        </select></label
      >
      <label
        >已部署 release（逗号分隔）
        <input v-model="releases" :disabled="busy" maxlength="1299" autocomplete="off"
      /></label>
      <label
        >声明有效天数
        <input v-model.number="days" type="number" min="1" max="366" :disabled="busy"
      /></label>
      <label
        >覆盖状态
        <select v-model="coverage" :disabled="busy">
          <option value="complete">已全量接入且未采样</option>
          <option value="interrupted">接入中断或存在已知缺失</option>
        </select></label
      >
      <label
        ><input
          v-model="confirmed"
          type="checkbox"
          :disabled="busy"
        />我已核实上述范围及覆盖状态</label
      >
      <button :disabled="busy || !releases.trim() || !confirmed" @click="mutate()">
        校验并保存声明草稿
      </button>
      <button :disabled="busy" @click="load">刷新版本</button>
      <p v-if="error" role="alert">{{ error }}</p>
      <p role="status">{{ feedback }}</p>
      <table>
        <caption>
          不可变接入声明版本
        </caption>
        <thead>
          <tr>
            <th>版本</th>
            <th>环境/来源</th>
            <th>覆盖/SDK/范围</th>
            <th>生效至失效</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in versions" :key="v.id">
            <td>{{ v.id }}</td>
            <td>{{ v.env }} / {{ v.sourceKey }} / {{ v.releases.join(", ") }}</td>
            <td>
              {{ v.coverage }} / {{ v.sdkVersion }} / {{ v.scope.pageCount }}页 /
              {{ v.scope.featureCount }}功能
            </td>
            <td>{{ v.from ?? "尚未发布" }} — {{ v.until }}</td>
            <td>{{ v.status }}</td>
            <td>
              <button
                v-if="v.status === 'draft'"
                :disabled="busy"
                @click="mutate(v.id)"
              >
                发布此接入声明
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
<style scoped>
label {
  display: block;
  margin: 0.6rem 0;
}
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
