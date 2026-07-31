<script setup lang="ts">
import { ref } from "vue";
import { formatDateTime, formatNumber } from "../range";
import type { SdkVersionUsage } from "../types";

defineProps<{
  sdkVersions?: SdkVersionUsage[] | undefined;
  lastUpdated?: string | null | undefined;
}>();

const open = ref(false);
const definitions = [
  ["PV", "page_view 事件数；刷新与重复访问都会计数。"],
  ["活跃浏览器", "去重 visitorId，代表浏览器存储实例，不等于真实人数。"],
  [
    "已识别账号",
    "业务显式传入的不透明账号引用经项目级 HMAC 后去重；共享账号只算一个账号。",
  ],
  ["会话", "标签页内连续活动；30 分钟无活动后创建新会话。"],
  ["成功使用", "按功能类型确认业务成功结果，不能以按钮点击替代。"],
  ["重复使用", "至少在两个不同会话中成功使用同一功能。"],
  ["昨日同时段", "按项目时区，将当前区间整体平移到前一自然日的同一时段。"],
];
</script>

<template>
  <el-button plain @click="open = true">指标口径</el-button>
  <el-drawer v-model="open" title="指标定义与解释边界" size="420px">
    <div class="definition-metadata">
      <span>数据更新时间</span>
      <strong>{{ formatDateTime(lastUpdated) }}</strong>
    </div>
    <div class="definition-metadata">
      <span>账号 / 浏览器口径</span>
      <strong>当前并列展示，可直接对照</strong>
    </div>

    <section class="sdk-distribution">
      <h3>SDK 版本分布</h3>
      <div v-if="sdkVersions?.length">
        <div v-for="item in sdkVersions" :key="`${item.sdk_name}:${item.sdk_version}`">
          <code>{{ item.sdk_name }}@{{ item.sdk_version }}</code>
          <span>{{ formatNumber(item.events) }} 个事件</span>
        </div>
      </div>
      <p v-else>所选范围内尚无 SDK 版本数据。</p>
    </section>

    <dl class="definitions-list">
      <template v-for="[term, definition] in definitions" :key="term">
        <dt>{{ term }}</dt>
        <dd>{{ definition }}</dd>
      </template>
    </dl>
    <el-alert
      title="项目运营指数提供可下钻的产品决策证据，不替代技术 SLO，也不用于人员绩效判断。"
      type="info"
      :closable="false"
      show-icon
    />
  </el-drawer>
</template>
