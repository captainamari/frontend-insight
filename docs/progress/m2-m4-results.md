# M2-M4 实现与验收记录

## 已完成

- M2：Web SDK 生命周期、隐私边界、功能采用 API、长时可见累计、队列/发送/重试/诊断和 12 KiB gzip 预算；
- M3：接收校验、项目级账号 HMAC、Kafka envelope、consumer 批写/死信/暂停恢复、每项目数据状态；
- M4：本地认证与刷新轮换、admin/viewer、项目成员与审计、项目/功能/onboarding、固定分析 API；
- MySQL migration `003_auth_sessions_and_data_status.sql`；
- Chromium/WebKit SDK 契约与 M2-M4 Compose 端到端 verifier。

## 当前自动化结果

| 检查                               | 本地结果                                      |
| ---------------------------------- | --------------------------------------------- |
| Prettier / ESLint / workspace 边界 | 通过                                          |
| TypeScript 全 workspace            | 通过                                          |
| Vitest                             | 41 项通过                                     |
| SDK ESM gzip                       | 4,448 bytes，预算 12,288 bytes                |
| Chromium/WebKit                    | 当前执行环境未预装对应浏览器；CI 安装后执行   |
| Docker Compose 全链路              | 当前执行环境无 Docker；由 GitHub Actions 执行 |

最终提交以 `m2-m4/full-flow` GitHub 状态为准。目标 M1 Mac 仍需按本地指引完成一次人工验收，重点记录首次构建耗时、稳态内存和 Docker Desktop 资源设置。

## 设计边界

- 未加入 Redis、Elasticsearch、自定义指标、健康度评分、错误/性能监控；
- 未实现 M5 的 Vue 管理后台和三场景 demo-app；
- Kafka 使用 at-least-once，查询侧按 `eventId` 去重，不宣称财务级 exactly-once；
- 账号表示项目级 HMAC 后的业务账号引用，浏览器/会话不解释为真实人数；
- 数据链路延迟时返回状态，不把缺失数据静默显示为 0。
