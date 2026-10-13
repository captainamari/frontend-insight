# D7 工程验收与发布准备

基线 D6 #35 已合入 `refactor` 的 `590c17b6e25ff3d002355705a5009a70e5d8473c`。D7 分支为 `agent/runtime-diagnostics-d7-acceptance-cleanup`，Draft PR 为 [#36](https://github.com/captainamari/frontend-insight/pull/36)。最终运行代码候选为 `73f5da8d273d5c730e3bc2e974f6301fc07ce91d`；自动化工程验收已经完成，Jesse 手工验收和实际发布批准仍待确认。

## D7 完成矩阵

| 原任务           | 当前实现/证据                                                | 本批修改                                                                               | 验证入口                                               | 状态                                     |
| ---------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| 1 字段一致性     | D0 transport、D1 error、D2 console、D3 request、D4 详情/导出 | 补真实 Vue、离线恢复、最大信封、故障重试及最终候选逐字段复验                           | Runtime diagnostics D7；D0–D6 全部浏览器 spec          | 自动化通过                               |
| 2 浏览器         | Chromium/WebKit 真链路；Firefox 栈 fixture                   | 同 SHA 重跑真实框架、完整产品流及生产恢复                                              | D7、D7 products、Ubuntu 22.04 三个 workflow            | Chromium/WebKit 通过；Firefox 仅 fixture |
| 3 权限与隔离     | D0 身份、D4 搜索导出、D5 map、D6 设置维护                    | admin/read+export/read/viewer、跨项目、撤权、旧 token/appId/上传凭证及日志隔离复验     | role matrix、D4/D5/D6 spec、privacy/log gate           | 自动化通过                               |
| 4 性能容量       | 12 KiB、同步 2 ms、接收 100 ms、可见 5 min、查询 2 s         | 持续 20/200 events/s、多客户端、四档原文、查询/存储/SourceMap 实测；修复策略重复写热点 | `node tools/d7-load.mjs`、浏览器同步测量、bundle build | 硬门禁通过                               |
| 5 故障恢复及继承 | D0 增量/写失败；D5/D6 恢复；R8 恢复                          | MySQL 实停恢复、Kafka/consumer/ClickHouse 恢复、001–011 增量升级、破坏恢复和保留卷重启 | D7 fault/storage、D7 products、Ubuntu production       | 自动化通过                               |
| 6 手工场景       | 实验室包含错误、Promise、503、资源、日志、源码、策略         | 自动化逐字段复验并提供下面最短人工路径                                                 | diagnostics 全部 spec；Jesse 按本页复验                | 自动化通过；人工待 Jesse                 |
| 7 发布证据       | D0–D6 历史结果                                               | 三 workflow 同 SHA、可下载小型证据、中文交接、发布/回滚步骤                            | 本页及 results 的 run/artifact 清单                    | 工程证据完成                             |
| 8 仓库清理       | 根目录阶段配置重复占据入口                                   | 16 个配置迁入 `tests/config/`，同步脚本/CI/文档；核实保留历史入口                      | clean checkout 安装、check、双浏览器、Docker/恢复 CI   | 清理后通过                               |

## D0–D7 最终状态

| 批次 | 实现状态                                | 最终入口                                     | 人工状态                            |
| ---- | --------------------------------------- | -------------------------------------------- | ----------------------------------- |
| D0   | 已合入；合同、受限存储与访问            | D7 的 D0 升级/身份/日志/双浏览器回归         | 不以历史合并代填人工通过            |
| D1   | 已合入；可定位错误与框架适配            | D7 的 D1 浏览器、实验室及 Firefox 栈 fixture | 同上                                |
| D2   | 已合入；console 原文上下文              | D7 的 D2 双浏览器和单元回归                  | 同上                                |
| D3   | 已合入；受控 fetch 与显式关联           | D7 的 D3 双浏览器和请求合同回归              | 同上                                |
| D4   | 已合入；详情、搜索、稳定链接、复制/导出 | D7 的 D4 权限/查询/双浏览器回归              | 同上                                |
| D5   | 已合入；CLI SourceMap 与生命周期        | D7 的 D5 双浏览器、存储和恢复                | 同上                                |
| D6   | PR #35 已合入；策略、维护和健康         | D7 的 D6 双浏览器及破坏恢复                  | Jesse 尚未确认全部手工场景          |
| D7   | 工程实现与同 SHA 自动化验收完成         | `73f5da8d…` 的三条最终 CI                    | 等待 Jesse 手工验收；未批准生产发布 |

## R1–R8 原产品回归映射

| 范围     | 产品能力                                       | 单元/集成                                       | 真实浏览器与服务                                               |
| -------- | ---------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| R1-A/B/C | 分析对象、指标库、公式、评分、快照、审计与历史 | focused tests、MySQL/API integration            | 管理员/viewer，Chromium/WebKit                                 |
| R2       | 项目入口、项目列表与概览、20项目查询预算       | API/read-model及真实MySQL/ClickHouse            | 管理员/viewer完整入口，Chromium/WebKit                         |
| R3       | 概览趋势、环境/版本/时间窗、绑定与隔离         | project-range、overview facts及p95              | 管理员/viewer与隔离fixture，Chromium/WebKit                    |
| R4-A/B/C | 业务分析、模块/工作流、效率、目录与重放        | 业务事实、SDK、队列重放和查询性能               | 管理员/viewer产品流、SDK链，Chromium/WebKit                    |
| R5-A/B   | 质量事实、真实分母、页面质量与受限查询         | golden fixtures、Kafka/存储/DLQ隐私、20/200负载 | SDK→真实服务和页面，Chromium/WebKit                            |
| R6       | 页面使用与运营                                 | 手算fixture、存储/API                           | 页面操作产品流，Chromium/WebKit                                |
| R7       | 设置、凭证与共享授权                           | 设置/API/数据库凭证边界                         | 设置流程，Chromium/WebKit                                      |
| R8       | 六模块导航、实验室、SDK保留断言、故障恢复      | 静态/单元/构建及持久schema恢复                  | 六模块与实验室、Kafka/consumer/ClickHouse恢复，Chromium/WebKit |

上述入口全部由 `runtime-diagnostics-d7-products.yml` 在最终SHA执行；R5-A/B或诊断专项没有代替其余范围。单元、集成、真实浏览器、隔离部署/恢复四类证据分别记录，不能互相冒充。

## 最终自动化证据

运行代码 `73f5da8d273d5c730e3bc2e974f6301fc07ce91d`：

- [Runtime diagnostics D7 38336455663](https://github.com/captainamari/frontend-insight/actions/runs/38336455663)：成功；artifact `diagnostics-d7-73f5da8d273d5c730e3bc2e974f6301fc07ce91d`，SHA-256 `cc140801beb5944cc79b22408ac627dbc06981467afdd1c7d5d6f4be0dd2369e`。
- [Ubuntu 22.04 Production deployment 38336455570](https://github.com/captainamari/frontend-insight/actions/runs/38336455570)：成功；artifact `production-deployment-evidence`，SHA-256 `e4ec80d0c901b7d9804d7b22a3a3e53eebbe9b24871034ede398bcdb389df958`。
- [D7 inherited R1–R8 38336455536](https://github.com/captainamari/frontend-insight/actions/runs/38336455536)：成功；artifact `d7-products-73f5da8d273d5c730e3bc2e974f6301fc07ce91d`，SHA-256 `8c507fca1479be19438f25eb095bef0e69773dd3f1c17ce8e179a0788691e11c`。

诊断 artifact 共 33 个文件、R1–R8 artifact 共 51 份 JSON，所有 JSON 的 `testedCommit` 已逐个核对；Ubuntu artifact 五份 JSON 也均为同一 SHA。证据只含字段/角色/性能摘要，不上传完整原文、SourceMap、凭据、trace 或全量服务日志。

## 性能与容量实测

硬门禁沿用 requirements-v1.8：基础 SDK gzip ≤12 KiB、同步处理 p95 ≤2 ms、ingestion p95 ≤100 ms、数据可见 p95 ≤5 min、核心查询 p95 ≤2 s。详情、搜索、导出、SourceMap 与维护查询均按 2 s 目标测量；没有提高预算。

环境为 GitHub Ubuntu runner：Linux Azure x64、4 vCPU AMD EPYC 9V45、约 16.7 GB 内存、Node 24.21.0、Docker 28.0.4、Compose 2.38.2。MySQL/Kafka/ClickHouse 容器上限分别为 768 MiB/1.5 GiB/2 GiB；API/consumer 在该 compose 未另设内存上限。结果只适用于该隔离合成环境。

| 负载                    | 事件/请求速率               | ingestion p95 |    persistence p95 |                调度/排空 | 结论                      |
| ----------------------- | --------------------------- | ------------: | -----------------: | -----------------------: | ------------------------- |
| 正常 20 events/s，60 s  | 20 events/s；1 request/s    |       9.44 ms | 不适用诊断 receipt | 59,000.97 / 59,007.14 ms | 通过                      |
| 正常 200 events/s，10 s | 200 events/s；4 requests/s  |      12.36 ms |             不适用 |   9,750.18 / 9,760.44 ms | 通过                      |
| 异常 20 events/s，60 s  | 20 events/s；5 requests/s   |      23.47 ms |              55 ms | 59,949.34 / 59,957.88 ms | 通过                      |
| 异常 200 events/s，10 s | 200 events/s；50 requests/s |      36.90 ms |           5,188 ms |  9,994.88 / 10,007.99 ms | 接收和 5 min 可见门禁通过 |

负载共 6,400 个正式事件，另有每组 3 次预热；异常原文使用 256/2,048/16,384/60,000 字节四档合成数据，批次不超过 100,000 字节/50 事件。请求按事件位置铺满每秒，最大调度漂移分别为 1.51/1.05/2.36/26.13 ms。events/s、requests/s、调度完成和响应排空分别报告；没有关闭页面限额或项目准入。nearest-rank p95 排除预热。

异常 20/200 events/s 分别保存 1,203/2,003 行（含 3 个预热），逻辑原文 23,701,524/39,503,124 bytes，信封 23,912,049/39,853,649 bytes，信封元数据 210,525/350,525 bytes，receipt 文本元数据 380,148/632,948 bytes。代表性查询 p95：详情 25.91 ms、导出 22.65 ms、维护 6.16 ms、搜索 40.40 ms；实际 SourceMap 20 样本 p95 49.98 ms，均低于 2 s。

共享 ClickHouse active parts 实际占用为 raw_events 198,777 bytes、diagnostic_details 520,770 bytes、schema_migrations 1,087 bytes；SourceMap 文件分配 12 KiB。它们是共享隔离实例物理值，不是单项目精确磁盘。按本次高度可压缩合成信封约 19.9 KiB/事件、连续异常流量和 14 天保留期做未压缩逻辑投影：20 events/s 约 480.9 GB，200 events/s 约 4.813 TB；压缩比未知，备份副本未计入，不能用作生产容量承诺。到期/主动删除先变为逻辑不可读，物理回收与 ClickHouse mutation/文件清理另行观测；本次结束时无未完成 mutation。

基础 SDK 为 36,756 raw bytes、**12,287/12,288 gzip bytes**。可选 errors/console/requests/policy/quality 分别为 2,305/2,741/4,976/2,667/5,239 bytes；完整诊断组合 24,976 bytes，带 quality 30,215 bytes。真实浏览器同步捕获 p95：Chromium 关闭/开启/64 KiB 信封为 0.1/0.2/0.2 ms，WebKit 为 0/1/1 ms；每项 20 次预热后 200 样本，计时只含同步捕获、不含传输。

## 最短手工验收

1. 按 D6 指南在隔离项目启用策略，给工程师 viewer 授予 read+export；保留一个仅 read 和一个普通 viewer。
2. 实验室依次触发 TypeError、未处理 Promise、Vue 框架捕获、连续 console 后错误、503（应用已读取正文）、超时/取消/网络失败和资源加载失败。沿错误组→实例检查 message/name/原始栈、cause、嵌套对象、console 顺序、完整 URL/query、正文与显式 request/operation/workflow 关联；无显式 ID 的只标时间邻近。
3. 用 D5 正式 CLI 上传压缩构建 map，核对固定源码位置；错 release、缺 map、无 sourcesContent 时仍显示编译栈和准确降级状态。
4. 刷新稳定链接，切换 env/release/时间窗，搜索、复制并导出；核对超长换行和 HTML/XSS 样本只显示文本。撤权后让已打开页面、复制和旧下载链接再次请求，均应被服务端拒绝。
5. 关闭策略并等待 SDK 同步，确认 collector 停止且基础质量计数不变；让旧/离线 SDK 投递，确认服务端拒收。重新启用后不重复包装、监听或计数。
6. 维护页核对未知/等待/过期/写失败状态、健康和容量口径。删除指定 eventId 后，详情/搜索/导出不可复活，而基础统计仍在。
7. 记录 appId、eventId、策略 revision、具体预期/实际和截图。只有 Jesse 明确确认后，才登记“用户手工验收通过”。

## 发布、升级、回滚与恢复

先隔离入口并备份，验证增量迁移 001–011，再按 consumer/API/UI、配套可选 SDK 的顺序发布。旧 SDK 仍可发基础事实；新服务端准入始终生效。保留数据库表和私有 SourceMap 卷，不修改已应用迁移，不用 reset/seed。旧服务不理解删除墓碑时，回滚后必须保持诊断原文入口关闭。

```bash
bash scripts/production doctor
bash scripts/production backup pre-d7
bash scripts/production deploy d7-candidate
bash scripts/production verify
bash scripts/production status
```

恢复只可在隔离对外入口后执行：`bash scripts/production restore pre-d7 --confirm-replace-data`。核对策略、授权/撤权、上传凭证、墓碑、健康、原文、SourceMap 元数据和私有文件，并补执行备份后的撤权与删除，再开放流量。回滚入口为 `bash scripts/production rollback <release-id> --confirm-rollback`，不下迁移。

Ubuntu 22.04 CI 已实际执行部署、TLS 双浏览器、保留卷重建、备份→破坏→恢复和恢复后 UI/API；此次演练在备份后没有新的授权变更，因此只证明恢复点状态一致，不证明现实环境会自动保留备份后的撤权或删除。生产证书、网络、目标机器容量和实际发布仍由 Jesse 决定并执行。

## 已知边界

- Firefox 只有 Chrome/WebKit/Firefox 栈格式 fixture，没有真实 Firefox 全链路；React 是适配器回调验证，没有完整 React 渲染树。
- D3 只采受控 fetch 与应用提供的已读响应文本；不 clone/tee，不调用业务 `Response.text/json`，XHR 不宣称自动采原文；`quality.observeApi` 仍是 API 事实唯一入口。
- 离线队列仅为有界内存队列，关页后不保证投递；已下载文件无法远程收回。
- CI 容量和时延不是生产承诺。上线前仍需目标环境容量预检、真实证书/网络配置、Jesse 手工验收和明确发布批准。
