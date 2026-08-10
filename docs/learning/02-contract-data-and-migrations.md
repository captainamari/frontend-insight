# 02. 事件契约、数据模型与迁移

> 当前基线：服务端同时接受 schema v1/v2；SDK 0.3 默认产生 v2。v1.7 提议的 v3-only 与测试数据重置尚未实现。M6/M8 已分别通过 ClickHouse migration 004/005 增加 operation 和 observability 列。

## 1. 为什么先学契约

Frontend Insight 的 SDK、ingestion、consumer 和分析查询由事件格式连接。只要其中一层对字段含义理解不同，系统即使“能跑”也会产生不可见的数据错误。

因此 M1 先建立协议，再开发 M2/M3：

- `packages/event-contract/schema/event-batch.schema.json` 与 `event-batch-v2.schema.json` 是当前两代网络传输格式的事实来源；
- `scripts/generate-types.mjs` 从 Schema 生成 TypeScript 类型；
- `contract:check` 在 CI 中检查生成结果是否漂移；
- producer、ingestion、consumer 分别调用命名边界，但当前都委托给同一个 `validateTransportBatch`；
- valid、invalid、golden 三类 fixtures 同时服务于协议测试和端到端指标测试。

“一个 validator，三个有名字的入口”是一个精巧点：今天保证语义一致，未来若 consumer 需要兼容旧版本，也有清晰的扩展缝隙，不必让调用方直接绑死内部函数。

## 2. 四层数据模型

不要把所有对象都叫“event”。当前链路中至少有四种不同模型：

| 层             | 代表类型/表                   | 特有内容                                              | 已删除或尚未拥有的内容            |
| -------------- | ----------------------------- | ----------------------------------------------------- | --------------------------------- |
| 浏览器传输批次 | `FrontendInsightEventBatchV1/V2` | `projectKey`、`accountRef?`、SDK；v2 增加 operation/M8 事件 | 没有内部 `projectId`、`accountId` |
| Kafka envelope | `KafkaEventEnvelope`          | `projectId`、`receivedAt`、`requestId`、`enrichments` | 原始 `accountRef` 已删除          |
| ClickHouse 行  | `raw_events`                  | 展平字段、HMAC 后 `account_id`、`feature_id`          | 不保存原始账号引用                |
| 分析响应       | overview/trend/pages/features | 去重、聚合、语义说明、时间范围                        | 不回传原始事件 body               |

这个分层适用于任何事件系统：外部协议、内部 envelope、存储模型、读模型不必相同，但转换位置和不变量必须明确。

## 3. JSON Schema 在约束什么

Schema 不只是类型声明，它表达了跨语言、跨进程的运行时规则：

- 顶层和 event 都设置 `additionalProperties: false`，未知字段直接拒绝；
- `schemaVersion` 当前允许 1/2，并据此选择对应 AJV validator；
- 每批 1–50 条；
- ID 使用带前缀的不透明字符串，便于排查口径；
- 标准 `page_`/`feature_` 前缀不能被自定义事件占用；
- properties 只能是一层 scalar map，最多 20 个键；
- 功能事件必须有 `featureKey`；
- `feature_failed` 必须有 `reasonCode`；
- `page_leave`、长时心跳和结束事件必须有 `visibleDurationMs`。
- v2 `feature_started/feature_canceled` 要求 SDK 生成的 `operationInstanceId`；
- v2 还约束 `error_js/error_resource/error_api/web_vital` 的低基数属性和 release/environment。

条件约束的价值在于把“字段存在”和“字段在什么语义下必须存在”放进同一个可执行协议。仅靠 TypeScript interface 无法阻止浏览器发来任意 JSON，也不能方便非 TypeScript producer 使用。

## 4. `validateTransportBatch` 的校验顺序

源文件：`packages/event-contract/src/validator.ts`。

校验顺序不是随意排列的：

1. **必须是普通对象**：避免后续属性读取出现模糊行为；
2. **先检查版本**：对未知协议快速返回稳定的 `SCHEMA_VERSION_UNSUPPORTED`；
3. **计算批次 UTF-8 大小**：在深入解析前限制资源消耗；
4. **检查事件条数**：快速阻止放大请求；
5. **递归扫描凭证**：在可能回显 schema 细节前拦截 token/cookie；
6. **逐事件检查字节与事件名**：返回更具体的拒绝码；
7. **AJV Schema 校验**：验证结构、类型、格式和条件字段；
8. **检查批内重复 ID 与客户端时钟**：完成需要强类型输入的语义校验。

错误只返回 `code`、路径和安全消息，不回显可疑值。注意 `findCredentialLeak` 返回的内部字符串含检测类型，但对外消息固定为 `credential-like data is forbidden`。

### 4.1 递归凭证扫描值得学习的写法

`findCredentialLeak(value, path, seen)` 同时处理：

- key 归一化：`access_token`、`Access-Token` 都会变为 `accesstoken`；
- Bearer 与 JWT 形态的字符串值；
- 数组和嵌套对象；
- `WeakSet` 防止循环引用造成无限递归。

但它是“防误采集护栏”，不是完整 DLP 产品。它不会识别所有 PII/secret，也不能替代业务端不读取凭证的原则。

## 5. 契约变更的正确顺序

任何事件字段或语义变化都按以下顺序：

1. 判断是兼容变更还是破坏性变更；
2. 先修改 JSON Schema；
3. 增加 valid/invalid/golden fixture；
4. 运行 `pnpm contract:generate`；
5. 修改 SDK、ingestion、consumer 与查询；
6. 运行 `pnpm contract:check`、单元、浏览器和完整流测试；
7. 更新对应契约文档和本学习指南。

当前实现选择 v1/v2 兼容窗口。v1.7 则因为系统尚未投产，提议直接发布 v3、拒绝 v1/v2 并清空可丢弃测试数据；这是新的产品/运维决策，必须由 ADR-014 和安全 reset 验收支持，不能把本段旧兼容策略当成仍然有效的目标。

## 6. MySQL 数据模型的学习重点

### 6.1 为什么身份与用户分表

`users` 保存系统内的人和全局角色，`identities` 保存登录提供方与 subject。当前只有 `provider='local'` 和密码哈希，但分表让未来接 SSO 时不必重写项目成员关系。

### 6.2 为什么删除使用状态而不是物理删除

项目、模块、页面、功能和用户都有 `status`/`disabled_at`。软停用保留历史事件与审计关联，避免一次 UI 操作物理删除 ClickHouse 大量数据。运营设置/profile 使用版本和生效区间，不原地改写 active 定义。

### 6.3 复合唯一键表达领域不变量

- `projects.project_key` 全局唯一；
- `(project_id, feature_key)` 保证功能键在项目内唯一；
- `(project_id, origin)` 防止 Origin 重复；
- `(project_id, user_id)` 保证一个成员只有一个项目角色；
- `(provider, subject)` 保证登录身份唯一。
- `(project_id, module_key)`、`(project_id, normalized_route)` 固定运营实体；
- `(project_id, profile_key, version)` 与 profile item 唯一键固定指数配置版本。

应用层校验用于友好错误，数据库约束负责最终一致性。两者不是重复劳动。

## 7. ClickHouse 原始表为什么这样设计

`infra/clickhouse/migrations/001_raw_events.sql`：

- `PARTITION BY toYYYYMM(received_at)`：按服务端接收月管理 part 与 TTL，避免客户端错误时间影响生命周期；
- `ORDER BY (project_id, toDate(received_at), event_name, route, event_time, event_id)`：优先服务项目+时间+事件/路由的主要查询；
- `event_time` 用于产品分析时间，`received_at` 用于链路新鲜度和分区，两者不能合并；
- `LowCardinality(String)` 用于 `event_name`、`sdk_version`；
- `properties_json` 保存受限自定义属性，但 M4 固定查询尚不依赖任意属性；
- TTL 当前固定 90 天；
- feature/session bloom filter 是数据跳过索引，不等于关系数据库 B-tree 索引。

M6 migration 004 增加 `operation_instance_id/interaction_type`；M8 migration 005 增加 release/environment、错误组、请求、Web Vital 和粗粒度终端列。它们都是 additive nullable 列，因此当前 production 可以保留数据并回滚应用镜像。v1.7 的 clean baseline 是一次性测试环境重建，不应改写投产后的向前 migration 原则。

为什么不用 `ReplacingMergeTree` 自动去重？当前选择是 `MergeTree` 保留真实接收事实，并在查询中 `LIMIT 1 BY event_id`。它实现简单、能观察重复率，但会增加存储与查询成本。达到规模阈值后应基于实测重新评估，而不是先假设哪种引擎最好。

## 8. Migration runner 的关键机制

源文件：`packages/database/src/migrations.ts`。

### 8.1 发现与排序

文件名必须匹配 `NNN_name.sql`。`discoverMigrations` 读取内容、计算 SHA-256 checksum、按版本排序并拒绝重复版本。

### 8.2 历史不可静默改写

每个引擎都有 `schema_migrations` ledger。已应用版本再次运行时：

- checksum 相同：记为 `alreadyApplied`；
- checksum 不同：立即失败；
- 新版本：顺序执行并记录耗时。

这意味着生产 migration 一旦应用就不应直接编辑；修复应添加新的前向 migration。它保留了“这个环境到底执行过什么”的可审计性。

### 8.3 并发与事务边界

MySQL runner 先获取命名 `GET_LOCK`，防止两个部署同时迁移。注意 MySQL DDL 可能隐式提交，所以这里的安全主要来自顺序、锁、幂等 SQL 和 checksum，而不是把整批 DDL 包进一个普通事务。

ClickHouse 多语句只在显式 `-- statement-breakpoint` 处分割，避免粗暴按分号切坏 SQL。目前 ClickHouse runner 没有跨进程命名锁，Compose 通过单个 `migrate` one-shot service 保证串行；生产部署必须保持这个约束或补锁。

## 9. 关键符号索引

| 符号                                     | 作用                      | 修改时必须关注                           |
| ---------------------------------------- | ------------------------- | ---------------------------------------- |
| `validateTransportBatch`                 | 协议总校验器              | 拒绝码优先级、错误是否泄密、三边界一致性 |
| `findCredentialLeak`                     | 凭证字段/值递归扫描       | 误报、漏报、路径不回显值                 |
| `validateForProducer/Ingestion/Consumer` | 稳定边界入口              | 新版本兼容是否需要分化                   |
| `discoverMigrations`                     | migration 清单与 checksum | 文件命名、重复版本、构建后路径           |
| `runMySqlMigrations`                     | MySQL 锁与 ledger         | DDL 幂等、锁释放、已应用文件不可修改     |
| `runClickHouseMigrations`                | ClickHouse 顺序执行       | breakpoint、单实例执行、ledger 重复风险  |
| `splitClickHouseStatements`              | 显式拆分多语句            | 不要改成简单 `split(';')`                |
| `CURRENT_SCHEMA_VERSION` / `SUPPORTED_SCHEMA_VERSIONS` | SDK 输出与服务端支持窗口 | v3 切换必须同步所有 producer/consumer |
| `infra/mysql/migrations/004_operational_metrics.sql` | M6 控制面模型 | 生效时间、版本、外键和唯一约束 |
| `infra/clickhouse/migrations/004/005` | operation/M8 事实列 | consumer 映射、nullable 兼容和查询索引 |

## 10. 可迁移到其他项目的经验

- 只要 producer/consumer 不在同一进程，就应有运行时契约，不能只共享编译期类型。
- 将协议验证和存储模型转换分开；外部协议不应直接等于数据库行。
- migration 的 checksum 是防止“旧环境和新环境同版本不同结构”的低成本手段。
- 事件时间和接收时间应分开；前者服务产品语义，后者服务运维与保留。
- Golden fixtures 应带人工可计算的 expected 结果，而不只是“能通过 Schema”。

本章实验见 [代码精读实验](07-code-reading-labs.md) 的实验 1、5 和 8。
