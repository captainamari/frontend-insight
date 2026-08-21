# ADR-015：六模块信息架构与正式路由

- 状态：Accepted
- 日期：2026-08-21
- 对应基线：requirements-v1.8、mvp-plan-v1.5 R0

## 决策

正式信息架构固定为“全部项目”以及项目内“概览、业务、页面、指标、设置”五个模块。正式路由和 API 名由 canonical manifest 生成并共享：项目入口 `/projects`，项目内路由依次为 `/overview`、`/business`、`/pages`、`/metrics`、`/settings`。

查询范围固定为 `7d/30d/90d/180d/365d/custom`；默认粒度分别是 day/day/week/month/month，自定义范围最长 13 个月并自适应粒度。旧 IA 只作为历史实现存在，后续里程碑按删除清单迁移，不增加兼容路由或第二套正式导航。

## R0 边界

R0 只冻结名称、DTO 和路由契约，不交付新页面，也不把旧页面包装成新模块。页面实施从 R1 开始。
