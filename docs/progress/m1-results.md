# M1 工程、契约与迁移基线结果

日期：2026-07-21  
分支：`agent/m1-engineering-contract-migrations`

## 完成范围

- pnpm/TypeScript monorepo，统一 lint、typecheck、test、build 和 workspace 边界检查；
- `apps/api`、`apps/consumer`、`apps/web` 的 M1 边界骨架与 fail-fast 环境配置；
- schemaVersion 1 的事件 JSON Schema、生成类型、拒绝码和三类 valid/invalid/golden fixtures；
- MySQL 元数据表、ClickHouse `raw_events`、版本/checksum migration runner；
- Apple Silicon M1 Compose 运行脚本及 GitHub Actions 全量自验。

M1 没有实现正式 SDK、事件接收 API、Kafka consumer、管理后台和分析 Dashboard；进入 M2/M3 前不应把当前分支描述为可用产品。

## 自动验证

| 检查                                                 | 当前结果                                     |
| ---------------------------------------------------- | -------------------------------------------- |
| workspace 依赖循环/跨 app 依赖                       | 通过：0 循环、0 跨 app 依赖                  |
| 格式、ESLint、TypeScript                             | 通过                                         |
| 契约/环境/migration 单测                             | 通过：3 个测试文件（准确数量以 CI 输出为准） |
| 全 workspace 构建                                    | 通过                                         |
| MySQL/ClickHouse 空库、升级、幂等、TTL、fixture 查询 | 由分支 GitHub Actions 执行                   |

## 固定数据预期

| 场景     | `featureKey`           | 事件数 |
| -------- | ---------------------- | -----: |
| 数据查看 | `sales_dashboard`      |      3 |
| 操作功能 | `report_export`        |      4 |
| 长时大屏 | `operations_wallboard` |      6 |

完整容器验收会同时确认总计 13 条事件、账号引用已 HMAC、原始引用未入库、90 天 TTL、月分区、两个跳数索引及典型查询使用 MergeTree。

## 人工验收入口

在目标 M1 Mac 上按 [M1 本地工程与迁移验收](../guides/m1-local-engineering-macos.md) 执行。人工结果应在合并本分支前记录；x86_64 GitHub runner 只能验证可移植性，不能替代 arm64 实机验收。
