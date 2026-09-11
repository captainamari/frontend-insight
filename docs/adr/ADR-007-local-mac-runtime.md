# ADR-007：M0 本地 Mac 运行基线

- 状态：已接受，等待目标设备实测补录
- 日期：2026-07-19
- 决策人：产品负责人

## 背景

MVP 需要由产品负责人在自己的电脑上独立启动、验证和排障。目标设备为 Apple Silicon M1、32 GB 内存、1 TB 硬盘，允许使用 Docker Compose。开发环境另有服务器，但不能代替本地全流程验收。

M0 需要先验证 MySQL、ClickHouse、Kafka、Node.js 客户端、浏览器 CORS/CSP/Beacon 以及最小数据链路，避免进入 M1 后才发现镜像或协议不兼容。

## 决策

1. 使用 Docker Compose v2 管理单节点、本地专用的 MySQL 8.4、ClickHouse 25.8 和 Kafka 4.1.1 KRaft 环境。
2. 不在 Compose 中固定 `platform`。所选镜像必须同时支持 amd64 与 arm64；M1 自动拉取 arm64 镜像，CI 自动拉取 amd64 镜像。
3. 只把 Browser Beacon 测试页和接收 API 绑定到 `127.0.0.1`；数据库和 Kafka 不发布宿主机端口。
4. 本地数据使用带 Compose 项目标签的命名卷。普通停止保留数据，只有带显式确认参数的 reset 才删除本项目卷。
5. M0 接收端不读取浏览器 Authorization、Cookie 或 Web Storage。业务显式传入的 `accountRef` 在接收边界做 HMAC-SHA256，Kafka 与 ClickHouse 只出现 `accountHash`。
6. M0 spike 与生产实现隔离。它验证依赖和协议，不承诺生产容量、可用性或最终模块结构。
7. GitHub Actions 在 Linux amd64 上执行完整 Compose 回归；目标 M1 的镜像架构、启动时间、峰值内存与磁盘必须由目标设备实测，不能用 CI 结果替代。

## 资源边界

Compose 为各服务设置上限：MySQL 768 MiB、ClickHouse 2 GiB、Kafka 1.5 GiB、Node 进程各 256 MiB。`doctor` 要求目标 Mac 至少有 16 GiB 内存与 10 GiB 可用磁盘；产品负责人提供的 32 GiB / 1 TB 基线满足要求。

## 后果

- 优点：环境可重复、数据隔离、普通关闭可恢复，且能同时在 CI 与 M1 上使用原生架构。
- 代价：单节点方案不覆盖高可用；首次下载镜像和 ClickHouse/Kafka 启动会占用时间与磁盘。
- 后续：M5 的完整产品 Compose 可复用命令界面，但必须重新评估资源与迁移，不直接把 spike 当生产部署。
