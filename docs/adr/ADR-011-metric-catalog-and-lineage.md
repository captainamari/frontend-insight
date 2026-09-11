# ADR-011：指标语义目录、固定计算与血缘

- 状态：Accepted
- 日期：2026-07-29
- 对应基线：requirements-v1.6、mvp-plan-v1.3

## 背景

M6 需要复合与派生指标，但当前项目没有跨业务任意公式、任意维度和任意 SQL 的自助需求。直接建设通用指标引擎会引入表达式执行、基数、成本、回算和权限治理。

## 决策

1. 指标分为 L0 事实、L1 原子、L2 派生、L3 复合和 L4 读模型。
2. `MetricCatalog` 在代码中注册定义，至少包含业务问题、单位、输入、公式说明、缺失语义、方向、minimum sample、版本、生效时间和 owner。
3. L1 只使用固定 ClickHouse 查询；L2/L3 使用可单测纯函数。
4. API、计算与 UI 说明使用同一个 catalog，不复制公式文案。
5. 启动和测试时校验全局唯一 key、缺失依赖和循环；失败即 fail fast。
6. lineage 由 catalog 的 `inputKeys` 生成 nodes/edges JSON；M6 P0 不提供公式编辑。
7. `0`、`unavailable`、`insufficient_sample`、`missing_target` 与 `data_delayed` 是不同结果。
8. 查询 p95 连续越过门槛前不引入物化 DWS、Redis 或调度集群。

## 后果

- 每个分数都能沿 DAG 回到事实、公式、样本与版本。
- 新指标必须同时增加定义、fixture 和业务解释。
- 图形化血缘可作为 P1 增量，不阻塞 P0 正确性。

## 被否决方案

- 接受前端 SQL、字段名、group by 或公式。
- 用缓存遮蔽慢查询或错误公式。
- 前后端各自维护一套指数计算。
