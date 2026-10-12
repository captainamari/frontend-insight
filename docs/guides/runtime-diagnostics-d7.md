# D7 工程验收与发布准备（进行中）

基线 D6 #35 已合入 refactor `590c17b6e25ff3d002355705a5009a70e5d8473c`。分支 `agent/runtime-diagnostics-d7-acceptance-cleanup`，Draft PR #36。本页为执行检查点，不是成功交付证明。Jesse 手工验收和实际发布批准均待确认。

## 完成矩阵

| 原任务           | 基线实现/证据                                               | 本批缺口/修改                                           | 验证命令                                                               | 当前状态                 |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| 1 字段一致性     | D0 transport、D1 error、D2 console、D3 request、D4详情/导出 | 最终候选重跑；逐场景与UI断言复核                        | diagnostics config 全部 spec、verify-d0                                | 进行中                   |
| 2 浏览器         | Chromium/WebKit 真链路；Firefox 栈 fixture                  | 同代码重跑，不以适配器fixture替代真实框架               | diagnostics config；pnpm test                                          | 待最终结果               |
| 3 权限与隔离     | D0身份、D4搜索导出、D5 map、D6设置维护                      | 最终候选入口与元数据泄漏复验                            | verify-d0、各诊断spec、d0-log-check                                    | 待最终结果               |
| 4 性能容量       | 12KiB / 同步2ms / 接收100ms / 可见5min / 查询2s             | 正常/异常20/200 eps、多客户端合成负载、查询p95与存储    | node tools/d7-load.mjs、console/requests specs、pnpm build             | 进行中；不得倒推门禁     |
| 5 故障恢复及继承 | D0增量与写失败；D5/D6破坏恢复；R8恢复                       | 复用全部R1–R8入口；Ubuntu22同候选隔离部署               | D7-products workflow、d7-fault、d5-storage-verify、production workflow | 待最终结果               |
| 6 手工场景       | 实验室已有错误/Promise/503/资源/日志/源码/策略              | 真实浏览器复验及下面最短路径                            | diagnostics config 全部 spec                                           | 等待Jesse                |
| 7 发布证据       | D0–D6历史结果                                               | 三workflow同SHA汇总，下载核对证据，中文交接             | workflow jobs/artifacts                                                | 尚未完成                 |
| 8 仓库清理       | 根目录阶段配置重复占据入口                                  | 16配置迁入tests/config并更新调用/文档；保留有效历史入口 | pnpm check、Playwright --list、最终干净checkout CI                     | 已改结构；最终验证待完成 |

## 测量前冻结的门禁与方法

原 requirements-v1.8 性能表规定基础 SDK gzip ≤12 KiB、同步处理 p95 ≤2ms、接收 p95 ≤100ms、数据可见 p95 ≤5分钟、核心查询 p95 ≤2秒。D7沿用，不提高预算。详情/搜索/导出/维护分别以2秒作为本批目标；详细字段与SourceMap解析继续受既有预算。CI资源与生产不同，结果仅适用于报告注明的环境。

`tools/d7-load.mjs`仅固定本机隔离Compose，正常/异常各20eps持续60秒和200eps持续10秒。每组新项目，3次预热排除；异常内容均为合成256/2048/16384/60000字节padding，精确事件大小另记。每组eps×3客户端固定页面轮转，60秒每页面最多20条，没有绕过服务端准入。目标速率按实际完整窗口计，完成超时记录负载生成器失败。记录发送/接收/持久化、请求数、nearest-rank p95、精确基础事件ID与去重、receipt状态。数据库收据时间为持久化延迟；完整查询可见时间为保守上界，不混成HTTP响应时间。

容量逻辑字节来自隔离项目的有效JSON。它不是共享磁盘精确占用，也不是生产容量承诺。D6维护页有界样本不升级为全量统计；压缩比、保留期、备份空间和待物理清理必须分别说明。尚未获得最终容量结果。

## 最短手工验收

1. 按D6指南以管理员启用隔离项目策略，授权工程师viewer read+export；普通viewer只能看统计。
2. 实验室依次触发TypeError、Promise、Vue框架捕获、日志后错误、503（应用已读取响应正文）、超时/取消/网络失败和资源失败。错误组→实例核对具体message/name/原始栈、cause、console顺序、URL参数、503正文和显式关联。没有显式ID的关联只能称时间邻近。
3. 按D5指南通过正式CLI上传压缩构建map，核对固定源码位置；错release、缺map、无sourcesContent保留编译栈并准确降级。
4. 稳定链接刷新，切换env/release/时间窗，复制和导出；HTML样本只显示文本。撤权后旧页面与导出链接再次请求均应拒绝。
5. 策略关闭→SDK同步→停止collector；离线旧SDK被服务端拒收，基础计数保留。恢复启用后不重复计数。维护页展示健康/容量口径，删除指定eventId后详情/搜索/导出不复活。
6. 记录实际eventId、具体字段、预期/实际与截图；只有Jesse明确确认后才登记手工验收通过。

## 发布、升级与恢复边界

执行入口见 [D6指南](runtime-diagnostics-d6.md)、[D5指南](runtime-diagnostics-d5.md)。先隔离入口和备份→验证增量迁移001–011→consumer/API/UI→配套可选SDK；保留数据库及私有SourceMap卷，不修改已应用迁移。旧SDK仍可发基础事实。旧服务不认识墓碑时不得重新开放原文入口。

真实恢复必须执行备份→破坏→恢复→API/UI/源码复验。旧备份可能恢复旧授权、凭证及已删数据；开放前补执行备份后的撤权与删除，不承诺自动保留备份后状态。待本批最终门禁完整成功后才可给出工程交付结论；当前不建议发布。

当前发布脚本入口（仅在独立环境演练；生产执行仍需Jesse实际批准）：

```bash
bash scripts/production doctor
bash scripts/production backup pre-d7
bash scripts/production deploy d7-candidate
bash scripts/production verify
bash scripts/production status
```

隔离对外入口后才可执行`bash scripts/production restore pre-d7 --confirm-replace-data`；核对并补执行备份后撤权/删除，再开放流量。回滚入口为`bash scripts/production rollback <已保留release-id> --confirm-rollback`，不down-migrate；不支持墓碑的旧服务须保持原文入口关闭。Ubuntu22恢复CI实际停止TLS边缘，逻辑行摘要一致后再开放；该演练无备份后授权变更，不冒充已自动对账现实中的后续撤权。

本批新增`node tools/d7-fault.mjs`实际停止隔离MySQL，检查准入失败、维护不可用不为零，恢复后同eventId投递两次只保留一条基础事实且原文一致。Kafka/consumer/ClickHouse实际停机恢复继承R8门禁；各自与单测故障注入分开记录。
