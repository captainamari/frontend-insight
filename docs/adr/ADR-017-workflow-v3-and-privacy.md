# ADR-017：workflow contract v3、步骤触发与隐私

- 状态：Accepted
- 日期：2026-08-21
- 对应基线：requirements-v1.8、mvp-plan-v1.5 R0

## 决策

workflow 定义和激活版本不可变，步骤具有稳定 `workflowKey/stepKey/stepOrder`。运行实例 ID 由 SDK 随机生成，公共 API 不接受业务方传入实例 ID。所有 workflow 动作使用 `event=custom` 和受控 `payload.name`，并携带 definition version。

显式 SDK 或 `data-fi-action` 优先作为触发源；DOM selector 只作受控适配，不采集 DOM 文本。查询侧按实例容忍乱序和迟到，以首个终态为结果并暴露重复终态冲突；超时只能标记近似放弃，不能推断业务失败。

设备、报警、订单、人员等业务 ID 不得作为实例 ID 或 payload。R0 seed 仅使用 `explicit_sdk`，fixture 覆盖并发、乱序、重复终态和超时。

## R4-B 实施补充（2026-09-28）

SDK 0.5.0 的公开调用参数统一为 `operationKey`（独立 tracker 与 workflow handle 相同）；其值复用已登记且 operationLifecycleEnabled=true 的 feature 标识。工作流步骤配置仍是 `operationKey + state`。contract v3 的 operation 事件沿用 canonical `payload.featureKey`，不新增 `payload.operationKey`、双 key 或兼容 alias；这里只区分配置/调用参数和既有事件字段，不创建新身份体系。

事件归并、准入区间、开始cohort、asOf、普通分位数及受控适配器实施边界见 R4-B decisions。Q07 与缺中间步骤/跳步扩展没有本次批准结论，受影响事实保持未解析，不改变既有任务成功率或评分权重。
