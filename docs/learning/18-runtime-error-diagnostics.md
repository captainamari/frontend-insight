# 18. D1–D5 运行时诊断维护路径

先阅读 ADR-021 与 D0–D5 接入说明。本章按批次解释错误原文、console、请求关联、搜索导出与SourceMap。前序章节保留当时的范围边界，最新实现及真实CI状态统一以[诊断结果](../progress/runtime-diagnostics-results.md)为准；D6已实现且PR #35已合入；D7同SHA自动化工程验收已通过，Jesse手工验收和生产发布批准待确认。

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
pnpm exec playwright test -c tests/config/playwright.diagnostics.config.ts
```

真实服务前置见 D1 指南。专项 CI 继承 D0 迁移、六身份、故障、TTL、日志/DLQ与 R5-A/B 真实分母回归。测试 fixture 路由只提供 SDK/合成业务场景，后端 ingestion/Kafka/consumer/数据库/API/管理页面为真实服务。

基础包保持 12 KiB gzip 门禁，errors 为显式可选入口；报告须同时给出基础、errors、quality 和实际组合总量。errors 提取 p95 在 Chromium/WebKit 测量，不把 Node 单测耗时当真实浏览器性能。Firefox 只测栈格式；D7已在隔离CI完成压力和破坏恢复，生产容量仍须按目标环境验证。

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

验证：`pnpm exec vitest run packages/web-tracker/test/console.test.ts`；真实链路 `pnpm exec playwright test -c tests/config/playwright.diagnostics.config.ts`。D0 真实权限/TTL/故障 fixture 也含 console 原文，继承的负向检查不删除。性能数据是同步局部测量，D3 请求关联、D5 SourceMap、D7 完整发布验收仍需分别实施。

## D3：请求证据与显式关联

阅读顺序：`web-tracker/src/request-evidence.ts` → `requests.ts` → event-contract生成源/diagnostics/validator → server-core/error-stack → `RequestTimeline.vue` → requests.test/spec。接入见 [D3指南](../guides/runtime-diagnostics-d3.md)，实测状态以results为准。

- 请求证据不产生第二份API分母或JS错误；quality观察、operation/workflow事实继续各自原合同。503仍是fulfilled；200业务失败必须应用提供依据。
- 不通过clone/tee后台读取正文，避免无限流/不可信长度和另一分支缓冲风险；应用提供已读取原始文本，SDK只做有限前缀快照，不能以重新序列化JSON伪装原文。零读取任务不等于应用自身没有读取开销。
- 区分发起/响应/正文/异常四个时点。异常即时冻结，pending是当时事实，晚回调按本地ID查找仍在同页缓冲的记录，不回写历史信封。
- getContext只暴露SDK真实operation/workflow实例ID，bind固化显式参数。同名step不足以说明因果；没有明确依据显示时间邻近，本地观察ID不是服务端requestId。
- 同时检查字段、单条、集合、总信封和raw归属。服务端验证生成源和预算函数必须一起维护，不能换一个数组名绕过raw.request旧预算。
- 单测关注Promise/响应/错误身份、this、原参数、访问器不执行、并发/跨页/销毁、JSON转义与容量；真实浏览器再验证HTTP/opaque/SSE取消与全服务链路。普通响应、日志、审计、DLQ仍不含原文。

D3不包含D4产品检索导出、D5源码映射或D7长期压力。上一节D2的后续说明保留为历史交接，当前进度以结果记录为准。

## D4：查询、协作与统计维护

阅读顺序：`server-core/src/diagnostic-search.ts` → `runtime-diagnostics.ts` → API `diagnostics.controller.ts` → `DiagnosticSearch.vue` / `DiagnosticDetail.vue` → `PageQualityStore.groupStats` / `DiagnosticImpact.vue`。指南与预算见 [D4](../guides/runtime-diagnostics-d4.md)。

搜索从基础事实有界选候选，再查未过期ready receipt与ClickHouse信封，搜索词只在服务内匹配解码字符串，不进入SQL/日志/URL；授权在读前与返回前重新检查。查询返回预算失败时不能改为空数组。测试应覆盖当前页以外命中、同时间戳分页、预算拒绝与过期原文排除。

导出走即时POST和StreamableFile，read+export都必要。`storedEnvelopeJson`是已存文本，`diagnostic`和`view`分别是解析对象与派生展示；不能用格式化对象冒充采集时字符串。前端下载使用同一会话刷新机制，blob及时释放，generation和AbortController防止旧范围异步结果回写。

稳定实例路由不依赖列表窗口，API按项目/eventId定位并返回基础上下文；不存在和未启用必须不同。质量计数/影响仍读取原基础事实，先eventId去重，再user_id/device_id/page_route统计；诊断采样、TTL、写失败不参与计数过滤。历史首次只是当前90天保留窗口最早事实。

回归入口：`diagnostic-search.test.ts`、`diagnostics-d4.controller.test.ts`、`runtime-diagnostics-integration.ts`、`tests/runtime-diagnostics/troubleshooting.spec.ts`，真实服务由Runtime diagnostics D4工作流执行。不存在Docker时不得把本地单测称为全链路验证。

## D5：源码映射维护路径

按 `tools/build-d5-fixture.mjs` → `tools/sourcemaps.mjs` → API `sourcemaps.controller.ts` → `server-core/src/sourcemaps.ts` → `sourcemap-parser.ts` / `sourcemap-worker.mjs` → `RuntimeDiagnostics.read/exportEvidence` → `DiagnosticDetail.vue` 跟读。精确权限、失败码、预算、身份与恢复操作见 [D5指南](../guides/runtime-diagnostics-d5.md)。

练习：把固定build或JS校验和改错，观察版本/校验失败但编译栈与基本次数仍在；去掉sourcesContent，验证位置成功而片段不可用；删除私有文件，确认storage_missing，然后通过实际隔离恢复脚本恢复位置。不要从URL或本地源码目录自动补读。解析worker只接收已授权的有界map字符串与行列，不能执行上传代码。数据库只存元数据/凭证hash，map与诊断原文走私有存储。

维护重点：URL origin/query不得为了方便匹配而删除；同身份不同内容不覆盖；SDK基础包无解析依赖；逐帧状态包括cause/子错误；read不等于export；无缓存不代表可以省掉异步返回前权限/文件状态复核。运行恢复验证只允许隔离栈，不把脚本存在或单测通过称为恢复成功。

D5维护基线：`8d7a8f3dd5e40db3e662e226cfe7b1698fea7470`；[完整专项验证](https://github.com/captainamari/frontend-insight/actions/runs/38199033567)与[隔离Ubuntu22生产配置验证](https://github.com/captainamari/frontend-insight/actions/runs/38199033462)已成功。实际生产与Jesse手工验收不在这些自动化结论内。

## D6 从配置到维护的源码阅读

读取`DiagnosticSettings.vue`→`DiagnosticsController`→`DiagnosticOperations.publish`事务及revision；随后看`IngestionController.workflowConfig`的公开配置投影→可选SDK`policy.ts`交集及生命周期→`RuntimeDiagnostics.admit`最新服务端准入→consumer.persist→receipt延迟与维护页。诊断失败不删除基础raw_events。

删除链路从明确eventId到持久墓碑；并发读取返回前复核、晚到consumer不将receipt改回ready、后台mutation物理回收。对照`policy.test.ts`与真实浏览器`policy.spec.ts`，再读D5恢复脚本中的D6策略/撤权/墓碑破坏恢复断言。不能从脚本存在推断执行通过。接入、观测口径、回滚及旧备份限制见[D6指南](../guides/runtime-diagnostics-d6.md)。

## D7维护入口

最终工程验收入口为[D7指南](../guides/runtime-diagnostics-d7.md)，目录变更依据见[清理记录](../progress/runtime-diagnostics-d7-cleanup.md)。最终运行代码`709db4bb9f66a178cb0e58d7a1bbf23423b5dc05`已通过D7专项、R1–R8继承回归及Ubuntu22隔离部署/恢复；维护时仍须以新候选同SHA复验，不能沿用本次成功。网络/5xx重试耗尽后保留有界内存事件，恢复后flush以原eventId投递；永久4xx不重试，关页后没有持久离线队列。测试实际挂载Vue树的错误事件与适配器fixture是两种证据，Firefox当前只栈fixture。详情中的错误、栈、console、请求和SourceMap源码由安全token组件展示，必须使用文本节点而不是`v-html`；行号/着色不进入复制或导出原文。
