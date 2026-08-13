# Frontend Insight

内部 Web 产品运营分析系统。它回答页面和功能是否真正被看见、持续使用，关键任务是否完成，以及停留和操作耗时是否符合显式业务目标；同时明确区分账号、匿名浏览器和会话。

M0-M8 已完成基础设施、Web SDK、数据链路、管理后台、运营指标与前端可观测性。M8.1-A 将产品入口固定为“入口页 → 项目概览”，项目内按业务分析、页面分析、指标管理和设置组织；M8.1-B 在独立 opt-in 下补齐 API/资源分母、首屏、列表、长任务、白屏候选和错误 breadcrumb。

## M7/M8 快速开始

目标环境：Apple Silicon M1、32 GB 内存、Docker Desktop + Compose v2。

```bash
./scripts/dev doctor
./scripts/dev bootstrap
./scripts/dev up
./scripts/dev smoke
./scripts/dev status
```

- 管理后台：<http://localhost:4173>
- 三场景 demo：<http://localhost:4174>
- 管理员：`admin@example.invalid` / `LocalAdmin-1234`
- viewer：`viewer@example.invalid` / `LocalViewer-1234`

demo 覆盖数据/图表渲染、导出/导入/配置/指令结果、大屏持续可见，以及受控 JS/资源/API/Web Vital/P1 事件。运行时统一为 schema v3 / SDK 0.4.0；浏览器发送前裁剪凭据、邮箱、URL 参数与动态 ID。P1 走查见 [M8.1-B Mac 本地验收指引](docs/guides/m8.1-b-local-acceptance-macos.md)。

M7 正式负载与故障演练：

```bash
bash scripts/m7 load full
bash scripts/m7 fault all --confirm-disruption
bash scripts/m7 release-drill --confirm-disruption
```

Production Compose 使用文件型 Docker Secret，并提供 additive deploy、备份、恢复和保留镜像回滚：

```bash
bash scripts/production init-secrets --confirm-create
bash scripts/production doctor
bash scripts/production deploy pilot-001
```

这些自动化不替代目标环境演练、真实项目试点和 M8 三项目/处理人发布门。

停止不会删除数据：

```bash
./scripts/dev down
```

只有显式确认才会删除本地命名卷：

```bash
./scripts/dev reset --confirm-local-data-loss
```

## M6 已实现范围

- module/page definition 管理、三类页面模板、核心页面和关键度；
- feature 页面归属、关键任务、权重、超时和 v2 operation lifecycle；
- 页面可见时长平均/p50/p75/覆盖率、会话页面深度和模块广度；
- 任务达成、失败、取消、近似放弃和成功耗时；
- 单一 `MetricCatalog`、definition version、固定公式与 lineage JSON；
- 版本化业务目标、指标 profile、clone-on-write 和显式激活；
- 30/25/30/15 四维项目运营指数、至少 3 维与 70% 权重覆盖 gate；
- 运营概览、页面详情、雷达图与无障碍等价表格、配置 UI；
- admin 写、viewer 只读，所有 M6 配置变更保留审计；
- 无 M6 配置或只有 v1 数据的项目继续使用 M5 页面。

项目运营指数用于确定调查和投入优先级，不替代技术 SLO，也不用于人员绩效。

## M7/M8.1 已实现范围

- 20 events/s 持续与 200 events/s 峰值固定负载工具、吞吐/延迟/追平报告；
- Kafka、ClickHouse、consumer 故障注入及真实 readiness/恢复语义；
- production Compose 的文件 Secret、只读文件系统、资源上限、优雅停止和日志轮转；
- additive migration、保留镜像应用回滚、MySQL/ClickHouse 校验和备份与恢复；
- schema v3 / SDK 0.4.0 唯一基线，v1/v2 明确拒绝；
- 项目入口页、项目概览，以及业务分析/页面分析/指标管理/设置的信息架构；
- 七类项目级版本化 P1 collector，默认关闭、独立采样、可远程回滚；
- API 请求 P50/P90 与分母、资源失败率、显式首屏、列表行数桶、长任务、白屏候选和受限 breadcrumb；
- 浏览器端凭据/PII/URL 裁剪、粗粒度浏览器/OS/视口、显式 release/environment；
- 稳定错误组、影响账号/浏览器/页面/版本、性能 p75 与固定只读告警；
- 页面分析中的 coverage/采样率/分子分母/样本不足/未采集，以及错误组下钻和受控 demo；
- M5/M6 回归与 M8 Chromium/WebKit E2E。

项目运营指数 v1 保持不变；SourceMap、运营指数 v2、自定义告警和 AI 分析仍按独立阶段门执行。

## M5 保留能力

- Vue 3 + TypeScript + Element Plus + ECharts 管理端；
- URL 可分享的项目/时间筛选、认证、全局错误与请求 ID；
- 功能采用首页、功能详情、页面访问、项目接入与功能配置；
- loading、empty、stale、error、forbidden 和链路状态；
- admin/viewer 界面与服务端双重权限；
- 三场景 demo、可见事件解释和模拟 token 泄露回归；
- full Compose、幂等 seed、数据流 smoke、Chromium/WebKit E2E。

M5 保留能力不包含 M6–M8 的指标、生产硬化和可观测性扩展。

## M2-M4 数据与管理能力

- npm ESM Web SDK：页面/SPA 生命周期、标签页会话、三类功能事件、长时可见心跳、隐私边界、批量与离开上报；
- 接收链路：64 KiB/50 条边界、Origin/项目/限流/schema/时间/feature 校验、项目级账号 HMAC、Kafka 202 语义；
- consumer：Kafka at-least-once、ClickHouse 批写、查询侧 `eventId` 去重、毒消息无 payload 死信；
- 本地认证、admin/viewer、项目成员、审计、项目/功能/onboarding API；
- overview、trend、pages、features、feature detail 固定口径查询，以及数据状态和健康接口。

底层链路仍可独立验证：

```bash
./scripts/m2-m4 doctor
./scripts/m2-m4 up
./scripts/m2-m4 verify
./scripts/m2-m4 status
./scripts/m2-m4 down
```

详细步骤见 [M2-M4 Mac 验收指引](docs/guides/m2-m4-local-macos.md)。

## M1 工程与迁移基线

- pnpm/TypeScript monorepo 与统一 CI 检查；
- 版本化事件 JSON Schema、生成类型、拒绝码和三类 golden fixtures；
- MySQL 元数据表和 ClickHouse 原始事件表的版本化 migration；
- Apple Silicon Mac 上可一键验证空库、升级、幂等、TTL 和固定事件查询。

```bash
./scripts/m1 doctor
./scripts/m1 up
./scripts/m1 verify
./scripts/m1 status
./scripts/m1 down
```

详细预期见 [M1 本地工程与迁移验收](docs/guides/m1-local-engineering-macos.md)。

## M0 历史验证

M0 证明 MySQL、ClickHouse、Kafka、浏览器 Beacon 和 ARM64 Compose 基线可行。独立 Compose 和结果文件仍保留作为技术决策证据；当前统一使用 M5 的 `./scripts/dev` 产品闭环命令。历史结果见 [M0 技术验证结果](docs/spikes/m0-results.md)。

## 开发者自检

不启动容器可以执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm exec playwright install chromium webkit
pnpm test:browser
```

启动 Compose 后可以执行 M5/M6 回归与 M8 页面验收：

```bash
pnpm test:m5:e2e
pnpm test:m6:e2e
pnpm test:m8:e2e
```

分支推送后，GitHub Actions 会执行静态/单元检查、两种浏览器 SDK 契约、完整 Compose 数据流、M7 负载/故障/恢复和 M5/M6/M8 产品闭环。Linux CI 不能替代 Apple Silicon 目标 Mac、部署环境和真实试点的最终人工验收。
