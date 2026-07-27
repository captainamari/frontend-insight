# Frontend Insight——M5 Mac 本地全流程指南

> 适用分支：`agent/m5-management-ui-demo`  
> 适用版本：需求文档 v1.5 / MVP 开发计划 v1.2  
> 目标机器：Apple Silicon M1、32 GB 内存、1 TB 硬盘  
> 更新日期：2026-07-27

这份指南从环境检查开始，带你完成管理端登录、三类 demo 操作、数据查询和安全停止。Kafka、ClickHouse、MySQL、Node.js 均在 Docker 中运行，不需要逐个安装。

## 1. 运行后会得到什么

| 服务 | 用途 | 本机地址 |
| --- | --- | --- |
| `web` | Frontend Insight 管理后台 | <http://localhost:4173> |
| `demo` | 三类受控使用场景 | <http://localhost:4174> |
| `api` | 管理、分析和事件接收 API | <http://localhost:3000> |
| `consumer` | Kafka → ClickHouse 消费者 | <http://localhost:3200/health/ready> |
| MySQL / Kafka / ClickHouse | 元数据、队列和分析存储 | 仅容器网络 |

本地种子账号：

| 权限 | 用户名 | 密码 |
| --- | --- | --- |
| 管理员 | `admin@example.invalid` | `LocalAdmin-1234` |
| 只读查看者 | `viewer@example.invalid` | `LocalViewer-1234` |

这些凭证仅用于本机 Compose 环境，不能复制到试点或生产配置。

## 2. 第一次启动

### 2.1 获取 M5 分支

```bash
git clone https://github.com/captainamari/frontend-insight.git
cd frontend-insight
git switch agent/m5-management-ui-demo
```

### 2.2 启动 Docker Desktop

建议 Docker Desktop 至少分配：

- CPU：4 核；
- 内存：8 GB；
- 可用磁盘：20 GB 以上。

等待 Docker Desktop 显示 Engine 正常运行，再执行下面的命令。

### 2.3 环境体检

```bash
./scripts/dev doctor
```

它会检查 Docker/Compose、Engine 状态、原生 `arm64`、总内存、剩余磁盘、端口和完整 Compose 配置。第一次运行会从 `.env.m5.example` 创建权限为 `600` 的 `.env.m5`。检查失败会输出可操作的下一步并返回非零状态。

### 2.4 初始化配置并启动

```bash
./scripts/dev bootstrap
./scripts/dev up
```

`up` 会构建应用、启动 MySQL/Kafka/ClickHouse、等待健康、执行 migration、启动完整应用，并幂等创建本地账号、示例项目和六个功能定义。第一次构建会下载多架构镜像，耗时明显长于后续启动。

### 2.5 自动冒烟测试

```bash
./scripts/dev smoke
```

它会验证：

- HTTP 接收 → Kafka → consumer → ClickHouse → analytics API；
- 重复 `eventId` 的查询侧去重；
- admin/viewer 权限；
- 三类 golden fixture 和大屏累计时长；
- 管理端、demo 与 API 健康地址。

看到 `Data flow, management UI and demo smoke checks passed` 后，再做页面验收。

## 3. 人工验收三类场景

打开 <http://localhost:4174>，输入默认用户名 `demo.operator`，密码填写任意非空测试值。

页面会同时显示模拟 session token（已脱敏）、独立的 `analyticsRef`、SDK 队列和每次操作的预期事件。模拟 token 只保存在 `sessionStorage`，SDK 不读取它。事件 payload 中不应出现 token、密码、Cookie 或 Authorization。

### 3.1 数据和图表

进入“数据与图表”：

1. 点击“请求成功 + 渲染成功”：应先曝光，再产生 `feature_succeeded`；
2. 点击“主要接口失败”：应产生 `feature_failed / api_failure`，成功数不增加；
3. 点击“数据成功但渲染失败”：应产生 `feature_failed / render_failure`。

### 3.2 导出、导入、配置和指令

进入“业务操作”，每行分别尝试成功、取消和失败：

- 点击后立即产生 `feature_started`；
- 只有成功结果产生 `feature_succeeded`；
- 取消产生 `feature_failed / user_cancelled`；
- 失败产生 `feature_failed / operation_failed`。

点击不等于成功，取消和失败不会增加成功使用次数。

### 3.3 持续展示大屏

进入“持续展示”：

1. 点击“开始持续展示”；
2. 保持前台 30 秒，事件栏出现成功；
3. 保持前台到 60 秒以上，观察心跳；
4. 切换到其他标签页，页面计时应暂停；
5. 返回后继续累计；
6. 点击“结束并结算”。

正常模式使用 30 秒成功阈值和 60 秒心跳。自动化验收使用 `?acceptance=fast` 将两者缩短为 1 秒，但正式页面口径不变。

## 4. 在管理端核对结果

打开 <http://localhost:4173>，使用管理员账号登录。

### 4.1 功能采用

默认首页应展示功能类型、曝光账号/浏览器、成功账号/浏览器、成功次数、转化率、跨会话重复使用、最近使用和采用趋势。功能详情展示标准阶段和大屏可见时长，但不输出健康度、好坏或设计得分。

### 4.2 页面访问

页面访问页应展示：

- PV、活跃浏览器、已识别账号、会话；
- 昨日同时段比较；
- PV / 浏览器趋势；
- 可搜索、分页的归一化路由排行；
- 最后事件时间和链路状态。

浏览器、账号、会话不会被称为真实人数。共享账号仍只算一个账号。

### 4.3 项目与接入

管理员可以创建、编辑和停用项目，复制 npm 代码/project key/endpoint，查看 Origin/CSP/隐私说明，发送测试事件，并创建或停用功能。使用 viewer 登录后仍可查看已授权项目，但看不到创建或保存入口，表单为只读。

### 4.4 页面状态

重点确认：

- 新项目无事件时进入接入流程，不显示误导性的全零指标；
- 链路正常但所选范围无访问时，明确显示“无有效访问”；
- 数据延迟时保留旧数据并显示横幅；
- API 失败时保留 URL 筛选和请求 ID；
- 趋势缺口不被折线跨越连接；
- 无权限页面说明应联系项目管理员。

项目和时间范围写在 URL 查询参数中，刷新或分享 URL 后应保持。

## 5. 日常命令

```bash
./scripts/dev up
./scripts/dev seed
./scripts/dev status
./scripts/dev logs
./scripts/dev logs consumer
./scripts/dev down
```

`down` 保留 MySQL、Kafka 和 ClickHouse 命名卷。只有下面的显式确认会删除本项目 M5 的卷：

```bash
./scripts/dev reset --confirm-local-data-loss
```

`reset` 会先列出带有精确 Compose 项目标签 `frontend-insight-m5` 的卷。不要用全局 Docker 清理命令代替。

## 6. 常见问题

### Docker Engine 未运行

打开 Docker Desktop，等状态稳定后重新运行 `./scripts/dev doctor`。

### 端口被占用

在 `.env.m5` 修改对应值，例如：

```dotenv
M5_WEB_PORT=5173
M5_DEMO_PORT=5174
```

随后执行 `./scripts/dev up`。修改 demo 端口后，seed 会自动加入新的 Origin。

### 测试事件返回 Origin 错误

在管理端“项目与接入”检查 Origin。它必须与浏览器地址栏的 scheme、host、port 完全一致，且不能带路径。

### 页面显示数据延迟

```bash
./scripts/dev status
./scripts/dev logs consumer
```

确认 consumer 健康；恢复后等待数秒并刷新。页面会保留上一次可用数据，不把延迟误报成 0。

### 首次构建失败

```bash
./scripts/dev logs
./scripts/dev down
./scripts/dev up
```

不要先执行 reset；普通构建或启动失败不需要删除已有数据。

## 7. M1 Mac 最终验收记录

| 项目 | 实际结果 |
| --- | --- |
| `doctor / bootstrap / up / seed / smoke` | 待填写 |
| 三类人工场景 | 待填写 |
| 管理端 admin/viewer | 待填写 |
| 首次构建耗时 | 待填写 |
| 后续启动耗时 | 待填写 |
| 稳态内存 / 峰值内存 | 待填写 |
| `down` 后数据保留 | 待填写 |
| reset 仅删除 M5 卷 | 待填写 |

Linux x86_64 CI 用于自动回归，不能替代这张 Apple Silicon 原生验收表。
