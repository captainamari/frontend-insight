# M2-M4 Mac 本地验收指引

> 适用分支：`agent/m1-engineering-contract-migrations`  
> 目标机器：Apple Silicon M1、32 GB 内存、1 TB 硬盘  
> 当前范围：Web SDK、接收/消费链路、认证/项目/功能/分析 API；管理后台和 demo-app 在 M5 实现

## 1. 准备环境

安装并启动 Docker Desktop，建议为 Docker 分配至少 4 核 CPU、8 GB 内存，并保证至少 20 GB 可用磁盘。仓库内的 MySQL、Kafka、ClickHouse、API 和 consumer 均使用多架构镜像，不需要在 Mac 单独安装数据库或消息队列。

```bash
git switch agent/m1-engineering-contract-migrations
./scripts/m2-m4 doctor
```

第一次执行会从 `.env.m2-m4.example` 创建 `.env.m2-m4`。其中只有本地测试凭证；不要替换为生产地址或真实 token。

## 2. 启动并自动验收

```bash
./scripts/m2-m4 up
./scripts/m2-m4 verify
```

`up` 会构建应用镜像，启动 MySQL、ClickHouse、单节点 Kafka，创建 event/DLQ topic，执行全部 migration，再启动 API 与 consumer。首次拉取镜像和构建会较慢，命令只有在两个进程均 ready 后才返回成功。

`verify` 是幂等的自动全流程检查，会执行：

1. 创建本地 admin、viewer、示例项目、Origin 和三种功能定义；
2. 上报 data view、action、long view 三套固定事件，并再次上报相同 `eventId`；
3. 等待 consumer 写入 ClickHouse；
4. 验证分析 API 按 `eventId` 去重，PV、账号、浏览器和功能成功数口径正确；
5. 验证长时展示累计 120 秒而不是重复累加心跳；
6. 验证 viewer 只能读授权项目、不能写项目或枚举成员；
7. 验证 refresh token 轮换、logout、数据状态、项目停用拒绝上报和审计日志。

成功时末尾会输出一行 JSON，其中 `status` 为 `passed`、`dataState` 为 `healthy`。

## 3. 手工查看 API

默认地址：

- API：<http://localhost:3000>
- API 健康：<http://localhost:3000/health/ready>
- consumer 健康：<http://localhost:3200/health/ready>

运行过 `verify` 后，可以用测试管理员登录：

```bash
curl --silent --request POST http://localhost:3000/api/auth/login \
  --header 'content-type: application/json' \
  --data '{"email":"admin@example.invalid","password":"LocalAdmin-1234"}'
```

响应中的短时 `accessToken` 只用于本地测试。把它作为 `Authorization: Bearer <accessToken>` 调用 `/api/projects`、项目功能、数据状态和分析接口。不要把 token 作为 SDK 的 `accountRef`；SDK 与接收端会拒绝 Bearer/JWT 形态的值。

当前阶段没有 Vue 页面，因此 M4 的人工核对以 API 与自动 verifier 为准。登录页、项目页、功能采用页和三场景 demo-app 将在 M5 接入这些 API。

## 4. SDK 浏览器验收（可选）

如果 Mac 已安装 Node.js 24，可额外执行真实浏览器契约：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium webkit
pnpm test:browser
```

该测试覆盖 SPA 路由、query/hash 移除、销毁监听器和单次事件同步处理 p95 预算。SDK 构建同时检查 ESM gzip 不超过 12 KiB。

## 5. 状态、日志和停止

```bash
./scripts/m2-m4 status
./scripts/m2-m4 logs api
./scripts/m2-m4 logs consumer
./scripts/m2-m4 logs kafka
./scripts/m2-m4 down
```

`down` 保留三个数据卷。重新启动后可以继续使用原数据。

只有明确需要清空本项目本地数据时执行：

```bash
./scripts/m2-m4 reset --confirm-local-data-loss
```

该命令会先列出 Compose 项目标签命中的卷，只删除 `frontend-insight-m2-m4` 的容器和卷，不处理其他 Docker 项目。

## 6. 常见问题

- `doctor` 提示架构错误：MVP 本地基线仅承诺 Apple Silicon；不要用 x86 模拟结果代替验收。
- 端口 3000/3200 被占用：在 `.env.m2-m4` 修改 `M24_API_PORT` 或 `M24_CONSUMER_PORT`，容器内部端口无需修改。
- API 一直不 ready：先看 `./scripts/m2-m4 logs api`，常见原因是 migration、Kafka topic 或本地 Secret 长度不符合要求。
- consumer 变为 not ready：它会在 ClickHouse/MySQL 故障有限重试后暂停分区，默认 30 秒后恢复；事件 offset 不会在错误写入前提交。
- Dashboard 显示全零：M4 尚无 Dashboard；使用 verifier/analytics API 区分 `no_data`、`delayed`、`broken` 和 `healthy`。
