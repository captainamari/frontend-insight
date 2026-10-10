# D0 运行时诊断接入与升级

D0 只提供基础传输和受限 API。旧 captureException/quality collector 尚未统一；不要同时为同一错误调用旧 captureException 和 captureDiagnostic，否则是两条不同事件。D1 才接通现有全局/框架采集器与完整错误提取。

## 最小 SDK 接入

```ts
tracker.captureDiagnostic({
  diagnosticVersion: 1,
  contentType: "application/json",
  source: "explicit",
  policyVersion: "d0-1",
  status: "complete",
  omittedBytes: 0,
  suppressed: 0,
  correlation: { requestId: "req_synthetic" },
  raw: {
    message: "token=synthetic\nsecond line",
    stack: "Error: synthetic\n at synthetic.js:10:2",
    url: "https://fixture.invalid/path?token=synthetic",
    nested: { value: "原样保留" },
  },
});
await tracker.flush();
```

只传入 JSON 可序列化、已取得的诊断对象；不主动读取浏览器凭证存储、DOM 或其他标签页。入口发出一条独立基础 JS error，派生字段为通用分类；原始 message/stack 在 raw 内保持原值。细分聚类/现有采集器统一属于 D1。原文仅在指定 raw 槽位免内容过滤；beforeSend 可以拒绝整事件，但不能篡改诊断扩展、身份或关联。旧非诊断 payload 仍受历史验证。

64 KiB UTF-8 信封，基础事件另限 8 KiB。保留字段 `raw.stack` 或 `raw.error.stack` 最多 16 KiB/32 帧；cause 最深 4；`raw.console` 最多 50 条/24 KiB/条 2 KiB；`raw.request.requestBody/responseBody` 各 16 KiB，`requestHeaders/responseHeaders` 各 4 KiB。完整 console 时间窗口、对象快照与裁剪在 D2/D3 实施。超限最小入口仍发送基础错误，详情状态 too_large；D0 不伪装完整采集。

批次 128 KiB/50 事件自动拆分，每页面每分钟最多 20 个完整信封。详情受限不删除基础错误。大批次使用普通 fetch，不承诺关闭页面时仍能送达，应在业务空闲时 await flush。服务器的按项目共享准入保护多实例，不能依靠修改客户端配置绕过。

## 管理与读取

使用平台登录 accessToken；appId 与外部接口 token 都无原文读取权。

| API                                                           | 用法                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/projects/:projectId/diagnostics/grants/:userId`     | admin；JSON `{ "read": true, "export": false }`。用户须已是项目成员。设置 false 撤权；移除成员时删除旧授权。                 |
| `PUT /api/projects/:projectId/diagnostics/policy`             | admin；JSON `{ "retentionDays": 14 }`；1–90，影响之后准入的详情，不回填历史。                                                |
| `GET /api/projects/:projectId/diagnostics/capabilities`       | 返回当前 read/export；没有导出产品接口。                                                                                     |
| `GET /api/projects/:projectId/diagnostics/instances/:eventId` | 原文受限读取；eventId 来自 SDK 发送或质量实例列表。返回 `state` 与不含 raw 的 `capture` 元数据，仅 ready 携带 `diagnostic`。 |

`pending` 是已准入尚未完成写入；`write_failed` 是写入失败正在重试；`rate_limited/too_large/unavailable` 表示详情缺失原因；`expired` 已到期；`not_enabled` 表示没有诊断接收记录（历史事件/未附带扩展），**不表示没有错误**。403 是没有当前项目原文权限，401 是登录无效。所有读取禁止共享缓存，审计不保存正文。策略管理不向 viewer 开放。

## 发布、备份与回滚

1. 发布前备份 MySQL 和 ClickHouse，包括新增 grants/policies/receipts/audit 与 diagnostic_details。备份含原文，访问应限定运维账户；离线备份保留与删除由部署方设置，在线 TTL 不会擦除已有备份。
2. 暂不启用 SDK 新入口，按现有迁移命令 `pnpm migrate` 执行 MySQL 008–009 / ClickHouse 005。只新增表，不改旧迁移，不 reset/seed。可重复执行；适用于已有数据。
3. 部署新 consumer，再部署 API 和代理，再启用新 SDK。旧 API/consumer 的 v3 schema 会拒绝新可选字段；不能先发新信封。滚动切换前要确认所有 consumer 实例升级。
4. API/ingestion/代理 128 KiB，Kafka topic `max.message.bytes=262144`、broker 1 MiB；topic 原文队列保留 24 小时、segment 1 分钟。沿用部署 Compose 的 kafka-topics 初始化步骤更新已有 topic。**该队列调整同时缩短基础事件的故障重放窗口，必须保证消费延迟小于 24 小时**。详情默认保存 14 天，统计仍沿用 90 天。
5. 逻辑 TTL 在读 API 即时生效；ClickHouse TTL 和 Kafka segment 清理是异步物理删除。缩短策略不追溯旧记录；D6 再补主动删除与完整运营 UI。备份恢复后仍由原 expires_at 决定是否可读，不能用恢复时间延长 TTL。
6. 回滚先禁用 SDK 新入口并清空客户端待发数据，等待 Kafka 新信封消费完毕，然后回滚 API/consumer。数据库新增表保留即可；不需要删除表或旧数据。未消费新信封不能交给旧 consumer，否则会进 DLQ。回滚后旧 SDK/指标仍可运行，新原文不可由旧 API 访问。
7. 执行恢复演练时恢复 MySQL receipt 与 ClickHouse detail 的同一备份时间点；只恢复一侧会出现 unavailable/pending，不伪造成完整详情。D7 再做完整备份恢复验收，本批不声称已经执行。

专项验证只用合成 fixture，详见 results。Firefox 暂无真实浏览器覆盖；D1 栈格式 fixture、D7 再决定真实浏览器成本。
