# ADR-014：规范名、contract v3 与 MetricCatalog key

- 状态：Accepted
- 日期：2026-08-21
- 对应基线：requirements-v1.8、mvp-plan-v1.5 R0

## 决策

`packages/event-contract/canonical-names.json` 是公共字段、事件枚举、受控 custom 名、指标 key、路由、API 名和时间范围的唯一机器可读事实来源。TypeScript 类型、JSON Schema、系统指标 seed 和规范名表均由该文件生成，CI 使用生成物校验和旧名扫描阻止漂移。

浏览器到 consumer 只接受 contract v3。公共字段使用 `appId/event/timestamp/deviceId/userId/pageRoute/payload`，每个事件都必须携带 `env/release/pageUrl/deptId/roleId/ua/os/browser`；`event` 仅允许 `page_view/page_leave/performance/api/error/custom`。具体功能与 workflow 动作放入受控 `custom.payload.name`。v1/v2、旧字段、旧 event alias 和旧 metric key 不做 alias、双读、normalizer 或回填。

SDK breaking 版本为 `0.4.0`。`userId` 在浏览器端只能是非敏感不透明引用，ingestion 在 Kafka 前执行项目域 HMAC；URL 去 query/hash，payload 使用白名单结构。

## 后果

这是 Pre-1.0 空数据重置。历史文档、差异说明、manifest 禁止清单和负向 fixture 可以引用旧名，运行时代码、SQL、API fixture 和 UI 绑定不可以。未采集的附件指标保留 key 并标记 `not_collected`，不得用近似值冒充。
