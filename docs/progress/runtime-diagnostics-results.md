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
