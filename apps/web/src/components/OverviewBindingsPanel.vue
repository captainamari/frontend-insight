<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { api, ApiError } from "../api";
const props = defineProps<{
  projectId: string;
  versionId: string;
  canWrite: boolean;
}>();
const emit = defineEmits<{ saved: [string] }>();
interface Snapshot {
  version: { id: string; status: string; libraryType: string };
  metricKeys: string[];
  definitions: {
    metricKey: string;
    displayName: string;
    implementationStatus: string;
    enabled: boolean;
    entityScopes: string[];
  }[];
}
const data = ref<Snapshot | null>(null),
  keys = ref<string[]>([]),
  error = ref(""),
  notice = ref(""),
  busy = ref(false);
let generation = 0;
const base = () =>
  `/api/projects/${props.projectId}/metrics/versions/${props.versionId}/overview-bindings`;
watch(
  () => [props.projectId, props.versionId],
  async () => {
    const id = ++generation;
    busy.value = false;
    notice.value = "";
    data.value = null;
    error.value = "";
    try {
      const r = await api.request<Snapshot>(base());
      if (id !== generation) return;
      data.value = r;
      keys.value = [...r.metricKeys];
    } catch (e) {
      if (id === generation)
        error.value = e instanceof ApiError ? e.code : "绑定读取失败";
    }
  },
  { immediate: true },
);
async function save() {
  const id = generation;
  busy.value = true;
  error.value = "";
  try {
    const r = await api.request<Snapshot>(base(), {
      method: "PUT",
      body: JSON.stringify({ metricKeys: keys.value }),
    });
    if (id !== generation) return;
    data.value = r;
    notice.value = "已保存到工作草稿。请查看影响范围并完成既有评审、激活流程后发布。";
    emit("saved", r.version.id);
  } catch (e) {
    if (id === generation)
      error.value =
        e instanceof ApiError
          ? e.code + " · 请求ID " + e.requestId
          : "保存失败，选择已保留";
  } finally {
    if (id === generation) busy.value = false;
  }
}
onBeforeUnmount(() => generation++);
</script>
<template>
  <details v-if="data?.version.libraryType === 'operational'" class="bindings">
    <summary>概览展示指标（版本化）</summary>
    <p>
      当前版本的指标卡与趋势共用此绑定，最多24项。修改已激活版本会创建或复用草稿；不会直接改线上显示。partial
      可绑定并显示实际限制，not_collected 不可绑定。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <fieldset :disabled="!canWrite || busy || data.version.status === 'abandoned'">
      <legend>选择概览指标</legend>
      <label
        v-for="d in data.definitions.filter((d) => d.entityScopes.includes('project'))"
        :key="d.metricKey"
        ><input
          v-model="keys"
          type="checkbox"
          :value="d.metricKey"
          :disabled="
            !d.enabled ||
            d.implementationStatus === 'not_collected' ||
            (!keys.includes(d.metricKey) && keys.length >= 24)
          "
        />{{ d.displayName }} · {{ d.metricKey }} · {{ d.implementationStatus }}</label
      >
    </fieldset>
    <button
      v-if="canWrite && data.version.status !== 'abandoned'"
      :disabled="busy"
      @click="save"
    >
      保存概览展示到草稿
    </button>
  </details>
  <p v-else-if="error" role="alert">{{ error }}</p>
</template>
<style scoped>
.bindings {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 16px;
  margin: 16px 0;
}
.bindings label {
  display: block;
  margin: 8px 0;
}
.bindings p {
  font-size: 13px;
  color: #536477;
}
.bindings button {
  padding: 8px 12px;
  margin-top: 12px;
}
summary {
  cursor: pointer;
}
</style>
