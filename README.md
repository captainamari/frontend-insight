# Frontend Insight

内部 Web 产品运营分析系统。它回答页面和功能是否真正被看见、持续使用，关键任务是否完成，以及停留和操作耗时是否符合显式业务目标；同时明确区分账号、匿名浏览器和会话。

M0-M5 已完成基础设施、Web SDK、数据链路、管理后台与三场景 demo。M6 在兼容既有功能采用页面的基础上，增加模块/页面/任务实体、operation lifecycle v2、固定运营指标、可查询血缘和可下钻的项目运营指数。

## M6 快速开始

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

demo 覆盖数据/图表渲染、导出/导入/配置/指令结果和大屏持续可见，并实时解释预期事件。操作型场景使用 v2 operation handle，成功、失败、取消和超时近似放弃不会串联。M6 完整人工步骤和排障见 [M6 Mac 本地验收指引](docs/guides/m6-local-acceptance-macos.md)。

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

## M5 保留能力

- Vue 3 + TypeScript + Element Plus + ECharts 管理端；
- URL 可分享的项目/时间筛选、认证、全局错误与请求 ID；
- 功能采用首页、功能详情、页面访问、项目接入与功能配置；
- loading、empty、stale、error、forbidden 和链路状态；
- admin/viewer 界面与服务端双重权限；
- 三场景 demo、可见事件解释和模拟 token 泄露回归；
- full Compose、幂等 seed、数据流 smoke、Chromium/WebKit E2E。

M6 不包含生产部署、备份恢复、错误/性能监控、AI 分析助手和真实项目试点。

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

启动 Compose 后可以执行 M5 回归与 M6 页面验收：

```bash
pnpm test:m5:e2e
pnpm test:m6:e2e
```

分支推送后，GitHub Actions 会执行静态/单元检查、两种浏览器 SDK 契约、完整 Compose 数据流、M5 回归和 M6 产品闭环。Linux CI 不能替代 Apple Silicon 目标 Mac 的最终人工验收。
