# M6 本地验收指引（Apple Silicon Mac）

> 适用分支：`agent/m6-operational-metrics-index`  
> 产品基线：`docs/product/requirements-v1.6.md`  
> 开发基线：`docs/planning/mvp-plan-v1.3.md`

本指引用于验收 M6 的模块/页面/任务配置、事件契约 v2、任务实例、页面运营指标、指标定义与血缘、项目运营指数，以及 M0–M5 回归。

项目运营指数是可下钻的运营摘要，不是技术 SLO、自动设计结论或人员绩效分。数据门槛不满足时总分应为 `—`，这属于正确行为。

## 1. 环境与端口

目标环境：

- Apple Silicon Mac，建议 16 GB 以上内存；
- Docker Desktop，支持 Docker Compose v2；
- Node.js 24；
- pnpm 11.15.1；
- 本地端口 `3000`、`3200`、`4173`、`4174` 可用。

服务入口：

| 服务           | 地址                                 |
| -------------- | ------------------------------------ |
| 管理端         | <http://localhost:4173>              |
| 场景 demo      | <http://localhost:4174>              |
| API ready      | <http://localhost:3000/health/ready> |
| consumer ready | <http://localhost:3200/health/ready> |

本地账号：

| 角色   | 邮箱                     | 密码               |
| ------ | ------------------------ | ------------------ |
| admin  | `admin@example.invalid`  | `LocalAdmin-1234`  |
| viewer | `viewer@example.invalid` | `LocalViewer-1234` |

## 2. 获取代码与静态检查

```bash
git fetch origin
git switch agent/m6-operational-metrics-index
git pull --ff-only
pnpm install --frozen-lockfile
pnpm check
```

预期：

- event contract v1/v2、SDK、指标计算、API、管理端均通过类型和单元测试；
- `MetricCatalog` 无重复 key、缺失依赖或循环；
- SDK gzip 包体仍小于 12 KiB；
- 管理端和 demo 均能构建。

如果只想复跑指标算法：

```bash
pnpm exec vitest run packages/server-core/test/metrics.test.ts
```

该测试覆盖 30/25/30/15 权重、子权重、三类归一化、样本不足、69.99%/70%/100% 权重门槛和数据延迟。

## 3. 启动或从 M5 原地升级

首次启动：

```bash
./scripts/dev doctor
./scripts/dev bootstrap
./scripts/dev up
```

已有 M5 本地卷时也直接执行 `./scripts/dev up`。migration 只追加：

- MySQL `004_operational_metrics.sql`；
- ClickHouse `004_operation_instance.sql`。

不应为了升级而删除已有数据。原有 v1 事件、M5 页面、项目、成员、Origin 和功能定义应继续可用。

启动后执行：

```bash
./scripts/dev smoke
./scripts/dev status
```

`smoke` 应完成：

1. 空库到最新版本升级和重复执行幂等检查；
2. v1/v2 事件经 API、Kafka、consumer 进入 ClickHouse；
3. operation instance ID 和终态配对校验；
4. overview/features 原接口回归；
5. M6 运营概览、项目运营指数和 lineage JSON 查询；
6. viewer 写运营配置返回 403；
7. 管理端、demo 和健康接口检查。

本地 seed 会注册两个模块、三个核心页面、四个关键任务、目标/业务日历和一个激活的 `operational_v1` profile。`smoke` 还会写入满足主要 M6 样本门槛的合成生产事件。场景 demo 的事件带 `demo: true`，可显示在原始访问分析中，但不进入项目运营指数。

## 4. schema v3 与 operation v2 任务实例验收

打开 <http://localhost:4174/action?acceptance=fast>，输入默认用户名 `demo.operator`，模拟密码填写任意非空值。

在第一行任务依次执行“成功”“取消”“失败”，然后点击“立即发送”。

确认事件解释区：

- 每次操作先出现 `feature_started`；
- 三次操作分别只有一个 `feature_succeeded`、`feature_canceled`、`feature_failed`；
- 取消显示为用户明确取消，不混入失败；
- 失败携带稳定的 `reasonCode`；
- 事件请求使用唯一运行时契约 `schemaVersion: 3`；operation v2 表示任务实例业务语义，不表示事件 schema 版本；
- 每次开始和对应终态具有相同 `operationInstanceId`，不同操作的 ID 不同；
- 模拟密码、token、邮箱等内容不出现在请求 payload。

自动双浏览器验收：

```bash
pnpm test:m6:e2e
```

该命令使用 Chromium 和 WebKit 检查 v2 配对、M6 页面闭环和 viewer 权限。

## 5. M5 回归

执行：

```bash
pnpm test:m5:e2e
```

然后用 admin 登录管理端，确认：

- 默认入口仍是“功能采用”；
- 既有功能列表、功能详情、页面访问和项目接入可用；
- UI 使用“曝光后使用率”，不再使用“转化率”作为新产品术语；
- 项目和时间范围仍保存在 URL，刷新后不丢失；
- 数据异常时保留旧数据和 request ID，不把失败显示为 0。

## 6. 运营概览与页面详情

选择“运营概览”，确认：

- 显示项目 PV、核心页面触达、关键任务达成和会话不同页面 p50；
- 模块表展示已用/已配置页面；
- 核心页面表展示 PV、可见时长 p50 和时长覆盖率；
- 关键任务表分别展示失败、取消和近似放弃；
- 未归类 route 单独提示，仍显示原始 PV，但不声称进入评分；
- 趋势图不跨缺失时间桶连线。

点击“经营分析”进入页面详情，确认：

- 显示所属模块、页面模板、核心标记和预期频率；
- 同时显示 PV、账号、浏览器、会话；
- 同时显示平均、p50、p75 可见时长和 coverage；
- 缺失 `page_leave` 的访问没有作为 0 毫秒样本；
- 模板参考区间随页面模板显示；
- 页面内关键任务展示权重、超时窗口和 v2 状态。
- 同一个长停留样本在三类模板下会得到不同解释；项目级页面时长符合度必须先逐页按模板归一化，再按关键度汇总。

从“页面访问”中的任意 route 也应能进入页面详情。未注册 route 应显示“未归类”与配置入口。

## 7. 项目运营指数

选择“项目运营指数”，确认页面同时提供：

- 总分或明确的不可用原因；
- profile、definition version 和 v2 `availableFrom`；
- 四维 radar；
- 与 radar 使用同一读模型的等价表格；
- 每个叶子的原始值、目标、样本、状态、得分、权重和贡献；
- eligible 维度数和叶子权重覆盖率；
- configuration gaps；
- 指标定义与血缘入口。

点击任一叶子指标，确认抽屉展示：

- 业务问题；
- 公式、分母和去重键；
- 缺失值语义和 minimum sample；
- definition version、生效时间和 owner；
- 从事实、原子、派生到复合指标的只读 lineage 节点与边。

门槛判断：

- 少于 3 个 eligible 一级维度时，总分必须为 `—`；
- eligible 叶子权重覆盖低于 70% 时，总分必须为 `—`；
- `delayed`、`broken` 或 `no_data` 时，总分必须为 `—`；
- 缺少目标账号时显示 `missing_target`，不得用浏览器数代替；
- 0、缺失、样本不足和数据延迟必须是不同状态；
- 门槛不满足时，已有原始值和分项不能消失。
- 时间筛选跨越 page/task/settings/profile 生效边界时，页面应显示实际 `evaluationRange`；新配置不能套用到边界前事件。

本地 `smoke` 的合成数据通常可使三个以上维度与 70% 权重门槛成立。如果当前时间范围没有覆盖 smoke 数据，选择“最近 7 天”并刷新。

## 8. 配置、版本和权限

用 admin 在“项目运营指数”点击“配置目标与权重”。

依次检查：

1. 新建一个 module，重复 `moduleKey` 应返回冲突；
2. 新建一个 page definition，route 必须以 `/` 开头且不能包含 query/hash；
3. 将一个 feature 绑定到页面，设为关键任务，配置权重、超时和 v2；
4. 修改目标账号或预期活跃日并保存；
5. 在 profile 表调整目标或权重，保存为草稿新版本；
6. 激活草稿。

预期：

- 已激活 profile 不被原地修改；
- 新配置具有新 version 和生效时间；
- 旧 settings/profile 版本仍在历史列表；
- 当前筛选范围的有效活跃账号和活跃日只作为历史参考，不会自动回填目标；
- 三类页面模板的时长方向和深度解释在配置页直接可见；
- 同一维度内启用子项权重之和必须为 1；
- 启用维度权重之和必须为 1；
- 废弃草稿或停用当前 profile 需要显式确认；只结束 assignment，不删除历史版本；
- 页面不允许输入 SQL、任意公式、函数名或 ClickHouse 字段；
- 配置变更写入 `audit_logs`。

退出后用 viewer 登录，打开：

```text
http://localhost:4173/operational-config
```

确认所有配置可读但不可编辑，且无“新建”“保存”“激活”入口。服务端写请求必须返回 403；不能只依赖前端隐藏按钮。

## 9. 无 M6 配置项目的兼容验收

用 admin 在“项目与接入”新建一个项目，不创建 module/page/profile，只发送接入测试事件。

确认：

- “功能采用”“页面访问”“项目与接入”仍可使用；
- 运营概览可以显示原始数据和未归类 route；
- 项目运营指数显示 `METRIC_PROFILE_NOT_CONFIGURED` 等缺口，不报 500；
- 系统不会生成虚假的 0 分；
- v1 SDK 项目不被强制要求立即迁移到 v2。

## 10. 停止、日志与回滚

查看日志：

```bash
./scripts/dev logs api
./scripts/dev logs consumer
./scripts/dev logs web
./scripts/dev logs demo
```

停止并保留数据：

```bash
./scripts/dev down
```

M6 migration 为前向兼容添加。应用回滚到 M5 时，不要先删除新增列或表；先关闭 M6 写入口，保留 v1/v2 原始事件，再回滚应用。数据库结构清理需要单独评审，不能在普通应用回滚中执行。

只有确定可以删除全部本地验收数据时才执行：

```bash
./scripts/dev reset --confirm-local-data-loss
```

该操作会删除当前 Compose 项目的命名卷，无法从本地恢复。

## 11. 验收记录建议

记录以下证据：

- 当前 commit SHA；
- `pnpm check`、`./scripts/dev smoke`、M5/M6 E2E 结果；
- Chromium 与 WebKit 版本；
- migration ledger 中 MySQL/ClickHouse 版本 `1–4`；
- 一个成功、失败、取消和近似放弃任务实例；
- 一个页面时长 p50/p75/coverage 截图；
- 一个可用指数或门槛拦截截图；
- 一个 definition/lineage 截图；
- viewer 写请求 403；
- 发现的问题、request ID 和对应服务日志。
