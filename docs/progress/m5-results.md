# M5 实现与验收记录

## 已完成范围

- Vue 3 + TypeScript 管理端，使用 Element Plus 与 ECharts；
- 登录、刷新令牌、项目权限、全局错误和请求 ID；
- 项目与时间范围保存在 URL；
- loading、empty、stale、error、forbidden 等统一状态；
- 功能采用、功能详情、页面访问、项目接入和功能配置；
- 数据延迟保留旧数据，趋势缺口插入 `null`，不伪造为 0；
- 三场景 demo：数据渲染、操作结果、持续展示；
- demo 明确区分模拟 token 与 analyticsRef，并显示事件解释；
- Mac full Compose、统一脚本、幂等 seed、smoke 和显式 reset；
- Chromium/WebKit 产品闭环自动化。

## 当前自动化结果

| 检查                        | 结果                           |
| --------------------------- | ------------------------------ |
| TypeScript 全 workspace     | 通过                           |
| Vitest                      | 9 个测试文件、65 项通过        |
| Web / demo production build | 通过                           |
| Demo 初始 JS gzip           | 约 33 KiB                      |
| SDK ESM gzip                | 4,419 bytes，预算 12,288 bytes |
| Bash 语法                   | 通过                           |
| Chromium/WebKit M5 产品闭环 | 推送后由 GitHub Actions 执行   |
| Docker Compose 全链路       | 推送后由 GitHub Actions 执行   |

## 设计边界

- M5 只消费 M4 的固定管理和分析 API；没有加入任意 SQL 或拖拽 Dashboard；
- 功能采用趋势由固定查询返回，不引入 Redis 或第二套指标口径；
- demo 的快速大屏阈值只在 `?acceptance=fast` 自动验收入口启用；
- 本地固定账号和密码只用于 Compose，试点与生产配置属于 M6；
- Apple Silicon 原生镜像与人工页面操作仍需在目标 M1 Mac 完成最终验收。
