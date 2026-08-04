# M7 + M8 Mac 本地验收指引

适用范围：requirements-v1.6 与 mvp-plan-v1.3 的 M7 生产硬化、M8 前端可观测性 v1。目标机仍为 Apple Silicon、32 GB 内存、Docker Desktop + Compose v2。

本指引把三类证据分开：

1. 可自动验证的代码、契约、数据链路和页面；
2. 会短暂停止本地服务的负载/故障/恢复演练；
3. 只能在目标部署环境与真实项目完成的发布门。

CI 或 synthetic fixture 不能替代第 3 类签字。

## 1. 验收前状态

```bash
git status --short
node --version
pnpm --version
docker compose version
docker info
```

预期：Node.js ≥24、pnpm 11.15.1、Docker 正常；工作区没有不明改动。首次安装：

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium webkit
```

## 2. 不启动容器的完整检查

```bash
pnpm check
pnpm test:browser
bash -n scripts/dev scripts/m7 scripts/production
```

必须全部通过。重点证据：

- event contract v1/v2、M6 operation 与 M8 四类事件 fixture 同时通过；
- SDK v0.3.0 的 JS/资源/API/Web Vital 脱敏、可选 fetch 包装和真实浏览器契约通过；
- M8 错误组、固定告警、权限注入和 migration inventory 单测通过；
- SDK gzip ≤12 KiB、同步事件处理 p95 ≤2 ms；
- production 与本地运维脚本通过 shell 语法检查。

## 3. 启动完整产品与受控数据

```bash
./scripts/dev doctor
./scripts/dev up
./scripts/dev smoke
./scripts/dev status
```

`smoke` 会幂等创建 M6 配置，发送重复的 v1/v2/M8 fixture，并校验：

- Kafka 202、consumer、ClickHouse 查询侧 `eventId` 去重；
- 三个稳定错误组：JS、资源、API；
- 20 个 LCP poor 样本及至少四条固定告警证据；
- 错误组详情、页面 × 发布版本、Web Vitals、release 与边界字段；
- 项目运营指数仍为 `operational_v1_unchanged`，SourceMap 为 deferred。

若 `smoke` 失败，先执行：

```bash
./scripts/dev logs api
./scripts/dev logs consumer
./scripts/dev logs clickhouse
./scripts/dev logs kafka
```

日志和死信中不得出现事件 payload、原始账号引用、token、邮箱或请求正文。

## 4. M8 手工产品验收

### 4.1 受控 SDK 场景

打开 <http://localhost:4174/observability?acceptance=fast>，模拟密码填任意非空值。

依次点击：

1. “模拟 JS 异常”；
2. “模拟 API 503”；
3. “模拟资源失败”；
4. “模拟 LCP poor”。

右侧事件解释应出现 `error_js`、`error_api`、`error_resource`、`web_vital`。浏览器 Network 的 `/v1/events` 请求中：

- 不得出现 `operator@example.invalid`、`private-token`、`token=secret`；
- API path 应为 `/api/budgets/:id`；
- 带 `releaseVersion=2026.08.1-demo` 与 `deploymentEnvironment=production`；
- 只有 browser/OS/viewport 粗粒度档位，不得有 User-Agent 原文；
- 不得有 header、query、请求/响应 body、DOM、源码或 SourceMap。

### 4.2 可观测性工作台

打开 <http://localhost:4173>：

- admin：`admin@example.invalid` / `LocalAdmin-1234`
- viewer：`viewer@example.invalid` / `LocalViewer-1234`

选择 fixture 项目和“最近 7 天”，点击“前端可观测性”。逐项确认：

- 页面顶部明确“项目运营指数仍为 v1”和“SourceMap 暂未启用”；
- 摘要分别显示错误次数、错误组、受影响账号、受影响浏览器、poor 占比和固定告警；
- 趋势将错误与 poor 性能样本并列，且说明相关不代表因果；
- 错误类型和级别筛选可组合使用；
- 点击错误组可以查看脱敏首帧、首次/最近时间、浏览器/OS/视口和“页面 × 发布版本”；
- Web Vitals 表按页面、指标、release 展示 p75、poor 率和样本；
- 固定规则构成可展开，告警没有确认、关闭或自定义编辑入口；
- release 表中的 `2026.08.1` 不会与 `unknown` 静默合并；
- viewer 能读取全部证据，但没有任何修改告警、错误或指数的入口。

自动 UI 验收：

```bash
pnpm test:m5:e2e
pnpm test:m6:e2e
pnpm test:m8:e2e
```

三组都必须在 Chromium 和 WebKit 通过，证明 M8 没有破坏 M0–M6 产品闭环。

## 5. M7 负载验收

快速排障剖面约 7 秒：

```bash
bash scripts/m7 load quick
```

正式验收剖面约 70 秒，随后最多等待 120 秒 consumer 追平：

```bash
bash scripts/m7 load full
```

正式剖面固定为：

- 20 events/s 持续 60 秒；
- 200 events/s 峰值 10 秒，以每批 ≤50 条发送；
- 全部事件使用未归类 `/m7/load`，不会进入项目运营指数。

JSON 报告必须满足：`status=passed`、HTTP 失败为 0、accepted/queryable 等于 expected、请求 p95 ≤1000 ms、120 秒内全部可查询。报告同时包含 API 当前进程的 ingestion/analytics/observability 指标。

## 6. M7 故障注入

以下命令会依次停止本地 consumer、ClickHouse 和 Kafka；不要对共享或生产环境执行：

```bash
bash scripts/m7 fault all --confirm-disruption
```

也可以单独执行：

```bash
bash scripts/m7 fault consumer --confirm-disruption
bash scripts/m7 fault clickhouse --confirm-disruption
bash scripts/m7 fault kafka --confirm-disruption
```

通过标准：

| 故障            | 故障期间                                                       | 恢复后                          |
| --------------- | -------------------------------------------------------------- | ------------------------------- |
| consumer 停止   | consumer readiness 失败；API 仍把事件持久化到 Kafka 并返回 202 | marker 最终可查询，无数据丢失   |
| ClickHouse 停止 | API readiness 失败；已进入 Kafka 的 marker 保留                | consumer 重试后 marker 可查询   |
| Kafka 停止      | API readiness 失败；接收明确返回 503，不返回虚假 202           | 新 marker 返回 202 并最终可查询 |

脚本带退出恢复 trap；如果终端被强制关闭，执行：

```bash
./scripts/dev up
./scripts/dev smoke
```

## 7. 本地升级、应用回滚姿态与恢复演练

此命令会备份本地 MySQL/ClickHouse、停止应用、重跑 additive migration、恢复备份并重新验证完整 flow：

```bash
bash scripts/m7 release-drill --confirm-disruption
```

通过标准：migration 幂等；停流切点导出的 MySQL 与 ClickHouse 内容在恢复后逐字节一致；恢复后新 marker 可写入并查询；M5/M6/M8 既有读模型全部可查；新增 nullable 列保留且不执行 down migration。演练不会用只适合干净数据窗口的固定 PV 断言误判已正确恢复的负载数据，证据文件只写入已忽略的 `.runtime/m7-release-drill`。

## 8. Production Compose 策略验收

首次只在本机生成 Secret；命令不会打印值，也不会覆盖已有或半成品 Secret 集：

```bash
bash scripts/production init-secrets --confirm-create
bash scripts/production doctor
```

检查 `.secrets/production` 目录与文件权限为 700/600，并确认：

- `docker compose config` 中没有 `local-only` 凭据；
- API/consumer 使用 `*_FILE`，refresh cookie secure；
- 服务有 CPU/内存上限、优雅停止和 `json-file` 大小/文件数轮转；
- Web/API/consumer 使用只读根文件系统与必要 tmpfs；
- `.env.production` 只有非 Secret 设置。

单机 pilot 部署示例：

```bash
bash scripts/production deploy pilot-001
bash scripts/production verify
bash scripts/production status
```

生产必须在 TLS 反向代理和内网 ACL 后暴露 Web；不要直接公开 API/consumer 端口。集中日志 30 天留存、备份异地复制、通知路由和基础设施高可用属于部署环境 owner 的必填项，单机 Compose 不宣称代替它们。

备份和回滚：

```bash
bash scripts/production backup before-upgrade
bash scripts/production rollback pilot-001 --confirm-rollback
```

`backup` 为取得 MySQL/ClickHouse 一致切点，会短暂停止 API/Web 接流、等待 Kafka lag 归零并停止 consumer；应在维护窗口执行。脚本无论成功或中途失败都会尝试恢复服务，结束后仍须执行 `verify`。

恢复会替换当前 MySQL/ClickHouse 数据，且先自动建立 pre-restore 安全备份：

```bash
bash scripts/production restore before-upgrade --confirm-replace-data
```

恢复前必须验证备份副本在另一存储位置可读取；不要把 `backups/` 或 `.secrets/` 提交到 Git。

## 9. 真实项目发布门

自动验收全绿后仍需记录以下外部证据：

- M7：目标部署环境完整备份/恢复、Kafka/ClickHouse/consumer 故障演练、资源峰值、日志/通知、升级/应用回滚 owner 与时间；
- M7：至少一个真实内部产品扩大试点，核对 20/200 events/s 剖面是否覆盖实际峰值；
- M8：至少三个项目确认错误定位为高频任务，并为固定告警指定处理人；
- M8：核对各宿主框架的 route 归一化、请求层显式上报和 release 注入；
- P0/P1 为 0，且 M5、M6 回归全绿。

未满足时可以保留受控/内部部署，但不能把对应阶段标记为真实项目 Go。

## 10. 停止与清理

保留本地数据：

```bash
./scripts/dev down
```

仅在确认本地数据可删除时：

```bash
./scripts/dev reset --confirm-local-data-loss
```

生产 Secret、备份和 runtime 状态不会被 `dev reset` 删除，必须按组织的数据销毁流程单独处理。
