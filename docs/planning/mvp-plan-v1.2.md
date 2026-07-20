# Frontend Insight——MVP 开发计划 v1.2

> 状态：待技术评审  
> 更新日期：2026-07-19  
> 对应需求：[需求文档 v1.5](../product/requirements-v1.5.md)  
> 适用假设：1 名有经验的全栈开发者，AI 辅助，复用现有 Kafka、ClickHouse、MySQL 和内网部署环境

## 1. 交付目标

先在一台 Mac 的 demo-app 中完成三类功能采用场景，再在一个真实内部 Web 项目中完成以下闭环：

```mermaid
flowchart LR
    A[定义功能] --> B[接入 SDK]
    B --> C[曝光与成功事件]
    C --> D[接收与入库]
    D --> E[功能采用 Dashboard]
    E --> F[Mac 全流程验收]
    F --> G[真实项目试点]
```

MVP 完成不以“代码生成完毕”为准，而以目标用户能独立接入、数据口径正确、链路异常可识别、部署可恢复为准。

### 1.1 MVP 交付物

- npm ESM Web SDK；
- NestJS 模块化单体：ingestion、consumer、analytics、admin、system；
- Vue 3 管理后台：登录、项目、功能定义、接入验证、功能采用、页面访问、数据状态；
- demo-app：数据/图表渲染、导出/导入/配置、大屏持续展示三类场景；
- Kafka topic、ClickHouse 原始事件表、MySQL 元数据表及 migrations；
- Mac Docker Compose 完整 profile，以及 `doctor/bootstrap/up/seed/smoke/status/logs/down/reset` 统一脚本；
- 事件 JSON Schema、OpenAPI、SDK 接入指南、Mac 本地全流程指南、部署与恢复手册；
- 自动化测试、固定数据集正确性测试与最小负载报告。

### 1.2 非交付物

本计划不包含自定义指标引擎、健康度评分、路径桑基图、错误/性能监控、SourceMap、告警、Redis、Elasticsearch、行为回放和小程序。

## 2. 工期与节奏

原计划的 8–13 天适合链路原型，不足以覆盖功能采用口径、本地 demo、接入体验、数据质量、故障状态和恢复演练。v1.2 给出两个口径：

| 口径 | 工期 | 可交付结果 |
|---|---:|---|
| 本地演示原型 | 12–15 个开发日 | Mac 完整链路、三类 demo 场景和功能采用页；不得称为可试点版本 |
| 可试点 MVP | 18–22 个开发日 | 本文完整验收范围，含真实项目、硬化、部署和恢复演练 |

日历工期还需包含依赖方响应、内网发布窗口和业务项目上线等待，不应直接等同于开发日。

### 2.1 里程碑

| 里程碑 | 建议时间 | 结果 | 阶段门 |
|---|---:|---|---|
| M0 决策与基线 | Day 1 | ADR、容量、身份、数据边界确认 | 未确认不得写核心数据模型 |
| M1 契约与工程 | Day 2–3 | Monorepo、功能事件 schema、migration、CI | 契约测试通过 |
| M2 SDK | Day 4–6 | 页面/功能事件、身份边界、长时心跳、发送 | 浏览器与 token 泄露测试通过 |
| M3 数据链路 | Day 7–9 | 接收、Kafka、consumer、ClickHouse、状态 | 三类 fixture 正确入库 |
| M4 管理与查询 | Day 10–12 | 认证、项目、功能、onboarding、分析 API | 功能采用口径测试通过 |
| M5 本地产品闭环 | Day 13–15 | demo-app、功能采用页、Mac 脚本和指南 | 未参与编码者本地走查通过 |
| M6 硬化与试点 | Day 16–22 | 真实项目、负载、故障、部署、恢复 | Go/No-Go 评审通过 |

## 3. 开工前阶段门 M0

### 3.1 决策清单

| ID | 决策 | 默认值 | 验收证据 |
|---|---|---|---|
| ADR-001 | 项目数、事件量、峰值 | ≤20、≤100 万/日、≤200 events/s 峰值 | 负责人签字/记录数据来源 |
| ADR-002 | 业务账号 | 显式传入稳定不透明账号引用，严禁 token | 能获取的账号引用与退出流程 |
| ADR-003 | 共享账号 | 账号、浏览器、会话三套口径并列，不推断真实人数 | 产品负责人确认展示文案 |
| ADR-004 | Kafka 复用 | 使用现有集群 | topic、ACL、容量、保留期可用 |
| ADR-005 | 浏览器矩阵 | 组织实际使用的最近两个主版本 | 业务项目访问统计或负责人确认 |
| ADR-006 | 试点项目 | 选定一个 history/hash 代表性项目 | 开发联系人与发布窗口 |
| ADR-007 | 本地 Mac | Docker Compose full profile；不单装基础组件 | Apple Silicon/Intel 与资源实测记录 |

### 3.2 Stop 条件

出现以下任一情况时暂停实现并更新设计：

- Kafka/ClickHouse/MySQL 不能复用，需要为本项目新建和维护集群；
- 日事件量或峰值超过默认假设 5 倍；
- 用户标识政策禁止稳定匿名标识或哈希用户 ID；
- 试点项目 CSP/网络不允许访问独立上报地址；
- 业务要求把错误监控、自定义指标或秒级数据强行并入同一 MVP。

## 4. 仓库与模块结构

建议使用 pnpm workspace，减少跨包契约漂移：

```text
frontend-insight/
├── apps/
│   ├── api/                  # NestJS HTTP：admin/analytics/system/ingestion
│   ├── consumer/             # Kafka consumer 进程入口
│   ├── web/                  # Vue 3 管理后台
│   └── demo-app/             # 三类功能采用场景
├── packages/
│   ├── web-tracker/          # 浏览器 SDK
│   ├── event-contract/       # JSON Schema、类型、兼容性测试
│   ├── shared-config/        # lint/tsconfig 等工程配置
│   └── test-fixtures/        # 固定事件集和预期指标
├── infra/
│   ├── compose/
│   ├── clickhouse/migrations/
│   ├── mysql/migrations/
│   └── kafka/
├── docs/
│   ├── product/
│   ├── planning/
│   ├── adr/
│   ├── api/
│   ├── operations/
│   └── guides/
└── scripts/
```

模块化单体不等于没有边界。`event-contract` 是 SDK、接收端、消费者和测试之间唯一共享的事件定义；业务模块不得直接引用另一个模块的数据库实现。

## 5. 详细任务清单

### M0：决策、基线与风险验证（Day 1）

#### M0.1 确认产品与数据边界

**背景**：v1.3 的核心风险是范围和口径不一致。  
**目标**：确认第 3.1 节 ADR，并冻结 MVP 的 P0/非 P0 列表。  
**任务**：

- [ ] 与产品、业务开发、数据/安全负责人完成 60 分钟评审；
- [ ] 记录容量、身份、字段、基础设施和浏览器矩阵；
- [ ] 确认三类功能成功规则：数据渲染成功、业务操作成功、大屏前台可见达到阈值；
- [ ] 明确 token 是禁止采集的凭证，共享账号不能推断真实人数；
- [ ] 选定试点项目和发布联系人；
- [ ] 将所有新增想法写入候选池，不直接加入当前里程碑。

**风险**：参会人把“以后需要”误认为“首期必须”。  
**测试/验证**：每项 P0 均能关联到一个第 2.2 节核心任务。  
**验收**：ADR 有负责人和日期，未决项有截止时间；Stop 条件未触发。

#### M0.2 技术 Spike

**目标**：在正式工程前消除最大不确定性。  
**任务**：

- [ ] 用真实权限验证 Kafka produce/consume；
- [ ] 用目标 ClickHouse 版本验证 Node 客户端批写与 DateTime64；
- [ ] 验证 MySQL migration 和连接池；
- [ ] 在试点域名验证 CORS、CSP `connect-src` 和 `sendBeacon`/keepalive fetch；
- [ ] 在目标 Mac 架构运行 Kafka、ClickHouse、MySQL 最小 Compose，记录启动时间、峰值内存和磁盘；
- [ ] 记录版本、配置、最小示例与结果。

**验收**：一条测试事件可从浏览器到达 ClickHouse；失败点和替代方案已记录。Spike 代码不可直接复制为生产实现，除非补齐测试和错误处理。

### M1：工程、契约与迁移基线（Day 2–3）

#### M1.1 Monorepo 初始化

**目标**：所有运行时与契约在一个可重复构建的仓库中。  
**任务**：

- [ ] 初始化 pnpm workspace、TypeScript、ESLint、Prettier；
- [ ] 建立 `apps/api`、`apps/consumer`、`apps/web` 和 packages；
- [ ] 增加统一 `dev`、`build`、`test`、`lint`、`typecheck` 命令；
- [ ] 配置环境变量 schema，缺失关键变量时 fail fast；
- [ ] 配置 CI：install、lint、typecheck、unit、build。

**风险**：AI 为每个包生成不同配置，导致重复与漂移。  
**测试**：全新 checkout 后单命令安装和构建。  
**验收**：CI 绿色；没有包依赖循环；生产凭证不进入仓库。

#### M1.2 事件契约

**目标**：先稳定事件语义，再并行开发 SDK 与服务端。  
**任务**：

- [ ] 定义 batch、`page_view`、`page_leave`、custom 和功能事件 JSON Schema；
- [ ] 定义 `feature_exposed/started/succeeded/failed` 与 long-view start/heartbeat/end；
- [ ] 为 `data_view`、`action`、`long_view` 建立三套 valid/invalid/golden fixtures；
- [ ] 定义 `schemaVersion=1`、字段上限、事件名称规则与拒绝码；
- [ ] 定义向后兼容策略：服务端至少接受当前与前一小版本；
- [ ] 建立 valid/invalid fixtures；
- [ ] 生成共享 TypeScript 类型但以 JSON Schema 为传输事实来源。

**风险**：把 SDK 内部对象直接当作网络协议，后续无法演进。  
**测试**：生产者/消费者契约测试、边界值、未知字段、旧版本事件。  
**验收**：同一 fixture 在 SDK、ingestion 和 consumer 中得到一致结果。

#### M1.3 数据库迁移

**目标**：表结构可版本化、可重复应用、可回滚或前向修复。  
**任务**：

- [ ] MySQL：projects、features、project_origins、identities/users、project_members、audit_logs；
- [ ] ClickHouse：raw_events MergeTree 与 TTL；
- [ ] 为 migration 建立版本表和执行脚本；
- [ ] 准备固定事件集与预期查询结果；
- [ ] 暂不创建 Redis、ES 或错误表。

**风险**：按错误排序键建表后，查询扫描量过大；直接用 SummingMergeTree 聚合 UV/平均值。  
**测试**：空库迁移、重复执行、升级路径、TTL 和典型查询 explain。  
**验收**：全新环境一键建表；三类固定功能事件可写入并按项目、功能和时间查询。

### M2：Web SDK（Day 4–6）

#### M2.1 生命周期与标识

**目标**：稳定生成页面、访客与会话事件。  
**任务**：

- [ ] 生成 `visitorId`、`sessionId`、`pageViewId`、`eventId`；
- [ ] 实现 `setAccount`，只接受业务显式传入的不透明账号引用；
- [ ] 禁止 SDK 扫描 Authorization、cookie、Local/Session Storage token；
- [ ] 实现 30 分钟活动超时；明确标签页边界；
- [ ] 采集初始页面和 History/hash 路由变化；
- [ ] 使用 `visibilitychange`/`pagehide` 结算可见时长；
- [ ] 实现重复路由事件抑制；
- [ ] 实现 `destroy()` 清理监听和 timer。

**风险**：replaceState、微前端、多次初始化导致重复 PV；后台标签页时长被高估。  
**测试**：Vitest 单元测试 + Playwright 浏览器矩阵；初始加载、前进后退、hash、隐藏恢复、多初始化和销毁。  
**验收**：固定操作脚本产生完全一致的事件序列；共享账号的账号/浏览器/会话口径正确；无遗留监听器。

#### M2.2 数据边界与路由归一化

**目标**：默认不采集敏感或高基数字段。  
**任务**：

- [ ] 默认移除 query/hash/referrer query；
- [ ] 提供 `normalizeRoute`；
- [ ] 实现事件名、属性数、键值长度、嵌套和总大小限制；
- [ ] `setAccount` 只接受业务不透明引用，测试接收端项目级 HMAC 和传输值丢弃；
- [ ] 为 header、cookie、Local Storage 和日志建立 token 泄露回归 fixture；
- [ ] 实现只允许删除/归一化的 `beforeSend`；
- [ ] 禁止 cookie、表单、DOM 文本和存储内容采集。

**风险**：业务把订单号、手机号或 token 放进 path/property。  
**测试**：敏感字段 fixtures、动态路由、超长值和恶意对象。  
**验收**：默认 payload 检查不含禁止字段；高基数路由可被项目规则归一化。

#### M2.3 标准功能采用 API

**目标**：让业务开发者无需自定义指标公式即可覆盖三类真实使用场景。  
**任务**：

- [ ] 实现 `featureExposed/Started/Succeeded/Failed`；
- [ ] 实现 `startLongView`，30 秒成功阈值、60 秒心跳、前台可见累计和停止函数；
- [ ] data view demo 在主要数据成功且渲染后触发 succeeded；
- [ ] action demo 只在后端结果成功后触发 succeeded；
- [ ] long view 在后台标签页暂停累计，恢复后继续；
- [ ] feature key 必须来自已注册功能，开发模式对未知 key 给出诊断。

**风险**：把点击当成功；大屏只依赖离开事件导致崩溃时无时长；后台标签页虚增。  
**测试**：接口失败、渲染失败、取消操作、后台切换、浏览器关闭、心跳丢失。  
**验收**：三类 Playwright 脚本产生与 golden fixtures 一致的事件序列。

#### M2.4 队列、发送与诊断

**目标**：在不阻塞宿主的前提下尽可能可靠上报。  
**任务**：

- [ ] 内存队列、满批和定时 flush；
- [ ] 常规 fetch、离开 sendBeacon、失败 keepalive fetch；
- [ ] 64 KiB 前拆批，不使用 Image Beacon；
- [ ] 失败退避但不无限重试，不写 Local Storage 持久队列；
- [ ] 初始化失败返回 no-op tracker；
- [ ] 开发模式诊断日志和 `getDiagnostics()`；
- [ ] 保证多次 createTracker 有明确行为。

**风险**：请求过大在页面退出时静默失败；错误处理反过来影响业务。  
**测试**：离线、超时、4xx/5xx、sendBeacon 返回 false、页面快速关闭、队列溢出。  
**验收**：降级链路可复现；所有失败均不向宿主抛错；丢弃计数可诊断。

#### M2.5 SDK 预算

- [ ] 构建 ESM 包并输出 bundle report；
- [ ] 基准测试初始化、路由事件和自定义事件同步耗时；
- [ ] 检查内存队列上限和 listener 数量；
- [ ] 生成 SDK README 与最小接入示例。

**验收**：gzip ≤12 KB、事件同步处理 p95 ≤2 ms、单批 ≤64 KiB、队列 ≤100 条。结果记录测试浏览器和机器。

### M3：接收、消费与数据状态（Day 7–9）

#### M3.1 Ingestion API

**目标**：快速、受控地接收有效事件并给出可诊断结果。  
**任务**：

- [ ] `POST /v1/events`，body ≤64 KiB、批量 ≤50；
- [ ] project key 缓存、Origin 校验、多维限流；
- [ ] schema、时间范围和字段边界校验；
- [ ] 校验 feature key 已注册、状态可用且事件阶段合法；
- [ ] 将 accountRef 转为项目级 HMAC 后丢弃传输值；拒绝疑似 Bearer/JWT/token 值；
- [ ] 添加 `receivedAt`、`requestId`；
- [ ] 写 Kafka 成功后返回 202；
- [ ] 结构化拒绝码与不含 payload 的日志；
- [ ] 指标：请求/事件、p95、拒绝原因、Kafka 写失败。

**风险**：逐事件查 MySQL；CORS `*`；把 project key 当密码；日志泄露。  
**测试**：契约、Origin、限流、未知 feature、非法阶段、token 泄露、过期/未来时间、超大请求、Kafka 不可用。  
**验收**：合法批次 202，非法批次有稳定错误码；p95 ≤100 ms 的目标在基准负载下通过。

#### M3.2 Consumer 与 ClickHouse

**目标**：批量、可恢复地将事件写入原始表。  
**任务**：

- [ ] consumer group、批量与 flush 超时；
- [ ] schema 归一化和项目 ID 映射；
- [ ] 按 `eventId` 做幂等容错或查询侧去重策略；
- [ ] 有限重试、退避和死信 topic；
- [ ] 批写 ClickHouse；
- [ ] 监控 lag、批大小、写入失败、重试和死信；
- [ ] 安全关闭时 flush/commit。

**风险**：先提交 offset 后写入失败；无限毒消息重试；小批写放大 ClickHouse parts。  
**测试**：ClickHouse 不可用、毒消息、进程在写入前后退出、重复消费、恢复追赶。  
**验收**：三类固定事件集最终可查；暂停/恢复 consumer 不丢失已入 Kafka 事件；死信可定位且不含 token。

#### M3.3 数据状态

**目标**：让用户和运维区分零访问与链路异常。  
**任务**：

- [ ] 每项目记录最后接收、最后入库、最后可查询时间；
- [ ] `/health/live`、`/health/ready`；
- [ ] `/api/projects/:id/data-status`；
- [ ] 定义 `healthy`、`delayed`、`no_data`、`broken` 状态机；
- [ ] 状态判断有超时阈值和可测试的时钟来源。

**验收**：暂停 consumer 后状态变为 delayed 而非 0；恢复追赶后自动回到 healthy。

### M4：认证、项目与分析 API（Day 10–12）

#### M4.1 认证与授权

**目标**：最小可用但不虚假的内部访问控制。  
**任务**：

- [ ] 按 ADR-002 实现 SSO 适配或本地认证；
- [ ] admin/viewer 和 project membership；
- [ ] 服务端项目级授权 guard；
- [ ] 管理操作审计；
- [ ] 登录限流、会话过期和退出。

**风险**：只有前端权限；本地 JWT 长期存 localStorage；默认管理员密码进入镜像。  
**测试**：越权矩阵、过期会话、禁用用户、项目隔离。  
**验收**：viewer 无写权限；未授权项目返回 403；审计可查。

#### M4.2 项目、功能与 onboarding API

**目标**：支持完整的创建—配置—验证流程。  
**任务**：

- [ ] 项目创建、编辑、停用；
- [ ] 功能创建、编辑、停用；feature key 在项目内唯一且创建后不可静默改义；
- [ ] 功能类型只允许 data_view/action/long_view，并保存上线时间和长时阈值；
- [ ] 公开 project key 生成；
- [ ] Origin、时区和保留期配置；
- [ ] onboarding status 与测试事件关联；
- [ ] 禁止 UI 物理删除项目。

**测试**：重复 project/feature key、非法类型、非法 Origin/时区、停用后上报、项目隔离。  
**验收**：创建项目和功能后 API 返回完整接入信息；停用后上报被明确拒绝。

#### M4.3 固定分析 API

**目标**：用同一口径提供 overview、trend、pages。  
**任务**：

- [ ] 先为固定 fixture 写预期结果；
- [ ] overview：PV、访客、用户、会话、昨日同时段比较；
- [ ] trend：范围与粒度校验、缺口显式表达；
- [ ] pages：搜索、分页、排序、最后访问；
- [ ] features overview：曝光、成功账号/浏览器、成功次数、转化率、重复使用和最后使用；
- [ ] feature detail：曝光/开始/成功/失败漏斗、趋势和大屏可见时长；
- [ ] 账号、浏览器、会话口径并列，禁止把共享账号的 token 或浏览器数称为人数；
- [ ] 时区统一；最大查询范围 13 个月；
- [ ] 查询超时、扫描量与 p95 指标；
- [ ] 记录真实查询性能，未达阈值前不加 Redis。

**风险**：重复事件、跨日时区、昨日完整天与今日半天错误比较；把缺失点补 0。  
**测试**：DST/跨日、重复、迟到事件、空范围、部分缺口、高基数页面、共享账号、多浏览器、跨会话重复使用和心跳缺口。  
**验收**：三类 golden fixtures 的全部指标与手算结果一致；30 天查询 p95 ≤2 秒。

### M5：Mac 本地产品闭环（Day 13–15）

#### M5.1 基础框架

- [ ] Vue 3、TypeScript、Element Plus、ECharts；
- [ ] 路由、认证、全局错误处理和 request ID；
- [ ] 项目/时间范围保存在 URL；
- [ ] 统一 loading、empty、stale、error、forbidden 状态组件；
- [ ] 功能列表、功能采用首页和功能详情页；
- [ ] 基础可访问性：键盘操作、颜色不作为唯一状态表达。

**验收**：刷新/分享 URL 保持筛选；API 失败不把旧数据清空为 0。

#### M5.2 项目与接入页

- [ ] 创建/编辑/停用项目；
- [ ] 复制 npm 代码、project key、endpoint；
- [ ] Origin 与 CSP 说明；
- [ ] 发送测试事件、显示请求 ID 与最近状态；
- [ ] 按拒绝码显示对应排障建议；
- [ ] 首次无数据 Dashboard 回到接入流程。

**验收**：未阅读外部文档的试用者能在 15 分钟内完成测试事件验证。

#### M5.3 功能采用与页面访问 Dashboard

- [ ] 项目、时区和时间范围；
- [ ] 默认首页展示功能采用：类型、曝光、成功、转化、重复使用、最近使用和趋势；
- [ ] 功能详情展示标准阶段，不输出健康/好坏分数；
- [ ] 四个核心指标卡和昨日同时段比较；
- [ ] PV/活跃访客趋势；
- [ ] 页面排行、搜索、分页；
- [ ] 数据更新时间、链路状态和指标定义；
- [ ] 部分数据缺口不直接连线；
- [ ] 响应式支持常用办公屏幕，不为移动端复杂交互做专门优化。

**测试**：正常、无数据、无访问、延迟、部分数据、失败、无权限、加载中八种状态。  
**验收**：目标用户能完成 PRD 第 2.2 节全部 P0 任务，并能区分“无曝光、曝光未使用、链路延迟”。

#### M5.4 三场景 demo-app

**目标**：在不改真实项目之前，用受控场景验证产品与数据口径。  
**任务**：

- [ ] 登录与明确的模拟 token/analyticsRef；
- [ ] 数据页面：成功、接口失败、渲染失败；
- [ ] 操作页面：导出、导入、保存配置的成功/取消/失败；
- [ ] 大屏页面：前台停留、后台暂停、心跳、异常关闭；
- [ ] UI 显示每次预期产生的事件，便于学习和排障。

**验收**：人工步骤和 Playwright 自动化均能复现三类 golden fixtures；payload 和日志中无模拟 token。

#### M5.5 Mac 本地脚本与指南

**目标**：使用者不单独安装 Kafka、ClickHouse、MySQL，即可运行完整链路。  
**任务**：

- [ ] Compose full profile 支持 Apple Silicon 和 Intel Mac；
- [ ] `doctor/bootstrap/up/seed/smoke/status/logs/down/reset`；
- [ ] down 保留数据，reset 需要 `--confirm-local-data-loss`；
- [ ] 实测并维护 `docs/guides/local-full-flow-macos.md`；
- [ ] 找一名未参与编码的人从 clone 开始完整执行。

**验收**：指南最终清单全部通过；任何失败都有用户可理解的下一步，不要求手工调试基础设施内部参数。

### M6：硬化、部署与试点（Day 16–22）

#### M6.1 自动化与数据正确性

- [ ] 单元测试：SDK、口径函数、权限、状态机；
- [ ] 契约测试：SDK → ingestion → consumer；
- [ ] 集成测试：Kafka、ClickHouse、MySQL；
- [ ] E2E：创建项目/功能 → 接入 → 三类使用 → 上报 → 功能采用 Dashboard；
- [ ] 固定事件集 golden test；
- [ ] CI 汇总测试和覆盖率趋势，不以单一覆盖率数字代替关键路径测试。

**验收**：关键路径和所有拒绝码均被自动化覆盖；fixture 结果稳定。

#### M6.2 负载与故障测试

| 场景 | 目标 |
|---|---|
| 20 events/s 持续 30 分钟 | 接收/消费稳定，延迟满足 SLO |
| 200 events/s 峰值 5 分钟 | Kafka 削峰，恢复后 15 分钟内追平 |
| Kafka 暂停 | 接收返回明确错误/降级，系统状态可见 |
| ClickHouse 暂停 | consumer 不提交错误 offset，有限重试后死信/暂停 |
| Consumer 重启 | 可从已提交 offset 恢复，无无限重复 |
| Dashboard 30 天查询 | p95 ≤2 秒，记录扫描量和资源 |

**验收**：形成可复现报告，失败项有是否阻止试点的结论。

#### M6.3 Docker 与运维

- [ ] 开发和试点 Compose 分离；
- [ ] 多阶段构建、非 root、健康检查、资源上限；
- [ ] 数据卷、日志轮转、Secret 注入；
- [ ] migration 在受控步骤执行，不由多个副本竞争；
- [ ] 编写安装、升级、回滚、备份、恢复和清理手册；
- [ ] 在全新环境部署一次；
- [ ] 在目标 Mac 按本地指南从 clone 执行一次；
- [ ] 使用备份恢复到另一实例一次；
- [ ] 验证升级不会删除已有数据卷。

**验收**：部署与恢复由未参与编码的人按文档完成；无默认生产密码。

#### M6.4 真实项目试点

- [ ] 接入选定业务项目；
- [ ] 在真实项目中选择至少一个数据查看、一个操作完成和一个持续展示功能；
- [ ] 观察至少 2 个工作日；
- [ ] 对比业务端已知访问样本；
- [ ] 访谈至少 1 名产品/运营和 1 名开发；
- [ ] 收集误解、缺失任务和性能影响；
- [ ] 只修复阻止核心任务的问题，其余进入候选池。

**验收**：首个项目完成接入；目标用户能完成 PRD 第 2.2 节全部 P0 任务；无 P0/P1 缺陷。

## 6. 测试矩阵

| 层级 | 工具/方式 | 关键覆盖 |
|---|---|---|
| 静态 | TypeScript、ESLint、dependency audit | 类型、规则、已知高危依赖 |
| 单元 | Vitest/Jest | SDK 生命周期、口径、权限、状态机 |
| 浏览器 | Playwright | history/hash、页面隐藏、CSP/CORS、卸载 |
| 三类场景 | Playwright + demo-app | 数据渲染、操作结果、大屏阈值/心跳/可见性 |
| 契约 | JSON Schema + fixtures | 兼容、边界、拒绝码 |
| 集成 | Testcontainers/测试 Compose | Kafka、ClickHouse、MySQL |
| E2E | Playwright + 完整环境 | 创建—接入—上报—查询—展示 |
| 数据正确性 | Golden dataset | PV、访客、会话、时区、重复、迟到 |
| 负载 | k6 或 Artillery | 接收 p95、峰值、恢复追赶 |
| 故障 | 手动/脚本化注入 | 依赖不可用、重启、毒消息、部分数据 |
| 隐私 | fixture + payload snapshot | 禁止字段、高基数、长度和日志泄露 |
| 本地操作 | 全新 Mac 人工验收 | doctor、启动、seed、smoke、验证、停止、恢复 |

## 7. MVP 验收清单

### 7.1 用户闭环

- [ ] 新用户能创建项目并完成测试事件；
- [ ] 新用户能创建三类功能并看到对应接入示例；
- [ ] 功能采用页可回答曝光、成功账号/浏览器、次数、转化、重复使用、趋势和最后使用；
- [ ] 页面访问页可回答访问量、浏览器、账号、会话、趋势和页面排行；
- [ ] 三类 demo 场景全部通过，点击、失败和后台停留不会被误计为成功；
- [ ] 共享账号不被误报为多个真实用户；
- [ ] 口径、时区、更新时间可见；
- [ ] 空数据与链路故障不混淆；
- [ ] 项目权限有效。

### 7.2 数据链路

- [ ] schema、Origin、大小、时间和限流校验有效；
- [ ] accountRef 转 HMAC 后原值被丢弃，任何层均无 token；
- [ ] Kafka 重试/死信和 consumer lag 可见；
- [ ] ClickHouse 数据与 fixed fixtures 一致；
- [ ] 重复、迟到和缺失 leave 事件有确定语义；
- [ ] p95 数据延迟 ≤5 分钟。

### 7.3 SDK

- [ ] 路由与生命周期浏览器测试通过；
- [ ] 标准功能事件和长时心跳浏览器测试通过；
- [ ] 默认不采集禁止字段；
- [ ] sendBeacon/keepalive 降级通过；
- [ ] `destroy()` 和多实例行为通过；
- [ ] 包体、同步耗时、队列与批大小预算通过。

### 7.4 工程与运维

- [ ] CI 全绿；
- [ ] OpenAPI、schema、migration、接入和运维文档齐全；
- [ ] 全新部署、升级、备份恢复演练通过；
- [ ] Mac 本地指南由未参与编码者完整执行通过；
- [ ] down 保留数据，reset 只清理本项目卷且要求显式确认；
- [ ] 关键运行指标和健康检查可见；
- [ ] 无 P0/P1 缺陷、默认密码、硬编码 Secret 或宽泛 CORS。

## 8. 风险登记

| 风险 | 概率/影响 | 早期信号 | 应对与负责人 |
|---|---|---|---|
| 需求再次扩张为 Sentry + BI | 高/高 | Sprint 中新增错误、规则、漏斗 | 以 PRD 非目标和阶段门拒绝插入；产品负责人 |
| 指标口径争议 | 高/高 | 同一 fixture 各端结果不同 | golden dataset + 口径文档；后端负责人 |
| 把 token 当用户标识 | 中/高 | payload 或日志出现 Bearer/JWT | SDK 禁读 + ingestion 拒绝 + 泄露回归测试；安全负责人 |
| 共享账号被当多人 | 高/中 | token/浏览器数被称为用户数 | 账号/浏览器/会话三口径并列；产品负责人 |
| 操作点击被误计成功 | 高/高 | 失败操作仍增长成功数 | started/succeeded 分离 + demo 失败测试；产品/SDK 负责人 |
| 大屏后台时间虚增 | 中/高 | 后台标签页仍累计 | visibility + 心跳 + Playwright；SDK 负责人 |
| 路由高基数/敏感数据 | 中/高 | 页面排行出现 ID/token | 默认清洗 + 归一化 + 服务端限制；SDK/安全负责人 |
| Kafka 权限或运维不可控 | 中/高 | Spike 无法稳定 produce/consume | 触发 ADR，简化链路；平台负责人 |
| ClickHouse parts/查询膨胀 | 中/高 | 小批写、p95 上升 | 批写、查询指标、聚合触发阈值；数据负责人 |
| 本地认证成为永久债务 | 中/中 | SSO 无期限搁置 | 明确临时期限和迁移任务；平台负责人 |
| Mac 本地环境无法复现 | 中/高 | 依赖手工安装或架构镜像失败 | full Compose + doctor + 全新 Mac 验收；开发体验负责人 |
| AI 生成跨模块重复逻辑 | 高/中 | 多份事件类型/校验器 | contract 包、代码评审、小步任务；技术负责人 |
| 工期被依赖等待吞噬 | 高/中 | 发布/ACL 无负责人 | 开发日与日历日分离，M0 锁定联系人；项目负责人 |
| 监控数据被误当精确审计 | 中/高 | 用户要求对账或人员考核 | UI 标注近似语义与非目标；产品/数据负责人 |

## 9. 变更控制与防熵规则

1. 新功能必须写明用户任务、成功指标、数据字段、失败状态和验收，不接受只有 UI 草图的需求；
2. 事件契约变更必须先改 schema/fixture，再改 SDK 和消费者；
3. 每个存储组件必须有不可被现有组件满足的证据和退出/运维方案；
4. 不允许在分析 API 暴露任意 SQL、任意字段或无限时间范围；
5. 不允许以缓存掩盖慢查询，先记录扫描量与查询计划；
6. 每个里程碑结束删除未使用代码、过期 feature flag 和重复文档；
7. ADR 只记录真正影响长期方向的决策，避免文档数量本身成为熵；
8. P0 功能上线后至少观察两周，再决定下一个阶段；
9. PR 必须关联任务和验收项，AI 生成代码与人工代码使用同一标准；
10. 每月复核依赖、数据保留、运行成本、失效项目和路线图进入条件。

## 10. Go / No-Go 评审模板

试点上线前由产品、开发、运维共同回答：

| 问题 | Go 条件 |
|---|---|
| 核心用户闭环是否完成？ | 三类功能采用、接入与全部 P0 任务通过走查 |
| 数据是否可信？ | Golden dataset 全通过，口径已签字 |
| 宿主影响是否可接受？ | SDK 性能与隐私预算通过 |
| 本地是否真正可运行？ | 未参与编码者按 Mac 指南完成完整链路 |
| 故障是否可见、可恢复？ | 延迟状态、重启、备份恢复通过 |
| 安全边界是否成立？ | 授权、Origin、Secret、日志检查通过 |
| 是否有已知阻断缺陷？ | P0/P1 为 0 |
| 运维是否有人负责？ | 负责人、告警接收和升级路径明确 |

任一项不满足时为 No-Go，记录修复任务与复评日期；不得用“内部系统”作为降低数据正确性和安全要求的理由。
