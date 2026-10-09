# Frontend Insight 文档索引

本索引按 `agent/v1-8-r8-cleanup-acceptance` 的 v1.8/R8 内容组织，核对基线 `641e106252e7053ea9a306fddcbc1c80ad66592e`（2026-10-09）。该分支已包含质量刷新修复；是否完成修复后手工复验、业务批准与最终发布，以 [R8 results](progress/v1.8-r8-results.md) 为准。本文不改变历史验收记录，也不表示这些改动已合入默认分支。

## 面向使用者与维护者

| 你要做什么                           | 从这里开始                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 登录并使用系统、按角色找到工作入口   | [用户操作指南](guides/user-manual/README.md)                                                        |
| 深入理解业务/质量指标并配置系统      | 用户指南中的分析、指标管理和设置章节                                                                |
| 从设计参与者成长为维护者             | [开发者学习与维护指南](learning/README.md)，当前主教材为 12–17 章                                   |
| 在本地走通和验收系统                 | [v1.8 最终 Mac 验收指南](guides/v1.8-local-acceptance-macos.md)                                     |
| 部署到 Ubuntu 22.04                  | [生产部署指南](guides/production-ubuntu-22.04.md) 与 [兼容说明](guides/deployment-compatibility.md) |
| 理解最近“触发错误但质量页看不到”问题 | [质量刷新反馈与修复记录](progress/v1.8-r8-quality-refresh-fix.md)                                   |

用户指南解释日常任务和结果含义；学习指南解释实现及修改；验收指南说明如何收集通过/失败证据。这三者用途不同。

## 当前需求、契约与架构依据

- [需求 v1.8](product/requirements-v1.8.md) 与 [开发计划 v1.5](planning/mvp-plan-v1.5.md)：范围、业务口径、阶段与交付要求。
- [规范名 v1.8](contracts/canonical-names-v1.8.md) 与 [事件契约 v3](contracts/event-contract-v3.md)：命名、字段、事件和传输边界。
- [新旧术语与删除清单](contracts/v1.8-r0-deletion-checklist.md)：R8 正式入口替代与历史能力去向。
- [ADR 目录](adr/)：先看与修改有关的决策，不用早期约定覆盖后续已批准决策。
- [实现进度目录](progress/)：按阶段查实际实现、决策、未完成事项与证据；以真实记录区分自动化、手工与业务批准。

## 当前验收和专题入口

| 范围              | 操作/接入说明                                                                                                                                                     | 结果入口                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| R1-A 分析对象     | [验收](guides/v1.8-r1a-local-acceptance-macos.md)                                                                                                                 | [results](progress/v1.8-r1a-results.md)                                                                            |
| R1-B 指标库       | [验收](guides/v1.8-r1b-local-acceptance-macos.md)                                                                                                                 | [results](progress/v1.8-r1b-results.md)                                                                            |
| R1-C 分数         | [验收](guides/v1.8-r1c-local-acceptance-macos.md)                                                                                                                 | [results](progress/v1.8-r1c-results.md)                                                                            |
| R2 项目入口       | [验收](guides/v1.8-r2-local-acceptance-macos.md)                                                                                                                  | [results](progress/v1.8-r2-results.md)                                                                             |
| R3 项目概览       | [验收](guides/v1.8-r3-local-acceptance-macos.md)                                                                                                                  | [results](progress/v1.8-r3-results.md)                                                                             |
| R4 业务分析       | [模块](guides/v1.8-r4a-local-acceptance-macos.md) / [工作流](guides/v1.8-r4b-local-acceptance-macos.md) / [效率与组织](guides/v1.8-r4c-local-acceptance-macos.md) | [R4-A](progress/v1.8-r4a-results.md) / [R4-B](progress/v1.8-r4b-results.md) / [R4-C](progress/v1.8-r4c-results.md) |
| R5 质量分析       | [业务接入](guides/v1.8-r5a-business-integration.md) / [统一验收](guides/v1.8-r5-unified-acceptance-macos.md)                                                      | [R5-A](progress/v1.8-r5a-results.md) / [R5-B](progress/v1.8-r5b-results.md)                                        |
| R6 页面运营       | [验收](guides/v1.8-r6-acceptance.md)                                                                                                                              | [results](progress/v1.8-r6-results.md)                                                                             |
| R7 设置           | [验收](guides/v1.8-r7-acceptance.md)                                                                                                                              | [results](progress/v1.8-r7-results.md)                                                                             |
| R8 清理与最终回归 | [统一验收](guides/v1.8-local-acceptance-macos.md)                                                                                                                 | [results](progress/v1.8-r8-results.md) / [decisions](progress/v1.8-r8-decisions.md)                                |

专题验收文件保留当时的上下文。若旧入口已经清理，实际操作从当前用户指南或 R8 统一验收进入；不要在已删除 URL 上继续验收。

## 历史资料

以下用于追溯，不是当前部署或产品入口：

- 早期需求与计划：[v1.7](product/requirements-v1.7.md) / [计划 v1.4](planning/mvp-plan-v1.4.md)、[v1.6](product/requirements-v1.6.md) / [计划 v1.3](planning/mvp-plan-v1.3.md)、[v1.5](product/requirements-v1.5.md) / [计划 v1.2](planning/mvp-plan-v1.2.md)、[v1.4](product/requirements-v1.4.md) / [计划 v1.1](planning/mvp-plan-v1.1.md)。
- [v1.3 评审报告](reviews/v1.3-review.md)、[M0 技术验证](spikes/m0-results.md)、[契约 v1](contracts/event-contract-v1.md)、[契约 v2](contracts/event-contract-v2.md)。
- [M1 工程验收](guides/m1-local-engineering-macos.md)、[M2–M4 验收](guides/m2-m4-local-macos.md)、[M5 结果](progress/m5-results.md)、[M6 验收](guides/m6-local-acceptance-macos.md)、[M7/M8 验收](guides/m7-m8-local-acceptance-macos.md)。
- [学习目录中的 01–11 章](learning/README.md)：固定于 M0–M5，用于比较设计演进；12–17 是当前主线。

文档更新应给出适用代码基线。产品要求、已实现能力和待批准事项必须分别描述；新增设计不能自动覆盖已验收事实。
