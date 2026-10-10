# 运行时诊断实施结果

## D0 当前状态

实施中，等待实际 CI 服务证据。基线：`8ff28a6140f62d8376d84a0a2e56fb93a5ff1b1e`（最新 `origin/refactor`）。分支：`agent/runtime-diagnostics-d0-contract-access`；目标：`refactor`。工作区开始时干净；未发现 AGENTS.md。

本批仅 D0。D1–D7 均未完成，尚无完整诊断抽屉、console/request collector、SourceMap 或原文导出产品。

| D0 验收项                                               | 实现位置                                                          | 当前证据                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| 可选 v3 信封、原文/派生字段、64 KiB 与子预算            | event-contract 生成器、validator/security/diagnostics             | 合同原文往返与边界测试，本地已通过                |
| SDK 最小入口、beforeSend、拆批、超限/限流不减少基础事件 | web-tracker tracker/privacy/types                                 | 新增 SDK 测试，本地通过                           |
| 原文链路                                                | pipeline → consumer → RuntimeDiagnostics → diagnostics controller | 可执行真实服务及双浏览器脚本；等待 CI             |
| 增量迁移、策略、授权、审计、状态                        | MySQL 008–009、ClickHouse 005                                     | 清单测试通过；已有数据升级脚本待真实执行          |
| 当前项目成员 + read/export、admin、撤权/移除、旧 token  | RuntimeDiagnostics / AuthGuard / DiagnosticsController            | 真实角色矩阵脚本待 CI                             |
| 重试、部分写入、基础错误计数、TTL                       | receipt/admission、consumer、ClickHouse TTL                       | 真实故障注入与 TTL 脚本待 CI                      |
| 普通列表/基础表/运行日志/DLQ 不含原文                   | page-quality、consumer、safe logger                               | 保留旧负向测试；新增真实断言待 CI                 |
| 兼容与部署交接                                          | 接入说明、decisions、ADR-021                                      | 已记录发布/回滚顺序、Kafka 保留期影响与浏览器范围 |

## 本地验证

- `pnpm install --frozen-lockfile`：通过；新增直接依赖后更新 lockfile。
- `pnpm test`：71 文件、536 测试通过（包含新增 6 项 D0 测试）。后续最终同提交门禁结果另行记录。
- `pnpm build`：通过；SDK gzip 12,252 bytes，原 12 KiB 预算未提高（最终值随最终构建记录）。
- `docker version`：当前执行环境没有 Docker。未在此环境声称跑过 MySQL/Kafka/ClickHouse。

## 真实验证入口

一次性 CI/本地隔离环境：`M5_ALLOW_NON_ARM64=1 ./scripts/dev bootstrap`，`./scripts/dev up`，`./scripts/dev smoke`。

- `./scripts/dev verify-d0-upgrade`：独立数据库 MySQL 7→8→9、ClickHouse 4→5，保存 sentinel 和旧 checksum，重复迁移不再应用。
- `./scripts/dev verify-d0`：真实 ingestion/Kafka/consumer/数据库/API、角色矩阵、重试、冲突、限流、旧 v3、TTL、详情表临时不可用恢复及 DLQ。**仅用于可丢弃的测试堆栈**，会临时重命名诊断表，不能在生产运行。
- `pnpm exec playwright test -c playwright.diagnostics.config.ts`：Chromium/WebKit SDK 原文、beforeSend、拆批、授权读取一致性。
- `node tools/d0-log-check.mjs`：只输出成功元数据，检查服务日志没有合成标记。
- `.github/workflows/runtime-diagnostics-d0.yml`：静态/全量单测/构建、上述验证及继承 R5-A/B 浏览器回归。

## 提交与 CI

首个远端代码 SHA：`8706616ce8f3d45a8af71268536d13f370fb434a`；本地测试 tree 与远端 tree 同为 `bc030cf61992382ebebecfbd1b8aae1e666c89ba`。Git 命令行无写入凭据，使用已连接 GitHub 插件提交，tree 一致性已核对。

[首轮 CI 38043186554](https://github.com/captainamari/frontend-insight/actions/runs/38043186554)：静态/全量单测/构建、真实服务启动与旧 v3 smoke 通过；增量迁移验收脚本的 ClickHouse 快照 SELECT 重复声明 FORMAT，导致语法错误。已修复脚本，未删断言；补充 sentinel 非空检查，避免 TTL 导致空表假通过。后续专项未执行，待新代码 CI。

[Draft PR #29](https://github.com/captainamari/frontend-insight/pull/29)，目标 refactor，未自动合并。

## 后续入口

只有 D0 实际证据完成并由用户合并后，再从最新 refactor 建 `agent/runtime-diagnostics-d1-errors`，按计划 D1 统一错误提取、修复栈解析、补原文详情呈现与实验室；保留本批合同、权限、TTL 和计数路径。

第二轮代码 `a340e7d814d9b52d1d2c5ad48b9b1d71d2ccab0d`：[CI 38043572676](https://github.com/captainamari/frontend-insight/actions/runs/38043572676) 已完成真实 MySQL 7→8→9 / ClickHouse 4→5 保留数据升级，以及原文/角色/撤权/限流/重试/部分写入恢复断言。之后 TTL 夹具错误地 UPDATE 分区键 expires_at，被 ClickHouse 拒绝；改用独立的已过期插入记录进行物理 TTL 断言，不修改生产表结构或 TTL。后续浏览器和 DLQ 验证仍待新一轮 CI。故障恢复轮询允许 90 秒，覆盖配置中的 30 秒 consumer 暂停时间。
