# Frontend Insight

内部 Web 功能采用分析系统。它回答页面和功能是否真正被看见、成功使用和跨会话复用，同时明确区分账号、匿名浏览器和会话，不输出“健康度”或自动设计评分。

M0-M4 已完成基础设施、工程契约、Web SDK、数据链路和管理/分析 API；M5 增加可直接验收的管理后台、三场景 demo 与 Apple Silicon 本地产品闭环。

## M5 快速开始

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

demo 覆盖数据/图表渲染、导出/导入/配置/指令结果和大屏持续可见，并实时解释预期事件。完整人工步骤和排障见 [M5 Mac 本地全流程指南](docs/guides/local-full-flow-macos.md)。

停止不会删除数据：

```bash
./scripts/dev down
```

只有显式确认才会删除 M5 本地命名卷：

```bash
./scripts/dev reset --confirm-local-data-loss
```

## M5 已实现范围

- Vue 3 + TypeScript + Element Plus + ECharts 管理端；
- URL 可分享的项目/时间筛选、认证、全局错误与请求 ID；
- 功能采用首页、功能详情、页面访问、项目接入与功能配置；
- loading、empty、stale、error、forbidden 和链路状态；
- admin/viewer 界面与服务端双重权限；
- 三场景 demo、可见事件解释和模拟 token 泄露回归；
- full Compose、幂等 seed、数据流 smoke、Chromium/WebKit E2E。

M5 不包含 M6 的生产部署、备份恢复、负载/故障报告和真实项目试点。

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

启动 M5 Compose 后可以执行完整页面验收：

```bash
pnpm test:m5:e2e
```

分支推送后，GitHub Actions 会执行静态/单元检查、两种浏览器 SDK 契约、完整 Compose 数据流和 M5 产品闭环。Linux CI 不能替代 M1/arm64 目标 Mac 的最终人工验收。
