# ADR-008：事件契约与数据库迁移边界

- 状态：Accepted
- 日期：2026-07-21
- 适用里程碑：M1

## 背景

M2 的 SDK 与 M3 的接收/消费链路会并行依赖事件格式。如果各自维护接口或直接复用某一层的内部对象，协议会在开发中漂移。MySQL 与 ClickHouse 也需要在全新环境、重复执行和版本升级时得到相同结果。

## 决策

1. JSON Schema 是事件传输协议的唯一事实来源，共享 TypeScript 类型从 Schema 生成。
2. producer、ingestion 和 consumer 使用同一 validator 与固定 fixtures；边界层可以转换为内部模型，但不得放宽传输约束。
3. 事件协议采用显式整数 `schemaVersion`。首版只接受 v1；未来发布 v2 时至少保留 v1 兼容窗口。
4. MySQL 与 ClickHouse 分别维护按版本排序的 SQL migration 和 checksum ledger。已应用版本内容被修改时立即失败。
5. migration 默认前向执行并可重复运行。破坏性回滚不自动执行，修复使用新的前向 migration。
6. M1 只创建需求文档明确需要的 MySQL 元数据表与 ClickHouse `raw_events`，不预建 Redis、Elasticsearch 或错误域表。

## 结果

- SDK 和数据链路可以围绕稳定契约独立开发；生成检查防止类型漂移。
- fixtures 同时承担协议测试和数据库查询基准，减少多套样例的熵增。
- migration 有版本、checksum、互斥锁和幂等验证，环境可重建且历史不可静默改写。
- 前向修复要求多一个 migration，但保留了生产数据与升级路径的可审计性。

## 后续触发条件

- 增加 v2 前，先补充双版本 validator 与 v1→v2 兼容测试。
- 只有达到需求文档的性能或使用阈值，才评估聚合表、Redis 或 Elasticsearch。
- 生产上线前仍需补齐备份、恢复和清理演练；这些不属于 M1 完成条件。
