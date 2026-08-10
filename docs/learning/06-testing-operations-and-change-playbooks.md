# 06. 测试、运维与变更手册

> 当前基线：M0–M8。M6 增加 operation/MetricCatalog/index golden，M7 增加负载/故障/备份恢复，M8 增加隐私/错误组/Web Vitals/双浏览器 E2E。

## 1. “能运行”不等于“语义正确”

这个项目的测试不是只检查 HTTP 200。它要证明：

- 三类场景产生正确事件序列；
- token/PII 不进入 payload、Kafka、ClickHouse 或错误；
- 隐藏标签页不累计长时使用；
- Kafka 重复交付不会把指标翻倍；
- viewer 不能写或访问未授权项目；
- DST、空数据、延迟和故障不会产生误导结果；
- migration 能从空库、旧版和重复执行得到同一结构。
- 并发 operation 只产生一个匹配终态，指数 gate 与手算一致；
- M8 脱敏、错误组、P75/告警不污染运营指数；
- Kafka/ClickHouse/consumer 故障和恢复表现符合 202/503/at-least-once 语义。

学习测试时先问“这个断言保护了哪个产品承诺”，而不是只看 mock 写法。

## 2. 当前测试分层

| 层               | 主要位置                                                  | 证明什么                                         | 不能证明什么                  |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------ | ----------------------------- |
| 静态/格式        | Prettier、ESLint、TypeScript                              | 代码一致、类型和基础规则                         | 运行时业务语义                |
| workspace 边界   | `tools/check-workspace-boundaries.mjs`                    | 无 app-to-app/package-to-app/循环依赖            | 模块内部职责是否合理          |
| 契约单元         | `packages/test-fixtures/test/contract-boundaries.test.ts` | 三边界同语义、限制/拒绝码                        | 浏览器真实生命周期            |
| SDK 单元         | `packages/web-tracker/test/tracker.test.ts`               | 路由、会话、隐私、队列、long view                | Chromium/WebKit 实际 API 行为 |
| 浏览器契约       | `tests/browser/web-tracker.spec.ts`                       | 真实 History/visibility/destroy、同步预算        | 服务端与基础设施              |
| pipeline 单元    | `packages/server-core/test/pipeline.test.ts`              | HMAC、Origin、feature stage、Kafka failure、限流 | 真 Kafka offset 行为          |
| 数据/时间单元    | `packages/server-core/test/status-and-range.test.ts`      | 状态机、范围、DST                                | ClickHouse SQL 真实结果       |
| migration 单元   | `packages/database/test/migrations.test.ts`               | 清单、DDL 必要表、TTL、breakpoint                | 真实引擎升级                  |
| Compose verifier | `packages/server-core/test/integration-flow.ts`           | HTTP→Kafka→consumer→CH、auth、权限、分析、审计   | M1 Mac 人工体验和生产容量     |
| M6 指标/产品      | `metrics.test.ts`、`tests/m6`、`m6-http-smoke.mjs`        | operation、配置版本、血缘、指数 gate 和页面下钻 | 真实业务目标是否合理          |
| M7 韧性/容量      | `scripts/m7`、`tools/m7-*`                                | 20/200 events/s、三依赖故障、备份恢复            | 目标环境 HA/异地副本          |
| M8 可观测性       | observability tests、`tests/m8`、`m8-http-smoke.mjs`      | 隐私、错误组、P75、固定告警、双浏览器 UI         | SourceMap/通知/真实处理流程    |

M7/M8 实现记录中的无容器证据为：Vitest 15 files/108 tests、Chromium SDK browser 4/4、SDK gzip 7,511 bytes（12 KiB 上限）和静态构建通过；Compose、WebKit、full load/fault/restore 以 PR checks 和本地指引为准。Linux CI 仍不能替代目标 Apple Silicon/部署环境验收。

## 3. Golden fixtures 为什么是项目的“校准砝码”

`packages/test-fixtures` 为 data view、action、long view 各提供：

- `valid/*.json`：应被所有边界接受；
- `invalid/*.json`：应被所有边界拒绝；
- `golden/*.expected.json`：人工可计算的指标结果。

同一组 valid batch 被 SDK/契约、ingestion、consumer 和完整流反复使用，减少测试样例各自演化造成的“每个模块都通过，但端到端含义不一致”。

新增事件语义时，优先扩 fixture，而不是只在一个模块增加孤立测试。

## 4. 完整流 verifier 在做什么

`packages/server-core/test/integration-flow.ts` 的步骤值得当作验收脚本模板：

1. 在 MySQL seed admin、viewer、项目、Origin 和三类 feature；
2. 把 fixture 时间移到当前测试窗口；
3. 每个 batch 故意发送两次；
4. 轮询 ClickHouse，等待原始行可见；
5. 登录 admin/viewer 并检查 HttpOnly refresh cookie；
6. 验证 viewer 只能读授权项目、不能写或枚举成员；
7. 查询 overview，断言双写原始事件去重后 PV/visitor/account 正确；
8. 查询三类 feature，断言每个成功只算一次；
9. 验证 long view 取最大累计值为 120,000 ms；
10. 验证 data status healthy 和 admin metrics；
11. 验证 refresh rotation 与 logout revoke；
12. 停用项目并确认 ingestion 明确拒绝；
13. 恢复项目并查询 audit log。

这比“启动服务后 curl 一下”强得多，因为它同时验证成功路径、权限、重复、状态变化和审计。

`./scripts/dev smoke` 还会串联 M5/M6/M8 HTTP smoke；M6/M8 Playwright 分别验证管理端任务，M7 drill 验证依赖中断和数据恢复。不要用某一层通过替代其余层。

## 5. 根检查命令如何形成质量门

`pnpm check` 的顺序：

```text
format:check
→ check:workspace
→ contract:check
→ lint
→ typecheck
→ vitest
→ build
```

顺序让便宜、反馈快的检查先失败。`contract:check` 放在编译前可以清楚指出 Schema/生成类型漂移，而不是等某个下游出现晦涩类型错误。

浏览器测试和 Compose 完整流独立执行，因为它们依赖浏览器/容器，成本更高。

## 6. Docker Compose 编排阅读法

`infra/compose/m2-m4.compose.yml` 把依赖关系显式化：

```text
mysql/clickhouse healthy
→ migrate one-shot 完成
kafka healthy
→ kafka-topics one-shot 完成
→ api + consumer healthy
→ verifier profile 运行
```

值得学习的点：

- Kafka 禁止自动建 topic，由 one-shot service 显式创建；
- migration 是服务启动前的阶段门；
- API/consumer 只暴露到 `127.0.0.1`；
- named volumes 默认保留；
- healthcheck 区分进程存活与依赖就绪；
- 所有服务在独立 network；
- resource limit 让目标 Mac 上的成本可见；
- 镜像固定版本，避免某天拉到不兼容 latest。

M5 overlay 增加 Web/demo/Nginx；production overlay 再增加 Docker Secret、只读 root、tmpfs、资源限制、日志轮转和 release-tag 镜像。具体见 [M7 生产硬化与故障恢复](15-m7-production-hardening-and-recovery.md)。

## 7. 本地命令与数据安全

```bash
./scripts/dev doctor
./scripts/dev up
./scripts/dev smoke
./scripts/dev status
./scripts/dev logs api
./scripts/dev down
```

`down` 不删除卷。只有明确执行以下命令才删除本 Compose 项目的数据：

```bash
./scripts/dev reset --confirm-local-data-loss
```

脚本用固定 Compose project name 和 label 选择卷，先列出目标，再 `down --volumes`。这是 destructive operation 应具备的模式：明确作用域、显式确认、普通停止不携带删除副作用。

`ensure_env` 首次从 example 复制本地 env 并 chmod 600；默认值只允许本地开发，不能原样用于生产。

## 8. 按症状定位故障

### 8.1 SDK diagnostics 有 dropped event

依次检查：

1. `lastErrorCode` 是 account/property/feature/batch 哪一类；
2. route normalizer 是否返回 query/hash 或超过长度；
3. featureKey 是否在 registered list；
4. beforeSend 是否修改了禁止字段；
5. 单事件/队列是否超限。

### 8.2 HTTP 4xx

使用响应 `requestId` 和 `code`：

- `PROJECT_*`/`ORIGIN_*`：查 MySQL 项目配置与 cache invalidation；
- `FEATURE_*`：查 feature type/status 与事件 stage；
- `SCHEMA_*`/`*_TOO_LARGE`：用契约 validator 重放最小 payload；
- `CREDENTIAL_DATA_REJECTED`：不要记录完整 payload，逐字段缩小范围。

### 8.3 HTTP 202 但 Dashboard 无数据

依次查看：

1. `/api/projects/:id/data-status`；
2. `last_received_at` 是否更新；
3. consumer `/health/ready` 和 metrics；
4. Kafka lag/retries；
5. `last_ingested_at`/`last_queryable_at`；
6. ClickHouse 原始行是否在 event_time 查询范围；
7. UI 是否把 gap/null 错画成 0。

### 8.4 原始行翻倍但指标正常

这是 at-least-once + 查询去重的预期现象。用 `eventId` 对比 raw count 和 deduplicated count；只有不同 eventId 的业务重复才会真实增加指标。

### 8.5 Migration 失败

- checksum changed：恢复旧文件，新增前向 migration；
- MySQL lock 失败：确认是否另一个迁移进程仍运行；
- ClickHouse 半执行：检查已成功 DDL 是否幂等，再用新 migration 修复；
- 编译后找不到 migrations：检查 `migrationsDirectory` 的 source/dist 路径测试。

## 9. 变更 Playbook

### 9.1 新增兼容事件字段

1. 修改 JSON Schema 为 optional；
2. 更新 valid/invalid/golden fixtures；
3. 生成类型并执行 `contract:check`；
4. SDK 只在必要时写入；
5. ingestion/consumer 保持旧字段缺失可用；
6. 需要查询时新增 typed ClickHouse 列和前向 migration；
7. 增加旧 payload + 新 payload 双测试；
8. 更新契约文档。

### 9.2 新增破坏性事件语义

当前一般规则仍是发布新 schema、同步 validator/SDK/consumer 并定义兼容窗口。v1.7 是一次明确例外：若 ADR 证明所有数据和消费者都可丢弃，可在同批切到 v3-only，但必须新增 v1/v2 拒绝 fixture、安全 reset、clean baseline/seed 和 M0–M8 全量回归。

### 9.3 新增分析指标

1. 在 PRD 写清 numerator、denominator、去重单位、时间和 null 语义；
2. 先扩 `METRIC_CATALOG` 的结构化定义/血缘，再用 fixture 手算 expected；
3. 优先扩固定 query，不开放任意 SQL；
4. 参数化所有值，动态列用 whitelist；
5. 检查是否需要 event time 或 received time；
6. 加重复 eventId、无数据、延迟和 DST 测试；
7. 记录 p95/扫描行数；
8. 只有达到阈值才加聚合/缓存。

### 9.4 修改项目/功能写操作

1. 明确全局角色和项目角色矩阵；
2. 输入用 Zod，最终不变量用数据库/事务；
3. 管理变更与 audit 尽量同事务；
4. 如果影响 ingestion 配置，失效 cache；
5. 加 admin/viewer/未授权/并发边界测试；
6. 保持统一错误结构。

### 9.5 新增数据库 migration

1. 新建下一个 `NNN_name.sql`；
2. 不修改已应用文件；
3. DDL 尽量幂等并评估锁表/数据回填；
4. 新增空库、旧版升级、重复执行断言；
5. 对 ClickHouse 多语句使用显式 breakpoint；
6. 设计前向修复，不依赖自动破坏性 rollback；
7. 更新备份/恢复和部署顺序。

### 9.6 引入新基础设施

先回答：现有 MySQL/Kafka/ClickHouse 为什么不能满足、触发指标是什么、谁运维、备份/恢复如何做、如何退出。没有证据就不引入 Redis/Elasticsearch。

## 10. 代码评审检查表

- [ ] 变更能关联到用户任务和明确成功语义；
- [ ] 没有把 started/click 当 succeeded；
- [ ] 没有混淆 visitor/account/session；
- [ ] 没有把 token、cookie、query 或原始账号写进事件/日志/DLQ；
- [ ] producer/ingestion/consumer 对契约理解一致；
- [ ] 异步失败没有被显示为真实 0；
- [ ] Kafka offset、重试和 DLQ 行为没有造成静默丢失；
- [ ] SQL 使用参数或 whitelist，并有范围上限；
- [ ] 管理写有服务端授权、事务不变量和审计；
- [ ] migration 是新版本且旧 checksum 未变；
- [ ] 新代码没有形成 app-to-app 或依赖环；
- [ ] 单元、浏览器、Compose 和目标 Mac 中该跑的层级都已验证；
- [ ] 文档中的当前边界和函数索引仍准确。

## 11. 当前维护关注点

- `MySqlStore`、`AnalyticsStore` 已显著增长；下一轮全链重命名前应先建立 inventory 和小步提交边界。
- 当前 SDK 旧 `featureStarted` wrapper 与 v2 operation 要求存在契约张力，新任务只使用 `startOperation`。
- API/UI types 手工维护，旧 M5 与新 M6 read model 命名不完全一致。
- production 仍是单机 pilot；限流/cache/进程指标没有多副本一致性。
- M7 外部发布门、M8 三项目/处理人、SourceMap 和通知仍未完成。
- v1.7 reset 只适用于确认可丢弃的本地/验收资源，不能替代投产后的 additive migration/backup/rollback。

本章的实践顺序见 [代码精读实验](07-code-reading-labs.md)。
