# 13. M6 指标目录、读模型与项目运营指数

## 1. 先区分四种东西

M6 中最容易混淆的是“事实、查询结果、指标定义和分数”。

| 层 | 示例 | 事实来源 |
| --- | --- | --- |
| 事实 | `fact.page_view`、`fact.operation_succeeded` | 去重事件 + 受治理实体 |
| 原子/派生指标 | `active_accounts`、`core_page_coverage` | `AnalyticsStore` 固定查询 |
| 规范定义 | 公式、分母、去重键、方向、最小样本、版本 | `METRIC_CATALOG` |
| 复合分数 | 四个维度和 `project_operational_index` | 原始指标 + active profile + gate |

MetricCatalog 不是数据仓库；它说明结果是什么意思。AnalyticsStore 仍负责实际 SQL/聚合。两者必须由 golden test 证明一致。

## 2. 当前 MetricCatalog 的结构

`MetricDefinition` 当前包含：

- metricKey、中文 displayName、businessQuestion；
- entityType、valueType、unit、layer；
- inputKeys、formulaDescription、denominatorDescription；
- deduplicationKey、missingValuePolicy、scoreDirection；
- minimumSample、definitionVersion、effectiveFrom、owner。

`validateMetricCatalog` 在模块加载时检查：

1. metricKey 不重复；
2. 每个 inputKey 存在；
3. 依赖图没有环。

`metricLineage` 从同一目录生成上游节点/边，并返回直接上游和直接下游。UI 不需要维护第二份血缘图。

### 与 v1.7 的距离

当前目录已经有“版本化指标骨架”，但还没有 v1.7 要求的全部结构化字段：numerator、primary percentile、coverage、available status 列表、适用页面模板等部分仍在描述文本或读模型里。评审时应把它视为扩展现有目录，不是从零新建；同时不能误称已经做到“SQL、API 文案和 fixture 的唯一生成源”。

## 3. 当前运营指标

| 指标 key | 当前公式/口径 | 关键缺失语义 |
| --- | --- | --- |
| `page_views` | 去重 `page_view` count | 链路不可用时不应当作 0 |
| `active_accounts` | 已注册有效活动中的 `uniq(account_id)` | 无账号不以 visitor 兜底 |
| `active_browsers` | 有效活动中的 `uniq(visitor_id)` | 浏览器实例不等于人数 |
| `page_duration_coverage` | 有有效 leave 的 pageView / 全部 pageView | 缺失 leave 不补 0ms |
| `page_visible_duration_p50` | 同 pageView 片段求和后取 P50 | 当前目录没有 P90 |
| `session_distinct_pages_p50` | 每 session 不同 route 数 P50 | 深度不是越大越好 |
| `session_module_breadth_p50` | 每 session 已归类 module 数 P50 | 未归类 route 不冒充 module |
| `active_account_target_attainment` | active accounts / 配置目标 | 缺目标为 missing_target |
| `core_page_coverage` | 已使用核心页面权重 / 全部核心页面权重 | 无核心页面不可用 |
| `active_day_coverage` | 有效活动预期日期 / 配置预期日期 | 空日历不是 0% |
| `cross_day_continuity` | 至少两个本地日期活跃账号 / 活跃账号 | 零账号分母不可用 |
| `key_task_completion_rate` | 关键任务加权 succeeded / started | 仅 v2 operation |
| `task_adverse_outcome_rate` | failed+canceled+超时未结束 / started | abandonment 是近似 |
| `key_task_duration_p50` | operation 成功时间 - 开始时间的 P50 | 失败/取消不进耗时 |
| `page_visible_duration_fit` | 页面 P50 对模板目标区间归一化后加权 | 样本≥5、coverage≥0.5 |

当前 page/task/session 详情同时返回 P50/P75；项目运营指数使用 P50 和模板化目标。v1.7 的 P90/P99 是新增计算和契约，不是把页面文字从 P75 改成 P90。

## 4. 页面模板与时长方向

`PAGE_TEMPLATE_DURATION_TARGETS` 为三类页面提供目标和容忍区间：

| 模板 | 当前目标区间 | 为什么不能全局“越短越好” |
| --- | ---: | --- |
| monitoring_dashboard | 1 分钟–1 小时 | 持续监测本来需要停留 |
| analysis_view | 30 秒–10 分钟 | 过短或过长都可能偏离目标 |
| task_operation | 10 秒–3 分钟 | 任务效率通常有上限，但也不能以瞬时点击替代完成 |

`normalizeMetricScore` 支持 higher_better、lower_better、target_range、none。target_range 在区间内为 100，向 tolerance 边界线性降到 0。

## 5. 当前固定读模型

`AnalyticsStore` 在 M5 查询之外增加：

| 方法 | 主要输出 |
| --- | --- |
| `modules` | 模块 PV/账号/浏览器/会话、页面覆盖、未归类 route |
| `operationalOverview` | 项目摘要、模块、核心页面、关键任务、session depth、task summary |
| `pageDetail` | 页面分类、时长样本/coverage/P50/P75、session depth、模板目标、趋势 |
| `taskDetail` | operation started/succeeded/failed/canceled/abandoned、成功耗时 P50/P75、可用起点 |
| `operationalIndex` | rawMetrics、profile/settings、四维结果、总分、缺口和版本边界 |

`readModelMeta` 统一返回 range、dataStatus、updatedAt 和 definitionVersion，但老的 M5 overview/features 仍保留较早的响应结构。v1.7 提出的“所有页面共享同一 read model meta”会涉及旧接口重整。

## 6. 项目运营指数 v1

默认维度权重：

| 维度 | 权重 | 当前叶子 |
| --- | ---: | --- |
| 使用覆盖 | 30% | 账号目标达成、核心页面覆盖、活跃日覆盖 |
| 持续使用与访问深度 | 25% | 跨日持续、页面范围 fit、模块范围 fit |
| 任务达成 | 30% | 完成率、不利终态率 |
| 使用效率 | 15% | 关键任务耗时、页面时长 fit |

### 6.1 叶子分数

每个 leaf 先按 profile target 归一化到 0–100。样本低于 profile/definition 门槛时改为 `insufficient_sample`；目标不完整则为 `missing_target`。

### 6.2 维度分数

只对 eligible leaf 按 metricWeight 重新归一化。缺失 leaf 不当 0，但会降低全局 leaf weight coverage。

### 6.3 总分 gate

`calculateOperationalIndex` 只有同时满足以下条件才返回总分：

1. `dataState === healthy`；
2. 至少 3 个维度有可计算 leaf；
3. eligible leaf weight coverage ≥70%；
4. eligible dimension weight 大于 0。

总分只在 eligible 维度间按维度权重重新归一化。UI 必须同时展示 raw value、target、sample、status、score、contribution 和 version，不能只展示一个雷达图数字。

## 7. 配置边界

`AnalyticsStore.operationalIndex` 将 `evaluationRange.from` 裁剪到以下最晚时间：

- active profile effectiveFrom；
- operational settings effectiveFrom；
- active page effectiveFrom；
- active feature configurationEffectiveFrom。

因此一个查询响应同时有用户选择的 `range` 和真正计算的 `evaluationRange`。跨配置边界时返回 `configurationAvailabilityStatus=partial`。这一点比“趋势图打断点”更基础：先保证当前总分没有混入旧定义。

## 8. 手算示例

假设四个维度分数为 80、70、90、60，四维均 eligible：

```text
index =
  (80×0.30 + 70×0.25 + 90×0.30 + 60×0.15)
  / (0.30+0.25+0.30+0.15)
  = 77.5
```

若使用效率不可用，其余三维可用且 leaf coverage 仍 ≥70%：

```text
index = (80×0.30 + 70×0.25 + 90×0.30) / 0.85 ≈ 80.6
```

缺失维度没有被当成 0，但必须显示 weightCoverage 和缺失原因，避免把 80.6 误解为“四维完整结果”。

## 9. 代码精读入口

1. `packages/server-core/src/metrics.ts`；
2. `packages/server-core/test/metrics.test.ts`；
3. `packages/server-core/src/analytics.ts` 的 `operationalOverview/pageDetail/taskDetail/operationalIndex`；
4. `packages/server-core/scripts/m6-fixture.ts`；
5. `tools/m6-http-smoke.mjs`；
6. `apps/web/src/components/OperationalRadar.vue`；
7. `apps/web/src/views/OperationalIndexView.vue`。
