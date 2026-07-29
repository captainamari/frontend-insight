# Frontend Insight 文档索引

当前评审基线：2026-07-27。最新产品基线为需求文档 v1.5，旧版保留用于查看决策演进。

待评审方案：

- [运营指标与可解释健康度重评估及实施计划 v0.1](planning/operational-metrics-health-plan-v0.1.md)：基于 M0–M5 实现重新评估运营指标目录、健康画像、影响范围和后续里程碑；评审通过前不改变 v1.5/v1.2 基线。

建议阅读顺序：

1. [v1.3 评审报告](reviews/v1.3-review.md)：了解最初范围、用户体验和技术方案为何调整；
2. [需求文档 v1.5](product/requirements-v1.5.md)：以功能采用为核心，确认三类使用场景、身份边界、MVP 范围和验收标准；
3. [MVP 开发计划 v1.2](planning/mvp-plan-v1.2.md)：按阶段门、任务、测试与 Go/No-Go 标准执行；
4. [M5 Mac 本地全流程指南](guides/local-full-flow-macos.md)：从环境体检到三类场景、管理后台和数据闭环验证。

当前实现与验收记录：

- [ADR-007：M0 本地 Mac 运行基线](adr/ADR-007-local-mac-runtime.md)；
- [M0 技术验证与本地验收](spikes/m0-results.md)；
- [事件传输契约 v1](contracts/event-contract-v1.md)；
- [ADR-008：事件契约与数据库迁移边界](adr/ADR-008-contract-and-migration-boundaries.md)；
- [M1 本地工程与迁移验收](guides/m1-local-engineering-macos.md)；
- [M1 实现与验收记录](progress/m1-results.md)；
- [M2–M4 本地验收指引](guides/m2-m4-local-macos.md)；
- [M2–M4 实现与验收记录](progress/m2-m4-results.md)；
- [M5 实现与验收记录](progress/m5-results.md)。

项目学习与维护：

- [M0–M5 项目学习指南](learning/README.md)：从架构与边界出发，依次精读事件契约、Web SDK、数据链路、管理 API、Vue 管理端、三场景 demo 和本地产品闭环；
- [M5 前端架构与运行时](learning/08-m5-frontend-architecture-and-runtime.md)：理解 Vue 组合根、路由认证、URL 状态、API 刷新和轻量共享状态；
- [M5 分析页面与数据状态](learning/09-m5-analytics-views-and-data-states.md)：理解页面/功能采用读模型、缺口、空数据、延迟和 stale 数据如何呈现；
- [M5 接入、demo 与本地闭环](learning/10-m5-onboarding-demo-and-local-loop.md)：理解项目接入、三类成功语义、token 隔离、Compose 与 Nginx；
- [M5 测试与代码精读实验](learning/11-m5-testing-and-code-reading-labs.md)：用单元、双浏览器、Compose 和手工实验验证 M5；
- [测试、运维与变更手册](learning/06-testing-operations-and-change-playbooks.md)：按症状排障，并安全修改契约、指标、权限和 migration；
- [M0–M4 代码精读实验](learning/07-code-reading-labs.md)：验证 SPA 生命周期、长时大屏、重复交付、refresh rotation、DST 和故障恢复。

历史基线：[需求文档 v1.4](product/requirements-v1.4.md)、[MVP 开发计划 v1.1](planning/mvp-plan-v1.1.md)。

实现过程中，产品范围以需求文档为准，任务次序以开发计划为准，架构方向变更通过 `docs/adr/` 中的 ADR 记录。
