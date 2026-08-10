# 18. M6–M8 代码精读实验

这些实验不是“看页面是否能打开”，而是要求你从输入、状态变化、存储、查询、输出和失败路径证明理解。破坏性或故障实验只在可丢弃本地环境执行。

## 实验 1：画出 v1/v2/v3 三条契约线

### 目标

区分当前真实支持窗口与 v1.7 目标。

### 阅读

- `packages/event-contract/src/constants.ts`；
- `validator.ts`；
- 两份 JSON Schema；
- requirements v1.7 第 3、7 节。

### 操作

列一张表：

- v1 当前能发哪些事件；
- v2 增加哪些字段/事件；
- SDK 0.3 默认发哪个版本；
- v3 提案删除/改名哪些字段；
- 当前正向 fixture 在 v3 后应变成什么拒绝 fixture。

### 必须发现

当前 `featureStarted` 公共 API 会生成没有 operation ID 的事件，而 v2 validator 对 `feature_started` 要求 operation ID。说明“兼容 wrapper 是否保留”必须由 v3 一次性解决并补契约测试。

## 实验 2：并发 operation 不串联

### 目标

证明配对键不是时间顺序。

### 操作

1. 为同一 feature 同时创建两个 operation handle；
2. 第二个先 succeed，第一个后 fail；
3. 检查四条事件的 operation ID；
4. 手算 started/succeeded/failed；
5. 对第一个再次 cancel，确认不发第三个 terminal，只增加 duplicate diagnostic；
6. 对照 `operationInstances` 的 `minIf/argMinIf`。

## 实验 3：配置生效边界

### 目标

理解为什么指数有 `range` 和 `evaluationRange`。

### 操作

构造：

- range 从 7 月 1 日到 7 月 8 日；
- settings 7 月 2 日生效；
- profile 7 月 3 日生效；
- 页面 7 月 4 日生效；
- 关键任务 7 月 5 日生效。

先预测 evaluationRange.from，再读 `operationalIndex` 验证。解释为何不能用 7 月 1–4 日的事件评价新任务。

## 实验 4：手算项目运营指数

### 目标

掌握 leaf → dimension → index。

### 操作

1. 从 `m6-fixture.ts` 选一组 raw metrics；
2. 按 profile 计算每个 leaf score；
3. 删除一个 optional leaf，观察维度重新归一化；
4. 让 leaf coverage 降到 69%，确认总分 null；
5. 恢复到 70%，但只剩 2 个维度，确认仍 null；
6. 把 data state 改 delayed，确认 raw metric 可展示但总分不可用。

## 实验 5：页面时长 coverage

### 目标

证明缺少 `page_leave` 不能补 0。

### 场景

发送 10 个 page_view，只有 6 个 pageViewId 有 leave，其中一个有两个 visible fragment。

计算：

- durationSamples；
- durationCoverage；
- 每个 pageView 合并后的 duration；
- P50/P75；
- 哪些条件允许进入 `page_visible_duration_fit`。

再思考 v1.7 增加 P90 后最少需要多少样本，以及门槛应在 SQL、MetricCatalog 还是两者共同执行。

## 实验 6：未归类 route

### 目标

理解“可见但不评分”。

### 操作

1. 发送 `/unknown` 的 page_view；
2. 查看 Pages；
3. 查看 Operational Overview 的 unclassified；
4. 查看 page detail 的 classification；
5. 确认 module/core-page coverage 和 index 不变化；
6. 在配置页建立 PageDefinition 并设置 effectiveFrom；
7. 解释旧事件是否应立即进入新定义。

## 实验 7：M8 浏览器端裁剪

### 目标

验证真实发送边界。

### 输入

构造一个 Error/message/URL，包含：

- Bearer token；
- JWT；
- 邮箱；
- query/hash；
- UUID/长 path ID；
- 很长 message。

### 操作

1. 调用 `captureException/captureApiError`；
2. 在 `beforeSend` 观察候选；
3. 在 Network 捕获最终 `/v1/events`；
4. 验证 path 的 `:id`、字符串截断、release/environment；
5. 确认没有 header/body/UA 原文；
6. 启用冲突 staticProperties，确认 fail-closed no-op。

## 实验 8：错误组稳定性

### 目标

理解“group ID”和“影响范围”分离。

### 操作

对同一脱敏错误特征生成事件，改变：

- route；
- release；
- visitor/account；
- event time。

预测 group ID 是否改变。再改变 message 或 API status bucket，预测是否改变。对照 consumer 的 group key 和 `ObservabilityStore.errorGroupsSql`。

## 实验 9：为什么错误率不能从 `error_api` 算

### 目标

识别缺失分母。

### 场景

看到 20 条 error_api。

回答：

- 总请求是 20、200 还是 2000？
- success rate、error rate、slow rate能否计算？
- 当前 duration 是错误请求的耗时还是所有请求的耗时？
- v1.7 M8.1-B 至少需要什么 summary 事件/字段/coverage？

同样检查 resource failure rate。不得使用 pageViews 作为 API/resource 请求分母。

## 实验 10：故障语义矩阵

### 目标

区分 API/consumer/ClickHouse/Kafka 故障。

### 操作

在可丢弃本地栈运行：

```bash
bash scripts/m7 fault all --confirm-disruption
```

对每一阶段记录：

- live/ready；
- ingestion HTTP；
- Kafka 是否已有消息；
- consumer 是否提交 offset；
- ClickHouse 是否可查询；
- 恢复后 marker；
- data status。

解释为何 Kafka 停止时必须 503，而 consumer 停止时仍可 202。

## 实验 11：备份与回滚

### 目标

区分 data restore 与 application rollback。

### 操作

画出 `backup`、`restore`、`rollback` 三条时序，标出：

- 停止哪些服务；
- 何时等待 lag=0；
- 导出什么；
- 哪一步替换数据；
- 哪一步只替换镜像；
- migration 是否向后执行；
- 自动安全备份在哪里发生。

回答：为什么旧镜像兼容新 additive schema 是应用回滚的前提？

## 实验 12：v1.7 命名 inventory

### 目标

防止机械重命名。

### 操作

对每个词执行源码搜索并分类：

- `appId`；
- `projectId/projectKey`；
- `env/deploymentEnvironment`；
- `release/releaseVersion`；
- `timestamp/eventTime/receivedAt`；
- `userId/accountRef/accountId`；
- `conversion/postExposureUseRate`；
- `active_browsers/activeVisitors`。

分类必须包含：产品概念、遥测字段、认证字段、数据库物理列、shell/env 局部变量、文档。只对相同命名域建立 rename 任务。

## 实验 13：设计安全 reset

### 目标

把“测试数据可丢弃”转成可执行安全边界。

### 设计要求

伪代码必须：

1. 要求 `--confirm-local-data-loss`；
2. 解析固定 Compose project；
3. 列出 MySQL/ClickHouse/Kafka/topic/volume/seed/配置目标；
4. 空变量、通配符、workspace root、`~` 被拒绝；
5. 默认 dry-run；
6. 不删除 repo、Secret 模板、backup；
7. 连续执行两次 reset → migrate → seed → smoke 均通过；
8. 发现真实环境标志时 No-Go。

将它与当前 `scripts/dev reset`、`scripts/production restore` 比较，说明为何不能复用 production restore 名称。

## 实验 14：Review v1.7 的四个决策

为以下四项分别写“接受/拒绝/需修改”和证据：

1. Pre-1.0 v3-only + 全量测试数据 reset；
2. 按指标族选择 P75/P90，而不是全局 P90；
3. 没有官方分母就不显示 rate；
4. M8.1-A 与新增 collector M8.1-B 分批。

每项必须引用当前代码路径、受影响层、测试门和回退策略，不能只写偏好。

## 最终自测

1. 为什么当前 `projectId` 不需要迁移，但 metric key 仍需要？
2. 为什么 auth `userId` 不能被“禁止遥测 userId”误伤？
3. P50/P75 改 P50/P90 为什么是数据契约变更？
4. 为什么 v1 operation 数据不能计算 task instance 指标？
5. 为什么 availableFrom 与 configuration effectiveFrom 都需要？
6. 为什么 missing leaf 不当 0，仍然需要 70% coverage gate？
7. 为什么错误/性能不能自动进入指数 v1？
8. 为什么 20 条 error_api 不能计算失败率？
9. application rollback 为什么不 down-migrate？
10. CI 绿为什么不代表 M7/M8 真实项目阶段 Go？

