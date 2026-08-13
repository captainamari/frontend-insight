# Frontend Insight 文档索引

当前实现基线：2026-08-04。M0–M8 已合并 `main`；M6–M8 的已实现行为仍以需求文档 v1.6、MVP 开发计划 v1.3 和对应 ADR/验收记录为依据。

当前待评审产品与修改基线：

- [需求文档 v1.7](product/requirements-v1.7.md)：结合内部系统前端监测指标字典和产品流程图，统一领域实体、字段/事件/UI 命名、指标公式与分母、分位数、采集上报、隐私边界、页面职责和下钻关系；
- [修改计划 v1.4](planning/mvp-plan-v1.4.md)：基于“当前全部为可丢弃测试数据”的前提，评估对 M0–M8 的影响，并以 M8.1-A（Pre-1.0 重置与规范口径）、M8.1-B（新增受控采集）、P2/P3（业务/组织/安全能力）分批实施和验收。

v1.7/v1.4 是后续改造目标，不表示 main 上已经实现。评审通过并完成对应实施、测试和验收前，产品不得把新指标或新采集标记为可用。

建议阅读顺序：

1. [需求文档 v1.7](product/requirements-v1.7.md)：确认规范名、指标口径、采集边界、产品流程和分期优先级；
2. [修改计划 v1.4](planning/mvp-plan-v1.4.md)：确认 M0–M8 影响、全量测试数据重置、schema v3/SDK 0.4 唯一基线、工作包、测试、发布门与工作量；
3. [需求文档 v1.6](product/requirements-v1.6.md) 与 [MVP 开发计划 v1.3](planning/mvp-plan-v1.3.md)：核对 M6–M8 当前已实现基线；
4. [v1.3 评审报告](reviews/v1.3-review.md)：了解早期范围、用户体验和技术方案为何调整；
5. [M6 Mac 本地验收指引](guides/m6-local-acceptance-macos.md) 与 [M7/M8 Mac 本地验收指引](guides/m7-m8-local-acceptance-macos.md)：验证当前实现。

当前实现与验收记录：

- [M0 技术验证与本地验收](spikes/m0-results.md)；
- [事件传输契约 v1](contracts/event-contract-v1.md)；
- [事件传输契约 v2](contracts/event-contract-v2.md)；
- [ADR-008：事件契约与数据库迁移边界](adr/ADR-008-contract-and-migration-boundaries.md)；
- [ADR-009：运营实体与模板](adr/ADR-009-operational-entities-and-templates.md)；
- [ADR-010：事件 v2 与任务实例](adr/ADR-010-event-contract-v2-operation-lifecycle.md)；
- [ADR-011：指标目录与血缘](adr/ADR-011-metric-catalog-and-lineage.md)；
- [ADR-012：项目运营指数 v1](adr/ADR-012-operational-index-v1.md)；
- [ADR-013：M7 生产硬化与 M8 可观测性 v1](adr/ADR-013-m7-production-and-m8-observability-v1.md)；
- [M1 本地工程与迁移验收](guides/m1-local-engineering-macos.md) 与 [M1 实现记录](progress/m1-results.md)；
- [M2–M4 本地验收指引](guides/m2-m4-local-macos.md) 与 [M2–M4 实现记录](progress/m2-m4-results.md)；
- [M5 实现与验收记录](progress/m5-results.md)；
- [M6 本地验收指引](guides/m6-local-acceptance-macos.md)；
- [M7/M8 本地验收指引](guides/m7-m8-local-acceptance-macos.md) 与 [M7/M8 实现记录](progress/m7-m8-results.md)。

项目学习与维护：

- [M0–M5 项目学习指南](learning/README.md)：从架构与边界出发精读事件契约、Web SDK、数据链路、管理 API、Vue 管理端、demo 和本地产品闭环；
- [M5 前端架构与运行时](learning/08-m5-frontend-architecture-and-runtime.md)；
- [M5 分析页面与数据状态](learning/09-m5-analytics-views-and-data-states.md)；
- [M5 接入、demo 与本地闭环](learning/10-m5-onboarding-demo-and-local-loop.md)；
- [M5 测试与代码精读实验](learning/11-m5-testing-and-code-reading-labs.md)；
- [测试、运维与变更手册](learning/06-testing-operations-and-change-playbooks.md)；
- [M0–M4 代码精读实验](learning/07-code-reading-labs.md)。

历史产品与开发基线：

- [需求文档 v1.6](product/requirements-v1.6.md) 与 [MVP 开发计划 v1.3](planning/mvp-plan-v1.3.md)：M6–M8 当前实现基线，并保留 M9 规划；
- [需求文档 v1.5](product/requirements-v1.5.md) 与 [MVP 开发计划 v1.2](planning/mvp-plan-v1.2.md)：M0–M5 功能采用实现基线；
- [需求文档 v1.4](product/requirements-v1.4.md) 与 [MVP 开发计划 v1.1](planning/mvp-plan-v1.1.md)：早期范围基线；
- [智慧园区内部产品运营指标与项目运营指数方案 v0.2](planning/operational-metrics-health-plan-v0.2.md) 与 [v0.1](planning/operational-metrics-health-plan-v0.1.md)：M6 决策演进。

实现过程中，产品范围以最新已通过评审的需求文档为准，任务次序以对应开发计划为准，架构或隐私方向变化必须通过 `docs/adr/` 记录。待评审文档不能覆盖已验收基线。
