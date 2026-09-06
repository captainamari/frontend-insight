<script setup lang="ts">
import { computed } from "vue";

type ImplementationStatus = "implemented" | "partial" | "not_collected";

interface LineageNode {
  metricKey: string;
  displayName: string;
  origin: "system" | "business";
  unit: string;
  minimumSample: number;
  missingPolicy: string;
  implementationStatus: ImplementationStatus;
}

interface MetricLineage {
  metricKey: string;
  versionId: string;
  formulaAst: unknown;
  formulaDescription: string;
  nodes: LineageNode[];
  edges: Array<{ from: string; to: string }>;
  directUpstream: string[];
  directDownstream: string[];
  validation: {
    valid: boolean;
    errors: Array<{ code: string; metricKey: string | null; path: string }>;
  };
}

const props = defineProps<{
  modelValue: boolean;
  lineage: MetricLineage | null;
}>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

const statusLabel = (status: ImplementationStatus): string =>
  status === "implemented" ? "已实现" : status === "partial" ? "部分实现" : "未采集";

const graph = computed(() => {
  const nodes = props.lineage?.nodes ?? [];
  const edges = props.lineage?.edges ?? [];
  const nodeKeys = new Set(nodes.map((item) => item.metricKey));
  const indegree = new Map(nodes.map((item) => [item.metricKey, 0]));
  const outgoing = new Map(nodes.map((item) => [item.metricKey, [] as string[]]));
  for (const edge of edges) {
    if (!nodeKeys.has(edge.from) || !nodeKeys.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = [...nodes]
    .filter((item) => indegree.get(item.metricKey) === 0)
    .map((item) => item.metricKey)
    .sort();
  const levels = new Map(nodes.map((item) => [item.metricKey, 0]));
  while (queue.length) {
    const key = queue.shift()!;
    for (const target of outgoing.get(key) ?? []) {
      levels.set(target, Math.max(levels.get(target) ?? 0, (levels.get(key) ?? 0) + 1));
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
    queue.sort();
  }
  const grouped = new Map<number, LineageNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.metricKey) ?? 0;
    grouped.set(level, [...(grouped.get(level) ?? []), node]);
  }
  for (const values of grouped.values()) {
    values.sort((left, right) => left.metricKey.localeCompare(right.metricKey));
  }
  const positioned = nodes.map((node) => {
    const level = levels.get(node.metricKey) ?? 0;
    const siblings = grouped.get(level) ?? [];
    const index = siblings.findIndex((item) => item.metricKey === node.metricKey);
    return { ...node, x: 28 + level * 230, y: 28 + index * 112 };
  });
  const positionByKey = new Map(positioned.map((item) => [item.metricKey, item]));
  const positionedEdges = edges.flatMap((edge) => {
    const from = positionByKey.get(edge.from);
    const to = positionByKey.get(edge.to);
    return from && to
      ? [
          {
            ...edge,
            x1: from.x + 188,
            y1: from.y + 39,
            x2: to.x,
            y2: to.y + 39,
          },
        ]
      : [];
  });
  const maximumLevel = Math.max(
    0,
    ...positioned.map((item) => levels.get(item.metricKey) ?? 0),
  );
  const maximumRows = Math.max(
    1,
    ...[...grouped.values()].map((items) => items.length),
  );
  return {
    nodes: positioned,
    edges: positionedEdges,
    width: Math.max(680, 56 + (maximumLevel + 1) * 230),
    height: Math.max(160, 56 + maximumRows * 112),
  };
});

function truncate(value: string, maximum = 22): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}
</script>

<template>
  <el-drawer v-model="open" title="指标血缘" size="min(860px, 96vw)">
    <article v-if="lineage" class="lineage-content">
      <header class="lineage-summary">
        <div>
          <span>当前指标</span>
          <h2>{{ lineage.metricKey }}</h2>
          <p>{{ lineage.formulaDescription }}</p>
        </div>
        <el-tag :type="lineage.validation.valid ? 'success' : 'danger'">
          {{ lineage.validation.valid ? "依赖校验通过" : "依赖校验失败" }}
        </el-tag>
      </header>

      <el-alert
        v-if="lineage.formulaAst === null && lineage.edges.length === 0"
        type="info"
        :closable="false"
        show-icon
        title="这是受保护的系统指标，当前没有已注册的可执行公式依赖；页面不会根据文字公式猜测或伪造上游。"
      />

      <section class="lineage-section">
        <div class="section-title">
          <div>
            <h3>依赖 DAG</h3>
            <p>箭头由上游指标指向当前计算结果。</p>
          </div>
          <span>版本 {{ lineage.versionId }}</span>
        </div>
        <div class="graph-scroll" data-testid="lineage-graph">
          <svg
            :viewBox="`0 0 ${graph.width} ${graph.height}`"
            :width="graph.width"
            :height="graph.height"
            role="img"
            :aria-label="`${lineage.metricKey} 指标依赖无环图`"
          >
            <defs>
              <marker
                id="metric-lineage-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            <path
              v-for="edge in graph.edges"
              :key="`${edge.from}-${edge.to}`"
              class="graph-edge"
              :data-edge="`${edge.from}->${edge.to}`"
              :d="`M ${edge.x1} ${edge.y1} C ${edge.x1 + 28} ${edge.y1}, ${edge.x2 - 28} ${edge.y2}, ${edge.x2} ${edge.y2}`"
              marker-end="url(#metric-lineage-arrow)"
            />
            <g
              v-for="node in graph.nodes"
              :key="node.metricKey"
              :transform="`translate(${node.x}, ${node.y})`"
              :class="[
                'graph-node',
                `status-${node.implementationStatus}`,
                { root: node.metricKey === lineage.metricKey },
              ]"
              :data-node-key="node.metricKey"
              role="group"
              :aria-label="`${node.displayName}，${node.metricKey}，${statusLabel(node.implementationStatus)}`"
            >
              <rect width="188" height="78" rx="10" />
              <text x="14" y="24" class="node-name">
                {{ truncate(node.displayName) }}
              </text>
              <text x="14" y="45" class="node-key">{{ truncate(node.metricKey) }}</text>
              <text x="14" y="64" class="node-meta">
                {{ node.unit }} · 样本 ≥ {{ node.minimumSample }} ·
                {{ statusLabel(node.implementationStatus) }}
              </text>
            </g>
          </svg>
        </div>
      </section>

      <section class="lineage-section relation-grid">
        <div>
          <h3>直接上游</h3>
          <div v-if="lineage.directUpstream.length" class="tag-list">
            <el-tag v-for="key in lineage.directUpstream" :key="key" effect="plain">
              {{ key }}
            </el-tag>
          </div>
          <p v-else>没有已注册的直接上游。</p>
        </div>
        <div>
          <h3>直接下游</h3>
          <div v-if="lineage.directDownstream.length" class="tag-list">
            <el-tag v-for="key in lineage.directDownstream" :key="key" effect="plain">
              {{ key }}
            </el-tag>
          </div>
          <p v-else>当前快照中没有直接下游。</p>
        </div>
      </section>

      <el-alert
        v-if="!lineage.validation.valid"
        type="error"
        :closable="false"
        show-icon
        :title="`依赖校验失败：${lineage.validation.errors.map((item) => item.code).join('、')}`"
      />

      <details class="lineage-details">
        <summary>查看血缘明细表</summary>
        <el-table :data="lineage.nodes" size="small">
          <el-table-column prop="metricKey" label="指标 key" min-width="170" />
          <el-table-column prop="displayName" label="中文名" min-width="150" />
          <el-table-column prop="unit" label="单位" min-width="120" />
          <el-table-column label="最小样本" width="100">
            <template #default="{ row }">{{ row.minimumSample }}</template>
          </el-table-column>
          <el-table-column label="实施状态" width="110">
            <template #default="{ row }">{{
              statusLabel(row.implementationStatus)
            }}</template>
          </el-table-column>
          <el-table-column prop="missingPolicy" label="数据缺失规则" min-width="260" />
        </el-table>
      </details>
    </article>
  </el-drawer>
</template>

<style scoped>
.lineage-content {
  display: grid;
  gap: 18px;
  min-width: 0;
}
.lineage-summary,
.section-title {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  min-width: 0;
}
.lineage-summary > div,
.section-title > div {
  min-width: 0;
}
.lineage-summary span,
.section-title span,
.section-title p,
.relation-grid p {
  color: var(--text-muted, #667085);
}
.lineage-summary h2,
.lineage-section h3 {
  margin: 4px 0;
}
.lineage-summary p,
.section-title p,
.relation-grid p {
  margin: 4px 0 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.graph-scroll {
  margin-top: 10px;
  overflow: auto;
  border: 1px solid var(--border-color, #e4e7ed);
  border-radius: 12px;
  background: var(--surface-muted, #f7f8fa);
}
.graph-edge {
  fill: none;
  stroke: #98a2b3;
  stroke-width: 2;
}
#metric-lineage-arrow path {
  fill: #98a2b3;
}
.graph-node rect {
  fill: #ffffff;
  stroke: #98a2b3;
  stroke-width: 1.5;
}
.graph-node.root rect {
  fill: #eff6ff;
  stroke: #2563eb;
  stroke-width: 2.5;
}
.graph-node.status-partial rect {
  stroke: #d97706;
}
.graph-node.status-not_collected rect {
  stroke: #98a2b3;
  stroke-dasharray: 5 4;
}
.node-name {
  fill: #101828;
  font-size: 14px;
  font-weight: 700;
}
.node-key {
  fill: #344054;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.node-meta {
  fill: #667085;
  font-size: 10px;
}
.relation-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.relation-grid > div {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--border-color, #e4e7ed);
  border-radius: 10px;
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.lineage-details {
  min-width: 0;
}
.lineage-details summary {
  cursor: pointer;
  font-weight: 600;
}
@media (max-width: 620px) {
  .lineage-summary,
  .section-title,
  .relation-grid {
    display: grid;
    grid-template-columns: 1fr;
  }
}
</style>
