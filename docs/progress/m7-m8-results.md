# M7/M8 实现与验收记录

- 日期：2026-08-02
- 产品基线：`docs/product/requirements-v1.6.md`
- 开发基线：`docs/planning/mvp-plan-v1.3.md`
- 决策：`docs/adr/ADR-013-m7-production-and-m8-observability-v1.md`
- 本地指引：`docs/guides/m7-m8-local-acceptance-macos.md`

## 1. 范围结论

M7 与 M8 可以在一次变更中实现，因为二者共享事件契约、additive migration、Compose 和回归流水线；但验收仍使用两个阶段门。代码完成或 synthetic CI 通过，不会自动把目标部署环境演练、真实项目扩大试点，以及 M8 的三项目/处理人证据标为完成。

M8 保持为独立 `observability_v1.0.0` 读模型：不修改项目运营指数 v1，不回写历史分数，不引入任意公式/SQL/告警 DSL。SourceMap 保持 `disabled_pending_real_location_evidence`。

## 2. 已交付

### M7

- production Compose 的 Docker Secret 文件、`*_FILE` 进程边界和一次性安全生成；
- API/consumer/web 的只读根文件系统与 tmpfs；全栈 CPU/内存、优雅停止和有界日志轮转；
- Kafka topic metadata、MySQL、ClickHouse 的真实 readiness；
- 20 events/s ×60 秒与 200 events/s ×10 秒固定负载，输出接受、p50/p95、可查询追平和进程指标；
- Kafka、ClickHouse、consumer 故障注入与 marker 恢复验证；
- additive deploy、保留镜像应用回滚、MySQL/ClickHouse 备份、SHA-256 和恢复前安全备份；
- M5/M6/M8 统一 smoke 与 90 分钟 GitHub Actions 产品回路。

### M8

- schema v2 新增 `error_js`、`error_resource`、`error_api`、`web_vital` 及 valid/invalid/golden fixtures；
- SDK v0.3.0 opt-in 自动/显式采集、固定 Web Vitals 等级、全局 fetch 默认关闭；
- 浏览器端凭据、JWT、邮箱、URL query/hash、动态 ID 裁剪；粗粒度 browser/OS/viewport，不保存 User-Agent 原文；
- ClickHouse migration 005、consumer 稳定 SHA-256 错误组与发布/环境/影响字段；
- 项目授权的 overview/errors/detail/web-vitals/releases/alerts 固定 API；
- 错误影响账号/浏览器/页面/版本、页面性能 p75、固定只读告警和数据边界；
- Vue 工作台、错误筛选与下钻、受控四事件 demo、Chromium/WebKit E2E 规格。

## 3. 当前验证证据

本地无容器检查：

| 检查                                   | 结果                                      |
| -------------------------------------- | ----------------------------------------- |
| `pnpm check`                           | 通过                                      |
| workspace boundary / contract check    | 11 packages、0 cycle、0 cross-app 依赖    |
| ESLint / TypeScript / production build | 通过                                      |
| Vitest                                 | 15 files、108 tests 通过                  |
| SDK bundle                             | 7,511 gzip bytes / 12,288 上限，通过      |
| shell / Node 语法与 `git diff --check` | 通过                                      |
| Chromium SDK browser contracts         | 4/4 通过，含 M8 发送前脱敏与 2 ms p95     |
| YAML 解析                              | production Compose 与 M7/M8 workflow 通过 |

当前执行容器没有 Docker daemon，且本地 WebKit 缺少系统动态库，因此 Compose、M5/M6/M8 E2E、M7 正式负载/故障/恢复和 WebKit 由分支 `.github/workflows/m7-m8.yml` 执行；Apple Silicon 最终人工步骤以本地验收指引为准。

## 4. 发布门状态

| 发布门                                     | 状态                         |
| ------------------------------------------ | ---------------------------- |
| 代码、契约、类型、单元、构建、Chromium     | 通过                         |
| Linux Compose 与 WebKit 自动回路           | 等待分支 Actions 结果        |
| Apple Silicon 负载/故障/备份恢复           | 等待本地指引执行             |
| 目标部署环境 Secret/日志/资源/备份异地副本 | 等待部署 owner 签字          |
| M7 真实项目扩大试点                        | 等待项目 owner               |
| M8 三个高频错误定位项目及处理人            | 等待产品/项目 owner          |
| SourceMap                                  | 未触发；符合基线             |
| 项目运营指数 v2                            | 未启动；不得由本变更隐式发布 |

上述外部项未完成前，可以评审和部署受控版本，但不能把真实项目阶段门标为 Go。
