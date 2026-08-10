# 05. 认证、管理与分析 API

> 当前基线：M4 认证/RBAC 仍是所有新页面的安全基础；M6 增加模块/页面/版本化设置/profile、MetricCatalog 和运营读模型；M8 增加独立 ObservabilityStore/Controller。

## 1. API 分层阅读法

管理/分析请求可以按固定顺序阅读：

```text
route decorator
→ AuthGuard 建立 Principal
→ Zod/参数解析
→ 项目级授权
→ server-core / MySqlStore / AnalyticsStore
→ ApiExceptionFilter 统一响应
```

这样可以快速判断一个规则属于 HTTP、认证、授权、领域还是数据访问，而不是在 Controller 中从头读到尾。

## 2. 本地认证模型

### 2.1 密码与 bootstrap

`AuthManager.bootstrapAdmin` 只允许空用户库执行一次，密码至少 12 位，使用 bcrypt cost 12。`users` 与 `identities` 分开，为未来替换 SSO 留出空间。

### 2.2 Access token

- HS256 JWT，15 分钟；
- 固定 issuer `frontend-insight`；
- 固定 audience `frontend-insight-api`；
- payload 标记 `typ: access`；
- `AuthGuard` 验证后仍从 MySQL 重新加载 principal。

最后一点意味着禁用用户或修改全局角色可以立即影响后续请求，而不是等 JWT 过期。代价是每个认证请求增加一次 MySQL 查询。这是安全即时性与性能之间的明确取舍。

### 2.3 Refresh token

- 32 字节随机值；
- 浏览器只通过 `HttpOnly; SameSite=Strict` cookie 持有；
- 数据库只保存 SHA-256 hash；
- 有效期 7 天；
- cookie path 限制为 `/api/auth`；
- 生产由 `REFRESH_COOKIE_SECURE=true` 强制 Secure。

`consumeSession` 在事务中 `SELECT ... FOR UPDATE`，随后把旧 session 标记 revoked。刷新成功后 `AuthManager.issue` 生成一枚新 refresh token，这就是 rotation。

并发使用同一个 refresh token 时，锁和 revoked 条件保证最多一个请求成功。即使数据库泄漏，攻击者也不能直接用 hash 作为 cookie。

### 2.4 登录限流

`AuthController` 以 IP 做 15 分钟 5 次的内存固定窗口限制。适合本地 MVP，但多副本/代理部署前必须：

- 正确配置可信代理与真实客户端 IP；
- 使用共享限流或网关；
- 明确失败登录审计和告警策略。

## 3. 认证与授权不是同一件事

`AuthGuard` 只回答“你是谁、会话是否有效”。Controller/Store 还要回答“你能否访问这个项目、能否写”。

当前有两层角色：

| 层   | 角色                         | 作用                     |
| ---- | ---------------------------- | ------------------------ |
| 全局 | `admin` / `viewer`           | 是否拥有系统级管理写权限 |
| 项目 | `owner` / `admin` / `viewer` | 用户与具体项目的关系     |

`MySqlStore.getProjectRole` 对全局 admin：只要项目存在就返回 `admin`；对全局 viewer：必须有 active 项目的 membership。

`ProjectsController.requireProject(principal, projectId, write)` 的当前写规则同时要求：

- 全局角色是 admin；
- 项目角色是 owner 或 admin。

因此项目 role 不是独立提升全局 viewer 写权限的机制。阅读 UI/需求时必须保持这个实际语义，不能看到 `project admin` 名称就假定它一定能写。

## 4. 管理操作中的事务与审计

### 4.1 创建项目

`createProject` 在一个事务里完成：

1. 生成内部 UUID 和公开 `fi_public_*` project key；
2. 插入 project；
3. 把创建者加入为 owner；
4. 写入 Origin；
5. 初始化 data status；
6. 写 audit log；
7. commit 后返回模型。

如果任一步失败，回滚可以避免“项目存在但没有 owner/Origin”的半成品状态。

### 4.2 最后一个 owner 不变量

修改或删除成员时，store 用 `FOR UPDATE` 锁成员/owner 集合；如果操作会移除最后一个 owner，抛 `LAST_OWNER_REQUIRED`。

这类必须在并发下成立的规则应放在事务内，而不是 Controller 先 count、再 update。否则两个并发请求都可能看到“还有两个 owner”并同时删掉。

### 4.3 审计与业务写应尽量同事务

项目创建、更新和成员变更把 audit 写入同一事务，避免业务成功而审计缺失。部分 feature 操作目前是先写再单独 audit；进入更严格生产要求时，可评估统一事务边界。

Audit metadata 只记录动作和变更字段，不复制敏感请求 body。

### 4.4 配置变更后的 ingestion cache

项目 Origin/status 或功能定义改变后，Controller 调用 `ingestion.invalidateProject(projectKey)`。这是管理面与数据面的关键连接点：如果忘记失效，旧配置会在 TTL 窗口内继续接受或拒绝事件。

## 5. 输入与错误边界

### 5.1 Zod 负责 HTTP 输入

Controller 中的 schema 处理：

- 字符串 trim、长度；
- IANA timezone 是否真实可用；
- Origin 必须只有 scheme + host，不能带 path；
- role/feature type 枚举；
- 数字范围和默认值；
- PATCH 至少一个字段。

`parseInput` 把 Zod issue 转为字段路径和安全消息，输出稳定 `VALIDATION_FAILED`。

### 5.2 `ApiExceptionFilter` 统一错误合同

最终格式：

```json
{
  "code": "...",
  "message": "...",
  "requestId": "...",
  "details": {}
}
```

它专门识别 ingestion error、Nest `HttpException`、body too large、MySQL duplicate/FK error和全大写领域错误。未知异常统一变成 500，不把 stack/SQL/body 暴露给客户端。

可复用经验：错误响应的 `requestId` 供用户报告问题；生产日志也应记录同一 ID 才能完成关联。错误码给程序处理，message 给人阅读。

当前审计表的 `request_id` 也是 store 内单独生成的 UUID，并未继承 HTTP transport request ID。它能唯一标识审计记录，但暂时不能直接完成 HTTP→审计的端到端关联；后续若增强可观测性，应把关联 ID 显式传入业务层。

## 6. 固定分析 API 为什么比任意查询更合适

当前固定查询包括 M5 的 overview/trend/pages/features、M6 的 modules/operational overview/page/task/index，以及 M8 的 observability overview/errors/vitals/releases/alerts。仍没有任意 SQL、任意字段或任意告警 DSL。

固定查询的收益：

- 指标含义可以验收；
- 查询成本有上限；
- 参数化和 whitelist 更容易防注入；
- UI 不会因用户组合出不可维护的指标而失控；
- 可以为每条查询记录 p95 和扫描量。

这符合产品定位：先证明固定 P0 任务，不提前建设通用 BI。

## 7. 时间范围与时区

`validateAnalyticsRange` 同时限制：

- from/to 必须合法且 from < to；
- 最大 13 个月；
- hourly granularity 最多 31 天；
- timezone 必须是有效 IANA zone；
- 最终时间归一为 ISO UTC。

`previousLocalCalendarDay` 不是简单减 24 小时。它先把 instant 转为项目时区的本地年月日时分秒，再把“前一日相同本地钟表时间”转换回 instant，因此能跨 DST 保持“昨日同时段”语义。

这是非常值得复用的经验：日历比较属于业务时区问题，不能用固定毫秒数代替。

## 8. 去重子查询是所有指标的公共基座

`deduplicatedEventsWhere(extra)` 统一提供：

- `project_id` 范围；
- `[from, to)` event time；
- 可选固定 extra filter；
- `ORDER BY received_at DESC LIMIT 1 BY event_id`。

所有 overview/trend/pages/features 都基于它，避免某个页面去重、另一个页面忘记去重。

动态值通过 ClickHouse `query_params` 传入。pages 的 sort column 和 direction 则先映射到固定 whitelist，再拼进 SQL。列名无法作为普通 value parameter，所以 whitelist 是必要的安全边界。

## 9. 每个指标到底怎么算

### 9.1 Overview

| 字段     | 当前口径                                |
| -------- | --------------------------------------- |
| PV       | `page_view` 事件数                      |
| visitors | `uniqExact(visitor_id)`，匿名浏览器实例 |
| accounts | 非空 HMAC `account_id` 去重             |
| sessions | `uniqExact(session_id)`，标签页会话     |

响应还返回三种身份语义说明，避免 UI 把字段名二次误读。comparison 是项目时区的 previous local day same duration。

### 9.2 Trend

按项目时区 `toStartOfHour` 或 `toStartOfDay` 分桶。缺失 bucket 不自动补 0，响应明确 `gapPolicy`：UI 不应把数据中断画成真实零访问。

### 9.3 Pages

只统计 `page_view`，按 route 聚合 PV、visitor、session、last visit；支持受限搜索、分页和 whitelist 排序。total 用另一个去重 route 查询，不能拿当前页长度冒充总数。

### 9.4 Feature overview

先在 ClickHouse 计算每个 `feature_key` 的曝光/成功账号与浏览器、成功次数、最近成功、重复使用；再与 MySQL 的 feature definitions 合并。

这样即使一个已定义功能没有事件，也仍然出现在结果中，指标为 0/null。否则 UI 无法区分“未定义”和“已定义但无人使用”。

旧 read model 字段仍叫 `accountConversionRate/visitorConversionRate`，但 UI 已显示“曝光后使用率”。只有 denominator > 0 才计算，否则返回 null；v1.7 要把 API 字段也统一为 postExposureUseRate。

重复使用定义为同账号/visitor 在至少 2 个不同 session 中成功，而不是同一会话连续点击两次。

### 9.5 Feature detail 与 long view

detail 返回 exposed/started/succeeded/failed、成功账号/浏览器、重复使用和趋势。

长时事件 heartbeat/ended 保存的是累计可见时间，所以查询：

1. 按 `visitor_id + session_id + page_view_id` 分组；
2. 每个实例取 `max(visible_duration_ms)`；
3. 再 `sum(instance_duration_ms)`。

如果直接 sum 所有 heartbeat，60 秒、120 秒两个累计值会被错误算成 180 秒。

### 9.6 M6 运营读模型与指数

`modules/operationalOverview/pageDetail/taskDetail` 将 MySQL 的模块、页面、任务定义与 ClickHouse 事实合并；未归类 route 保留基础证据但不进入覆盖率/指数。`operationalIndex` 还读取生效中的 settings/profile，按最晚配置边界裁剪 evaluationRange，并通过 3 维 + 70% leaf coverage + healthy data gate 决定是否返回总分。详细公式见 [M6 指标目录、读模型与项目运营指数](13-m6-metrics-read-models-and-index.md)。

### 9.7 M8 可观测性读模型

`ObservabilityStore` 独立处理错误组、影响账号/浏览器/页面/发布、Web Vitals P75 和固定只读告警，并使用 `observability_v1.0.0`。它不会修改运营指数 v1，也不把相关时间趋势解释为因果。

## 10. 数据状态是分析 API 的前置语义

`evaluateDataStatus` 不查询 ClickHouse 指标，而是读取 MySQL 链路状态，告诉 UI 数据是否可信：

- `no_data`：展示接入引导；
- `delayed`：展示数据处理中/延迟；
- `broken`：展示故障而不是 0；
- `healthy`：才把指标当作当前链路结果。

M5–M8 页面应先消费 data status，再决定 Dashboard 空状态。M6 又增加 availableFrom/configuration gap/metric status；当前它们还不是同一个统一枚举，v1.7 会进一步重构。

## 11. 关键符号索引

| 符号                                   | 值得学习的点                                   |
| -------------------------------------- | ---------------------------------------------- |
| `AuthManager.issue`                    | 短 access token + 随机 refresh token + DB hash |
| `MySqlStore.consumeSession`            | `FOR UPDATE` 实现 refresh rotation 一次性消费  |
| `AuthGuard.canActivate`                | 公共路由元数据、JWT 到 principal               |
| `ProjectsController.requireProject`    | 认证后再执行双层授权                           |
| `MySqlStore.createProject`             | 多表写入与审计的原子事务                       |
| `setProjectMember/removeProjectMember` | 最后一个 owner 并发不变量                      |
| `ApiExceptionFilter`                   | 内部异常到稳定、安全 HTTP 合同                 |
| `validateAnalyticsRange`               | 成本上限和时间语义                             |
| `previousLocalCalendarDay`             | DST 安全的“昨日同时段”                         |
| `deduplicatedEventsWhere`              | 全指标共享幂等基座                             |
| `AnalyticsStore.features`              | 元数据和事实数据合并                           |
| `AnalyticsStore.featureDetail`         | 累计 heartbeat 的 max-then-sum                 |
| `OperationalController`                | 模块/页面/设置/profile 的双层授权和版本动作     |
| `METRIC_CATALOG/calculateOperationalIndex` | 定义、血缘、归一化和总分 gate               |
| `ObservabilityStore`                   | M8 固定错误/性能读模型与告警                    |

## 12. 当前边界与维护提醒

- access token 每次请求回查 MySQL；若未来性能不足，应先测量，再设计短缓存和禁用传播语义。
- 本地认证最终是否被 SSO 替换尚未完成；不要让新 UI 深度耦合密码登录细节。
- project `retentionDays` 目前是元数据，ClickHouse TTL 仍固定 90 天；UI 不应声称已执行项目级保留。
- analytics route 的 `timezone` 来自请求并只校验为合法 IANA zone，当前未与项目表中的 timezone 比对；客户端从项目设置生成 query，但服务端仍可进一步强制。
- M5 与 M6 read model 尚未完全统一：旧 feature 结果混有 snake_case SQL 字段，types.ts 手工维护，MetricCatalog 也还没有驱动所有页面文案。
- analytics metrics 只保留当前 API 进程最近 1000 次样本，多副本不会自动合并。
- `uniqExact` 在当前数据规模保证清晰口径；数据量大后可能切换近似聚合，但必须同步 UI 语义与基准测试。
- 新增 sort/filter 时，必须继续使用参数或固定 whitelist，不能拼接任意用户字符串。

本章实验见 [代码精读实验](07-code-reading-labs.md) 的实验 6、7 和 9。
