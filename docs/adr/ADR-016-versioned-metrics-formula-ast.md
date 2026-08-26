# ADR-016：指标版本快照、受控公式 AST 与 DAG

- 状态：Accepted
- 日期：2026-08-21
- 对应基线：requirements-v1.8、mvp-plan-v1.5 R0

## 决策

指标库以 `metric_library_versions` 保存完整不可变快照；激活版本不原地修改。`metric_definitions` 保存 key、单位、实现状态、真实分母、minimum sample 与公式 AST，展示位置另存 `metric_display_bindings`。

公式只能引用同一已注册版本的 metric key 和有限算术/聚合节点。保存前校验节点、单位、最大深度、最大依赖数和 DAG 无环性；禁止原始 SQL、任意字段、任意函数和跨版本隐式引用。除数为零、样本不足、缺少目标、未采集和链路延迟保持独立状态，不折叠为 0。

## 后果

每次定义变化先产生新版本和 golden fixture，再改计算与展示。R0 只建立模型、seed 和合法/非法公式 fixture；完整计算器在后续里程碑实现。
