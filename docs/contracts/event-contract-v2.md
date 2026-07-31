# 事件传输契约 v2

状态：M6 基线  
事实来源：`packages/event-contract/schema/event-batch-v2.schema.json`

v2 在 v1 页面、功能和 long-view 语义上增加任务实例与取消终态。服务端、consumer 和 SDK 同时支持 v1/v2；v1 数据继续进入 M5 分析，但不能计算依赖 operation 配对的 M6 指标。

## 1. v2 新增字段与事件

| 字段或事件            | 规则                                                       | 业务语义                       |
| --------------------- | ---------------------------------------------------------- | ------------------------------ |
| `operationInstanceId` | `op_` 加 16–64 位不透明字符；由 SDK 随机生成               | 一次具体任务操作的配对键       |
| `interactionType`     | `click`、`submit`、`keyboard`、`programmatic`、`automatic` | 任务如何开始；不用于识别人员   |
| `feature_canceled`    | 必须有 operation ID                                        | 用户明确取消，不与系统失败混合 |

一次任务的合法状态：

```text
feature_started → feature_succeeded / feature_failed / feature_canceled
```

`feature_failed` 仍必须携带稳定、非敏感的 `reasonCode`。取消原因如需记录，应使用受限自定义属性，不得写入报警编号、设备 ID、人员 ID或凭证。

## 2. SDK handle

```ts
const operation = tracker.startOperation(
  "alarm_acknowledge",
  { entry: "alarm_list" },
  "click",
);

try {
  await acknowledgeAlarm();
  operation.succeed();
} catch {
  operation.fail("request_failed");
}
```

- 公共 API 不接受调用方传入 operation ID；
- 每个 handle 只能完成一个终态；
- 重复终态不发送事件，只增加 `duplicateOperationTerminals`；
- `operation.cancel()` 只表示用户明确取消；
- 同一 feature 的多个并发 handle 使用不同 ID，不按时间相邻关系配对；
- SDK 异常被隔离，不向宿主业务调用栈抛出。

## 3. 兼容边界

| 情况                                      | 行为                                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| v1 合法批次                               | 继续接收、入 Kafka/ClickHouse并供 M5 查询             |
| v2 普通页面或功能事件                     | 按 v1 兼容语义接收                                    |
| 已配置 `operationLifecycleEnabled` 的任务 | started/succeeded/failed/canceled 必须有 operation ID |
| v2 operation 数据尚不存在                 | 任务实例指标返回不可用及 `availableFrom=null`         |
| 调用旧 feature API 的项目                 | 不强制立即迁移；不能误生成 operation 指标             |

数据消费端将 `operationInstanceId` 和 `interactionType` 写入独立 ClickHouse 列，不依赖 `properties_json` 解析配对。

## 4. 隐私与大小边界

v2 继承 v1 的全部边界：

- 每批 1–50 条；
- 单事件不超过 8 KiB；
- 单批不超过 64 KiB；
- 自定义属性最多 20 个且禁止嵌套；
- token、Authorization、cookie、邮箱、手机号等凭证或直接身份信息拒绝；
- `eventId` 批内唯一，查询侧继续按 `eventId` 去重。

operation ID 只能是 SDK 生成的随机不透明值，不能使用设备、报警、订单、门禁或人员业务主键。

## 5. 稳定拒绝码

v2 新增：

| 拒绝码                        | 含义                                                |
| ----------------------------- | --------------------------------------------------- |
| `OPERATION_INSTANCE_INVALID`  | operation ID 缺失或格式不合法                       |
| `OPERATION_INSTANCE_REQUIRED` | 项目配置要求 operation lifecycle，但事件没有实例 ID |

其他 schema、大小、时间、Origin、项目、feature 和凭证拒绝码沿用 v1。

## 6. 修改和验证

1. 修改 v2 JSON Schema；
2. 更新 valid/invalid/golden operation fixtures；
3. 执行 `pnpm contract:generate`；
4. 执行 `pnpm check`；
5. 执行浏览器 SDK 契约和 Compose 数据链路；
6. 核对 v1/v2 SDK 分布与拒绝量后再讨论停止旧版本。

Schema 是传输格式的唯一事实来源；TypeScript 类型由生成器产生，不手工修改。
