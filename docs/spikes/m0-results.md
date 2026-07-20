# M0 技术验证与本地验收

> 更新日期：2026-07-19  
> 分支：`agent/m0-local-infrastructure-spike`

## 1. 结论

M0 代码已覆盖四项关键风险，并建立一条最小端到端链路：浏览器合成事件 → 接收 API → 账号引用 HMAC → Kafka → consumer → ClickHouse。

这不是生产实现。它不包含正式 SDK、认证、重试队列、管理后台、容量保障或高可用。

## 2. 自动验收矩阵

| 验证项 | 自动化证据 | 当前状态 |
|---|---|---|
| 事件、CORS 和凭证护栏 | Node 单元测试 | 通过（本工作区） |
| HTTP 接收、严格 CSP、精确 Origin | Node HTTP 集成测试 | 通过（本工作区） |
| Compose 结构、镜像固定、端口隔离 | YAML 结构测试 + `docker compose config` | 通过（本工作区 + 远程 CI） |
| MySQL migration、连接池、读写 | `verify.mjs` | 通过（远程 CI） |
| ClickHouse Node 批写、DateTime64(3) | `verify.mjs` | 通过（远程 CI） |
| Kafka topic、produce/consume | `verify.mjs` | 通过（远程 CI） |
| 浏览器事件进入 ClickHouse | API + Kafka + consumer + ClickHouse 轮询 | 通过（远程 CI） |
| 原始账号引用不进入 Kafka/ClickHouse | HMAC 结果断言 + 禁止字段测试 | 通过（本工作区 + 远程 CI） |
| Apple Silicon 原生镜像与资源 | 目标 M1 Mac 的 `doctor/status` 输出 | 等待产品负责人本地验收 |

提交前本工作区执行 `npm test`：10 项测试通过，0 项失败；依赖审计 0 个已知漏洞；`scripts/dev` 通过 Bash 语法检查。当前执行环境没有 Docker，因此容器项以远程 CI 和目标 Mac 的结果为准。

### 2.1 远程 Compose 实测

[GitHub Actions run 29718940166](https://github.com/captainamari/frontend-insight/actions/runs/29718940166) 在 Linux amd64 上通过，验证提交为 `cccc9540e17a3b5a8849558bbcfa76a671496d27`。

| 步骤 | 结果 | 耗时 |
|---|---|---:|
| MySQL migration、pool、写入/读回 | 通过 | 83 ms |
| ClickHouse JSONEachRow、DateTime64(3) | 通过 | 52 ms |
| Kafka produce/consume | 通过 | 315 ms |
| CORS/CSP/凭证拦截、浏览器事件落 ClickHouse | 通过 | 151 ms |

远程验证事件 ID 为 `0a27bac5-5139-483a-9d91-825ae5fc3328`，结果明确记录 `rawAccountReferencePersisted: false`。容器从开始创建到 5 个常驻服务全部健康约 23 秒；空闲附近资源快照合计约 1.15 GiB，其中 ClickHouse 388.7 MiB、Kafka 300.9 MiB、MySQL 439.6 MiB、两个 Node 进程合计 46.6 MiB。

以上只证明 amd64 CI 环境。Apple Silicon 原生镜像、Mac 启动耗时和 Docker 磁盘增量仍必须执行第 3 节后补录。

## 3. Mac 首次验收步骤

### 3.1 启动

从仓库根目录依次执行：

```bash
./scripts/dev doctor
./scripts/dev m0-up
./scripts/dev m0-verify
./scripts/dev m0-status
```

预期：

- `doctor` 最后显示 `Doctor passed`，架构为 `arm64`/`aarch64`；
- `m0-up` 等待所有服务健康后返回；
- `m0-verify` 输出 JSON，顶层 `status` 为 `passed`，四个 `results` 均为 `passed`；
- 浏览器链路结果包含 `rawAccountReferencePersisted: false`；
- `m0-status` 显示 5 个常驻容器健康，并输出 CPU、内存用量。

首次拉取镜像所需时间不计入稳定启动时间。第二次执行时，请记录：

| 项目 | 实测值 |
|---|---|
| `m0-up` 稳定启动时间 | 待填写 |
| 所有容器合计内存 | 待填写 |
| Docker 数据磁盘增量 | 待填写 |
| Docker engine 架构 | 待填写 |

### 3.2 浏览器手工复核

1. 打开 <http://localhost:4173>；
2. 点击“发送测试事件”；
3. 页面应显示事件已由 `sendBeacon` 排队，或由 `fetch keepalive` 接收；
4. 再运行 `./scripts/dev m0-verify`，确认完整链路仍为 `passed`；
5. 浏览器开发者工具中，页面响应的 CSP 只允许连接 `http://localhost:3100`，测试事件内容不得出现登录 token、Cookie 或 Local Storage 值。

### 3.3 停止与重置

普通停止会保留数据：

```bash
./scripts/dev m0-down
```

只有确定要删除本项目的 MySQL、ClickHouse 和 Kafka 本地数据时才执行：

```bash
./scripts/dev m0-reset --confirm-local-data-loss
```

脚本会先列出由 `frontend-insight-m0` Compose 项目标签选中的卷，不会操作其他项目的数据卷。

## 4. 排障

```bash
./scripts/dev m0-status
./scripts/dev m0-logs
./scripts/dev m0-logs kafka
./scripts/dev m0-logs clickhouse
```

- 端口 3100/4173 被占用：修改 `.env.m0` 中对应端口后重新启动；
- Docker 未启动或内存不足：`doctor` 会在拉取镜像前停止并给出原因；
- `m0-verify` 某一步失败：JSON 会保留已完成步骤、失败步骤和耗时，结合该服务日志定位；
- 只有 x86 CI 通过：仍不能认定 M1 已验收，必须完成第 3 节。
