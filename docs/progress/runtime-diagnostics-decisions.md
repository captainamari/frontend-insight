# 运行时诊断决策记录

## D0（2026-10-10）

依据：Jesse 本次实施授权、ADR-021 和已批准开发计划。基线为 `refactor` 的 `8ff28a6140f62d8376d84a0a2e56fb93a5ff1b1e`。不实施 D1–D7，不自动合并或操作生产。

| 决定               | 实施与理由                                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保持 contract v3   | 增加可选的顶层 `event.diagnostic`，独立 `diagnosticVersion: 1`。生成源与生成物一起更新；没有扩展的旧 SDK 数据不变。旧服务不认识新字段，必须先升级存储、consumer/API，再启用新 SDK。                                                                                                                             |
| 原文与派生字段分离 | 只有精确位置 `events[i].diagnostic.raw` 豁免递归凭据扫描。信封元数据、基础 payload、项目、事件结构、大小继续验证。原文不复制进 `raw_events.payload_json`。原有 collector 保持历史行为，D1 再统一提取。                                                                                                          |
| 传输容量调整       | 保留基础事件 8 KiB；信封 64 KiB UTF-8；批次从 64 KiB 调至 128 KiB，避免信封加基础事件后永远无法发送。50 事件上限不变，API/ingestion/Nginx 一致。Kafka topic 256 KiB（含服务端 enrichments），broker 1 MiB。这只增加封装余量，不扩大原文预算。                                                                   |
| 客户端生命周期     | 正常 flush 按 128 KiB 拆批；大于 60 KiB 的批次不用 Beacon/keepalive，使用普通 fetch。接入方应主动 await flush；不保证浏览器关页时完成大批次传输。没有虚构持久离线队列。                                                                                                                                         |
| 有限原文           | 整信封 64 KiB，保留 stack/cause/console/request 子预算常量与校验。最小入口超限以 `too_large` 空原文信封保留基础错误；不会悄悄截断。精细优先级裁剪、不可序列化对象提取、console 回溯由 D1–D3 实施。                                                                                                              |
| 限流与幂等         | SDK 按页面窗口最多 20 个；服务端用 MySQL 项目锁和页面分钟桶再次限制，多 API 实例共享。超限事件仍发布并计入基础错误，只把详情改为 `rate_limited`。同 project/event 重投复用摘要、准入与到期时间；内容冲突 409。                                                                                                  |
| 故障一致性         | 基础事实先写，详情后写，最后提交 Kafka offset。详情失败写 `write_failed` 并重试；已有质量/聚类查询按 eventId 去重。详情 ReplacingMergeTree + FINAL 处理写成功但回执失败；不采用双库分布式事务。原文不写 MySQL 状态表。                                                                                          |
| TTL                | 明细默认 14 天，项目策略可设 1–90 天，仅影响新准入事件。API 到期立即拒绝返回原文，ClickHouse 后台 TTL 物理删除；状态墓碑在到期后再保留 90 天，清理每次活跃 consumer 批次最多每分钟一次。                                                                                                                        |
| Kafka 保留期       | 事件 topic 显式限制为 24 小时、segment 1 分钟，避免最短 1 天项目策略下原文在 broker 默认 7 天队列中继续保留。**影响：整个事件 topic（含基础事件）的故障重放窗口缩短到约 24 小时**；部署时应检查消费延迟，超过窗口可能丢失未消费基础事件。物理删除仍受 broker 清理周期影响。既有 ClickHouse 统计 90 天保留不变。 |
| 权限               | 当前账户 active + 当前项目关系 + 显式 read；export 必须同时 read。平台 admin 也重新读当前数据库角色。成员移除级联删除授权，重加成员不会恢复旧权限。现有外部 token/public appId 不提供读取权限。                                                                                                                 |
| 管理与审计         | 提供 admin-only grants/policy 后端，写入和成功审计同 MySQL 事务。读及拒绝审计保存 actor/project/event/action/result/time，不含正文。未登录/外部 token 由 AuthGuard 拒绝并记录匿名结果。详情所有响应 no-store；无 D4 导出端点、无 D6 设置 UI。                                                                   |
| 浏览器及 CI 预算   | D0 专项 Chromium/WebKit 各一条 SDK 全链路；继承 R5-A/B 浏览器与统计回归；job 上限 45 分钟，重试 0。Firefox 在 D1 加 Chrome/WebKit/Firefox 栈格式 fixture，D7 再评估真实 Firefox专项，不声称现在执行过 Firefox。仅上传小型 JSON 证据，保留 7 天，无 trace/body/log artifact。                                    |

## 历史断言调整

- 不删除历史脱敏/项目隔离/日志负向测试。旧采集器未迁移到新信封，现有测试继续适用。
- 新诊断字段单独新增原文一致性正向测试；把原文放回普通 payload、冒充别的位置、改变元数据、跨 appId 仍拒绝。
- 迁移清单由 MySQL 1–7 / ClickHouse 1–4 增加到 1–8 / 1–5；原升级脚本预期新增版本 8，不修改旧 SQL/checksum。
- 页面摘要仅新增公开关联 `eventId`，原文仍不进入列表；不会用详情缺失推断基础错误不存在。
