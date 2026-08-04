# Frontend Insight 文档索引

当前实现基线：2026-08-02。M0–M5 以 v1.5/v1.2 和对应验收记录为历史依据；M6–M8 按已通过评审的需求文档 v1.6 与 MVP 开发计划 v1.3 实现。

本轮基线：

- [需求文档 v1.6](product/requirements-v1.6.md)：面向智慧园区等复杂内部产品，定义模块/页面/任务、三类页面模板、运营指标、事件 v2、项目运营指数、M8 前端可观测性及 M9 AI 分析助手边界；
- [MVP 开发计划 v1.3](planning/mvp-plan-v1.3.md)：在已完成 M0–M5 的基础上，细化 M6 产品运营闭环，并规划 M7 硬化、M8 可观测性和 M9 多模型 AI 分析、上下文快照及对话历史；
- [智慧园区内部产品运营指标与项目运营指数方案 v0.2](planning/operational-metrics-health-plan-v0.2.md)：第二轮评审通过的决策来源；[v0.1](planning/operational-metrics-health-plan-v0.1.md) 保留用于查看评审演进。

建议阅读顺序：

1. [v1.3 评审报告](reviews/v1.3-review.md)：了解最初范围、用户体验和技术方案为何调整；
2. [需求文档 v1.6](product/requirements-v1.6.md)：确认最新产品定位、指标口径、项目运营指数、可观测性和 AI 分析边界；
3. [MVP 开发计划 v1.3](planning/mvp-plan-v1.3.md)：按 M6–M9 阶段门、任务、测试、迁移和 Go/No-Go 标准执行；
4. [M6 Mac 本地验收指引](guides/m6-local-acceptance-macos.md)：验证 v1/v2 双版本链路、运营指标、项目运营指数、配置版本和 M0–M5 回归；
5. [M7/M8 Mac 本地验收指引](guides/m7-m8-local-acceptance-macos.md)：验证生产策略、负载、故障、恢复，以及错误/性能/发布/固定告警产品闭环。

当前实现与验收记录：

- [ADR-007：M0 本地 Mac 运行基线](adr/ADR-007-local-mac-runtime.md)；
- [M0 技术验证与本地验收](spikes/m0-results.md)；
- [事件传输契约 v1](contracts/event-contract-v1.md)；
- [事件传输契约 v2](contracts/event-contract-v2.md)；
- [ADR-008：事件契约与数据库迁移边界](adr/ADR-008-contract-and-migration-boundaries.md)；
- [ADR-009：运营实体与模板](adr/ADR-009-operational-entities-and-templates.md)；
- [ADR-010：事件 v2 与任务实例](adr/ADR-010-event-contract-v2-operation-lifecycle.md)；
- [ADR-011：指标目录与血缘](adr/ADR-011-metric-catalog-and-lineage.md)；
- [ADR-012：项目运营指数 v1](adr/ADR-012-operational-index-v1.md)；
- [ADR-013：M7 生产硬化与 M8 可观测性 v1](adr/ADR-013-m7-production-and-m8-observability-v1.md)；
- [M1 本地工程与迁移验收](guides/m1-local-engineering-macos.md)；
- [M1 实现与验收记录](progress/m1-results.md)；
- [M2–M4 本地验收指引](guides/m2-m4-local-macos.md)；
- [M2–M4 实现与验收记录](progress/m2-m4-results.md)；
- [M5 实现与验收记录](progress/m5-results.md)；
- [M6 本地验收指引](guides/m6-local-acceptance-macos.md)；
- [M7/M8 本地验收指引](guides/m7-m8-local-acceptance-macos.md)。
- [M7/M8 实现与验收记录](progress/m7-m8-results.md)。

项目学习与维护：

- [M0–M5 项目学习指南](learning/README.md)：从架构与边界出发，依次精读事件契约、Web SDK、数据链路、管理 API、Vue 管理端、三场景 demo 和本地产品闭环；
- [M5 前端架构与运行时](learning/08-m5-frontend-architecture-and-runtime.md)：理解 Vue 组合根、路由认证、URL 状态、API 刷新和轻量共享状态；
- [M5 分析页面与数据状态](learning/09-m5-analytics-views-and-data-states.md)：理解页面/功能采用读模型、缺口、空数据、延迟和 stale 数据如何呈现；
- [M5 接入、demo 与本地闭环](learning/10-m5-onboarding-demo-and-local-loop.md)：理解项目接入、三类成功语义、token 隔离、Compose 与 Nginx；
- [M5 测试与代码精读实验](learning/11-m5-testing-and-code-reading-labs.md)：用单元、双浏览器、Compose 和手工实验验证 M5；
- [测试、运维与变更手册](learning/06-testing-operations-and-change-playbooks.md)：按症状排障，并安全修改契约、指标、权限和 migration；
- [M0–M4 代码精读实验](learning/07-code-reading-labs.md)：验证 SPA 生命周期、长时大屏、重复交付、refresh rotation、DST 和故障恢复。

历史基线：

- [需求文档 v1.5](product/requirements-v1.5.md) 与 [MVP 开发计划 v1.2](planning/mvp-plan-v1.2.md)：M0–M5 功能采用实现基线；
- [需求文档 v1.4](product/requirements-v1.4.md) 与 [MVP 开发计划 v1.1](planning/mvp-plan-v1.1.md)：早期范围基线。

实现过程中，产品范围以最新需求文档为准，任务次序以最新开发计划为准，架构方向变更通过 `docs/adr/` 中的 ADR 记录。
