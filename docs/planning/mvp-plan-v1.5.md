# Frontend Insight——MVP 开发计划 v1.5（v1.8 逐模块重构）

> 状态：待技术评审<br>
> 更新日期：2026-08-19<br>
> 对应需求：[需求文档 v1.8](../product/requirements-v1.8.md)<br>
> 代码基线：`main` @ `a79fa5368b806c9808242eb65c6d076d5d1464eb`<br>
> 历史开发基线：[MVP 开发计划 v1.3](mvp-plan-v1.3.md)<br>
> 废弃文档：`requirements-v1.7.md`、`mvp-plan-v1.4.md`，不得作为实现或验收依据
> 适用假设：1 名有经验的全栈开发者，AI 辅助；项目未上线，测试数据允许清理

## 0. 计划目标

本计划把当前 `main` 已实现的 M0–M8 能力重组为 v1.8 六模块产品，而不是重新从零建设采集平台。

核心交付原则：

1. **一批只完成一个页面或一个清晰子模块**；
2. 每批从最新已验收的 `main` 创建新分支；
3. 每批都有独立 API、UI、fixture、E2E、手工验收和删除清单；
4. 当前批验收并合入后才开始下一批，默认不并行堆叠长期分支；
5. 不把“能看到新页面”当作完成，必须验证公式、权限、状态、隐私和下钻；
6. 不为未上线的旧测试数据保留迁移或兼容代码；
7. 不重写已经验证的数据链路、鉴权、审计和隐私能力，除非新需求确实改变边界。

## 1. 为什么采用逐模块重构

上一轮大范围重构暴露了以下风险：

- 导航、页面、API、术语和 E2E 同时变化，容易漏改旧入口；
- 新页面已经出现，但数据仍来自旧接口或旧口径；
- 大量兼容分支掩盖“哪个页面才是正式产品入口”；
- 文档、代码、fixture 和手工验收之间容易漂移；
- 一次 PR 涉及过多模块，review 很难确认是否完整。

v1.5 使用以下防漏机制：

| 机制 | 要求 |
| --- | --- |
| 页面边界 | 一个里程碑只交付一个页面或一个页内子模块 |
| 需求追踪 | PR 描述逐条链接 v1.8 对应小节与验收项 |
| 路由清单 | 每批列出新增、保留、替代和待删除路由 |
| 数据清单 | 每张卡片/图表注明 read model、metric key、单位和版本 |
| 自动化门 | 当前模块 E2E + 已合入模块回归全部通过 |
| 手工门 | 在真实浏览器完成该模块的目标角色任务 |
| 删除门 | 替代能力完成后删除旧页面、旧 API、旧测试和旧术语 |
| 文档门 | 代码、需求、计划、ADR、验收指引同批更新 |

## 2. 当前代码地图与处理策略

### 2.1 直接复用

| 代码区域 | 已有能力 | 处理 |
| --- | --- | --- |
| `packages/web-tracker` | 页面、功能、operation、错误、Web Vitals、浏览器侧脱敏 | 保留；R4-B 扩展工作流 step |
| ingestion/consumer | schema 校验、Kafka、ClickHouse 写入、死信隐私 | 保留；支持新 contract 后删旧兼容 |
| `packages/server-core/src/analytics.ts` | PV、趋势、页面、任务、运营输入 | 拆分 read model，不重写固定查询 |
| `packages/server-core/src/metrics.ts` | MetricCatalog、DAG、归一化、运营指数 | 演进为系统目录 + 受控公式 evaluator |
| `packages/server-core/src/observability.ts` | 错误组、影响范围、Web Vitals、发布、固定告警 | 复用到质量指标与页面质量分析 |
| auth/project guard | admin/viewer、项目级授权 | 保留 |
| audit logs | admin 修改审计 | 扩展新的实体类型 |
| DataStatus/StatePanel | 数据状态、错误、request ID | 保留并统一 |
| ECharts/Element Plus 基础组件 | 图表、表格、抽屉、表单 | 复用并补无障碍 |
| dev/production scripts | Compose、负载、故障、备份恢复 | 保留；调整 reset 和新 E2E |

### 2.2 需要重构

| 当前文件/模块 | 问题 | 目标 |
| --- | --- | --- |
| `apps/web/src/router.ts` | 默认 `/features`、项目由 query 选择 | 项目入口 + `/projects/:id/*` |
| `AppShell.vue` | 6 个旧导航并列 | 入口页与项目内 5 模块框架 |
| `OperationalConfigView.vue` | 分析对象、目标、profile 混在单页 | 指标管理分 TAB、版本库 |
| `OperationalOverviewView.vue` + `OperationalIndexView.vue` | 概览和分数分离 | 项目概览统一 read model |
| `ObservabilityView.vue` | 项目级证据面板 | 页面质量 TAB + 项目质量分数输入 |
| `PagesView.vue` + `PageDetailView.vue` | 页面运营独立导航 | 页面分析运营 TAB |
| `FeaturesView.vue` + `FeatureDetailView.vue` | 功能采用独立入口 | 业务分析工作流/指标证据 |
| `OnboardingView.vue` | 创建、接入、项目配置、功能定义混合 | 入口页创建 + 设置 |
| `RangePreset` | 24h/7d/30d | 7d/30d/90d/180d/365d + custom |

### 2.3 最终删除

最终 R8 删除：

- 旧一级导航与旧默认入口；
- `/features`、`/operational`、`/pages`、`/page-detail`、`/operational-index`、`/observability`、`/operational-config`、`/onboarding`；
- 只为旧页面存在的响应 DTO、UI 文案和 E2E；
- v1/v2 测试数据兼容分支；
- “功能采用默认首页”“项目运营指数”等不再面向用户的术语；
- 被新 read model 替代且没有内部消费者的 API。

项目未上线，因此最终不提供旧路由 redirect。开发过程中旧页面可以暂时保留以保证当前 `main` 可用，但每个替代项必须带删除里程碑，不能无限共存。

## 3. 目标技术架构

~~~mermaid
flowchart TD
    A["Web Tracker contract v3"] --> B["Ingestion + Kafka + Consumer"]
    B --> C["ClickHouse raw facts"]
    D["MySQL projects/domains/pages/workflows"] --> E["Atomic metric stores"]
    C --> E
    E --> F["MetricCatalog + FormulaEvaluator"]
    G["Metric library versions"] --> F
    F --> H["ScoreEvaluationService"]
    H --> I["Project summary/overview read models"]
    F --> J["Business/page read models"]
    K["Probe/export settings"] --> L["Settings read models"]
    I --> M["Vue six-module UI"]
    J --> M
    L --> M
~~~

### 3.1 服务边界

建议在现有进程中明确以下职责，不要求立即拆成微服务：

- `ProjectSummaryService`：入口页批量汇总，禁止 N+1；
- `ProjectOverviewService`：链路、两类分数、概览指标和趋势；
- `BusinessAnalysisService`：业务域聚合和工作流分析；
- `PageAnalysisService`：页面质量/运营 read model；
- `SystemMetricCatalog`：代码注册的原子指标；
- `MetricLibraryService`：用户业务指标、版本和展示配置；
- `FormulaValidationService`：AST、单位、scope、复杂度和 DAG 校验；
- `FormulaEvaluationService`：服务端纯函数求值和逐桶趋势；
- `ScoreEvaluationService`：归一化、权重、eligibility、coverage 和贡献；
- `ProbePolicyService`：推荐/支持/阻断版本；
- `ExportInterfaceService`：外部接口、凭证、限流和审计。

controller 保持薄层，只处理授权、参数、稳定错误码和 request ID。

### 3.2 不引入的新基础设施

本轮默认不引入 Redis、Elasticsearch、向量数据库、调度平台或新的消息系统。公式只组合已注册指标，不直接执行用户 SQL。原始查询达到真实性能门槛后，再评审 ClickHouse 小时/天聚合状态。

## 4. Pre-1.0 数据与契约重置

### 4.1 重置决策

由于没有生产数据，本轮不使用“新增迁移 + 双读 + 双写 + 回填”的上线策略。

R0 应：

1. 将当前 MySQL 迁移整理为一个可从空库创建的 v1.8 基线；
2. 将 ClickHouse raw schema 整理为一个包含当前字段和新字段的 v1.8 基线；
3. 更新 `scripts/dev reset --confirm-local-data-loss` 清理本地命名卷；
4. 重建 seed、golden fixtures 和 E2E 数据；
5. 删除只为旧测试数据存在的应用兼容路径；
6. 保留备份/恢复脚本的安全行为，但不要求把旧 schema 恢复到新应用。

重置必须有显式确认，不得让普通 `down` 删除数据。

### 4.2 目标 MySQL 模型

建议模型：

| 表 | 职责 |
| --- | --- |
| `projects`、`project_origins`、`project_members` | 项目、接入和授权 |
| `business_domains` | 替代面向用户的 project_modules |
| `page_definitions` | 页面与业务域归属 |
| `workflow_definitions`、`workflow_definition_versions`、`workflow_steps` | 多阶段工作流 |
| `metric_library_versions` | 运营/质量指标版本快照 |
| `metric_definitions` | 当前版本中的原子/业务指标元数据与 formula AST |
| `metric_display_bindings` | 指标在哪些页面/卡片/趋势展示 |
| `score_definitions`、`score_dimensions`、`score_items` | 运营/质量分数 |
| `probe_policies` | 推荐、支持、弃用、阻断策略 |
| `export_interfaces`、`export_credentials` | 外部接口与 hash 凭证 |
| `audit_logs`、`data_status`、`auth_sessions` | 继续保留 |

可以按实现便利合并表，但必须保持激活版本不可变和完整快照语义。

### 4.3 目标 ClickHouse 字段

在当前 raw facts 上新增：

- `workflow_instance_id`；
- `workflow_key`；
- `workflow_definition_version`；
- `workflow_step_key`；
- `workflow_step_order`；
- `error_category`；
- 可选白名单 `lifecycle_phase`。

禁止新增 request/response body、header、DOM text 或业务 ID 字段。

### 4.4 contract v3

工作流阶段需要新的事件语义，采用下一版 Pre-1.0 契约：

- 保留当前 page/feature/long-view/observability 事件；
- operation 与 workflow instance 使用 SDK 随机 ID；
- 新增 `workflow_started`、`workflow_step_reached` 和明确终态；
- 公共 API 不允许业务方传入 instance ID；
- 事件声明 definition version；
- 同一 instance 的 step 顺序和终态由查询侧容忍迟到并识别冲突；
- 完成 v3 切换后不再接收历史 v1/v2 测试事件。

建议探针发布为下一个 breaking Pre-1.0 minor（预计 `0.4.0`，最终版本在 ADR 中确认）。

## 5. 分支、PR 与阶段门

### 5.1 分支规则

每个里程碑：

1. 以前一里程碑已合入的最新 `main` 为基线；
2. 使用 `agent/v1-8-<milestone>-<module>`；
3. 一个分支只实现该里程碑；
4. 不提前夹带后续页面；
5. 验收通过后合入，再创建下一分支。

### 5.2 每个 PR 必须包含

- v1.8 需求追踪表；
- 新增/修改/删除路由；
- 新增/修改/删除 API；
- 数据表和 fixture 变化；
- metric key/单位/公式/版本变化；
- 权限与审计验证；
- 隐私负向 fixture；
- 自动化命令与结果；
- 手工验收步骤；
- 已知非目标；
- 后续删除项。

### 5.3 通用完成定义

- `pnpm check` 通过；
- 当前模块 E2E 通过；
- 已合入 v1.8 模块回归通过；
- Chromium 与 WebKit 涉及的 SDK/产品流通过；
- 目标角色手工任务通过；
- 无 P0/P1 阻断缺陷；
- 不存在同时生效的两套公式或两套页面入口；
- 文档和代码使用同一术语。

## 6. 工期与里程碑

| 里程碑 | 页面/子模块 | 建议时间 | 阶段门 |
| --- | --- | ---: | --- |
| R0 | 重构契约、ADR、空库基线和测试骨架 | 2–3 日 | 空库一键启动，决策无歧义 |
| R1-A | 指标管理：分析对象 | 3–4 日 | 业务域/页面/工作流元数据闭环 |
| R1-B | 指标管理：指标版本与公式 | 5–7 日 | 公式、单位、DAG、版本正确 |
| R1-C | 指标管理：分数与质量指标 | 4–6 日 | 运营/质量分数与手算一致 |
| R2 | 入口页：全部项目 | 3–4 日 | 搜索、创建、卡片、分页闭环 |
| R3 | 项目框架与项目概览 | 4–6 日 | 两类分数、指标、趋势闭环 |
| R4-A | 业务分析：业务域指标 | 3–5 日 | 业务域卡片和趋势正确 |
| R4-B | 业务分析：多阶段工作流 | 6–8 日 | 并发实例和阶段耗时正确 |
| R5 | 页面分析：质量 TAB | 5–7 日 | 筛选、明细、复现上下文安全 |
| R6 | 页面分析：运营 TAB | 3–4 日 | 页面指标和趋势同源 |
| R7 | 设置 | 5–7 日 | 接入、探针、接口管理闭环 |
| R8 | 旧能力清理、全量回归与验收文档 | 4–6 日 | 只有一套正式 IA，全部 Go |

总计：**47–67 个开发日**。不包含产品评审等待、真实项目观察期、外部 Prometheus 环境协调和 SourceMap/AI 等非目标。

允许清理测试数据预计比生产兼容方案节省 5–8 个开发日；该节省不能用来省略产品版本、权限、隐私和自动化测试。

## 7. R0：契约、ADR、空库基线和测试骨架

建议分支：`agent/v1-8-r0-refactor-contract`

### 7.1 ADR

- ADR-014：六模块信息架构、正式路由和旧路由删除；
- ADR-015：指标版本快照、受控公式 AST、单位与 DAG；
- ADR-016：workflow contract v3、步骤触发和隐私；
- ADR-017：质量分数、外部接口凭证和 Prometheus 标签边界。

### 7.2 工程任务

- [ ] 固化新 route names、API names 和共享 DTO；
- [ ] 固化 7d/30d/90d/180d/365d/custom 范围与 day/week/month 粒度；
- [ ] 定义 v1.8 seed 项目、业务域、页面、工作流、指标和两类分数；
- [ ] 生成运营/质量分数手算 fixture；
- [ ] 生成公式合法/非法 fixture；
- [ ] 生成 workflow 并发、乱序、重复终态和超时 fixture；
- [ ] 生成错误复现上下文敏感数据负向 fixture；
- [ ] 建立新 E2E 目录和按模块运行命令；
- [ ] 验证空库、reset、重复 bootstrap 和完整 smoke。

### 7.3 Stop 条件

- 80 状态门槛与 85/60 色带没有按 v1.8 分开；
- 质量分数没有明确分母、minimum sample 或 gate；
- formula AST 仍可能拼接任意 SQL；
- workflow selector 需要采集 DOM 文本；
- 外部接口准备复用 projectKey 作为秘密凭证。

### 7.4 阶段门

- ADR accepted；
- 空库可一键重建；
- 5 类核心 fixture 能人工手算；
- 新旧术语和删除清单完整；
- 不开始页面代码，直到上述决策通过。

## 8. R1-A：指标管理——分析对象

建议分支：`agent/v1-8-r1a-analysis-objects`

### 8.1 范围

只交付指标管理中的“分析对象”TAB：

- business domain CRUD、排序、停用；
- page definition CRUD、route 归一化、业务域归属、页面模板和核心状态；
- workflow definition 基础信息与步骤编辑；
- 未归类 route 创建页面定义；
- admin 写、viewer 只读；
- 审计和项目隔离。

### 8.2 复用与重命名

- 复用当前 module/page/feature 配置逻辑；
- UI 和新 DTO 统一使用 business domain；
- 数据库允许直接重建为 `business_domains`；
- 不保留 module/business domain 两套可编辑页面；
- 现有 feature/task 元数据按工作流模型重新映射，不做历史数据迁移。

### 8.3 测试

- [ ] 项目隔离、唯一 key、排序和停用；
- [ ] route 高基数/动态 ID 归一化；
- [ ] 页面不能引用其他项目业务域；
- [ ] 工作流步骤 2–20、顺序唯一、终态合法；
- [ ] 普通 class 显示脆弱性提示；
- [ ] viewer 写 API 返回 403；
- [ ] 每次修改有审计且无敏感 payload。

### 8.4 阶段门

一个 admin 能在指标管理内完成“业务域 → 页面 → 工作流步骤”的配置，viewer 能查看但不能写；不要求此时已有工作流事实数据。

## 9. R1-B：指标管理——指标版本与公式

建议分支：`agent/v1-8-r1b-metric-library`

### 9.1 后端

- [ ] 将当前 `METRIC_CATALOG` 定义为只读系统指标目录；
- [ ] 增加运营/质量 metric library version；
- [ ] 增加草稿复制、校验、激活、废弃和重新激活；
- [ ] 实现 formula AST parser/validator；
- [ ] 实现单位、entity scope、时间粒度和 minimum sample 校验；
- [ ] 实现 DAG 拓扑排序、循环/缺失依赖 fail fast；
- [ ] 实现纯函数 evaluator；
- [ ] 实现逐桶趋势 evaluator；
- [ ] 输出 definition/lineage/diff/impact read model。

### 9.2 前端

- [ ] 默认指标与用户定义指标分区；
- [ ] 新建业务指标的语义化公式编辑器；
- [ ] 输入指标搜索、运算符、目标、单位和缺失规则；
- [ ] 保存前本地提示，服务端再次权威校验；
- [ ] 版本列表、草稿状态、公式 diff 和影响范围；
- [ ] 激活确认；
- [ ] 血缘抽屉；
- [ ] viewer 只读。

### 9.3 公式安全测试

- [ ] 任意 SQL/字段/函数被拒绝；
- [ ] 最大输入数、深度和节点数；
- [ ] 同单位加减、非法单位加减；
- [ ] scalar 乘除与非法单位组合；
- [ ] 分母 0；
- [ ] null/insufficient/delayed 传播；
- [ ] 循环、缺失依赖和跨项目引用；
- [ ] 同一公式总值和趋势桶一致；
- [ ] UI/API/fixture 使用同一公式说明。

### 9.4 阶段门

固定 fixture 中至少 3 个用户业务指标与手算完全一致；激活版本不可修改；修改会创建新草稿；页面尚未消费新指标也不影响本阶段验收。

## 10. R1-C：指标管理——分数与质量指标

建议分支：`agent/v1-8-r1c-score-management`

### 10.1 运营分数

- 将当前运营指数四维公式迁入 score definition；
- 保持 30/25/30/15 默认权重和现有 eligibility/coverage 语义；
- UI 改称运营分数；
- 总分、维度、原始值、目标、样本、原因、贡献和版本完整。

### 10.2 质量指标

新增系统原子/派生指标：

- JS/resource/API error occurrences；
- 每千 PV 错误率；
- affected account/browser/page；
- error group severity counts；
- LCP/CLS/INP/FCP/TTFB sample/p75/poor rate；
- release/error correlation evidence；
- telemetry freshness 只作为 gate。

### 10.3 质量分数

- 默认四维：JS 稳定性、资源稳定性、API 稳定性、页面性能；
- 每维使用可配置 lower_better/target_range；
- 质量分数与运营分数独立 metric library version；
- 没有足够 PV/性能样本时不可用；
- “没有错误事件”但链路无数据时不能得到 100；
- 默认模板先通过 demo fixture 手算，再允许新项目向导选择激活。

### 10.4 测试

- [ ] 运营分数与当前固定 fixture 等价；
- [ ] 质量分数的每千 PV 分母正确；
- [ ] 数据链路 broken/delayed gate；
- [ ] 0 error + healthy + sufficient PV 与 no_data 区分；
- [ ] minimum sample 边界；
- [ ] 维度少于门槛/权重覆盖不足；
- [ ] 色带 85/60 与项目状态 80 分开；
- [ ] 雷达和等价表格一致；
- [ ] 运营/质量版本不会交叉引用未批准指标。

### 10.5 阶段门

两个分数都能从总分沿 lineage 下钻到原子事实，并与手算一致。若质量目标仍无业务 owner，不允许用“临时阈值”伪装正式分数。

## 11. R2：入口页——全部项目

建议分支：`agent/v1-8-r2-project-entry`

### 11.1 后端

- [ ] `GET /api/projects/summary`：search、page、pageSize、time range；
- [ ] 一次批量查询返回项目、角色、两类分数、链路和更新时间；
- [ ] 告警优先 + 更新时间排序；
- [ ] 分数 unavailable reasons；
- [ ] viewer 项目授权过滤；
- [ ] 查询指标和 N+1 防护测试。

### 11.2 前端

- [ ] 新 `ProjectsView`；
- [ ] 登录成功和根路由进入 `/projects`；
- [ ] 模糊搜索、防抖、创建项目弹窗；
- [ ] 运营/质量分数、状态、链路、更新时间；
- [ ] 12/24/48 分页；
- [ ] loading/empty/error/forbidden；
- [ ] 创建成功定位新项目；
- [ ] 点击进入项目概览。

### 11.3 E2E

- admin 搜索、创建、分页、进入项目；
- viewer 只见授权项目且无创建按钮；
- 正常、告警、待配置、数据不足、链路异常卡片；
- 80 状态门槛与 85/60 色带；
- 刷新后 search/page 保留。

### 11.4 阶段门

入口页成为唯一登录后默认入口。旧页面仍可通过旧路由临时访问，但旧导航不得抢占默认首页。

## 12. R3：项目框架与项目概览

建议分支：`agent/v1-8-r3-project-overview`

### 12.1 项目框架

- [ ] 左上项目名和返回全部项目；
- [ ] 左下 5 个新导航；
- [ ] 右上公共时间、时区、账号；
- [ ] 7d/30d/90d/180d/365d；
- [ ] day/week/month gap fill；
- [ ] URL path 使用 projectId，不再依赖全局 project query；
- [ ] 项目切换回入口页，不在所有页面保留项目下拉。

未交付的后续模块可以显示明确“尚未在当前里程碑交付”，但不能链接到旧同名页面冒充完成。

### 12.2 项目概览 read model

- [ ] 链路、更新时间；
- [ ] 运营分数和维度；
- [ ] 质量分数和维度；
- [ ] 概览运营指标 display bindings；
- [ ] 多指标趋势；
- [ ] P0 固定告警摘要；
- [ ] definition/metric library/score version；
- [ ] unavailable/partial reason。

### 12.3 前端

- [ ] 两个雷达与等价表格；
- [ ] 分数下钻；
- [ ] 指标卡可滚动但保持键盘访问；
- [ ] 同单位多线、混合单位小多图；
- [ ] 维度设置只改变展示，公式修改进入指标管理新版本；
- [ ] 刷新保留旧数据并标记 stale。

### 12.4 阶段门

项目负责人可以只通过项目概览说明“当前链路、两个分数、最低维度、主要指标变化和告警证据”，且每个结论可下钻。

## 13. R4-A：业务分析——业务域指标

建议分支：`agent/v1-8-r4a-business-analysis`

### 13.1 后端

- [ ] 业务域列表；
- [ ] 业务域指标 read model；
- [ ] 按业务域聚合 page/task 指标；
- [ ] 排除未归类/停用页面；
- [ ] 指标 display bindings；
- [ ] 业务域趋势逐桶公式；
- [ ] 业务域 data status 和 sample。

### 13.2 前端

- [ ] 业务域单选；
- [ ] 运营指标卡；
- [ ] 同源趋势；
- [ ] 无配置、无数据、部分数据；
- [ ] 指标定义/版本入口；
- [ ] 工作流区先显示定义和“数据将在 R4-B 接入”的明确状态。

### 13.3 阶段门

同一业务域的卡片、趋势和原始页面汇总手算一致；切换业务域和时间范围后 URL 可恢复。

## 14. R4-B：业务分析——多阶段工作流

建议分支：`agent/v1-8-r4b-workflow-tracking`

### 14.1 SDK/contract

- [ ] contract v3 schema/types/golden fixtures；
- [ ] `startWorkflow(workflowKey)` handle；
- [ ] `reachStep(stepKey)`；
- [ ] complete/fail/cancel；
- [ ] instance ID 由 SDK 生成；
- [ ] terminal 只生效一次；
- [ ] 跨页面实例只在受控 session 范围内保存，TTL 到期清除；
- [ ] data-fi-action/ID adapter；
- [ ] 网络/lifecycle adapter 显式 opt-in；
- [ ] 宿主异常隔离和 bundle diff。

### 14.2 ingestion/consumer

- [ ] v3 权威校验；
- [ ] step key/version/order；
- [ ] ClickHouse 新字段；
- [ ] 重复、乱序、冲突终态诊断；
- [ ] 日志/死信无 payload；
- [ ] 完成 v3 后删除 v1/v2 接收测试。

### 14.3 查询

- [ ] started、每阶段到达、终态；
- [ ] 阶段到达率和流失；
- [ ] 总耗时、阶段耗时 p50/p75；
- [ ] 并发实例；
- [ ] 超时后 approximate abandonment；
- [ ] availableFrom 和 definition version；
- [ ] 任务前页面数/业务域跨度。

### 14.4 E2E 与阶段门

受控 demo 覆盖：

1. action → action → API success；
2. action → page lifecycle；
3. 同一 workflow 三个并发实例分别成功、失败、取消；
4. 超时前不算放弃、超时后近似放弃；
5. selector 变化不影响显式 SDK step；
6. token、query、DOM text 和业务 ID 不出现在 payload。

阶段门：所有实例与人工手算一致，且工作流追踪不影响宿主页面。

## 15. R5：页面分析——质量 TAB

建议分支：`agent/v1-8-r5-page-quality`

### 15.1 数据与 API

- [ ] 标准化 error category：api/resource/vue/react/promise/js/other；
- [ ] 保留 stable error group；
- [ ] 增加按 route/time/category 的 occurrence read model；
- [ ] cursor pagination；
- [ ] sanitized stack frames；
- [ ] safe reproduction context；
- [ ] 最新/全部实例切换；
- [ ] release/environment/browser/OS/viewport；
- [ ] query/headers/body/账号原值永不返回。

### 15.2 UI

- [ ] 页面分析默认 quality；
- [ ] route 模糊单选、custom date、category；
- [ ] 路径、时间、堆栈、复现条件、类别；
- [ ] 复现条件抽屉；
- [ ] group 折叠和分页；
- [ ] 数据状态、availableFrom、release；
- [ ] URL 可刷新/分享；
- [ ] 键盘可打开/关闭抽屉。

### 15.3 隐私测试

固定 fixture 包含 token、邮箱、动态 URL ID、query、header、body、DOM text 和业务编号；检查浏览器发送前、Kafka、ClickHouse、API、UI、日志和死信均无泄露。

### 15.4 阶段门

研发能按“某页面 + 某时间 + 某类别”找到错误并获得足够的安全上下文；不能为了提高复现信息量突破 v1.8 白名单。

## 16. R6：页面分析——运营 TAB

建议分支：`agent/v1-8-r6-page-operations`

### 16.1 范围

- [ ] 复用页面 PV/账号/浏览器/会话；
- [ ] 平均/p50/p75 可见时长和 coverage；
- [ ] 页面深度和业务域广度；
- [ ] 页面工作流/任务；
- [ ] 页面级 display bindings；
- [ ] 同源趋势；
- [ ] 页面模板和目标；
- [ ] 未归类 route 配置入口。

### 16.2 删除/迁移

本阶段完成后：

- `PagesView`、`PageDetailView` 的运营能力全部由新 TAB 替代；
- 页面相关旧导航进入 R8 删除清单；
- 不再新功能双写到旧页面 DTO。

### 16.3 阶段门

质量/运营 TAB 共享 route 和时间筛选；页面运营指标与指标管理版本一致；缺失 leave 不按 0，趋势缺口不连接。

## 17. R7：设置

建议分支：`agent/v1-8-r7-settings`

### 17.1 接入指南

- [ ] 项目基础设置、成员、Origin；
- [ ] 当前推荐探针的最小代码；
- [ ] CSP/endpoint/projectKey；
- [ ] 测试事件和数据状态；
- [ ] admin/viewer 边界；
- [ ] 将创建项目移至入口页。

### 17.2 探针版本

- [ ] probe policy CRUD；
- [ ] recommended/supported/deprecated/blocked；
- [ ] 从事件按版本统计占比和最后观测；
- [ ] release notes/升级建议；
- [ ] contract version；
- [ ] 不实现远程自动升级；
- [ ] blocked 策略有审计和显式确认。

### 17.3 接口管理

- [ ] metric snapshot/trend/error summary/Prometheus 类型；
- [ ] 默认关闭；
- [ ] 创建、启用、停用、轮换和撤销；
- [ ] token 只显示一次，DB 保存 hash；
- [ ] 参数 tooltip、分页、最近调用；
- [ ] per-project/interface/range scope；
- [ ] 限流、request ID 和审计；
- [ ] 禁止任意字段/SQL/group by；
- [ ] Prometheus 标签基数 allowlist；
- [ ] projectKey 不能作为凭证。

### 17.4 安全测试与阶段门

- 跨项目 token、过期/撤销 token、接口停用、超范围、暴力限流；
- Prometheus 输出无 route/error/account 高基数标签；
- 接口错误不暴露 SQL/Secret；
- viewer 不能创建或查看明文 token；
- 设置页三个 TAB 的目标任务全部通过。

## 18. R8：清理、回归和最终验收

建议分支：`agent/v1-8-r8-cleanup-acceptance`

### 18.1 删除

- [ ] 旧路由和导航；
- [ ] 旧 views；
- [ ] 旧页面专用 DTO/API；
- [ ] 旧 M5/M6/M8 产品 E2E 中已被新流替代的断言；
- [ ] 旧默认入口和旧 UI 术语；
- [ ] v1/v2 contract 和 fixture；
- [ ] 临时 feature flag、placeholder 和兼容 adapter；
- [ ] 漂移的文档链接。

保留仍有价值的底层单元/集成测试，不因删除旧页面而删除数据正确性证据。

### 18.2 全量自动化

- [ ] `pnpm check`；
- [ ] contract v3；
- [ ] SDK Chromium/WebKit；
- [ ] ingestion/Kafka/consumer/ClickHouse；
- [ ] MySQL/ClickHouse 空库 baseline 和 reset；
- [ ] 6 模块全 E2E；
- [ ] admin/viewer；
- [ ] formula/score/workflow golden fixtures；
- [ ] privacy negative fixtures；
- [ ] query performance；
- [ ] 20/200 events/s 负载；
- [ ] Kafka/ClickHouse/consumer 故障恢复；
- [ ] backup/restore 对新 schema 的演练。

### 18.3 最终手工验收

新增 `docs/guides/v1.8-local-acceptance-macos.md`，按以下顺序：

1. 空库重建与登录；
2. 入口页创建和查找项目；
3. 指标管理配置分析对象；
4. 创建并激活运营/质量指标版本；
5. 查看项目概览两类分数；
6. 查看业务域指标；
7. 执行多阶段工作流；
8. 触发错误和性能样本；
9. 页面质量/运营分析；
10. 探针与外部接口；
11. viewer 只读；
12. 数据状态、隐私、故障和恢复。

### 18.4 最终 Go

- 六模块是唯一正式信息架构；
- 所有新页面从同一指标版本服务取值；
- 两类分数与手算一致；
- 工作流并发和阶段耗时正确；
- 错误复现上下文无敏感数据；
- 外部接口默认关闭且凭证受控；
- 旧测试数据清理后系统可完整重建；
- GitHub Actions 全部通过；
- P0/P1 阻断缺陷为 0。

## 19. 测试矩阵

| 层级 | 关键覆盖 |
| --- | --- |
| 静态 | 类型、lint、workspace、catalog/DAG 静态校验 |
| 单元 | formula AST、单位、null、score、色带、range、workflow reducer |
| 契约 | v3 valid/invalid、边界、拒绝码、敏感字段 |
| 浏览器 | history/hash、visibility、selector adapter、并发 workflow、destroy |
| 集成 | MySQL baseline、Kafka、consumer、ClickHouse 新字段 |
| 数据正确性 | 原子/业务指标、两类分数、业务域、页面、工作流 |
| API | 授权、分页、范围、版本、availableFrom、错误码 |
| 前端 | 6 模块、URL、状态、表格/图表等价、键盘 |
| 隐私 | payload、Kafka、ClickHouse、API、UI、日志、死信 |
| 外部接口 | token、scope、限流、撤销、Prometheus 基数 |
| 性能 | SDK、ingestion、项目汇总、13 个月查询 |
| 运维 | reset、负载、故障、备份恢复 |

修改 golden fixture 时必须同时说明业务口径变化，不能只更新 snapshot 使测试变绿。

## 20. 查询与性能计划

### 20.1 项目入口

- 批量获取项目授权、状态和 active score version；
- ClickHouse 按项目一次聚合所选窗口；
- score evaluator 批量执行；
- 记录项目数、扫描量、查询时间；
- 20 项目下 p95 ≤2 秒；
- 禁止逐项目 HTTP/SQL N+1。

### 20.2 长时间范围

- 7/30 天为 day；
- 90 天为 week；
- 180/365 天为 month；
- 自定义范围按跨度选择安全粒度；
- trend query 返回缺口，不用 0 补齐；
- 同一 business metric 逐桶计算 AST。

### 20.3 物化触发

只有默认查询 p95 连续 3 天超过 2 秒、扫描负载影响其他查询或单项目事件量超过已评审阈值时，才设计 AggregatingMergeTree。

UV 使用可合并去重状态，p75 使用可合并 quantile 状态；不能直接相加或平均预聚合结果。

## 21. 风险登记

| 风险 | 概率/影响 | 早期信号 | 应对 |
| --- | --- | --- | --- |
| 一次 PR 又扩展为全站重构 | 高/高 | 同时修改多个未交付页面 | 强制里程碑边界和顺序合入 |
| 受控公式变成任意 BI | 高/高 | 出现任意字段/SQL/function | AST allowlist、scope/单位/复杂度 gate |
| 质量分数误把无数据当满分 | 高/高 | 0 error 即 100 | data status、PV/性能 minimum sample |
| 运营/质量版本交叉污染 | 中/高 | 分数引用未激活指标 | version pinning 和静态校验 |
| workflow selector 脆弱 | 高/中 | CSS 调整导致断链 | 显式 SDK/data-fi-action 优先 |
| workflow 并发串联 | 中/高 | 耗时异常、终态冲突 | SDK 随机 instance + fixture |
| “复现条件”导致隐私扩大 | 高/高 | 出现 query/body/DOM | 白名单 DTO + 全链路负向 fixture |
| 90d/1y 查询变慢 | 中/高 | 扫描量/p95 上升 | week/month 粒度与物化门槛 |
| 入口页 N+1 | 中/高 | 项目数线性增加请求 | 批量 read model 和查询计数测试 |
| 外部接口泄露数据 | 中/高 | 复用 projectKey/无限范围 | hash token、scope、限流、审计 |
| Prometheus 高基数 | 高/高 | route/error/account 成标签 | 标签 allowlist 和测试 |
| 旧页面长期共存 | 高/中 | 新旧术语和公式同时出现 | 每阶段删除清单，R8 强制清理 |

## 22. Stop 条件

出现以下任一情况，暂停对应里程碑并提交产品/技术决策：

- 业务指标需要访问当前目录以外的任意字段或原始 SQL；
- 质量分数没有可确认的目标/ceiling/minimum sample owner；
- 工作流成功不能由业务提供可靠终态；
- 需要业务敏感 ID 才能关联 workflow instance；
- 复现问题被要求采集正文、header、DOM 或录屏；
- 13 个月查询在固定查询和合理粒度下仍无法满足预算；
- Prometheus 必须使用高基数标签才能满足外部需求；
- 一批改动必须同时修改三个以上未交付页面才能“看起来完整”；
- 当前里程碑回归未通过却准备开始下一分支。

## 23. 变更控制与防熵规则

1. 指标变化先改定义、fixture 和 version，再改计算和 UI；
2. contract 变化先改 schema/fixture，再改 SDK、ingestion、consumer；
3. 激活的 metric/workflow/score version 不原地修改；
4. 任何卡片和图表都能定位 metric key 和 read model；
5. 前端不独立实现分数或公式；
6. 0、null、insufficient、missing_target、delayed 不合并；
7. 未归类页面不静默进入业务域或分数；
8. 数据状态不作为业务质量正向加分；
9. 外部接口默认关闭，projectKey 永远不是秘密凭证；
10. 不以缓存掩盖错误公式或高扫描查询；
11. 每个里程碑结束清理临时 flag、重复 DTO 和漂移文档；
12. 只有前一阶段合入并验收后才开始下一阶段；
13. 最终 `main` 不保留两套正式 IA、两套术语或两套公式；
14. 允许清理测试数据不等于允许降低隐私、权限或恢复安全。

## 24. 最终 Go / No-Go 模板

| 问题 | Go 条件 |
| --- | --- |
| 产品入口是否唯一？ | 登录 → 全部项目 → 项目 5 模块 |
| 页面职责是否清晰？ | 概览、业务、页面、指标、设置不重复 |
| 指标是否正确？ | catalog、AST、趋势、血缘和 fixture 一致 |
| 分数是否可信？ | 运营/质量独立，gate、目标、样本和贡献完整 |
| 工作流是否可靠？ | 并发、乱序、终态、超时和隐私通过 |
| 错误定位是否安全？ | 白名单复现上下文全链路无敏感数据 |
| 外部接口是否受控？ | 默认关闭、hash token、scope、限流、审计 |
| 查询是否可控？ | 入口和核心 Dashboard p95 ≤2 秒 |
| 宿主影响是否可接受？ | SDK bundle、同步耗时和异常隔离通过 |
| 重建是否可靠？ | 空库 reset、bootstrap、smoke 和 seed 通过 |
| 回归是否完整？ | 6 模块 E2E、负载、故障和恢复通过 |
| 是否有阻断缺陷？ | P0/P1 为 0，Actions 全绿 |

任一项不满足时为 No-Go，记录修复任务、owner、证据和复评日期。
