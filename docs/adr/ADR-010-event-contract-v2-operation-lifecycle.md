# ADR-010：事件契约 v2 与任务实例生命周期

- 状态：Accepted
- 日期：2026-07-29
- 对应基线：requirements-v1.6、mvp-plan-v1.3

## 背景

v1 的 `feature_started` 与终态没有实例关联。同一功能并发操作时无法可靠计算耗时，也无法区分明确取消和长时间无终态。

## 决策

1. ingestion、Kafka consumer 和查询在迁移期同时接受 schema v1/v2。
2. v2 增加随机 `operationInstanceId`、`feature_canceled` 和受限 `interactionType`。
3. SDK 提供 handle-first API：

   ```ts
   const operation = tracker.startOperation("alarm_acknowledge");
   operation.succeed();
   operation.fail("request_rejected");
   operation.cancel();
   ```

4. SDK 公共 API 不接受调用方指定 operation ID；ID 使用 Web Crypto 随机 UUID。
5. 一个 handle 只能进入一个终态。重复终态不再发送事件，只增加本地诊断计数。
6. 同一 feature 的多个 handle 完全独立。
7. 对启用 `operation_lifecycle_enabled` 的 data-view/action feature，v2 started 和终态必须包含 operation ID；long-view 保持独立生命周期。
8. `operation_instance_id` 在 ClickHouse 为 nullable 高基数字符串，不进入排序键，也不回填历史。
9. 没有终态的 started 仅在任务超时窗口结束后标记为“近似放弃”。
10. v2 指标返回 `availableFrom`；跨 v1/v2 边界标记 partial，不伪造历史耗时。

## 安全边界

- operation ID 必须匹配 `op_` 加随机字符格式。
- SDK 保留字段不能由自定义属性或 `beforeSend` 覆盖。
- 服务端只能验证格式，不能声称识别所有伪装成随机值的业务标识。
- 日志和死信不记录事件 payload。

## 后果

- 可以正确计算任务达成、失败、取消、近似放弃和成功耗时。
- 旧 SDK 和 v1 历史继续支持功能采用，但没有任务实例指标。
- 业务必须在真实成功点调用 `succeed`，点击不能直接等同成功。
