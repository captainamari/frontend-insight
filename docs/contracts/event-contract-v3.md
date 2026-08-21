# 事件传输契约 v3

状态：v1.8 R0 唯一运行时契约

事实来源：`packages/event-contract/canonical-names.json` 与生成的 `packages/event-contract/schema/event-batch-v3.schema.json`。

## 公共上下文

每个事件必须独立携带 `appId/env/release/event/timestamp/pageUrl/pageRoute/userId/deptId/roleId/sessionId/deviceId/ua/os/browser/payload`，另含技术字段 `eventId/pageViewId`。批次只保存 `schemaVersion=3`、epoch-ms `sentAt` 和 SDK 名称/版本，不作为事件公共字段的替代位置。

- `env` 只允许 `prod/staging/dev`，`release` 由宿主构建配置显式提供；缺失即拒绝。
- `pageUrl` 与 `pageRoute` 在浏览器发送前删除 query/hash；动态路由可通过 `normalizePageRoute` 归一化。
- `userId/deptId/roleId` 缺失时显式为 `null`。`userId` 只能是非敏感不透明引用，并在 ingestion 进入 Kafka 前转换为项目域 HMAC。
- `deviceId/sessionId/pageViewId` 由 SDK 生成；`ua` 截断并过滤，`os/browser` 为受控粗粒度值。
- 同一批次不得混用 `appId` 或 `env`，事件时间使用 epoch milliseconds。

## 事件

| `event`       | payload                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `page_view`   | 空对象                                                                         |
| `page_leave`  | `visibleDurationMs`                                                            |
| `performance` | 小写 `metric`、`value/rating/navigationType`                                   |
| `api`         | `success/requestMethod/requestPath/statusCode/durationMs/failureType`          |
| `error`       | `errorType/errorCategory` 及 JS 或资源错误白名单                               |
| `custom`      | 受控 `name`，可选 feature、operation、workflow 技术字段和最多 12 个标量 labels |

功能与 workflow 的具体动作不是顶层 event alias。operation/workflow instance ID 只能由 SDK 随机生成；不采集 query、header、body、DOM 文本、业务对象 ID 或完整错误堆栈。

## 拒绝与版本边界

v1、v2、旧公共字段、旧 event alias、旧 metric key、凭据/直接 PII、重复 event ID、超限事件和时间偏移均稳定拒绝。没有 alias、双读、双写、自动 normalizer 或旧数据回填。
