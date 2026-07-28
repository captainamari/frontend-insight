# 事件传输契约 v1

状态：M1 基线  
事实来源：`packages/event-contract/schema/event-batch.schema.json`

本文说明契约语义，JSON Schema 才是网络传输格式的唯一事实来源。TypeScript 类型由 Schema 生成，不应手工修改。

## 1. 批次与通用边界

| 约束               | v1 规则                                             |
| ------------------ | --------------------------------------------------- |
| `schemaVersion`    | 固定为 `1`                                          |
| 每批事件数         | 1–50                                                |
| 单事件序列化大小   | ≤ 8 KiB                                             |
| 单批序列化大小     | ≤ 64 KiB                                            |
| 客户端时间偏差     | 默认不超过服务端时间 ±24 小时                       |
| 自定义属性         | 最多 20 个；不允许嵌套；键长 ≤ 64；字符串值长 ≤ 256 |
| 未声明字段         | 拒绝                                                |
| 同一批次 `eventId` | 必须唯一                                            |

事件名称使用小写 snake_case，最长 64 个字符。`page_` 和 `feature_` 前缀保留给标准事件，自定义事件不能占用这两个前缀。

## 2. 标准事件语义

| 使用场景      | 标准事件                                                                              | 必填补充字段                                             | 成功含义                           |
| ------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| 页面/数据查看 | `page_view`、`page_leave`                                                             | `page_leave.properties.visibleDurationMs`                | 页面已展示；离开时记录可见时长     |
| 功能采用      | `feature_exposed`                                                                     | `featureKey`                                             | 功能入口确实对当前访问者可见       |
| 操作功能      | `feature_started`、`feature_succeeded`、`feature_failed`                              | `featureKey`；失败还需 `reasonCode`                      | 开始不等于成功；以后两者计算完成率 |
| 长时大屏      | `feature_long_view_started`、`feature_long_view_heartbeat`、`feature_long_view_ended` | `featureKey`；心跳/结束需 `properties.visibleDurationMs` | 可见期间累计心跳，结束事件用于收口 |

`visitorId`、`sessionId` 和 `pageViewId` 是浏览器/会话口径，不能解释为真实人数。共享账号可产生多个 token，但 token 不属于分析身份，也不得进入事件、日志、Kafka 或 ClickHouse。

## 3. 拒绝码

| 拒绝码                       | 含义                                                   |
| ---------------------------- | ------------------------------------------------------ |
| `SCHEMA_INVALID`             | 缺失字段、未知字段、格式或条件约束不满足               |
| `SCHEMA_VERSION_UNSUPPORTED` | 服务端不支持该 `schemaVersion`                         |
| `BATCH_TOO_LARGE`            | 批次超过 64 KiB                                        |
| `BATCH_EVENT_LIMIT_EXCEEDED` | 一批超过 50 个事件                                     |
| `EVENT_TOO_LARGE`            | 单事件超过 8 KiB                                       |
| `EVENT_NAME_INVALID`         | 事件名称不符合标准或自定义命名规则                     |
| `DUPLICATE_EVENT_ID`         | 同批次内存在重复事件 ID                                |
| `EVENT_TIME_OUT_OF_RANGE`    | 客户端时间超出允许偏差                                 |
| `CREDENTIAL_DATA_REJECTED`   | 字段名或值疑似包含 token、Authorization、cookie 等凭证 |

错误响应只能返回字段路径和拒绝原因，不得回显疑似凭证值。

## 4. 兼容与变更策略

- v1 是当前首个版本，因此服务端目前只接受 `schemaVersion=1`。
- 新增可选字段且不改变旧语义时，更新 Schema、fixtures 和生成类型，但不改变版本号。
- 删除字段、改名、改变必填性、类型或事件语义属于破坏性变更，必须增加 `schemaVersion`。
- 引入 v2 后，服务端至少同时接受当前版本 v2 和前一版本 v1；SDK、ingestion 与 consumer 必须使用同一组版本化 validators。
- 停止接受旧版本前，需要先验证 SDK 版本分布，并给出升级窗口和拒绝量监控。

## 5. 修改流程

1. 修改 JSON Schema；
2. 增加或更新 valid/invalid/golden fixtures；
3. 执行 `pnpm contract:generate`；
4. 执行 `pnpm check`；
5. 在 PR/变更记录中说明兼容性影响。

`pnpm contract:check` 会阻止 Schema 与生成类型不一致。三类 fixture 会分别经过 producer、ingestion 和 consumer 边界验证，避免各层自行解释协议。
