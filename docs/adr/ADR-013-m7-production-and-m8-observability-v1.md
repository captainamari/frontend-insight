# ADR-013：M7 生产硬化与 M8 可观测性 v1

- 状态：Accepted
- 日期：2026-08-02
- 对应基线：requirements-v1.6、mvp-plan-v1.3

## 背景

M6 已通过产品验收并部署。后续需要同时降低私有化部署风险，并让前端开发在用户反馈前看到生产 JS、资源、API 错误和页面性能证据。M7 与 M8 的代码依赖相邻，但产品退出条件不同：M7 还需要目标环境演练和真实项目试点，M8 还需要至少三个项目确认错误定位是高频任务并明确处理人。

## 决策

### 1. 同一变更、两个阶段门

M7 与 M8 在同一分支交付，复用契约、迁移、Compose 与回归流水线；Go/No-Go 分开记录。代码和受控验收通过不等于真实项目试点自动完成，部署环境的备份恢复、故障演练、容量证据与业务 owner 仍需人工签字。

### 2. M7 生产边界

- production Compose 使用 Docker Secret 文件，不把 Secret 写入 Compose 环境明文或版本库；应用支持 `*_FILE`。
- API、consumer、数据库、Kafka 与 Web 都有资源上限、优雅停止和有界 `json-file` 日志轮转。
- migration 只向前、可幂等；应用回滚复用保留镜像，不执行破坏性 down migration。
- 备份先停止 API/Web 接流、等待 Kafka consumer group lag 归零并停止 consumer，再导出 MySQL 全库、ClickHouse `raw_events` Native 数据、元数据与 SHA-256；完成或失败都会尝试恢复服务。恢复前强制生成安全备份并要求精确确认参数。
- 固定负载剖面为 20 events/s 持续 60 秒、200 events/s 峰值 10 秒；要求接收无失败、p95 ≤1 秒且 120 秒内全部可查询。
- Kafka publish 使用有界重试与 5 秒请求 timeout；不可用时接收明确返回 503，不伪造 202。超时结果按“未确认”处理，SDK 可用相同 `eventId` 重试并由查询侧去重；consumer/ClickHouse 中断期间已进入 Kafka 的数据在恢复后可查询。
- `/health/ready` 对 MySQL、ClickHouse 和 Kafka 做真实探测；`live` 只代表进程存活。
- 本地 Docker 日志按大小和文件数限制；生产 30 天集中日志留存、告警通知与备份异地复制由部署环境 owner 配置，不由单机 Compose 假装完成。

### 3. M8 事件和隐私

- 新增 `error_js`、`error_resource`、`error_api`、`web_vital`，沿用兼容的 schema v2 外壳。
- 采集为逐项目显式 opt-in，release/environment 必填；自动全局 `fetch` 包装默认关闭。
- URL query/hash、Bearer/JWT、凭据赋值、邮箱与动态路径 ID 在浏览器发送前删除或替换。
- 不采集请求/响应正文、header、DOM、录屏、源码、User-Agent 原文和 SourceMap。
- 只保存浏览器/OS 粗粒度家族与 compact/standard/wide 视口档位。
- M8 数据与现有原始事件共用 90 天 TTL；日志和死信仍禁止记录 payload。

### 4. 稳定读模型

- 错误组 ID 是脱敏稳定特征的 SHA-256；API 状态只按状态段参与分组，账号、visitor、页面、时间和发布不参与。
- 影响范围分别返回去重 HMAC 账号、visitor 浏览器实例、页面、发布版本和粗粒度浏览器/OS/视口。
- Web Vitals 使用固定阈值：LCP 2500/4000 ms、CLS 0.1/0.25、INP 200/500 ms、FCP 1800/3000 ms、TTFB 800/1800 ms。
- 固定错误告警：warning 为次数 ≥5 且浏览器 ≥3；high 为次数 ≥10 或浏览器 ≥5；critical 为次数 ≥50、账号 ≥10，或 5xx 次数 ≥20。
- 固定性能告警：样本 ≥20 且 poor ≥30%；poor ≥50% 为 high。
- 告警是只读的当前范围证据，不在 v1 中加入确认、关闭、自定义路由或通知状态。

### 5. 明确不做

- 项目运营指数 v1 的公式、历史和展示门槛完全不变；错误/性能加入总分必须另发指数 v2 并重新评审。
- SourceMap 只有在脱敏首帧无法满足真实定位任务、且源码暴露、上传、权限、保留、版本匹配和容量评审通过后再触发。
- 不把错误/性能与使用下降的时间重合解释为因果。
- 不在 M8 引入任意告警 DSL、任意查询、自动修复或 AI 分析。

## 后果

- M8 能在不扩大运营指标引擎范围的情况下形成错误、性能、发布和影响范围的稳定 read model。
- 旧项目、v1 事件和未开启 M8 的 SDK 保持可用；M8 页面显示空态，不生成虚假错误或性能结论。
- 生产镜像与数据 schema 可以独立回滚，但恢复数据是破坏性运维动作，必须使用验收指引中的备份和确认流程。
- M7 真实试点与 M8 三项目/owner 证据是发布门，不会被 CI 的 synthetic 数据替代。
