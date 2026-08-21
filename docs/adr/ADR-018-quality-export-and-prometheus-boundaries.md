# ADR-018：质量分、外部接口凭证与 Prometheus 标签边界

- 状态：Accepted
- 日期：2026-08-21
- 对应基线：requirements-v1.8、mvp-plan-v1.5 R0

## 决策

运营分与质量分使用独立 `score_definitions`、维度、项目和 gate。两者共享 85/60 色带，但运营状态门槛 80 不得复用于质量分。质量分只有链路健康、真实分母成立且 minimum sample 达标时才计算；无数据或样本不足不能得到满分。

外部接口默认关闭，使用独立随机 token；数据库只保存 hash、前缀、scope、过期/撤销时间和限流配置。`appId` 永远不是秘密凭证。

Prometheus 标签只允许服务、环境、稳定错误类别和有界状态等低基数字段。`pageRoute/error message/userId/deviceId/workflow instance` 不得成为标签；高基数明细留在受权限控制的查询接口。

## R0 边界

R0 建立版本模型、两类 score seed 和手算 fixture，不开放外部接口，也不发布新的 Prometheus 指标。
