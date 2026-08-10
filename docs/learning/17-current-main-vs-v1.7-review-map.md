# 17. 当前 `main` 与 v1.7 评审地图

## 1. 结论先行

requirements v1.7 与 MVP plan v1.4 是“下一阶段目标”，不是当前实现说明。提案分支相对 `main` 只有三份文档变化，没有 schema v3、SDK 0.4.0、migration、查询或 UI 代码。

整体判断：

- 统一术语、指标口径、数据状态和页面关系的方向正确；
- Pre-1.0 重置能降低无生产数据阶段的兼容成本，但必须通过独立 ADR 和精确 reset 命令固化；
- M8.1-A 不是纯改名，它会同时修改契约、SDK、ingest、consumer、ClickHouse、Analytics、API、UI、fixture 和运维；
- M8.1-B 是新增采集能力，应与 A 分阶段；
- 提案中的“当前名称盘点”需要按源码修正：若把已经规范的字段也当成待改名，会误判工作量；若漏掉旧 read model/API 和公共 wrapper，又会低估改动。

## 2. 当前实际命名盘点

| 概念 | 当前 `main` | v1.7 目标 | Review 结论 |
| --- | --- | --- | --- |
| 项目管理/读模型 | `projectId` | `projectId` | 已一致 |
| SDK 项目键 | `projectKey` | `projectKey` | 已一致 |
| `appId` | 代码中不存在 | 删除 | 不应列为实际全仓迁移项 |
| 事件名 | `eventName` | `eventName` | 已一致 |
| 事件发生时间 | `eventTime` | `occurredAt` | 真实破坏性改名 |
| 批发送时间 | `sentAt` | 提案未明确是否保留 | v3 精确 schema 必须决定 |
| 服务端时间 | `receivedAt`/`received_at` | `receivedAt` | 语义已存在 |
| 页面 route | 传输 `route`；配置 `normalizedRoute` | 同左 | 基本一致 |
| 原始页面 URL | 不发送；默认只取 pathname | 不采集 | 已一致 |
| 页面 title | 当前 `page_view.title` 截断后发送 | v1.7 外壳未明确 | 必须决定保留、删除或约束 |
| 账号传输 | `accountRef` | `accountRef` | 已一致 |
| 账号存储 | 项目 HMAC `accountId/account_id` | `accountId` | 已一致 |
| 管理端用户 | `userId` | 提案“删除 userId 输入” | 只应禁止遥测 userId，不能机械改认证/成员 userId |
| 浏览器实例 | `visitorId`；指标 `active_browsers` | `visitorId/activeVisitors` | ID 已一致，指标 key/文案需调整 |
| 设备 ID | 代码中不存在 | 删除 | 已满足 |
| 发布 | `releaseVersion` | `releaseVersion` | 已一致 |
| 部署环境 | `deploymentEnvironment` | 同名 | 字段一致；当前枚举多一个 `test` |
| UA | 原文只在浏览器内解析，不发送 | browserFamily/osFamily | 已一致 |
| UV/VV | UI 不使用；API 用 accounts/visitors/sessions | 明确三种口径 | 产品文案大体一致 |
| “转化” | API 字段仍有 `accountConversionRate/visitorConversionRate`；UI 已显示“曝光后使用率” | `postExposureUseRate*` | 真实 read model 改名 |
| “健康度” | 已使用 `project_operational_index` / 项目运营指数 | `projectOperationalIndex` | 中文已一致；metric key 命名风格不同 |
| metric key | snake_case，如 `page_views`、`active_accounts` | camelCase | MetricCatalog/profile/API/fixture 的破坏性重命名 |
| 物理列 | snake_case | 允许 snake_case 映射 | 无需为了产品术语重建每列名 |

`env`、`release`、`timestamp` 等词在 shell、Node 环境或局部变量中也会出现。A0 inventory 必须区分“遥测/产品概念”和普通编程变量，不能用全仓文本替换。

## 3. 当前契约与 v3 的差异

| 项目 | 当前 `main` | v1.7/M8.1-A |
| --- | --- | --- |
| 支持版本 | v1 + v2 | 只支持 v3 |
| SDK 版本 | 0.3.0 | 0.4.0 |
| SDK 默认输出 | schema v2 | schema v3 |
| legacy feature API | 仍暴露 featureStarted/Succeeded/Failed | 删除 deprecated wrapper |
| operation | v2 `operationInstanceId` | 保留并使用规范字段 |
| eventTime | 当前字段 | 改 `occurredAt` |
| environment enum | production/staging/test/development | production/staging/development |
| custom event | `track` 接受符合 regex 的任意非 page_/feature_ 名 | 生产 allowlist/目录化 |
| queue | 默认最多 100，batch 最多 50 | 队列/批次都计划按新规范收敛 |
| flush | 默认 10 秒 | 10 秒；已满足 |
| 大小 | 8 KiB/event、50/batch、64 KiB/batch | 保留；已满足 |
| v1/v2 fixture | 正向兼容验收 | 改为明确拒绝 fixture |
| 数据 | additive migration 保留 | 本地/验收全量 reset |

### 必须在 ADR-014 说清的细节

- v3 是否保留 `sentAt`、`title`、`timezoneOffsetMinutes` 和 generic `properties`；
- `test` 环境如何处理，demo/CI 是否改用 development；
- generic `track` 是删除、完全关闭，还是只能发 registry 事件；
- v3 的 feature exposure/success 与 operation started/terminal 如何共存；
- SDK 0.3 公共 `featureStarted` 在默认 v2 下缺 operation ID 的现有契约不一致如何清理；
- reset 删除的 Compose project、库、topic、volume、账号和配置的精确清单。

## 4. 当前指标实现与 v1.7 的差异

| 领域 | 当前 `main` | v1.7 目标 | 类型 |
| --- | --- | --- | --- |
| MetricCatalog | 已有版本/公式/分母说明/去重/最小样本/方向/血缘 | 增加 numerator、percentile、coverage、完整 status、适用实体/模板 | 扩展现有骨架 |
| page duration | average/P50/P75 + coverage | P50/P90 + coverage，补 P75/P99 | 新 SQL/类型/UI/fixture |
| task duration | P50/P75 | P50/P90，补 P75/P99 | 新 SQL/类型/UI/fixture |
| session depth | P50/P75 | P50/P90 | 新 SQL/类型/UI/fixture |
| Web Vitals | P75 + poor rate/sample | P75 主值，补 P50/P90 | 扩展 M8 查询 |
| API | 只有错误事件及错误耗时 | 全部受控请求的 P50/P90、成功/错误/慢率 | 新事实和分母 |
| resource | 只有失败事件 | 失败率和 coverage | 新总量分母 |
| active users | active_accounts + active_browsers | activeAccounts + activeVisitors + sessions | 重命名并统一 meta |
| module adoption | 当前只返回模块活动账号/浏览器/页面覆盖 | 有 eligibleAccountCount 才显示 adoption rate | 新目录分母；不能用当前活跃数冒充 |
| 数据状态 | 链路四态 + 局部 metric/config 状态 | 统一更细状态 | 契约重构 |
| 运营指数 | 30/25/30/15、3 维、70% gate | 构成保持，用新 key/seed 重算 | 骨架复用、全量重基线 |

v1.7 的“MetricCatalog 是共同真相源”目前只实现了一部分：目录提供 definition/lineage，但 SQL 和部分 UI 文案仍手写。A2 验收应证明目录、SQL、API、UI 和 golden 的一致性，而不是仅补元数据字段。

## 5. 当前产品流程与 v1.7 的差异

当前所有主页面共享 project/range/timezone。v1.7 还要求 environment/release，并可选 module/page/feature/task/browser/OS。要实现它需要：

- 新的 canonical filter 类型；
- URL 序列化/恢复；
- 所有 controller/query 同口径；
- ClickHouse WHERE 条件；
- 下钻时保留；
- 旧页面/新页面的统一空态；
- E2E 验证返回路径与筛选不丢失。

当前信息架构已经有功能采用、运营概览、页面详情、任务证据、指数、可观测性和配置入口。M8.1-A 应优先重组和统一，而不是重新复制一套页面。

## 6. 分批评审

### 6.1 M8.1-A（P0）

适合一次评审锁定：

- canonical naming/forbidden manifest；
- v3-only + SDK 0.4；
- reset 安全边界；
- MetricCatalog 元数据与 key；
- 现有事实可计算的 P90/状态/统一 read model；
- 页面筛选、职责和下钻；
- 运营指数新 baseline。

风险最高的是全链同步切换和 reset，不是 UI 改字。

### 6.2 M8.1-B（P1）

API/resource/first-screen/list/long-task/blank/breadcrumb 都需要新 collector、容量和隐私 gate。它们不应阻塞 A 的术语/口径修复，也不能以“当前 M8 已有错误事件”宣称已有总请求/总资源分母。

### 6.3 P2/P3

组织目录、task journey、表单、业务拒绝、重复业务对象、安全异常、SourceMap、指数 v2 和 AI 都需要独立 owner/ADR。保留规划入口可以，但不应进入 M8.1-A 完成定义。

## 7. 对 requirements v1.7 的 Review 检查表

### 命名

- [ ] 每个“当前名”都能在 `main` 找到真实调用方，而不是附件中的外部命名；
- [ ] 明确 auth `userId` 与 telemetry accountRef/accountId 的不同命名域；
- [ ] metric key、API 字段、UI 文案和数据库列分别列出，不进行机械全仓替换；
- [ ] `title/sentAt/timezoneOffsetMinutes/test environment/custom event` 有明确结论。

### 指标

- [ ] 每个率都有当前或新增分母事实；
- [ ] P75/P90 门槛按指标族固定；
- [ ] numerator/denominator/sample/coverage/status/version 在 API 中结构化；
- [ ] 缺失、未采集、样本不足、延迟、故障、配置缺口不补 0；
- [ ] 运营指数 leaf key 重命名后有新手算 golden；
- [ ] 错误/性能仍不进入指数 v1。

### 数据与重置

- [ ] 已确认仓库外没有真实 SDK/数据消费者；
- [ ] reset 精确解析资源名并提供 dry-run；
- [ ] 空变量、通配符、错误 Compose project 被拒绝；
- [ ] reset 不删除源码、文档、Secret 模板、备份或其他项目资源；
- [ ] v3 各组件同批切换，不允许新旧混跑；
- [ ] 投产后的 additive migration 与本次测试 reset 明确分开。

### 产品流程

- [ ] 全局筛选的每个字段都有数据来源和 query 支持；
- [ ] 下钻/返回保留上下文；
- [ ] unclassified route 仍可见但不进入评分；
- [ ] 页面定义/血缘来自 API，旧本地定义文案被清理；
- [ ] viewer/admin 双层权限回归；
- [ ] M5/M6/M8 页面不是被新页面平行复制。

## 8. 对 MVP plan v1.4 的 Review 重点

计划的 18–28 人日不是“改名工作量”，而是一次全链 baseline 重建。评审估算时重点检查：

- A0 是否真的列全旧 read model、SDK wrapper、fixtures、seed、SQL alias 和 UI 本地文案；
- A1 是否包含 v1/v2 拒绝、v3 consumer、clean schema/seed 和 demo 同步；
- A2 是否包含真实 P90 SQL、sample gate、zero denominator 和 DST golden；
- A3/A4 是否包含旧 M5 API 响应结构的统一，而不只处理 M6 页面；
- A5 是否运行 M7 full load/fault/backup/restore，而不是只跑单元；
- M8.1-B 是否每个 collector 独立估算并可单独关闭；
- M9 是否保持在 M8.1 完成门之外。

如果上述任一项未分配 owner/测试/退出条件，18–28 人日会偏乐观；若 A0 证明多数组段已经规范，则纯命名部分可以缩小，但契约重建和全量回归仍不会消失。

