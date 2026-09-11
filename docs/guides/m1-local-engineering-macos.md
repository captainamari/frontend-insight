# M1 本地工程与迁移验收（Apple Silicon Mac）

本指南只验收 M1：工程基线、事件契约和数据库 migration。它不会启动管理后台、正式 SDK、接收 API 或 Kafka 全链路；这些分别在后续 M2–M4 实现。

## 1. 环境准备

- Apple Silicon M1 或更新芯片；当前验收基线为 32 GB 内存、1 TB 硬盘；
- Docker Desktop 已启动，支持 Docker Compose v2；
- 至少 20 GiB 可用磁盘；
- Git。Node.js 和 pnpm 只在你要直接运行静态检查时需要，数据库验收会在容器内构建。

在仓库根目录确认当前分支：

```bash
git branch --show-current
./scripts/m1 doctor
```

预期看到 `Doctor passed`。第一次执行会从 `.env.m1.example` 复制 `.env.m1`；该文件只用于本地且不会提交。

## 2. 一键启动与验收

```bash
./scripts/m1 up
./scripts/m1 verify
./scripts/m1 status
```

首次构建需要下载 Node、MySQL 和 ClickHouse 镜像，耗时取决于网络。`verify` 会自动完成：

1. 从空库应用 v1 migration；
2. 从 v1 升级到最新版本；
3. 重复执行 migration，确认无重复变更；
4. 写入 `data_view`、`action`、`long_view` 三类固定事件；
5. 按项目、功能和时间查询，并校验事件数量；
6. 检查 ClickHouse 90 天 TTL、月分区、跳数索引和典型查询 `EXPLAIN`。

成功时输出 JSON，其中 `status` 为 `passed`，所有 `steps[].status` 均为 `passed`。`./scripts/m1 status` 应显示 MySQL 与 ClickHouse 为 healthy。

验收后停止容器但保留数据：

```bash
./scripts/m1 down
```

## 3. 直接运行代码检查（可选）

安装 Node.js 24 后执行：

```bash
npm install --global pnpm@11.15.1
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 包括格式、workspace 依赖边界、生成类型一致性、lint、类型检查、契约/配置/migration 单测和全量构建。

## 4. 分项操作

```bash
./scripts/m1 migrate mysql
./scripts/m1 migrate clickhouse
./scripts/m1 migrate all
./scripts/m1 logs
./scripts/m1 logs clickhouse
```

migration 已执行时会跳过；如果已应用 SQL 的 checksum 被改写，命令会失败并要求新增前向 migration。

## 5. 常见问题

| 现象                           | 处理                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| `Docker engine is not running` | 启动 Docker Desktop，等待状态变为 Running 后重试                         |
| 检测到非 arm64                 | 在目标 M1 Mac 运行；`M1_ALLOW_NON_ARM64=1` 只供 CI 冒烟，不代表 Mac 验收 |
| 可用磁盘不足 20 GiB            | 清理 Docker 的无关镜像/缓存，再执行 `doctor`                             |
| 服务未变为 healthy             | 执行 `./scripts/m1 logs mysql` 或 `./scripts/m1 logs clickhouse`         |
| migration checksum 不一致      | 不要改写已应用 SQL；恢复原文件并新增下一个版本 migration                 |
| 本地旧数据影响验证             | 确认数据可丢弃后执行下面的显式 reset 命令                                |

只有以下命令会删除本项目 M1 的本地数据库卷：

```bash
./scripts/m1 reset --confirm-local-data-loss
```

脚本会先列出由 Compose 项目标签识别的卷，不会删除其他项目的卷。删除后重新执行 `up` 和 `verify` 即可验证空库路径。

## 6. 本次人工验收建议

请保存以下输出，作为 M1 在 Apple Silicon 上的验收证据：

```bash
uname -m
docker info --format '{{.Architecture}}'
./scripts/m1 doctor
./scripts/m1 up
time ./scripts/m1 verify
./scripts/m1 status
./scripts/m1 down
```

如果这些步骤通过，表示 M1 基础工程和数据库契约可在你的 Mac 重建；不表示产品页面或完整埋点链路已经完成。
