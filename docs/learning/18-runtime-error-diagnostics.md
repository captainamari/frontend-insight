# 18. D1 运行时错误诊断维护路径

先阅读 ADR-021 与 D0/D1 接入说明。本章只解释错误原文闭环，D2 console、D3 请求关联、D5 SourceMap 尚未实现。

## 从浏览器到页面

| 位置                                             | 负责什么                                                             | 修改时检查什么                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `web-tracker/src/observability.ts`、`quality.ts` | 全局、Promise、资源与显式入口                                        | 不再分别实现原文提取；生命周期、采样元数据和质量分母不丢                            |
| `web-tracker/src/tracker.ts` reportError         | 汇合两条路径，调用可选提取器；沿用 captureDiagnostic 准入和信封限流  | 一次错误只产生一个基础事件；详情抑制不能减少基础错误                                |
| `web-tracker/src/errors.ts`                      | 原文快照、循环/访问器处理、UTF-8/JSON预算、身份去重、Vue/React适配器 | 不执行自定义 getter/toJSON；不修改原错误，不把派生消息覆盖 raw；原生 stack 单独识别 |
| `event-contract/src/diagnostics.ts` 与生成合同   | D0 信封预算；只允许指定 raw 豁免内容过滤                             | 不全局取消敏感内容检查；不直接修改生成物                                            |
| pipeline → Kafka → consumer                      | 继承 D0 发布、事实/详情分离与重试                                    | `raw_events` 与 DLQ/日志不保存诊断正文                                              |
| `server-core/src/runtime-diagnostics.ts`         | 当前成员/能力、审计、TTL、受限实例读取                               | 原文前授权；历史 fallback 也在同一授权后；API no-store                              |
| `server-core/src/error-stack.ts`                 | 保留原文，派生编译帧和解析状态                                       | HTTP/相对路径、Chrome/WebKit/Firefox fixture；失败不丢事件；不远程抓 SourceMap      |
| `web/src/components/DiagnosticDetail.vue`        | 按需详情、展开/复制、访问续验与清理                                  | scope变化/关闭/失焦清空；复制重新授权；只用文本插值；过期清空                       |
| `demo-app/src/App.vue`                           | 实际 Vue handler 与 throw/Promise/显式/资源失败场景                  | 合成 fixture；React 是显式适配器演示，不冒充挂载 React                              |

## 四层状态不要混用

1. **采集**：capture.status = complete/truncated/rate_limited/too_large/unavailable；issues 是具体字段不可读/截断原因。
2. **存储**：state = pending/ready/write_failed/expired/not_enabled/unavailable；pending 不等于没有基础错误。
3. **解析**：view.stack.state = parsed/partial/parse_failed/unavailable/not_applicable；原始编译栈始终独立保留。
4. **访问**：HTTP 401/403 在 UI 表现为 forbidden；未授权响应不带正文。项目列表权限不等于 diagnostics.read。

## 常见维护练习

- 找到一个原文 Error，比较 SDK 出站信封、诊断表、受限 API diagnostic 与页面消息。原文应一致，普通 payload 与列表不能含 fixture 标记。
- 把 stack 改为非标准格式：错误仍入库，页面显示 parse_failed 并保留原文。不要通过返回空列表伪装未采集。
- 同消息创建 25 个独立 Error：基础错误 25 个，完整详情最多 20；不要把 fingerprint 去重当采集限流。
- 同一个 Error 在框架处理器后继续传播到全局：当前任务只计算一次。不要跨页面维护一个长期消息去重表。
- 打开 viewer 详情后撤权、移除成员或切换项目：检查 API 拒绝、旧响应竞态、正文清理、复制再授权。能力每秒核对，无推送式瞬间擦除承诺。
- `raw_events` 历史摘要可能早已脱敏；legacy=true 明示这一点，不能推测原始 token 或补造栈。

## 验证与体积

```bash
pnpm exec vitest run packages/web-tracker/test/errors.test.ts packages/server-core/test/error-stack.test.ts
pnpm check
pnpm exec playwright test -c playwright.diagnostics.config.ts
```

真实服务前置见 D1 指南。专项 CI 继承 D0 迁移、六身份、故障、TTL、日志/DLQ与 R5-A/B 真实分母回归。测试 fixture 路由只提供 SDK/合成业务场景，后端 ingestion/Kafka/consumer/数据库/API/管理页面为真实服务。

基础包保持 12 KiB gzip 门禁，errors 为显式可选入口；报告须同时给出基础、errors、quality 和实际组合总量。errors 提取 p95 在 Chromium/WebKit 测量，不把 Node 单测耗时当真实浏览器性能。Firefox 只测栈格式；完整 D7 压力/备份恢复未完成。

后续 D2 入口：在此有界原文和访问通道上添加 console 环形缓冲、采集/销毁包装及 UI，不改变基础错误计数；以运行时诊断计划中的 D2 清单为准。
