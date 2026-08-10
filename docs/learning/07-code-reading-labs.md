# 07. 代码精读实验

> 本文保留 M0–M4 的基础实验，并按当前 `main` 修正契约和 SDK 用法。M6–M8 的操作域、生产运维与前端可观测性实验见 [18. M6–M8 代码精读实验](18-m6-m8-code-reading-labs.md)。

## 1. 如何把项目从“看过”变成“掌握”

只顺着文件读很容易产生熟悉感，却不能证明你能维护。每个实验都要求你完成四项输出：

1. **预测**：运行前写下会经过哪些函数、产生什么事件/状态；
2. **观察**：用测试、断点、临时日志或数据库查询验证；
3. **解释**：说明为什么结果正确，以及哪条不变量在保护它；
4. **变体**：改变一个输入，预测失败路径和错误码。

学习笔记建议使用固定模板：

```markdown
## 实验 N：标题

- 我的预测：
- 实际调用链：
- 关键状态变化：
- 成功/失败输出：
- 保护的不变量：
- 如果修改 X，会破坏：
- 仍未理解的问题：
```

## 2. 推荐的七个学习单元

| 单元 | 主题               | 对应实验 | 完成标志                                    |
| ---: | ------------------ | -------- | ------------------------------------------- |
|    1 | 架构和契约         | 1、8     | 不看文档画出模块/数据模型，解释升级规则     |
|    2 | SDK 页面生命周期   | 2、3     | 能手算 route、ID、visible time 事件序列     |
|    3 | SDK 业务与隐私     | 4        | 能把真实操作接成 started/succeeded/failed   |
|    4 | ingestion/consumer | 5、10    | 能解释 202、offset、DLQ、重复和延迟         |
|    5 | auth/authorization | 6、9     | 能画权限矩阵和 refresh rotation             |
|    6 | analytics/time     | 7        | 能手算去重、昨日同时段和 long-view duration |
|    7 | 完整维护演练       | 11       | 能安全设计一次小变更及其测试/文档           |

## 3. 实验 1：契约拒绝与错误优先级

### 目标

理解 Schema 校验之前/之后的手工边界，以及为什么错误不回显敏感值。

### 阅读路径

1. `packages/event-contract/src/constants.ts`；
2. `packages/event-contract/schema/event-batch.schema.json`；
3. `packages/event-contract/src/security.ts`；
4. `packages/event-contract/src/validator.ts`；
5. `packages/test-fixtures/test/contract-boundaries.test.ts`。

### 操作

从一个 valid fixture 分别制造：

- `schemaVersion=3`（当前实现尚不接受）；
- 合法的 v2 `feature_started`，以及删除 `operationInstanceId` 后的非法版本；
- 顶层增加 `authorization`；
- property value 改为 Bearer/JWT；
- 同批两个相同 `eventId`；
- `feature_failed` 删除 `reasonCode`；
- event time 移到 25 小时前；
- event 与 batch 分别超过字节限制。

运行契约测试，记录每种情况最先返回的 code 和 path。

### 你必须能解释

- 为什么未知版本在 AJV 前拒绝；
- 为什么 token 形态不会出现在错误 message；
- 为什么 TypeScript 类型不能替代运行时 Schema；
- 为什么 producer/ingestion/consumer 虽然当前同实现，仍保留三个函数名。

## 4. 实验 2：SPA 路由与页面三个 ID

### 目标

理解初始页面、push/replace/pop/hash 对 PV 和可见时长的影响。

### 阅读路径

`packages/web-tracker/src/index.ts → packages/web-tracker/src/tracker.ts`，然后依次看 constructor、`installLifecycle`、`handleRouteChange`、`settleVisiblePage`。

### 操作

在测试 runtime 或 browser test 中执行：

1. 从 `/orders/1?token=x#tab` 初始化；
2. `pushState` 到 `/orders/2?x=1`；
3. `replaceState` 到同一个归一化 route；
4. 浏览器 back；
5. hidden 10 秒、visible 5 秒后离开；
6. 调用 `destroy` 后再次导航。

先手写每一步应产生的 `page_view/page_leave`、route、visitor/session/pageView ID 是否变化，再与 payload 对比。

### 变体

实现业务 `normalizeRoute`，把 `/orders/123` 变为 `/orders/:id`，确认两个不同 ID 页面不会制造高基数 route，但真实 route 变化是否仍需要新 PV 要按产品定义决定。

## 5. 实验 3：长时大屏的可见时间

### 目标

手算 `startLongView` 的累计算法，理解 heartbeat 为什么是累计值。

### 场景

使用较短测试阈值：成功 30 秒、heartbeat 60 秒。

```text
visible 20s → hidden 40s → visible 15s → visible 60s → stop
```

应能推导：

- hidden 40s 不计入；
- 恢复 10s 后累计 30s，只发一次 succeeded；
- heartbeat 的 `visibleDurationMs` 是达到条件时的累计值；
- ended 保存最终累计值；
- 查询端对同一 page instance 取 max，而不是 sum heartbeat。

再做 route change 变体，确认旧 long view 的 ended 仍绑定旧 `pageViewId/route`。

## 6. 实验 4：业务操作和隐私

### 目标

把一个真实异步“导出报表”接成正确事件，而不是把点击当成功。

### 伪代码练习

```ts
tracker.featureExposed("report_export");

async function exportReport() {
  const operation = tracker.startOperation("report_export");
  try {
    await api.exportReport();
    operation.succeed();
  } catch (error) {
    operation.fail(mapSafeReason(error));
    throw error;
  }
}
```

验证：

- API 失败时没有 succeeded；
- 同一次 operation 只有一个 terminal，started/succeeded/failed 共享 `operationInstanceId`；
- reasonCode 是低基数安全枚举，不是完整 exception message；
- properties 中嵌套对象、email、Bearer token 会被拒绝；
- `beforeSend` 可以进一步归一 route，但不能改 eventId/featureKey 或增加字段；
- SDK 不扫描 cookie 或其他 localStorage key。

### 迁移练习

列出同一模式可迁移的功能：导入、配置保存、审批、下发指令、批量更新。为每个功能定义“业务真正成功”的回调点。

## 7. 实验 5：重复交付和查询去重

### 目标

理解 at-least-once 不是 bug，以及 `eventId` 是跨层幂等键。

### 操作

完整流 verifier 已把每个 fixture 发送两次。执行：

```bash
./scripts/m2-m4 up
./scripts/m2-m4 verify
```

观察最终输出的 inserted rows 与 deduplicated events。再在 ClickHouse 分别查询：

```sql
SELECT count() FROM raw_events WHERE project_id = {projectId:UUID};

SELECT count()
FROM (
  SELECT *
  FROM raw_events
  WHERE project_id = {projectId:UUID}
  ORDER BY received_at DESC
  LIMIT 1 BY event_id
);
```

### 你必须能解释

- consumer 在什么崩溃窗口会重写同一消息；
- producer idempotent 为什么仍不能保证端到端 exactly-once；
- 如果客户端为同一次业务动作生成两个不同 eventId，查询为何无法去重；
- 原始层保留重复的存储与调试价值是什么。

## 8. 实验 6：Refresh token rotation

### 目标

理解 access token、refresh token、数据库 session 的不同职责。

### 调用链

```text
login
→ bcrypt compare
→ AuthManager.issue
→ DB 保存 refresh hash
→ 返回 access token + HttpOnly cookie

refresh
→ cookie 原文做 SHA-256
→ consumeSession SELECT FOR UPDATE
→ revoke 旧 session
→ issue 新 access + refresh
```

### 操作

1. 登录并保存 refresh cookie A；
2. 用 A 刷新得到 B；
3. 再次使用 A，应失败；
4. 用 B 刷新得到 C；
5. logout C；
6. 再用 C，应失败；
7. 在数据库确认只存 hash，没有 token 原文。

并发变体：同时用 A 发两个 refresh，请解释 `FOR UPDATE` 为什么只允许一个成功。

## 9. 实验 7：DST 与指标手算

### 目标

避免把“昨日同时段”写成 `timestamp - 24h`，并能手算核心指标。

### 操作

1. 阅读 `previousLocalCalendarDay` 的 formatter/迭代转换；
2. 运行 `packages/server-core/test/status-and-range.test.ts` 的 DST 用例；
3. 用 `America/Los_Angeles` 选择春季/秋季切换日期；
4. 对比“减 24 小时”和“前一日相同本地钟表时间”；
5. 用一小组 page/feature events 手算 PV、visitors、accounts、sessions、曝光后使用率、repeat usage；
6. 用累计 heartbeat 60s、120s 验证 max-then-sum 得 120s 而不是 180s。

### 变体

把 hourly 查询范围改成 32 天、总范围改成 14 个月、timezone 改成不存在的值，预测错误码/错误消息路径。

## 10. 实验 8：Migration 不可改写

### 目标

理解版本、checksum、幂等与前向修复。

### 操作

1. 在空库运行 migration，记录 applied；
2. 再运行一次，记录 alreadyApplied；
3. 在实验分支修改已应用 SQL 的一个空格，确认 checksum changed；
4. 恢复旧文件，新增下一版本 migration；
5. 分别验证从空库直升和从旧版本升级；
6. 对 ClickHouse 写一个包含两个语句的 migration，只用显式 breakpoint 分割。

### 你必须能解释

- 为什么“只改一个空格”也应该失败；
- 为什么 DDL rollback 不等于普通业务事务 rollback；
- MySQL `GET_LOCK` 与 Compose 单实例 ClickHouse migration 的差异；
- 项目级 `retentionDays` 为什么当前没有自动改变表 TTL。

## 11. 实验 9：权限矩阵与最后一个 owner

### 目标

区分认证、全局角色、项目角色和并发领域不变量。

### 权限表练习

为以下主体填写可读/可写/不可见，并用 API 验证：

| 主体          | 项目关系          | 列项目 | 查分析 | 改项目 | 管理成员 |
| ------------- | ----------------- | ------ | ------ | ------ | -------- |
| global admin  | 无显式 membership |        |        |        |          |
| global viewer | project viewer    |        |        |        |          |
| global viewer | project admin     |        |        |        |          |
| global viewer | 无 membership     |        |        |        |          |

不要按角色名称猜，按 `getProjectRole` 与 `requireProject` 的实际条件填写。

然后创建两个 owner，依次删除/降级，确认最后一个 owner 被事务拒绝。解释如果 Controller 先 count 再 delete 为什么有并发竞态。

## 12. 实验 10：毒消息与基础设施故障

### 目标

理解 consumer 为什么对两类失败采取相反策略。

### 场景 A：确定性毒消息

向 events topic 写 envelope version 错误或缺 enrichment 的消息。预期：

- 进入 DLQ；
- DLQ 没有原 payload，只有 hash/定位元数据；
- offset 被 resolve；
- 同批正常消息继续处理。

### 场景 B：ClickHouse 暂时不可用

暂停 ClickHouse 或让 insert 失败。预期：

- 正常消息不被提交；
- retries 增加；
- 达上限后 consumer readiness false 并暂停；
- data status 进入 delayed；
- 恢复后重新消费，可能产生同 eventId 重复，但查询正确。

必须能解释：如果把基础设施故障也送 DLQ，会怎样静默丢数据；如果让毒消息无限重试，会怎样阻塞分区。

## 13. 实验 11：设计一次小变更

### 题目

为 action feature 增加一个可选、低基数 `resultCategory` 属性，用于固定分类统计。不要直接写代码，先提交设计说明。

说明至少包括：

- 它是通用 property 还是正式字段，为什么；
- 是否兼容 v1；
- Schema、生成类型、SDK API 是否要改；
- ingestion 是否要 whitelist/校验；
- ClickHouse 是否需要 typed column 和 migration；
- 查询的 numerator/denominator/null/去重语义；
- valid/invalid/golden fixture；
- 旧 SDK 缺字段时结果；
- 字段基数和隐私上限；
- 单元、浏览器、Compose 验收；
- 文档更新位置。

完成后对照 [变更 Playbook](06-testing-operations-and-change-playbooks.md)，检查有没有从 UI 需求直接跳到 SQL。

## 14. 最终自测题

不看源码，用自己的话回答：

1. 202 之前和之后分别有哪些保证？
2. 为什么 `accountRef` 可以进入 HTTP body，却绝不能进入 Kafka？
3. `visitorId`、`sessionId`、`pageViewId`、`accountId` 各是什么口径？
4. route 变化时为什么先 stop long view，再生成新 page view？
5. 为什么 heartbeat 是累计值，查询为什么 max-then-sum？
6. 为什么原始 ClickHouse 行可以重复，而 Dashboard 不重复？
7. 毒消息和 ClickHouse 故障分别如何处理 offset？
8. 为什么“昨日同时段”不能简单减 24 小时？
9. 为什么 feature definitions 来自 MySQL、使用事实来自 ClickHouse？
10. global viewer 即使有 project admin 角色，当前是否能写？请引用实际条件解释。
11. 修改已应用 migration 为什么必须失败？
12. M4 能运行的 API 为什么还不等于一个完整可用产品？M6–M8 分别补上了哪些产品面与运维能力？

如果其中任何一题只能背一句结论，回到对应实验，画出输入→状态→输出→失败路径后再继续。
