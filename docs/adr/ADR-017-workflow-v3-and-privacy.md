# ADR-017：workflow contract v3、步骤触发与隐私

- 状态：Accepted
- 日期：2026-08-21
- 对应基线：requirements-v1.8、mvp-plan-v1.5 R0

## 决策

workflow 定义和激活版本不可变，步骤具有稳定 `workflowKey/stepKey/stepOrder`。运行实例 ID 由 SDK 随机生成，公共 API 不接受业务方传入实例 ID。所有 workflow 动作使用 `event=custom` 和受控 `payload.name`，并携带 definition version。

显式 SDK 或 `data-fi-action` 优先作为触发源；DOM selector 只作受控适配，不采集 DOM 文本。查询侧按实例容忍乱序和迟到，以首个终态为结果并暴露重复终态冲突；超时只能标记近似放弃，不能推断业务失败。

设备、报警、订单、人员等业务 ID 不得作为实例 ID 或 payload。R0 seed 仅使用 `explicit_sdk`，fixture 覆盖并发、乱序、重复终态和超时。
