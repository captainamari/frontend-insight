# 18. 运行时错误与 console 诊断维护路径

先阅读 ADR-021 与 D0/D1/D2 接入说明。本章解释错误原文及 console 上下文；D3 请求关联、D5 SourceMap 尚未实现。D2 最终验证状态以结果文档为准。

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

后续 D3 入口：D2 合并后从最新 refactor 开始请求、操作与工作流关联；不改变原文权限和基础计数。

## D2：从前置日志学习快照与生命周期

D2 已新增 console 实现（最终验证状态以 results 为准）。接入和边界见 [D2 指南](../guides/runtime-diagnostics-d2.md)。

1. `console.ts` 的共享 hub 负责方法包装、receiver/参数/返回/抛错及恢复所有权；每订阅者独立缓冲，明确 appId 作用域，冲突清空。它没有事件监听或网络发送。
2. `console-snapshot.ts` 通过 descriptor 读取数据属性，拒绝业务 getter/toJSON，使用节点/深度/条数/序列化字节预算。编写新对象类型支持前先决定是否会触发业务函数；不可读不是空对象，也不能声称原始字节完整。
3. `ErrorExtractor.start` 由 tracker 生命周期初始化，返回 cleanup；异常仍经 reportError → D1 提取和去重 → captureDiagnostic → D0 限流及结构校验。console 回溯在提取前冻结，框架处理器的后续日志属于后续异常的上下文。
4. 比较两次相同对象日志、日志后修改对象、连续异常、重试，以及导航后 pageView：每个位置应持有哪个时刻的数据？用 console.test.ts 的实际断言回答，不靠深拷贝这个名词推断正确性。
5. `diagnosticErrorView` 只在已授权详情通道追加 console view；`DiagnosticDetail.vue` 展示/过滤/复制，但不负责批准访问。原文的服务端权限、撤权、TTL 与无缓存仍在 D0/D1 层。
6. `scripts/build-bundle.mjs` 明确压缩的只有 private 生命周期成员白名单；公共 API/字段不得加入。console 使用共享 errors 模块，体积报告同时计量各模块与实际组合；不要只看基础包。

排错时依次看：接入是否启用 → scope 是否冲突 → 配置级别/页面/窗口 → 实际 records/预算说明 → 信封采集状态 → 存储状态 → 当前访问权限 → UI 过滤条件。不要把“debug 没有显示”直接解释为采集故障。

验证：`pnpm exec vitest run packages/web-tracker/test/console.test.ts`；真实链路 `pnpm exec playwright test -c playwright.diagnostics.config.ts`。D0 真实权限/TTL/故障 fixture 也含 console 原文，继承的负向检查不删除。性能数据是同步局部测量，D3 请求关联、D5 SourceMap、D7 完整发布验收仍需分别实施。
