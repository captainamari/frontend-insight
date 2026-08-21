# v1.8 规范名（生成文件）

> 来源：`packages/event-contract/canonical-names.json`。请勿直接编辑本文件。

## 公共事件字段

| 字段 | 中文名 |
| --- | --- |
| `appId` | 应用 ID |
| `env` | 环境 |
| `release` | 发布版本 |
| `event` | 事件类型 |
| `timestamp` | 事件时间 |
| `pageUrl` | 页面 URL |
| `pageRoute` | 页面路由 |
| `userId` | 用户 ID |
| `deptId` | 部门 ID |
| `roleId` | 角色 ID |
| `sessionId` | 会话 ID |
| `deviceId` | 设备 ID |
| `ua` | 受控 User-Agent |
| `os` | 操作系统 |
| `browser` | 浏览器 |
| `payload` | 受控业务载荷 |

## 事件类型

- `page_view`
- `page_leave`
- `performance`
- `api`
- `error`
- `custom`

## UI 中文名

| key | 中文名 |
| --- | --- |
| `projects` | 全部项目 |
| `projectOverview` | 项目概览 |
| `projectBusiness` | 业务分析 |
| `projectPages` | 页面分析 |
| `projectMetrics` | 指标管理 |
| `projectSettings` | 设置 |
| `module` | 功能模块 |
| `pageQualityTab` | 质量分析 |
| `pageOperationsTab` | 运营分析 |
| `operationalScore` | 运营分数 |
| `qualityScore` | 质量分数 |
| `activeUser` | 活跃用户 |
| `sessionCount` | 会话数（VV） |

## 附件保留指标 key

| key | 中文名 | 类别 | 实施状态 | 交付里程碑 |
| --- | --- | --- | --- | --- |
| `pv` | 页面浏览量 | usage | `partial` | R6 |
| `uv` | 活跃用户数 | usage | `partial` | R6 |
| `dau` | 日活跃用户数 | usage | `not_collected` | R6 |
| `wau` | 周活跃用户数 | usage | `not_collected` | R6 |
| `mau` | 月活跃用户数 | usage | `not_collected` | R6 |
| `vv` | 会话数（VV） | usage | `partial` | R6 |
| `module_penetration` | 功能模块渗透率 | usage | `not_collected` | R4-A |
| `avg_usage_duration` | 人均使用时长 | usage | `not_collected` | R6 |
| `hourly_distribution` | 时段分布 | usage | `not_collected` | R6 |
| `bounce_rate` | 跳出率（单页会话率） | usage | `not_collected` | R6 |
| `task_duration` | 任务耗时 | operation | `partial` | R4-B |
| `form_efficiency` | 表单效率 | operation | `not_collected` | R4-C |
| `operation_fail_rate` | 操作失败率 | operation | `not_collected` | R4-C |
| `repeated_operation_rate` | 重复操作率 | operation | `not_collected` | R4-C |
| `path_steps` | 操作路径步数 | operation | `not_collected` | R4-B |
| `lcp` | 最大内容绘制 | performance | `partial` | R5-A |
| `inp` | 交互到下次绘制 | performance | `partial` | R5-A |
| `cls` | 累积布局偏移 | performance | `partial` | R5-A |
| `fcp` | 首次内容绘制 | performance | `partial` | R5-A |
| `ttfb` | 首字节时间 | performance | `partial` | R5-A |
| `first_screen_time` | 业务首屏时间 | performance | `not_collected` | R5-A |
| `api_duration` | 接口耗时 | performance | `not_collected` | R5-A |
| `api_slow_top` | 慢接口 TOP | performance | `not_collected` | R5-A |
| `list_render_duration` | 列表渲染耗时 | performance | `not_collected` | R5-A |
| `longtask_count` | 长任务次数 | performance | `not_collected` | R5-A |
| `longtask_total` | 长任务总时长 | performance | `not_collected` | R5-A |
| `js_error_rate` | JS 错误率 | stability | `partial` | R5-A |
| `api_error_rate` | API 错误率 | stability | `not_collected` | R5-A |
| `resource_error_rate` | 资源错误率 | stability | `not_collected` | R5-A |
| `blank_screen_rate` | 白屏率 | stability | `not_collected` | R5-A |
| `breadcrumb` | 安全操作面包屑 | stability | `not_collected` | R5-A |
| `dept_usage` | 部门使用率 | organization | `not_collected` | R4-C |
| `role_usage` | 角色使用率 | organization | `not_collected` | R4-C |
| `role_feature_profile` | 角色功能画像 | organization | `not_collected` | R4-C |
| `abnormal_access` | 异常访问 | organization | `not_collected` | R7 |
| `operational_score` | 运营分数 | score | `partial` | R1-C |
| `quality_score` | 质量分数 | score | `not_collected` | R1-C |
