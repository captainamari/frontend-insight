# 09. M5 分析页面与数据状态

## 1. 页面不是 API 字段的平铺

M5 的三个主任务分别回答不同问题：

| 页面       | 用户问题                                     | 主要事实来源                                |
| ---------- | -------------------------------------------- | ------------------------------------------- |
| 功能采用   | 功能有没有被看见、成功使用和跨会话复用？     | features + feature detail API               |
| 页面访问   | 哪些页面被访问、由多少浏览器/账号/会话访问？ | overview + trend + pages API                |
| 项目与接入 | 为什么没有数据，怎样接入、配置和验证？       | project/features/onboarding/data-status API |

默认首页是“功能采用”，不是通用概览。因为产品的核心决策是“开发的功能是否被使用”，PV 只是辅助证据。

页面层要做的是组合事实和解释边界，不能做两件事：

- 在浏览器重新计算另一套转化率或去重人数；
- 根据一个数字自动判断“设计好/坏”。

## 2. 先分清三种状态

同一个页面同时存在三类状态，名称相似但来源不同。

### 2.1 请求状态

来自 `useRemoteData`：

- loading；
- success；
- error；
- stale（旧数据仍可用但新请求失败）。

### 2.2 链路数据状态

来自后端 `DataStatus.state`：

- `healthy`：最近接收和查询链路正常；
- `delayed`：已经接收，但可查询进度落后；
- `no_data`：项目尚未收到数据；
- `broken`：链路存在明确异常或拒绝证据。

### 2.3 所选范围的业务活动

来自分析响应：

- 有活动；
- 链路正常但当前范围没有活动；
- 趋势存在缺失 bucket。

这三类不能合并。例如“最近 24 小时 PV=0”可能是：

1. 项目从未接入；
2. 链路正常但最近 24 小时无人访问；
3. consumer 延迟，数据还没进查询层；
4. 请求失败，页面拿不到最新结果。

如果统一显示四张 0 指标卡，用户无法做正确判断。

## 3. `resolveProductPresentation` 的优先级

源文件：`apps/web/src/presentation.ts`。

输入不是一个枚举，而是请求、旧数据、HTTP status、链路状态、活动和缺口的组合。输出是页面产品状态：

| 优先级 | 条件                         | 输出          | 为什么                 |
| -----: | ---------------------------- | ------------- | ---------------------- |
|      1 | loading 且无旧数据           | `loading`     | 首屏还没有任何证据     |
|      2 | error 且无旧数据，status=403 | `forbidden`   | 用户无权读取           |
|      3 | 其他 error 且无旧数据        | `error`       | 无可展示结果           |
|      4 | error 且有旧数据             | `stale`       | 保留旧结果并明确过期   |
|      5 | data state = no_data         | `onboarding`  | 引导完成接入           |
|      6 | data state = delayed/broken  | `delayed`     | 不能把未到达的事件当 0 |
|      7 | 趋势有缺口                   | `partial`     | 有结果但时间序列不完整 |
|      8 | 链路正常且无活动             | `no_activity` | 这是有效的 0 活动      |
|      9 | 其他                         | `ready`       | 正常展示               |

优先级有实际含义：

- HTTP 失败且没有旧数据时，不能继续讨论业务活动；
- 有旧数据时，错误优先变成 stale，而不是清空页面；
- no_data 比 no_activity 更需要行动，所以进入接入流程；
- delayed/partial 必须在 0 指标之前出现。

`PagesView` 已使用这套 resolver。`FeaturesView` 当前用较简单的请求状态加 `DataStatusBanner`，两者在扩展时要避免逐渐形成不一致的第二套状态机。若新增第四个分析页，优先复用统一 resolver，并补表驱动测试。

## 4. `StatePanel` 与 `DataStatusBanner` 分工

### 4.1 `StatePanel`

`StatePanel.vue` 决定主内容能否显示：

- loading：Skeleton；
- empty/error/forbidden：替代主内容；
- stale：显示警告，但仍渲染 slot 中的旧内容；
- ready：直接渲染内容。

它同时保留 request ID。用户报告问题时，request ID 是从浏览器定位到 Nginx/API 日志的关键证据，不能只显示“请求失败”。

### 4.2 `DataStatusBanner`

`DataStatusBanner.vue` 始终解释事件链路：

- 最近可查询时间；
- 最近 request ID；
- rejection code；
- 尚未收到数据。

它不是 HTTP 请求错误组件。例如 API 本次请求成功，链路仍可能是 delayed；反过来，API 请求失败时，旧链路状态也可能显示 healthy，但页面必须标记 stale。

“主内容状态”和“链路状态”分开，是分析产品比普通 CRUD 页面多的一层语义。

## 5. 为什么趋势缺口必须是 `null`

后端 `gapPolicy` 明确说明缺失 bucket 被省略，前端不能把它们当 0。源文件：`range.ts` 的 `fillTrendGaps`。

算法：

1. 将 bucket 解析成时间并排序；
2. 根据 hour/day 确定期望步长；
3. 写入真实点；
4. 如果下一个点距离超过 1.5 个步长，在第一个缺失位置插入：

```ts
{
  bucket: "...",
  primary: null,
  secondary: null
}
```

`TrendChart.vue` 同时设置 `connectNulls: false`。两个条件缺一不可：

- 只有 null、图表却连接空值：看起来仍像连续数据；
- 图表不连接，但前端把缺失补 0：会制造一次虚假暴跌。

当前算法只插入一个 null 就能打断线，不会生成每一个缺失 bucket。这降低前端点数，又保留“这里不连续”的事实。

### 5.1 为什么 0 和 null 不同

| 值     | 含义                                 |
| ------ | ------------------------------------ |
| `0`    | 链路完整，查询确认该 bucket 没有事件 |
| `null` | 没有足够证据说明是 0，趋势不应连接   |

这种差异适用于监控、财务、IoT 和任何时序系统。图表美观不能优先于数据诚实。

### 5.2 当前时间解析边界

`fillTrendGaps` 对没有时区后缀的 bucket 加 `Z` 解析。这依赖服务端 bucket 字符串约定。若 API 改为返回项目本地时间但没有 offset，前端会误当 UTC。

安全演进方式：

- API 返回 ISO 8601 + offset，或同时返回 epoch；
- 前端契约测试覆盖 DST 和非 UTC 项目；
- 不要只改 `bucketLabel` 的显示格式来掩盖解析问题。

## 6. `TrendChart` 为什么是纯展示组件

`TrendChart.vue` 只接收：

- `points`；
- 两条序列的标签。

它不认识 PV、成功率或 feature，也不发请求。这样同一个组件可用于：

- PV vs 活跃浏览器；
- 曝光 vs 成功；
- 功能详情趋势。

内部只注册 ECharts Line、Grid、Legend、Tooltip、Aria 和 Canvas renderer，而不是引入所有图表。生命周期：

```text
mounted → echarts.init → setOption
props 变化 → setOption
容器 ResizeObserver → chart.resize
unmount → observer.disconnect + chart.dispose
```

`dispose` 是必要的；遗漏会让路由切换后保留 Canvas、事件监听和内存。

`aria.enabled` 提供基础可访问性，但 Canvas 趋势图不能替代表格或文字摘要。关键指标仍通过卡片和表格呈现，图表只是辅助识别变化。

## 7. 页面访问页的四请求快照

源文件：`apps/web/src/views/PagesView.vue`。

一次加载并行请求：

1. overview；
2. trend；
3. pages；
4. data-status。

使用 `Promise.all` 的设计取舍：

- 优点：页面只替换一份完整快照，不会混合不同请求轮次；
- 优点：四个请求并行，延迟取最大值而不是相加；
- 代价：任一请求失败，整组失败；
- 代价：不能单独刷新表格或状态。

当前 stale 机制让已有快照在失败时仍可见，因此一致性优先是合理的。若未来页面变大，可以拆成独立 remote resource，但必须先定义：

- overview 成功、pages 失败时显示什么；
- 每个区域如何显示更新时间；
- project/range 改变时旧区域能否继续保留；
- request ID 放在哪里。

不能仅为了“组件更小”就拆掉快照语义。

### 7.1 卡片口径

页面访问页并列四个值：

- PV；
- 活跃浏览器；
- 已识别账号；
- 会话。

每个 `MetricCard` 都有定义 tooltip，并显示项目时区下“昨日同时段”。UI 没把浏览器、账号、会话混成“用户数”，也没有从三者推断真实人数。

`formatNumber(value ?? 0)` 会把 null/undefined 显示为 0，因此调用方必须保证只有“定义上确定为数字”的字段传入。未知/不适用的比例使用 `formatPercent`，显示 `—` 而不是 0%。

### 7.2 页面排行

页面排行由服务端完成：

- 搜索；
- 分页；
- PV 排序；
- route 归一化；
- 最后访问/接收时间。

这与功能页的客户端搜索不同，因为路由数量可持续增长，不能默认全部加载浏览器。新增排序字段时，应扩展固定 API 白名单，而不是把任意 SQL/column 传给后端。

## 8. 功能采用页为什么把定义和使用事实合在一行

源文件：`apps/web/src/views/FeaturesView.vue`。

列表项同时包含：

- MySQL 功能定义：name、featureKey、featureType、status；
- ClickHouse 使用事实：曝光、成功、重复使用、最近成功；
- 派生比例：账号/浏览器转化率。

即使某个功能完全没有事件，它也应出现在列表中，并明确显示“尚未收到曝光事件”。如果查询只从 ClickHouse 分组，零使用功能会消失，产品经理反而看不到“做了但没人用”的证据。

这是“维表左连接事实表”的产品意义：**absence 本身也是结果**。

### 8.1 三种功能不能只看同一个点击

| 类型        | 成功条件                          | 页面应怎样解释                     |
| ----------- | --------------------------------- | ---------------------------------- |
| `data_view` | 关键数据请求成功且内容完成渲染    | 仅进入页面或发起请求不算成功       |
| `action`    | 导出/导入/配置/下发等业务结果成功 | started 与 succeeded 必须分开      |
| `long_view` | 前台可见累计达到阈值              | 后台时间不计入，heartbeat 不能相加 |

功能列表统一展示“曝光 → 成功”，详情页再展示 started/failed 和 long-view 时长。这样默认页保持可比较，复杂语义在详情中展开。

### 8.2 转化率为什么允许 null

如果 `exposedAccounts = 0`：

```text
succeededAccounts / exposedAccounts
```

没有定义，不能显示 0%。0% 表示“存在分母但无人成功”；`—` 表示“没有足够分母”。服务端返回 null，前端 `formatPercent` 保留这个差异。

### 8.3 重复使用

重复使用定义为至少两个不同 session 中成功。它比“同一会话点了两次”更接近回访采用，但仍不等于真实用户留存：

- 共享账号仍算一个账号；
- 匿名 visitor 是浏览器存储实例；
- 清存储或换浏览器会变成新 visitor。

UI 必须继续并列账号与浏览器，不能在表头缩写为“复用用户”。

## 9. 功能详情页如何避免“万能指标”

`FeatureDetailView.vue` 展示：

- 曝光、开始、成功、失败四阶段；
- 曝光与成功趋势；
- 成功账号/浏览器；
- 重复使用账号/浏览器；
- 长时可见累计时长。

它没有为每个 featureType 写完全不同的页面。统一结构降低维护成本，但也意味着某些卡片对特定类型只是补充证据：

- data_view 可能没有 started；
- action 的可见时长通常为 0；
- long_view 的 started/failed 取决于业务是否发送。

若未来需要类型专属指标，应先写清“不适用”和分母，再增加类型化 detail section；不要把 0 当成所有不适用情况的默认值。

### 9.1 long-view 时长

后端先按 `visitor_id + session_id + page_view_id` 对 heartbeat/ended 取最大累计值，再跨实例求和。前端只把毫秒格式化成秒。

如果前端把所有 heartbeat 相加：

```text
60s + 120s + ended 135s = 315s
```

会严重重复计数。M5 正确地把计算留在查询层。

## 10. 指标定义抽屉为什么是产品功能

`DefinitionsDrawer.vue` 集中说明：

- PV；
- 活跃浏览器；
- 已识别账号；
- 会话；
- 成功使用；
- 重复使用；
- 昨日同时段；
- SDK 版本分布；
- 最新数据时间；
- 不输出健康度和设计得分。

这不是“帮助文字”。分析产品如果不给出分母、身份和时间口径，数字很容易被错误用于人员评价或设计结论。

指标说明与展示组件分开，避免每个页面复制稍有差异的定义。修改指标语义时，应同时检查：

1. PRD；
2. 服务端查询；
3. API semantics/gapPolicy；
4. `DefinitionsDrawer` 与 tooltip；
5. golden fixture 与 E2E 文案断言。

## 11. SDK 版本分布为什么进入分析响应

M5 增加 ClickHouse `sdk_name` 列和 SDK name/version 分布。它用于回答：

- 某项目是否仍有旧 SDK 在发送；
- “没有数据”是否与接入版本有关；
- 升级后新版本是否开始出现。

它不是产品采用指标，而是数据质量和接入诊断信息，所以放在定义抽屉，而不是默认核心卡片。

迁移 `003_sdk_name.sql` 使用 `ADD COLUMN IF NOT EXISTS`，旧行默认 `unknown`。查询和 UI 必须能同时处理新旧行，不能因新增诊断字段让历史数据不可读。

## 12. 可持续扩展页面的规则

### 新增一个固定指标

```text
先定义业务问题、事件和分母
→ 修改服务端固定查询与响应
→ 增加 golden/查询测试
→ 更新前端读模型
→ 选择卡片/表格/趋势
→ 更新指标定义
→ 增加页面状态和 E2E
```

不要先在 Vue 中对已有字段做组合，之后再补文档。否则页面会出现后端不知道、测试没覆盖的“影子指标”。

### 新增一个页面

先回答：

- 它是新的用户任务，还是现有页面的筛选/详情？
- project/range 是否应写入 URL？
- 首屏、no_data、no_activity、delayed、partial、stale、403 分别是什么？
- 可以和其他区域部分成功吗？
- 是否需要服务端分页/搜索？
- 哪个组件可以复用，哪个业务状态不能抽象成通用组件？

### 防止熵增

- 一个页面只组合固定 API，不直接拼 ClickHouse 查询；
- 状态优先级进入纯函数和表驱动测试；
- 指标格式化集中，分母未知保留 null；
- 图表只展示，不拥有业务口径；
- 页面请求拆分前先写部分成功语义；
- 同一术语只在一个 definitions 来源维护。

## 13. 本章代码精读入口

按以下顺序：

1. `apps/web/src/presentation.ts` 与 `apps/web/test/presentation.test.ts`；
2. `apps/web/src/remote.ts`；
3. `apps/web/src/components/StatePanel.vue`；
4. `apps/web/src/components/DataStatusBanner.vue`；
5. `apps/web/src/range.ts` 与 `apps/web/test/range.test.ts`；
6. `apps/web/src/components/TrendChart.vue`；
7. `apps/web/src/views/PagesView.vue`；
8. `apps/web/src/views/FeaturesView.vue`；
9. `apps/web/src/views/FeatureDetailView.vue`；
10. `apps/web/src/components/DefinitionsDrawer.vue`；
11. `packages/server-core/src/analytics.ts`；
12. `infra/clickhouse/migrations/003_sdk_name.sql`。

自测问题：

1. no_data、no_activity、delayed、partial 和 stale 分别有什么证据？
2. 为什么 stale 仍显示旧图表，但必须带请求错误和 request ID？
3. 为什么趋势只插一个 null 就足够？0 为什么不行？
4. 功能完全没有事件时为什么仍必须出现在列表？
5. 转化率何时是 0%，何时必须是 `—`？
6. 页面访问为什么暂时用一个 Promise.all？拆分会引入什么产品决定？
7. SDK 版本分布为什么是诊断信息而不是核心采用指标？
