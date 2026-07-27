# Frontend Insight 文档索引

当前实现基线：2026-07-27。最新产品基线为需求文档 v1.5，旧版保留用于查看决策演进。

建议阅读顺序：

1. [v1.3 评审报告](reviews/v1.3-review.md)：了解最初范围、用户体验和技术方案为何调整；
2. [需求文档 v1.5](product/requirements-v1.5.md)：以功能采用为核心，确认三类使用场景、身份边界、MVP 范围和验收标准；
3. [MVP 开发计划 v1.2](planning/mvp-plan-v1.2.md)：按阶段门、任务、测试与 Go/No-Go 标准执行；
4. [Mac 本地全流程指南](guides/local-full-flow-macos.md)：从环境体检到三类场景和 Dashboard 验证。

当前实现与验收记录：

- [ADR-007：M0 本地 Mac 运行基线](adr/ADR-007-local-mac-runtime.md)；
- [M0 技术验证与本地验收](spikes/m0-results.md)；
- [事件传输契约 v1](contracts/event-contract-v1.md)；
- [ADR-008：事件契约与数据库迁移边界](adr/ADR-008-contract-and-migration-boundaries.md)；
- [M1 本地工程与迁移验收](guides/m1-local-engineering-macos.md)；
- [M1 实现与验收记录](progress/m1-results.md)；
- [M2-M4 Mac 验收指引](guides/m2-m4-local-macos.md)；
- [M2-M4 实现与验收记录](progress/m2-m4-results.md)；
- [M5 实现与验收记录](progress/m5-results.md)。

历史基线：[需求文档 v1.4](product/requirements-v1.4.md)、[MVP 开发计划 v1.1](planning/mvp-plan-v1.1.md)。

实现过程中，产品范围以需求文档为准，任务次序以开发计划为准，架构方向变更通过 `docs/adr/` 中的 ADR 记录。
