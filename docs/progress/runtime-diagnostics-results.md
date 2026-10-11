# 运行时诊断实施结果

## D0 当前状态

D0 已实现并通过真实 CI，等待用户评审/合并；不代表整条诊断路线完成。基线：`8ff28a6140f62d8376d84a0a2e56fb93a5ff1b1e`（最新 `origin/refactor`）。分支：`agent/runtime-diagnostics-d0-contract-access`；目标：`refactor`。工作区开始时干净；未发现 AGENTS.md。

本批仅 D0。D1–D7 均未完成，尚无完整诊断抽屉、console/request collector、SourceMap 或原文导出产品。

| D0 验收项                                               | 实现位置                                                          | 当前证据                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 可选 v3 信封、原文/派生字段、64 KiB 与子预算            | event-contract 生成器、validator/security/diagnostics             | 合同原文往返与边界测试，本地已通过                                              |
| SDK 最小入口、beforeSend、拆批、超限/限流不减少基础事件 | web-tracker tracker/privacy/types                                 | 新增 SDK 测试，本地通过                                                         |
| 原文链路                                                | pipeline → consumer → RuntimeDiagnostics → diagnostics controller | 最终 CI 真实服务与 Chromium/WebKit 通过                                         |
| 增量迁移、策略、授权、审计、状态                        | MySQL 008–009、ClickHouse 005                                     | MySQL 7→8→9 / ClickHouse 4→5 保留数据与重复迁移通过                             |
| 当前项目成员 + read/export、admin、撤权/移除、旧 token  | RuntimeDiagnostics / AuthGuard / DiagnosticsController            | 最终 CI admin、授权/普通 viewer、跨项目、未登录、外部 token、撤权与移除成员通过 |
| 重试、部分写入、基础错误计数、TTL                       | receipt/admission、consumer、ClickHouse TTL                       | 最终 CI 重试、冲突、限流保留基础计数、逻辑/物理 TTL、详情表故障恢复通过         |
| 普通列表/基础表/运行日志/DLQ 不含原文                   | page-quality、consumer、safe logger                               | 旧负向测试及新增普通列表/基础表/日志/DLQ 原文隔离断言通过                       |
| 兼容与部署交接                                          | 接入说明、decisions、ADR-021                                      | 已记录发布/回滚顺序、Kafka 保留期影响与浏览器范围                               |

## 本地验证

- `pnpm install --frozen-lockfile`：通过；新增直接依赖后更新 lockfile。
- `pnpm test`：71 文件、536 测试通过（包含新增 6 项 D0 测试）。最终代码 SHA 的 CI 再次通过同一完整门禁。
- `pnpm build`：通过；SDK gzip 12,252 bytes，原 12 KiB 预算未提高（最终 CI 构建数值相同）。
- `docker version`：当前执行环境没有 Docker。未在此环境声称跑过 MySQL/Kafka/ClickHouse。

## 真实验证入口

一次性 CI/本地隔离环境：`M5_ALLOW_NON_ARM64=1 ./scripts/dev bootstrap`，`./scripts/dev up`，`./scripts/dev smoke`。

- `./scripts/dev verify-d0-upgrade`：独立数据库 MySQL 7→8→9、ClickHouse 4→5，保存 sentinel 和旧 checksum，重复迁移不再应用。
- `./scripts/dev verify-d0`：真实 ingestion/Kafka/consumer/数据库/API、角色矩阵、重试、冲突、限流、旧 v3、TTL、详情表临时不可用恢复及 DLQ。**仅用于可丢弃的测试堆栈**，会临时重命名诊断表，不能在生产运行。
- `pnpm exec playwright test -c playwright.diagnostics.config.ts`：Chromium/WebKit SDK 原文、beforeSend、拆批、授权读取一致性。
- `node tools/d0-log-check.mjs`：只输出成功元数据，检查服务日志没有合成标记。
- `.github/workflows/runtime-diagnostics-d0.yml`：静态/全量单测/构建、上述验证及继承 R5-A/B 浏览器回归。

## 最终验收证据

- 精确代码 SHA：`b7e7bc9dcb37d2d8afcf6629b1a50da62245e09c`。
- 对应源码 tree：`99afb30b2791ba6861912a3fc7bf10d4e4b77b12`。
- [最终 CI 38043937843](https://github.com/captainamari/frontend-insight/actions/runs/38043937843)：全部步骤成功，job `114189558197`。
- `pnpm check`：格式、workspace/合同/规范名、lint、类型检查、71 文件 / 536 测试、完整构建均通过。
- 真实旧 v3 smoke：3 个合法批次 / 10 个事件接受；2 个旧合同批次拒绝。
- 真实升级：旧数据 sentinel 非空且内容不变，旧 checksum 不变，迁移再次运行不重复应用。
- 真实服务脚本：原文 JSON 往返一致；六类身份和即时撤权/移除成员通过；重投 ID 不覆盖证据，冲突 409；详情限流后基础错误仍保留；故障恢复前后独立基础错误数均为 26。Kafka 跨项目诊断信封拒绝，DLQ 仅摘要。
- 浏览器：D0 Chromium/WebKit 共 2 项通过；继承 R5-A 共 2 项、R5-B 共 2 项通过，R5-B storage privacy 检查通过。
- 日志：API/consumer/web/demo/MySQL/ClickHouse/Kafka 均无合成诊断原文标记；Prometheus 未增加任何原文标签。
- [小型证据 artifact](https://github.com/captainamari/frontend-insight/actions/runs/38043937843/artifacts/11667131484)：2,004 bytes，保留 7 天；包含 D0 services/upgrade/双浏览器/logs、R5-B privacy、SDK bundle JSON。保留期过后仍可按本文件命令重新验证。
- 最后的文档收尾提交只修改 `docs/`：不会把新文档 SHA 冒充已经执行过全部 CI 的代码 SHA，也不重复上传中间产物。

## 交付边界与剩余风险

D0 五项清单均有实际证据，D1–D7 保持未完成。当前只有最小显式诊断入口与受限 API；原有全局/框架错误采集、console、请求捕获、原文 UI、SourceMap、导出和完整策略 UI 没有提前实施。SDK 最小入口的通用派生分类不会恢复历史丢失信息。

没有 D0 验证阻塞。需关注：SDK base gzip 距原 12 KiB 上限仅剩 36 bytes，D1 新提取器应考虑可选包结构，不能静默提高预算；大批次关页发送不保证完成；Kafka 整个事件 topic 重放窗口为约 24 小时；物理 TTL 与备份清理不是即时擦除。部署、备份、回滚影响详见接入说明与 decisions。D7 完整容量/备份恢复验收未执行，Firefox 真实浏览器未覆盖。

## 提交与 CI 历史

首个远端代码 SHA：`8706616ce8f3d45a8af71268536d13f370fb434a`；本地测试 tree 与远端 tree 同为 `bc030cf61992382ebebecfbd1b8aae1e666c89ba`。Git 命令行无写入凭据，使用已连接 GitHub 插件提交，tree 一致性已核对。

[首轮 CI 38043186554](https://github.com/captainamari/frontend-insight/actions/runs/38043186554)：静态/全量单测/构建、真实服务启动与旧 v3 smoke 通过；增量迁移验收脚本的 ClickHouse 快照 SELECT 重复声明 FORMAT，导致语法错误。已修复脚本，未删断言；补充 sentinel 非空检查，避免 TTL 导致空表假通过。后续专项未执行，待新代码 CI。

[Draft PR #29](https://github.com/captainamari/frontend-insight/pull/29)，目标 refactor，未自动合并。

## 后续入口

只有 D0 实际证据完成并由用户合并后，再从最新 refactor 建 `agent/runtime-diagnostics-d1-errors`，按计划 D1 统一错误提取、修复栈解析、补原文详情呈现与实验室；保留本批合同、权限、TTL 和计数路径。

第二轮代码 `a340e7d814d9b52d1d2c5ad48b9b1d71d2ccab0d`：[CI 38043572676](https://github.com/captainamari/frontend-insight/actions/runs/38043572676) 已完成真实 MySQL 7→8→9 / ClickHouse 4→5 保留数据升级，以及原文/角色/撤权/限流/重试/部分写入恢复断言。之后 TTL 夹具错误地 UPDATE 分区键 expires_at，被 ClickHouse 拒绝；改用独立的已过期插入记录进行物理 TTL 断言，不修改生产表结构或 TTL。后续浏览器和 DLQ 验证仍待新一轮 CI。故障恢复轮询允许 90 秒，覆盖配置中的 30 秒 consumer 暂停时间。

## D1 实施检查点（2026-10-11，进行中）

- 已核实 PR #29 merged，最新 refactor 基线 `39693e9385edc6a259e2e19ed836bee927d89ecc`，tree 与 D0 文档收尾 `b85197e9c0a99cb91e5739bfd3457f612258c019` 完全一致。
- 分支 `agent/runtime-diagnostics-d1-errors`；没有仓库或上层 AGENTS.md，没有覆盖已有工作区修改。
- 检查点一：共用 reportError 通道、可选 `./errors` 提取器、框架适配器、错误身份去重、编译栈解析器与专项单测。quality 原有按指纹最多五条的基础错误抑制已移除，详情继续使用 D0 限流。
- 已运行受影响单测：7 文件 / 71 项通过；其中 Firefox 仅为解析 fixture。当前环境没有 Docker，真实服务、浏览器和权限闭环尚未运行，不以单测替代。
- 页面/API 与实验室仍在实施；下一步：类型/包体完整检查、授权详情与实验室检查点、真实 CI。D1 尚未完成，D2–D7 未开发。

### D1 检查点二：授权详情与实验室

- 检查点一远端代码 `2372ea484d17d05c33d559adf6933f0709fc50f9`；本地提交与 GitHub 插件创建提交 tree 一致，均为 `8c97c0b710c5552df392010bf4ad3f04446523fb`。命令行没有写入凭据，后续继续通过已授权插件推送。
- 当前已补质量详情组件、历史摘要受限投影、实验室真实 throw/Promise/Vue 及 React 显式适配器、资源失败；普通列表不新增原文。
- 现测基础包 12,276 bytes gzip / 12,288 上限；可选 errors 1,776 bytes，基础＋errors 14,052 bytes；可选 quality 5,239 bytes，三者合计 19,291 bytes。没有提高门禁；D0 最小显式入口的通用派生摘要统一为 Error，不改变 raw 或计数。
- 全量本地 73 文件 / 556 测试通过；完整门禁曾因基础包超限 1 byte 阻断，已消除重复摘要常量，正在复验完整门禁。
- 新专项 `.github/workflows/runtime-diagnostics-d1.yml` 继承 D0 真实升级、六身份/撤权/TTL/故障/日志/DLQ 和 R5-A/B；新增 D1 双浏览器字段/API/UI一致性、权限撤销、同步提取 p95。该检查点尚无真实 CI 成功证据。
- 下一步：检查本提交 CI，修复失败；补齐手工接入/验收、学习与最终矩阵，不提前结束。

### D1 检查点三：真实回归与交接收尾

- 第一轮代码 `cd14ad210b7307fd875f571eec291a5846271cc4`：[CI 38113912856](https://github.com/captainamari/frontend-insight/actions/runs/38113912856) 全部成功，job `114394890065`。包括 pnpm check、真实服务与增量升级、D0 六身份/撤权/重试/TTL/部分写入/DLQ、D1 SDK→API→质量详情双浏览器、继承 R5-A/B 和日志检查。小型证据 artifact 2,915 bytes，保留 7 天。
- [Draft PR #30](https://github.com/captainamari/frontend-insight/pull/30) 已创建，目标 refactor，未合并。
- 本次收尾修复 JSON 转义预算、提取器复用时的项目/生命周期隔离、无函数名 async/anonymous 帧、已打开详情过期清理；Vue 适配器重复安装返回同一卸载句柄。新增 cause/子错误展开、失败状态、项目切换、实际场景实验室/真实 Vue handler 浏览器断言。
- 增补 D1 接入/手工验收指南、用户入口、SDK说明、学习文档 18。最终代码需重跑 CI，不能引用第一轮成功作为本次收尾代码的最终证据。
- 最近完整本地 pnpm check 已通过（73 文件 / 559 测试）；最后 Vue 重复安装补丁额外受影响测试/构建通过，最终完整门禁仍以最终 CI 为准。

- 第二轮 `94251be550ad9e21fc5fd18f29146da85ac2faf4` / CI `38114399686` 的 pnpm check 已成功。静态复核发现新增“切换项目”浏览器 fixture 错误地传了空 origins（合同要求至少一个），并补上非字符串 name/message 的对象 rejection 回归；修复后推送替代轮次，由工作流 concurrency 取消旧轮次，避免继续运行已知有缺陷的 fixture。没有放宽项目合同或删除断言。

## D1 逐项完成矩阵（已通过最终 CI，待用户手工验收/评审）

| D1 项目                                   | 实现位置                                                                                      | 验证与边界                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 两条 SDK 错误路径统一；原文与派生字段分离 | `web-tracker/src/{tracker,quality,observability,errors,error-port}.ts`                        | 全局 JS、Promise（Error/字符串/对象/null）、显式、cause、AggregateError；raw 与基础 payload 分离；重复监听/同任务传播去重、独立错误不漏计        |
| 框架显式接入、保留已有处理行为            | `errors.ts`、`demo-app/src/App.vue`、D1 指南                                                  | Vue 重复安装/卸载、receiver/参数/返回/抛错；真实 Vue 事件；React 显式回调及可执行 ErrorBoundary 示例                                             |
| 有界提取和容量                            | `errors.ts`、继承 D0 diagnosticBudgetError/captureDiagnostic                                  | 不执行自定义 getter/toJSON；循环/BigInt/不可读取/JSON转义/对象字段有界；64 KiB 信封、16 KiB/32 帧、cause 4层；限流仍保留基础错误数               |
| 编译栈与解析失败                          | `server-core/src/error-stack.ts`、`page-quality.ts`                                           | HTTP/HTTPS/相对路径、函数包裹、Chrome/WebKit/Firefox fixture、eval/native/async/anonymous、无栈；原文保留，结构化 file/function/line/column 分离 |
| 受限 API 与历史字段                       | `runtime-diagnostics.ts`、D0 DiagnosticsController                                            | diagnostics.read、当前成员、admin审计、no-store、expiresAt；历史已存字段在授权后返回 legacy，不伪造丢失信息                                      |
| 可用质量详情页面                          | `web/src/components/DiagnosticDetail.vue`、`views/PageQualityView.vue`                        | 消息/栈文本渲染、帧表、cause/子错误展开、复制前重新授权；服务端即时撤权，页面一秒轮询往返清空；切项目/实例/关闭/失焦/到期清理                    |
| 完整状态中文说明                          | 同上与 D1 指南                                                                                | 存储 state、采集 capture.status、解析 view.stack.state、访问401/403分层；保留 write_failed/rate_limited/too_large 等元数据                       |
| 资源失败                                  | `observability.ts`、实验室、详情组件                                                          | 真实资源加载失败，受限显示完整 resourceUrl，说明“不适用 JS 调用栈”；无 SourceMap                                                                 |
| 真实业务链路与负向回归                    | `tests/runtime-diagnostics/{errors,transport}.spec.ts`、D0 integration、R5-A/B、专项 workflow | SDK→ingestion→Kafka→consumer→存储→授权API→UI 原文一致；不只断言一条记录；普通列表/日志/DLQ及真实分母继承验证                                     |
| 交接与兼容                                | D1 指南、用户指南、学习文档18、SDK README、results/decisions                                  | 无新迁移；先 D0 存储/consumer/API，再 D1 API/UI/SDK；可选启用原文；D2–D7 保持未完成                                                              |

### 最终包体方案与影响

D0 基础 gzip 12,252 bytes；D1 基础 12,276 bytes，增加 24 bytes，原上限 12,288 不变、余量 12 bytes。去除重复转发/包装，统一基础错误报告；没有为过门禁删除 D1 必需功能。

| 实际下载组合            | gzip bytes |
| ----------------------- | ---------: |
| 基础入口                |     12,276 |
| 可选 errors 单独        |      1,948 |
| 基础 + errors           |     14,224 |
| 可选 quality 单独       |      5,239 |
| 基础 + errors + quality |     19,463 |

将完整提取器无条件加入基础包会超出现有预算；显式可选入口保留基础门禁并披露真实组合体积。没有需要用户批准的预算上调。余量仍小，D2 不应把 console 功能直接挤入基础包。

### 覆盖的解释与未覆盖项

- Chromium/WebKit：真实 SDK、服务、存储、授权 API、页面。HTTP fixture 仅提供合成业务页/错误/SDK文件；后端没有用 mock 代替真实链路。
- Firefox：仅栈格式 fixture。React：真实浏览器显式适配器回调，未挂载 React 渲染树；Vue 则覆盖实际实验室组件事件处理器。
- 剪贴板：验证按钮重新授权和准确文本，浏览器测试使用 clipboard sink；未宣称操作系统剪贴板集成。
- 页面覆盖正常消息/栈、cause/AggregateError、解析失败、截断、无栈、资源不适用、撤权/移除成员及项目切换。pending/write_failed/expired/限流/容量等后端状态沿用 D0 真实服务测试；完整状态文案均已实现，不把每种故障状态都描述成做过页面故障注入。
- 本地无 Docker；真实环境证据来自 Actions 的 Ubuntu 24.04 一次性容器。没有连接或操作生产，没有替用户完成手工验收。
- D7 完整压力、长期容量、备份恢复未执行；console、请求正文、SourceMap、导出、完整策略 UI 未实现。

## D1 最终交付证据（2026-10-11）

- **精确验证代码 SHA**：`c98f322c0ee078f88a8aa9124a586830e76045bf`；源码 tree `a6e0e325788e17acf0ed716be2af8f1b94d0ea8c`。
- **成功 CI**：[38114551404](https://github.com/captainamari/frontend-insight/actions/runs/38114551404)，job `114396788473`。核对 head_sha 与上述代码相同，全部步骤成功，不以“已触发”代替验证。
- `pnpm check`：格式、workspace/合同/规范名、lint、类型、73 文件 / 560 项单测、完整构建全部成功。基础 SDK 12,276 bytes，可选 errors 1,948 bytes，quality 5,239 bytes；组合数值与上表一致。
- 真实 D0/D1 Chromium/WebKit 专项 **6 项通过**：D0 transport 各一项；D1 原文→API→质量 UI 各一项；实际实验室（throw、Promise、显式、Vue、React适配器、资源）各一项。
- D1 每浏览器 11 个合成错误实例逐一比对出站 diagnostic 与受限存储/API结果；具体消息、函数、文件、行列和原始编译栈断言通过。展开 cause/子错误、失败/无栈/截断/资源提示、纯文本安全、复制再授权、撤权/移除成员及项目切换通过。
- D0 实际增量升级、原文往返、六类身份、跨项目/外部token/未登录、即时撤权/移除、限流保留计数、重试冲突、TTL、详情表故障恢复、DLQ元数据与日志隔离通过；旧 v3 smoke 通过。
- 继承 R5-A **2 项**、R5-B **2 项**真实浏览器/统计/分母回归及 storage privacy 通过。没有整套删除旧负向断言。
- 同步 `extractError` 普通合成消息/双帧 fixture，各浏览器 300 次：Chromium p95 **约 0.1 ms**；WebKit p95 读数 **0 ms（低于本次计时分辨率，不表示没有耗时）**。不包含网络/UI/整条 SDK flush，也不是最大信封/高频 console 压测；完整 D7 性能校准未执行。
- [最终小型证据 artifact](https://github.com/captainamari/frontend-insight/actions/runs/38114551404/artifacts/11692947316)：**3,496 bytes**，保留 7 天，SHA-256 `35026741cb6d7e9b9ff09284fb625d520e6cd12075301c78f2b229898b0ad4c2`；仅必要 JSON 摘要/包体，不上传 trace、原文 body 或服务日志中间产物。
- 最后收尾仅修改 `docs/` 的状态和证据，不把文档 SHA 冒充完整 CI 已验证的代码 SHA；精确文档提交 SHA 同步记录在 PR #30 与交付回复中。

### 手工验收、合并与下一阶段

[可执行 D1 指南](../guides/runtime-diagnostics-d1.md) 包含原生 JS/Vue/React 接入、升级顺序、角色授权、实验室按钮、具体消息/栈和状态预期；[学习文档18](../learning/18-runtime-error-diagnostics.md) 解释维护路径。

D1 已完成实现与自动化交付，没有替用户填写手工验收通过；[Draft PR #30](https://github.com/captainamari/frontend-insight/pull/30) 指向 refactor，未自动合并。D1 仅代表错误诊断首个可试用闭环。

合并后 D2 入口：核实 PR #30 的实际合入内容，从最新 refactor 新建 D2 分支，按开发计划“D2 — console 上下文”实现有界环形缓冲、包装/销毁恢复、错误时冻结快照和授权页面。继承本批原文权限/预算/计数，不提前实现 D3–D7。剩余限制见前述覆盖说明；基础包仅余 12 bytes，应继续采用显式可选入口。

## D2 检查点 1：SDK（2026-10-11，进行中）

- 实际基线 `69ad25ad0d68040067f5114ca709e2657676b85e`；已核对 PR #30 合并，且 refactor 内容与 D1 文档收尾 `fea2ea31dbfdbb08d0e0624344f50be14fa632ce` 一致。没有新增人工验收记录。工作区为新克隆，无原有修改；未发现适用 AGENTS.md。
- 分支 `agent/runtime-diagnostics-d2-console`。已实现可选 console 入口、原调用语义、独立快照、生命周期与作用域、UTF-8/JSON 总预算；具体实现 `web-tracker/src/console.ts`、`console-snapshot.ts`、`error-port.ts`、`tracker.ts`。
- 基础包门禁未调整：本检查点实测 12,258 bytes；errors 1,971；console 2,684；quality 5,239。基础+errors+console 16,913；再加 quality 22,152。console 的 errors 依赖作为独立公共下载计入，不重复内嵌。
- SDK/合同针对性 29 项通过；此前完整检查到类型阶段通过，574 单测中一项 fixture 在 Vitest 自定义 stack formatter 下失败，已改成明确的数据属性 fixture 并通过针对性测试。完整门禁仍须重跑，不声称完成。
- 本地没有 Docker，真实服务和浏览器全链路将由 D2 Actions 一次性环境运行。当前没有真实 CI 成功证据。
- 下一步：提交 SDK 检查点；完成授权详情/实验室/专项浏览器测试，运行 `pnpm check` 后推送并核对 D2 CI。D2 尚未交付；D3–D7 未实施。

## D2 检查点 2：授权详情与实验室（进行中）

- SDK 远端提交 `70be050ff7f58a06d2d02e71d74242fed0e51c40`；命令行 Git 没有写入凭据，通过已授权 GitHub 连接器提交，已核对本地/远端源码 tree 完全一致并同步本地分支。不是推送失败后放弃交付。
- 已实现 `DiagnosticDetail.vue` console 级别/时间/相对时间/参数/展开/过滤/复制与淘汰说明；复制沿用重新授权，原文仍由实例 API 返回。历史缺失和未启用分开，存储/采集/解析/权限层不合并。
- 场景实验室所有错误入口增加业务日志；新增仅 console.error 与快照/BigInt/循环/长参数/淘汰场景。React 仍为显式适配器，Vue 是真实组件事件，未宣称真实 React 树。
- 本地完整 `pnpm check` 已通过 74 文件 / 576 单测与构建；后续补充信封最终状态预算边界及实验室日志断言，将随同提交 CI 重新验证。
- D2 workflow 继承真实 D0/D1、权限六身份、故障/TTL/重试、R5-A/B 与分母验证；新增 console 原文逐字段 API/UI 检查、复制时撤权、浏览器同步开销和持续有界容量测量。D0 真实 fixture 增加 console 原文，负向检查保留并扩展至原始事实/审计/DLQ/服务日志/Prometheus。
- 尚未得到真实 CI 结果，不标记 D2 完成。下一步提交此检查点、创建 Draft PR、等待并修复实际 Actions；完成指南和最终证据。

## D2 实现矩阵（代码完成，最终提交 CI 待核验）

| D2 任务                            | 实现位置                                                              | 已有验证 / 交付边界                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可选五级 console 与默认 error/warn | `web-tracker/src/console.ts`、`package.json`                          | 默认/自定义级别、显式禁用、不可用级别；无独立网络请求或全局异常监听                                                                                            |
| 调用时快照、异常前冻结、重试稳定   | `console-snapshot.ts`、`console.ts`、`tracker.ts`                     | 对象后改、后续日志、连续异常、异常发生在原 console 尚未返回时、重试 body 不变                                                                                  |
| 有界序列化与预算                   | 同上、`event-contract/src/diagnostics.ts`                             | 50/24KiB/60s/整条2KiB，UTF-8/JSON转义、紧缩预算、总信封与状态/元数据；Error/cause/AggregateError、BigInt/循环/不可读；getter/toJSON 不执行                     |
| 原 console 行为与恢复              | `console.ts`、`sdk-console.ts`                                        | 参数引用和顺序、this、返回、抛错；递归、重复安装、第三方前后包装/所有权、缺失/不可写；同前缀业务日志保留                                                       |
| 页面/实例/项目隔离                 | `console.ts`、tracker lifecycle                                       | 独立 records/元数据、导航/pageView、destroy/reinitialize；同项目多实例；不同 scope 冲突停止采集；存活 tracker 的导航不被另一实例销毁破坏                       |
| 计数、D1 去重与 D0 传输            | 原 `reportError/captureDiagnostic` 与 D2 模块                         | console.error 不计 JS；25 个独立错误全部计数、最多20份详情；双监听去重、旧 v3、重试/TTL/故障保持                                                               |
| 按实例授权与原文隔离               | 原 RuntimeDiagnostics/DiagnosticsController、`error-stack.ts`         | 服务端 diagnostics.read/当前成员、admin审计、no-store；D0六身份及撤权/移除；普通列表/raw_events/审计/DLQ/Prometheus/服务日志负向断言保留并扩充 console fixture |
| 详情页面与状态                     | `DiagnosticDetail.vue`、受限 console view                             | 级别/顺序/时间/相对毫秒、参数与Error栈、展开/过滤/复制再授权；legacy/not_enabled/empty/conflict，继承存储和访问状态；文本渲染不执行HTML                        |
| 实验室                             | `demo-app/src/App.vue`                                                | 五种实际错误路径先记录 info/warn/error；仅console、对象后改/循环/BigInt/Error/长参数/缓冲淘汰；React为显式回调，不是React树                                    |
| 双浏览器与性能                     | `tests/runtime-diagnostics/console.spec.ts`、errors.spec、D2 workflow | 首轮真实双浏览器完整链路已通过；参数/顺序/级别/相对时间、具体错误/帧、撤权与复制。普通1000/复杂1000/高频10000/冻结500采样；最终报告待同提交 artifact           |
| 体积与交接                         | build-bundle、D2指南、SDK README、用户指南、学习18                    | 基础12KiB不变，私有属性压缩白名单；各可选模块和组合计量；无新增迁移；Firefox仅fixture；D3–D7未完成                                                             |

### D2 检查点 3（最终回归准备）

首轮验证代码 `101095a2807ebabcbb49a51ee4438acef942b9cf`，CI [38118755398](https://github.com/captainamari/frontend-insight/actions/runs/38118755398)。已确认真实权限/故障/双浏览器链路通过，继承回归仍在执行，未提前填全部成功。

复核追加：复制 console 的 limits/unavailableLevels，冻结配置所有者并只接受五个合法级别；避免可变元数据跨异常共享。增加总信封边界、配置/元数据变更、实际双 tracker 销毁后导航与 SDK warning 排除测试，18 项 D2 单测通过。console 模块现为 2,706 bytes，完整启用组合 22,174 bytes；最终 CI 会重新构建确认。指南已完成，接下来提交此批最终代码并等待同 SHA 的全部 Actions 完成，再追加最终证据。

首轮 CI `38118755398` 已全步骤成功（代码仍为 `101095a...`，不冒充后续修订已验证），artifact `11693823421` 为 5,221 bytes，仅摘要 JSON。初步测量：Chromium 时钟约0.1ms，普通/复杂/高频/冻结 p95 约0.1/0.3/0.1/0.2ms；WebKit 时钟约1ms，对应 <分辨率/1/<分辨率/1ms。连续调用后保留50条、10,601 bytes。最终同提交测量将在下一轮完成后追加，不用此轮替代最终结果。
