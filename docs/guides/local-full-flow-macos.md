# Frontend Insight——Mac 本地全流程操作指南

> 文档状态：实现契约（代码实现后逐命令实测）  
> 更新日期：2026-07-19  
> 适用版本：需求文档 v1.5 / MVP 开发计划 v1.2  
> 目标：不单独安装 Kafka、ClickHouse、MySQL，在一台 Mac 上完成 SDK → 接收 → Kafka → ClickHouse → API → Dashboard 全流程验证

## 1. 先说明这份文档如何使用

当前仓库仍处于需求与计划阶段，下面的 `./scripts/dev` 命令是后续实现必须满足的用户接口，不代表此刻已经存在。每完成一个开发 issue，都必须在一台全新或清理过项目环境的 Mac 上实际执行对应命令，并更新本文的实际输出、耗时和故障处理。

本指南的目标是让使用者只需要理解：

1. 如何检查电脑是否满足条件；
2. 如何一条命令启动完整环境；
3. 如何在示例应用完成三类操作；
4. 如何在 Frontend Insight 中确认事件；
5. 如何安全停止，而不误删本地数据；
6. 出错时先看哪里。

使用者不需要分别学习 Kafka、ClickHouse 和 MySQL 的安装命令。

## 2. 本地环境包含什么

完整 profile 由 Docker Compose 统一管理：

| 服务 | 用途 | 默认访问方式 |
|---|---|---|
| `web` | Frontend Insight 管理后台 | `http://localhost:5173` |
| `api` | 管理、分析和事件接收 API | `http://localhost:3000` |
| `consumer` | 消费 Kafka 并批量写 ClickHouse | 仅容器网络 |
| `demo-app` | 三类功能场景示例应用 | `http://localhost:4173` |
| `mysql` | 项目、功能和账号配置 | 仅容器网络；必要时开放调试端口 |
| `kafka` | 本地单节点事件队列 | 仅容器网络 |
| `clickhouse` | 原始事件与分析查询 | 仅容器网络；必要时开放调试端口 |

本地环境使用模拟账号和模拟 token。任何真实业务 token、生产数据库地址或生产 Secret 都不得写入 `.env.local`、示例数据或 Git 仓库。

## 3. Mac 前置条件

### 3.1 必需软件

- Git；
- Docker Desktop for Mac；
- macOS 自带的终端；
- 浏览器。

应用、Node.js、Kafka、ClickHouse 和 MySQL 都运行在容器中，因此完整体验不要求先在 Mac 全局安装 Node、pnpm 或数据库客户端。

### 3.2 支持的芯片

- Apple Silicon：`arm64`；
- Intel Mac：`x86_64`。

所有镜像必须提供相应架构或使用明确可运行的替代镜像。`doctor` 会自动识别架构，不要求使用者自行判断镜像标签。

### 3.3 资源预算

实现阶段必须测量并记录实际资源。当前试点目标：

| 资源 | 建议值 | 处理方式 |
|---|---:|---|
| 可用磁盘 | ≥ 15 GB | 不足时 doctor 阻止启动并说明清理位置 |
| Docker 可用内存 | 建议 ≥ 6 GB | 低于建议值时警告；若无法稳定运行则不得宣称本地全流程通过 |
| 空闲端口 | 3000、4173、5173 | 冲突时 doctor 显示占用进程和可修改配置 |

如果 Mac 总内存较小，允许先运行 UI fixture profile 评审界面，但最终的“本地全流程验收”必须在 full profile 完成，不能用 mock 结果替代。

## 4. 第一次使用

### 4.1 获取代码

```bash
git clone https://github.com/captainamari/frontend-insight.git
cd frontend-insight
git switch agent/refine-monitoring-requirements-v1.4
```

分支名称会在正式开发分支确定后更新；指南中的分支必须与当前可执行代码一致。

### 4.2 启动 Docker Desktop

打开 Docker Desktop，等待状态显示 Docker Engine 已启动。不要在 Docker 尚未启动时反复执行后续命令。

### 4.3 环境体检

```bash
./scripts/dev doctor
```

doctor 必须检查：

- Docker 与 Docker Compose 是否可用；
- Docker Engine 是否已启动；
- Mac 芯片架构；
- Docker 可用内存和磁盘；
- 3000、4173、5173 端口；
- `.env.local` 是否存在且不包含明显生产地址；
- 必要镜像是否支持当前架构；
- 现有容器和数据卷是否属于本项目。

成功时输出：

```text
[PASS] Docker Engine
[PASS] Docker Compose
[PASS] Architecture: arm64 or x86_64
[PASS] Disk
[PASS] Ports
[PASS] Environment file
Frontend Insight local environment is ready.
```

失败时命令返回非零退出码，并给出下一步操作，不能只输出底层堆栈。

### 4.4 初始化本地配置

```bash
./scripts/dev bootstrap
```

bootstrap 必须：

1. 从 `.env.example` 安全创建 `.env.local`；
2. 生成仅用于本地的随机 Secret；
3. 不覆盖已经存在的 `.env.local`；
4. 检查配置中没有生产域名和真实凭证；
5. 创建需要的本地目录，但不创建全局系统文件。

### 4.5 启动完整链路

```bash
./scripts/dev up --profile full
```

该命令应依次：

1. 拉取或构建镜像；
2. 启动 MySQL、Kafka、ClickHouse；
3. 等待基础设施 healthy；
4. 执行 MySQL 和 ClickHouse migration；
5. 启动 API、consumer、web 和 demo-app；
6. 输出访问地址和各服务状态。

第一次拉取镜像可能较慢。命令不得因为某个依赖仍在初始化就提前报告成功。

### 4.6 创建示例项目与功能

```bash
./scripts/dev seed
```

seed 必须幂等：重复执行不会无限创建重复项目或功能。它至少创建：

| featureKey | 类型 | 示例场景 |
|---|---|---|
| `sales_dashboard` | `data_view` | 查看数据和图表 |
| `report_export` | `action` | 点击按钮并成功导出 |
| `data_import` | `action` | 导入测试数据并成功处理 |
| `settings_save` | `action` | 修改并成功保存配置 |
| `operations_wallboard` | `long_view` | 长时间查看大屏 |

seed 同时创建本地管理员、viewer、示例项目、允许的 `http://localhost:4173` Origin 和明确标记为假的演示 token。

### 4.7 运行自动冒烟测试

```bash
./scripts/dev smoke
```

smoke 必须验证：

- `/health/live` 与 `/health/ready`；
- MySQL migration 已完成；
- Kafka 可生产和消费；
- ClickHouse 可写入和查询；
- demo-app 能发送测试事件；
- 事件最终可通过 analytics API 查到；
- Dashboard 静态资源可访问；
- payload、服务日志和死信中不含演示 Authorization token。

只有全部通过，才进入人工页面验证。

## 5. 人工完成三类真实场景

### 5.1 登录示例应用

1. 打开 `http://localhost:4173`；
2. 使用 seed 输出的本地演示账号登录；
3. 登录后 demo-app 在业务代码中显式调用 `setAccount(demoAccount.analyticsRef)`；
4. SDK 不允许读取页面中的 Authorization header、cookie 或 Local Storage token。

在浏览器开发者工具 Network 中查看 `/v1/events`，应看到不透明 `accountRef`，不应看到 `Bearer`、登录 token、密码或真实用户名。

### 5.2 场景 A：查看数据和图表

1. 进入“销售数据”页面；
2. 等待主要数据接口返回成功；
3. 等待图表完成渲染；
4. 页面应产生 `feature_exposed(sales_dashboard)`；
5. 只有主要数据成功且数据区渲染后，才产生 `feature_succeeded(sales_dashboard)`；
6. 人为触发一次接口失败时，只应有 exposed/failed，不应产生 succeeded。

成功标准：Frontend Insight 功能详情中 `sales_dashboard` 的曝光与成功均增加，失败测试不增加成功次数。

### 5.3 场景 B：按钮驱动的操作

依次完成：

1. 导出测试 CSV；
2. 导入 seed 提供的测试 CSV；
3. 修改一个演示配置并保存。

每项操作在点击时产生 `feature_started`，只有业务结果成功后才产生 `feature_succeeded`。取消文件选择、接口失败、校验失败或后端拒绝不得计为成功。

成功标准：

- `report_export`、`data_import`、`settings_save` 各增加一次成功；
- 再制造一次失败，失败数增加但成功数不增加；
- 重新登录形成新会话并再次成功导出后，`report_export` 被识别为重复使用。

### 5.4 场景 C：长时间查看大屏

1. 打开“运营大屏”；
2. 等待主要数据和图表渲染成功；
3. 保持标签页前台可见至少 70 秒；
4. 前 30 秒达到默认成功阈值，之后应至少产生一次 60 秒心跳；
5. 切换到其他标签页 30 秒，后台时间不应累计；
6. 切回大屏，继续前台停留；
7. 正常离开页面，产生结束事件。

成功标准：

- `operations_wallboard` 增加一次成功使用；
- 可见时长接近前台实际时长，不包含后台 30 秒；
- 即使关闭浏览器未产生结束事件，已收到的心跳仍保留可计算时长。

## 6. 在 Frontend Insight 中核对结果

1. 打开 `http://localhost:5173`；
2. 使用 seed 输出的本地管理员登录；
3. 选择示例项目；
4. 打开“功能采用”；
5. 时间范围选择“今日”；
6. 核对下面的最低预期。

| 功能 | 曝光 | 成功 | 失败 | 重复使用 | 补充 |
|---|---:|---:|---:|---:|---|
| sales_dashboard | ≥1 | ≥1 | ≥1（执行失败测试后） | 可选 | 数据成功渲染 |
| report_export | ≥2 | ≥2 | ≥1（执行失败测试后） | ≥1 | 两个会话成功 |
| data_import | ≥1 | ≥1 | 视测试而定 | 可选 | 导入成功 |
| settings_save | ≥1 | ≥1 | 视测试而定 | 可选 | 配置保存成功 |
| operations_wallboard | ≥1 | ≥1 | 0 | 可选 | 有可见时长与心跳 |

同时确认：

- 账号口径显示一个演示账号；
- 若换浏览器或清理匿名 ID，浏览器口径可能增加，但不称为新增真实用户；
- 数据更新时间与链路状态正常；
- 功能无人成功使用时显示“尚无成功使用”，而不是“系统故障”或“设计失败”。

## 7. 常用维护命令

### 7.1 查看状态

```bash
./scripts/dev status
```

输出每个服务的 running/healthy 状态、端口和最后健康检查，不要求使用者阅读原始 `docker ps`。

### 7.2 查看日志

```bash
./scripts/dev logs api
./scripts/dev logs consumer
./scripts/dev logs kafka
./scripts/dev logs clickhouse
```

不传服务名时应显示可用名称，而不是一次输出所有海量日志。日志必须脱敏。

### 7.3 安全停止

```bash
./scripts/dev down
```

`down` 停止容器但保留 MySQL、Kafka 和 ClickHouse 本地卷。再次 `up` 后数据应仍然存在。

### 7.4 清除全部本地测试数据

这是破坏性操作，只在明确需要重新开始时使用：

```bash
./scripts/dev reset --confirm-local-data-loss
```

reset 执行前必须列出即将删除的本项目容器和命名卷，再要求完整确认参数。它不得删除其他 Docker 项目的容器、镜像或卷。

## 8. 常见问题

### 8.1 Docker Engine 未启动

现象：doctor 显示无法连接 Docker daemon。  
处理：打开 Docker Desktop，等待 Engine 就绪，再重新运行 doctor。

### 8.2 端口被占用

现象：3000、4173 或 5173 无法绑定。  
处理：doctor 应显示端口和占用进程。优先停止明确属于旧开发环境的进程；不要自动杀死未知进程。也可在 `.env.local` 修改本项目端口后重新启动。

### 8.3 Mac 内存不足或容器频繁退出

现象：服务反复 restarting、Docker Desktop 卡顿。  
处理：先运行 `./scripts/dev status`，再检查 Docker Desktop 资源配置。关闭无关容器后重试。若 full profile 在文档声明的最低资源下仍无法稳定运行，应记录为实现缺陷，而不是要求使用者自行调 Kafka 参数。

### 8.4 Apple Silicon 镜像不兼容

现象：出现 `no matching manifest` 或进程架构错误。  
处理：doctor 必须在启动前识别；项目维护者负责修正镜像，不要求使用者长期使用模拟架构绕过。

### 8.5 Dashboard 没有数据

按顺序检查：

1. `./scripts/dev status` 是否全部 healthy；
2. demo-app Network 是否成功请求 `/v1/events`；
3. 项目 Origin 是否包含 `http://localhost:4173`；
4. `./scripts/dev logs api` 是否拒绝 schema/Origin；
5. `./scripts/dev logs consumer` 是否有消费或 ClickHouse 写入错误；
6. Dashboard 的数据状态是 `no_data`、`delayed` 还是 `broken`。

不直接进入数据库手工改数据，先保留请求 ID 和失败状态。

### 8.6 修改代码后没有生效

实现阶段必须明确哪些服务支持热更新。若依赖或 Dockerfile 变化，使用：

```bash
./scripts/dev up --profile full --build
```

命令不得删除现有数据卷。

## 9. 每个开发 issue 的本地文档验收

每完成一个 issue，提交前必须：

- [ ] 在 README 标记真实进度；
- [ ] 执行与该 issue 相关的 `doctor/up/seed/smoke/status`；
- [ ] 确认本文中的命令和页面路径真实存在；
- [ ] 更新预期输出和新发现的常见错误；
- [ ] 确认普通停止不会删除数据；
- [ ] 确认日志和事件中没有 token；
- [ ] 把验证结果记录到 `docs/progress.md`；
- [ ] 一个 issue 对应一个可回退的 commit 或 PR。

## 10. 本地全流程最终验收

由未参与核心编码的人在 Mac 上完成：

- [ ] clone 仓库并切换到指定分支；
- [ ] doctor 通过；
- [ ] bootstrap 不覆盖现有配置；
- [ ] full profile 启动；
- [ ] seed 可重复执行；
- [ ] smoke 全通过；
- [ ] 三类人工场景全部完成；
- [ ] Dashboard 指标符合最低预期；
- [ ] Network、日志和死信无 token；
- [ ] down 后数据保留；
- [ ] 再次 up 后数据仍可查询；
- [ ] reset 仅删除本项目本地数据且必须显式确认。

只有该清单完成，项目才能宣称“可以在本地跑完整流程”。
