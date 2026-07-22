# Frontend Insight

内部前端功能采用度监控系统。当前分支只实现 M0：验证本地基础设施与浏览器上报链路，为后续 MVP 开发消除技术风险。

## M0 验证范围

- MySQL：迁移表、连接池、写入与读取。
- ClickHouse：Node.js 客户端批量写入及 `DateTime64(3)` 精度。
- Kafka：单节点 KRaft 模式下生产与消费。
- Browser Beacon：严格 CORS/CSP 下的 `sendBeacon`/`fetch keepalive` 上报，并经 Kafka consumer 到达 ClickHouse。
- 隐私护栏：示例事件不读取 token、Cookie 或 Local Storage；接收端拒绝疑似凭证字段和值。

M0 不包含管理后台、指标配置、正式 SDK、实时计算或生产部署。

## 本地要求

- Apple Silicon Mac（基线：M1、32 GB 内存、1 TB 硬盘）
- Docker Desktop，包含 Docker Compose v2
- Bash

容器镜像均为多架构镜像，不固定 `platform`，在 M1 上会自动使用 arm64 版本。

## 快速开始

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
cd spikes/m0
npm ci
npm test
```

分支推送后，GitHub Actions 会在 Linux x86_64 runner 上执行完整 Compose 冒烟。M1/arm64 仍需在目标 Mac 上执行上面的快速开始命令，不能由 x86 CI 替代。
