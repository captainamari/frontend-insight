# Frontend Insight

内部 Web 功能采用分析系统。M0 已验证基础设施，M1 已建立工程、事件契约和迁移基线；当前分支继续实现 M2 Web SDK、M3 数据链路和 M4 管理/分析 API。

## M2-M4 已实现范围

- npm ESM Web SDK：页面/SPA 生命周期、标签页会话、三类功能事件、长时可见心跳、隐私边界、批量与离开上报；
- 接收链路：64 KiB/50 条边界、Origin/项目/限流/schema/时间/feature 校验、项目级账号 HMAC、Kafka 202 语义；
- consumer：Kafka at-least-once、ClickHouse 批写、查询侧 `eventId` 去重、毒消息无 payload 死信、基础设施故障有限重试后暂停；
- 本地认证、admin/viewer、项目成员、审计、项目/功能/onboarding API；
- overview、trend、pages、features、feature detail 固定口径查询，以及数据状态和健康接口；
- Vitest、Chromium/WebKit SDK 契约和 Docker Compose 端到端验收。

M2-M4 快速验收（Apple Silicon Mac + Docker Desktop）：

```bash
./scripts/m2-m4 doctor
./scripts/m2-m4 up
./scripts/m2-m4 verify
./scripts/m2-m4 status
./scripts/m2-m4 down
```

`verify` 会自动验证三类 fixture 从 HTTP 经 Kafka/consumer 到 ClickHouse，并检查登录、viewer 越权、分析口径、重复事件、长时可见时长、项目停用和审计。详细步骤见 [M2-M4 Mac 验收指引](docs/guides/m2-m4-local-macos.md)。Vue 管理后台与三场景 demo-app 属于 M5，本分支不包含。

## M1 验证范围

- pnpm/TypeScript monorepo 与统一 CI 检查；
- 版本化事件 JSON Schema、生成类型、拒绝码和三类 golden fixtures；
- MySQL 元数据表和 ClickHouse 原始事件表的版本化 migration；
- Apple Silicon Mac 上可一键验证空库、升级、幂等、TTL 和固定事件查询。

以下 M1 命令仍可单独验证契约和数据库迁移：

```bash
./scripts/m1 doctor
./scripts/m1 up
./scripts/m1 verify
./scripts/m1 status
./scripts/m1 down
```

详细预期和排障见 [M1 本地工程与迁移验收](docs/guides/m1-local-engineering-macos.md)，实现结果见 [M1 验收记录](docs/progress/m1-results.md)。

## M0 验证范围（已合并）

- MySQL：迁移表、连接池、写入与读取。
- ClickHouse：Node.js 客户端批量写入及 `DateTime64(3)` 精度。
- Kafka：单节点 KRaft 模式下生产与消费。
- Browser Beacon：严格 CORS/CSP 下的 `sendBeacon`/`fetch keepalive` 上报，并经 Kafka consumer 到达 ClickHouse。
- 隐私护栏：示例事件不读取 token、Cookie 或 Local Storage；接收端拒绝疑似凭证字段和值。

M0 不包含管理后台、指标配置、正式 SDK、实时计算或生产部署。

## M0 本地要求

- Apple Silicon Mac（基线：M1、32 GB 内存、1 TB 硬盘）
- Docker Desktop，包含 Docker Compose v2
- Bash

容器镜像均为多架构镜像，不固定 `platform`，在 M1 上会自动使用 arm64 版本。

## M0 快速开始

```bash
./scripts/dev doctor
./scripts/dev m0-up
./scripts/dev m0-verify
./scripts/dev m0-status
./scripts/dev m0-down
```

首次执行会从 `.env.m0.example` 创建仅供本地使用的 `.env.m0`。`m0-down` 会保留数据卷；只有下面的显式命令才会删除本项目的本地 M0 数据：

```bash
./scripts/dev m0-reset --confirm-local-data-loss
```

浏览器验证页：<http://localhost:4173>。接收 API：<http://localhost:3100>。

常见排查：

```bash
./scripts/dev m0-logs
./scripts/dev m0-logs kafka
```

更详细的检查项与预期结果见 [M0 技术验证结果](docs/spikes/m0-results.md)。完整产品的本地全流程指引仍在 [macOS 本地全流程指南](docs/guides/local-full-flow-macos.md) 中维护，相关命令会在后续里程碑逐步实现。

## 开发者自检

不启动容器也能执行静态和单元测试：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm exec playwright install chromium webkit
pnpm test:browser
```

分支推送后，GitHub Actions 会执行静态/单元检查、Chromium/WebKit 契约和完整 Compose 数据流。Linux CI 不能替代 M1/arm64 目标 Mac 的最终人工验收。
