# 14. M6 管理端页面与配置闭环

## 1. 当前导航不是六张独立报表

`AppShell.vue` 的主导航是同一项目/时间上下文下的六个任务入口：

| 入口 | 当前职责 | 主要下钻 |
| --- | --- | --- |
| 功能采用 | 曝光、成功、曝光后使用、跨会话复用 | feature detail |
| 运营概览 | 模块、核心页面、关键任务、访问深度 | page/task detail |
| 页面访问 | 全部 route 的基础访问证据 | page detail |
| 项目运营指数 | 总分 gate、维度、leaf、目标、贡献、血缘 | 配置、metric definition |
| 前端可观测性 | 错误组、Web Vitals、release、固定告警 | error detail |
| 项目与接入 | 项目/Origin/SDK 接入与链路排障 | 测试事件 |

`operational-config` 不在主导航独立显示，它从运营概览/指数进入并在导航中归属于“项目运营指数”。这是因为配置是完成分析任务的支持步骤，不是普通 viewer 的主任务。

## 2. 路由与上下文

`router.ts` 当前新增：

- `/operational`；
- `/page-detail?route=...`；
- `/operational-index`；
- `/observability`；
- `/operational-config`。

`AppShell` 将 `project` 和 `range` 保存在 query。所有主导航跳转复制现有 query；下钻也复制 query，再增加 route/feature/evidence。

`useDashboardContext` 从 query + 项目列表派生：

- projectId/project；
- 24h、7d、30d preset；
- from/to/timezone/granularity；
- API query string。

当前尚未把 deploymentEnvironment、releaseVersion、module/page/task 和 browser/OS 变成全局筛选；这是 v1.7 产品流程的新增范围。

## 3. 运营概览

`OperationalOverviewView.vue` 同时请求：

1. `analytics/operational-overview`；
2. `analytics/trend`。

页面组合：

- 有效活跃账号、活跃日覆盖、页面/关键任务覆盖；
- 模块使用表；
- session page view / distinct page / module breadth P50/P75；
- 关键任务终态摘要；
- 核心页面和关键任务下钻；
- 未归类 route 及配置入口。

页面不会把低深度直接解释为坏设计，也不会把未归类 route 放入指数。

## 4. 页面详情与任务详情

### 4.1 页面详情

`PageDetailView` 通过 route 查询 `analytics/page-detail`：

- 显示 classified/unclassified；
- 显示 page/module/template；
- 显示 PV、账号、浏览器、会话；
- 显示 duration sample、coverage、average/P50/P75；
- 显示 session depth 与模板目标；
- 列出页面上的关键任务；
- 返回 MetricCatalog 的页面指标定义。

unclassified 页面仍显示基础证据，但有清晰提示“不进入运营指数”。

### 4.2 任务详情

当前复用 `FeatureDetailView`。当 query `evidence=task` 时并行请求：

- 既有 feature adoption；
- `analytics/task-detail` 的 operation 证据。

因此同一功能可以同时查看“是否被曝光/使用”和“任务实例是否完成”。两种分母不能混成一个率。

## 5. 运营指数页面

`OperationalIndexView` 的用户任务顺序是：

1. 先看总分是否 available；
2. 若不可用，查看 data/config/sample/coverage 原因；
3. 看四维 radar，同时有等价表格；
4. 展开 leaf 的 raw value、target、sample、score 和 contribution；
5. 请求 definition + lineage；
6. 管理员进入配置页。

`OperationalRadar` 对缺失维度使用 `null`，并提供表格/aria-label，不能用 0 补齐雷达形状。

## 6. 配置页的五类配置

`OperationalConfigView` 一次加载 modules、page definitions、features、settings、profiles、MetricCatalog 和当前 baseline。

| 配置 | 当前写法 | 为什么 |
| --- | --- | --- |
| 模块 | create/update/disable | 稳定业务域，不物理删除 |
| 页面 | create/update/disable | route 归类、模板、核心性和权重 |
| 任务 | 更新既有 feature | 绑定页面、关键任务、timeout、operation lifecycle |
| 运营设置 | 每次保存新 version | 目标账号和工作日不能改写历史 |
| profile | draft → clone → activate/retire | 目标、权重和样本门槛可审计 |

“历史活跃账号”只作为目标设置参考，页面不会自动把它保存为 targetAccounts。

## 7. 权限是双层的

前端 `canWrite` 只用于改善体验：

- global admin 才显示编辑控件；
- viewer 看到只读内容。

服务端 `OperationalController.authorize` 再次要求：

- 项目角色存在；
- 写操作同时满足 global admin；
- 项目角色为 owner/admin。

所以隐藏按钮不是安全边界。新增页面/配置操作时必须同时补 controller 403 测试和 viewer E2E。

## 8. 页面状态

所有新页面继续复用 M5 的两层机制：

- `useRemoteData`：loading、error、stale data；
- `resolveProductPresentation`：onboarding/no_activity/delayed/partial/ready。

M6 又增加业务级局部状态：

- configuration gap；
- availableFrom/partial；
- metric status；
- unclassified entity；
- insufficient sample；
- index unavailable reasons。

这些局部状态没有完全收敛成统一 enum。v1.7 若统一数据状态，应明确哪些是链路状态、哪些是指标状态、哪些是配置/范围状态，避免一个 `status` 字段承担所有含义。

## 9. 当前前端技术债

- `apps/web/src/types.ts` 手工维护数百行读模型；
- 旧 M5 feature API 仍返回 snake_case SQL 字段，并使用 `accountConversionRate` 名称，UI 文案已经写成“曝光后使用率”；
- `useRemoteData` 没有 request sequence，旧响应可能覆盖新 query；
- 运营概览的多个请求使用 `Promise.all`，任一失败会让整块进入 stale/error；
- 全局筛选只覆盖 project/range；
- MetricCatalog 解释已用于指数页，但旧页面仍存在本地 DefinitionsDrawer 文案。

这些正是 v1.7 “统一 read model/术语/解释源”需要处理的真实位置。

## 10. 代码精读入口

1. `apps/web/src/router.ts`、`components/AppShell.vue`；
2. `apps/web/src/context.ts`、`range.ts`、`remote.ts`；
3. `views/OperationalOverviewView.vue`；
4. `views/PageDetailView.vue`、`FeatureDetailView.vue`；
5. `views/OperationalIndexView.vue`、`components/OperationalRadar.vue`；
6. `views/OperationalConfigView.vue`；
7. `apps/api/src/analytics.controller.ts`、`operational.controller.ts`；
8. `tests/m6/product-flow.spec.ts`。

