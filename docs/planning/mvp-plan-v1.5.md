# Frontend Insight——MVP 开发计划 v1.5（v1.8 逐模块重构）

> 状态：待技术评审<br>
> 更新日期：2026-08-27<br>
> 对应需求：[需求文档 v1.8](../product/requirements-v1.8.md)<br>
> 代码基线：`main` @ `a79fa5368b806c9808242eb65c6d076d5d1464eb`<br>
> 历史开发基线：[MVP 开发计划 v1.3](mvp-plan-v1.3.md)<br>
> 命名与指标基线：《内部业务操作系统 · 前端监测指标字典》v1.0，以附件字段名、事件名、指标 key 和口径为准<br>
> 废弃文档：`requirements-v1.7.md`、`mvp-plan-v1.4.md`，不得作为实现或验收依据<br>
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
7. 不重写已经验证的数据链路、鉴权、审计和隐私能力，除非新需求确实改变边界；
8. 先冻结附件规范名，再在对应页面/模块阶段完成端到端改名，R8 只清理残留；
9. 近似指标不能通过改名冒充附件指标；缺少分母、事实或组织目录时必须实现依赖或返回 `not_collected`。

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
| 命名门 | 规范名 manifest、生成类型、负向旧名测试和全仓 allowlist 同批更新 |

## 2. 当前代码地图与处理策略

### 2.1 直接复用

| 代码区域 | 已有能力 | 处理 |
| --- | --- | --- |
| `packages/web-tracker` | 页面、功能、operation、错误、Web Vitals、浏览器侧脱敏 | 保留实现；R0 切换规范字段，R4-B/R5-A 增加工作流和字典 collector |
| ingestion/consumer | schema 校验、Kafka、ClickHouse 写入、死信隐私 | 保留链路；R0 只支持 contract v3 并删除旧字段兼容 |
| `packages/server-core/src/analytics.ts` | PV、趋势、页面、任务、运营输入 | 拆分 read model；查询输出附件规范 key，不用 DTO alias |
| `packages/server-core/src/metrics.ts` | MetricCatalog、DAG、归一化、运营指数 | 演进为附件保留指标目录 + 扩展指标 + 受控公式 evaluator |
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
- `projectKey/eventName/eventTime/visitorId/accountRef/route/properties` 等旧公共字段；
- `page_views/active_accounts/active_browsers/sessions/project_operational_index` 等旧规范指标 key；
- business domain/业务域与 module/功能模块并存的同义模型；
- 被新 read model 替代且没有内部消费者的 API。

项目未上线，因此最终不提供旧路由 redirect。开发过程中旧页面可以暂时保留以保证当前 `main` 可用，但每个替代项必须带删除里程碑，不能无限共存。

### 2.4 `main` 命名与指标审计摘要

| 审计对象 | 当前实现 | 附件规范 | 实施结论 |
| --- | --- | --- | --- |
| event contract | `projectKey/eventName/eventTime/visitorId/accountRef/route/properties` | `appId`、`event`、`timestamp`、`deviceId`、`userId`、`pageRoute`、`payload`，并补 `env`、`release`、`pageUrl`、`deptId`、`roleId`、`ua`、`os`、`browser` | R0 breaking reset，不提供 alias/normalizer |
| raw ClickHouse | `project_id/event_name/event_time/visitor_id/account_id/route/properties_json` | `app_id/event/timestamp/device_id/user_id/page_route/payload_json` 等一一映射列 | 空库重建；技术追踪列另行保留 |
| usage metrics | `page_views/active_accounts/active_browsers/sessions` 等 | `pv`、`uv`、`dau`、`wau`、`mau`、`vv`、`module_penetration`、`avg_usage_duration`、`hourly_distribution`、`bounce_rate` | R1-B 注册，R4-A/R6 实现 |
| operation metrics | task success/duration、session depth 等近似指标 | `task_duration/form_efficiency/operation_fail_rate/repeated_operation_rate/path_steps` | 不做别名；R4-B/R4-C 补事实和正确分母 |
| performance | `web_vital` + 大写 vitalName，主要 P75；只采 API 失败 | `lcp`、`inp`、`cls`、`fcp`、`ttfb`、`first_screen_time`、`api_duration`、`api_slow_top`、`list_render_duration`、`longtask_count`、`longtask_total` | R5-A 逐 collector 实现 |
| stability | JS/resource/API 错误分子与错误组 | `js_error_rate/api_error_rate/resource_error_rate/blank_screen_rate/breadcrumb` | R5-A 补分母/事实，R5-B 展示 |
| organization | 无目录、部门/角色或异常访问指标 | `dept_usage`、`role_usage`、`role_feature_profile`、`abnormal_access` | R4-C/R7；先过隐私与管理评审 |
| product score | `project_operational_index` | `operational_score`；新增 `quality_score` | R1-C 同步重命名与新增，不保留双 key |
| analysis object | module 与 v1.8 初稿 business domain 混用 | 功能模块、`moduleId/moduleKey` | 复用 module，删除 business domain 同义设计 |

R0 输出一份机器可读 canonical-name manifest。历史文档、差异报告和 migration 说明可以在 allowlist 中引用旧名；生产 TypeScript、schema、SQL 查询别名、API fixture 和 UI 绑定不得引用旧名。

## 3. 目标技术架构

~~~mermaid
flowchart TD
    A["Web Tracker contract v3"] --> B["Ingestion + Kafka + Consumer"]
    B --> C["ClickHouse raw facts"]
    D["MySQL projects/modules/pages/workflows"] --> E["Atomic metric stores"]
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
- `BusinessAnalysisService`：功能模块聚合和工作流分析；
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
| `projects`、`project_origins`、`project_members` | 项目、`appId`、接入和授权；内部主键仍为 `projectId` |
| `modules` | 功能模块；使用 `moduleId/moduleKey` |
| `page_definitions` | 页面与功能模块归属 |
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

contract v3 raw facts 使用以下附件语义列；物理列采用 snake_case：

- `app_id`、`env`、`release`；
- `event`、`timestamp`、`received_at`；
- `page_url`、`page_route`；
- `user_id`、`dept_id`、`role_id`、`session_id`、`device_id`；
- `ua`、`os`、`browser`；
- `payload_json`；
- 技术列 `schema_version/event_id/page_view_id/request_id/sdk_version`。

在上述 raw facts 上增加工作流与错误明细列：

- `workflow_instance_id`；
- `workflow_key`；
- `workflow_definition_version`；
- `workflow_step_key`；
- `workflow_step_order`；
- `error_category`；
- 可选白名单 `lifecycle_phase`。

禁止新增 request/response body、header、DOM text 或业务 ID 字段。

### 4.4 contract v3

工作流阶段和附件统一命名使用下一版 Pre-1.0 契约：

- 公共字段严格使用 `appId`、`env`、`release`、`pageUrl`、`pageRoute`、`userId`、`deptId`、`roleId`、`sessionId`、`deviceId`、`ua`、`os`、`browser`、`timestamp`；
- `event` 只接受 `page_view/page_leave/performance/api/error/custom`，业务明细放入受控 `payload`；
- `web_vital/error_js/error_resource/error_api/feature_*` 按需求 v1.8 §2.5 映射，不作为 `event` 的运行时别名；
- operation 与 workflow instance 使用 SDK 随机 ID；
- workflow 具体动作使用 `event=custom` + 受控 `payload.name`；
- 公共 API 不允许业务方传入 instance ID；
- 事件声明 definition version；
- 同一 instance 的 step 顺序和终态由查询侧容忍迟到并识别冲突；
- 完成 v3 切换后不再接收历史 v1/v2、旧字段或旧 event alias。

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
- canonical-name manifest 变化和旧名扫描结果；
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
- 文档和代码使用同一术语；
- 当前阶段替代范围内的旧字段、旧 key 和旧 UI 名称命中为 0。

## 6. 工期与里程碑

| 里程碑 | 页面/子模块 | 建议时间 | 阶段门 |
| --- | --- | ---: | --- |
| R0 | 规范命名、contract、ADR、空库基线和测试骨架 | 4–6 日 | 空库一键启动，旧字段被拒绝 |
| R1-A | 指标管理：分析对象及验收改造 | 6–9 日 | 生命周期、模块下页面和可理解工作流闭环 |
| R1-B | 指标管理：指标字典、版本与公式 | 6–8 日 | 附件 key、公式、DAG、版本正确 |
| R1-C | 指标管理：分数与质量指标 | 4–6 日 | 运营/质量分数与手算一致 |
| R2 | 入口页：全部项目 | 3–4 日 | 搜索、创建、卡片、分页闭环 |
| R3 | 项目框架与项目概览 | 4–6 日 | 两类分数、指标、趋势闭环 |
| R4-A | 业务分析：功能模块指标 | 4–6 日 | `module_penetration` 和趋势正确 |
| R4-B | 业务分析：多阶段工作流 | 7–9 日 | 并发实例、关联 operation 和阶段耗时正确 |
| R4-C | 业务分析：操作效率与组织维度 | 6–9 日 | 操作/组织指标口径与隐私通过 |
| R5-A | 页面分析：性能与稳定性 collector/指标 | 8–12 日 | 字典性能/稳定性指标事实正确 |
| R5-B | 页面分析：质量 TAB UI | 5–7 日 | 筛选、明细、复现上下文安全 |
| R6 | 页面分析：运营 TAB | 5–7 日 | 字典使用指标和趋势同源 |
| R7 | 设置 | 6–8 日 | `appId`、探针、接口、异常规则闭环 |
| R8 | 旧能力清理、全量回归与验收文档 | 5–7 日 | 只有一套正式 IA/命名，全部 Go |

总计：**73–104 个开发日**。不包含产品评审等待、真实项目观察期、外部 Prometheus 环境协调和 SourceMap/AI 等非目标。R1-A 增加 3–5 日用于手工验收发现的生命周期、页面信息架构和工作流可理解性改造；R4-B 增加 1 日用于 operation 与 workflow instance 的显式 handle 关联及并发防串线验证。其他增量仍来自 `api_error_rate/resource_error_rate` 缺少分母，`form_efficiency/list_render_duration/longtask_*/blank_screen_rate/breadcrumb` 等没有事实采集，以及组织指标没有目录来源。

允许清理测试数据预计比生产兼容方案节省 5–8 个开发日；该节省不能用来省略产品版本、权限、隐私和自动化测试。

## 7. R0：规范命名、契约、ADR、空库基线和测试骨架

建议分支：`agent/v1-8-r0-refactor-contract`

### 7.1 ADR

- ADR-014：附件规范名、contract v3、MetricCatalog 保留 key 和禁止旧名；
- ADR-015：六模块信息架构、正式路由和旧路由删除；
- ADR-016：指标版本快照、受控公式 AST、单位与 DAG；
- ADR-017：workflow contract v3、步骤触发和隐私；
- ADR-018：质量分数、外部接口凭证和 Prometheus 标签边界。

### 7.2 工程任务

- [ ] 建立 machine-readable canonical-name manifest：公共字段、event enum、附件保留 metric key、UI 中文名和 forbidden aliases；
- [ ] 从 manifest 生成 TypeScript 类型、JSON Schema 枚举、MetricCatalog seed 和文档表，不手写平行常量；
- [ ] 将 `projectKey/eventName/eventTime/visitorId/accountRef/route/properties` 切换为 `appId/event/timestamp/deviceId/userId/pageRoute/payload`；
- [ ] 为所有事件补齐 `env`、`release`、`pageUrl`、`deptId`、`roleId`、`ua`、`os`、`browser` 的 schema、默认/缺失规则和隐私处理；
- [ ] 固化新 route names、API names 和共享 DTO；
- [ ] 固化 7d/30d/90d/180d/365d/custom 范围与 day/week/month 粒度；
- [ ] 从空库重建 MySQL `app_id/modules` 与 ClickHouse v3 规范列；不写旧列迁移或回填；
- [ ] 定义 v1.8 seed 项目、功能模块、页面、工作流、附件指标和两类分数；
- [ ] 生成 v3 valid/invalid/golden fixtures；v1/v2、旧字段、旧 event alias 和旧 metric key 必须失败；
- [ ] 建立代码扫描 allowlist，旧名只允许出现在历史文档、差异说明和负向 fixture；
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
- 外部接口准备复用 `appId` 作为秘密凭证。

### 7.4 阶段门

- ADR accepted；
- 空库可一键重建；
- canonical-name manifest 与生成物一致；
- v3 事件完整通过，v1/v2 和旧字段全部被拒绝；
- 5 类核心 fixture 能人工手算；
- 新旧术语和删除清单完整；
- 不开始页面代码，直到上述决策通过。

## 8. R1-A：指标管理——分析对象

建议分支：`agent/v1-8-r1a-analysis-objects`

### 8.1 范围

只交付指标管理中的“分析对象”TAB：

- 功能模块创建、排序、停用与归档；删除模块级关键度，不提供产品内物理删除；
- page definition 创建、`pageRoute` 归一化、模块优先的页面管理、页面模板和核心状态；
- workflow definition 基础信息、步骤编辑、达成条件说明和自然语言判定预览；
- 未归类 route 在 R6 上线前保留折叠临时入口，并准备迁移跳转；
- admin 写、viewer 只读；
- 审计和项目隔离。

需求 9.7.1 的决策已确认为 `D1-A / D2-A / 调整后的 D3-A / D4-A / D5-A / D6-A`。文档评审通过前不开始本批后续代码；实施不得重新引入已否决的模块关键度、物理删除、全量页面表格、常驻未归类大表或 selector `appeared`。

### 8.2 复用与重命名

- 复用当前 module/page/feature 配置逻辑；
- UI 使用“功能模块”，新 DTO 使用 `moduleId/moduleKey`；
- 数据库直接重建为 `modules`；
- 不保留 module/business domain 两套名称或可编辑页面；
- 现有 task 元数据按工作流模型重新映射，不做历史数据迁移；启用 operation lifecycle 的 feature 标识只作为 `operationKey` 登记来源保留，不能同时成为第二套工作流步骤模型。
- 页面配置优先复用现有一页归属一个模块的关系；模块主从视图是查询和交互调整，不建立第二套模块—页面模型；
- 从 modules 的 UI/DTO/API/schema/seed/test 删除模块级 `criticalityWeight`；页面级字段保留；
- module/page 增加配置 revision 与 effective window；启用态语义字段允许修改，开始修改时显示“不建议频繁修改该字段”，保存必须创建新 revision，不能只覆盖当前行；
- 工作流激活版本保持不可变；编辑启用中的工作流时创建/打开新草稿，不要求先停用当前版本；
- 增加归档状态、默认过滤、恢复、依赖检查和审计；归档前必须停用，唯一 key 继续占用，不提供产品内物理删除；
- 工作流 `explicit_sdk` 不再要求用户填写无业务区别的“受控值”，改为生成 `startWorkflow/reachStep` 只读接入示例；
- `operation_terminal` 保存已登记且 `operationLifecycleEnabled=true` 的 `operationKey + state`，operation 状态只使用 `succeeded/failed/canceled`；当前 `featureKey` 是 operation 标识来源，不建立第二套可编辑身份；
- R1-A 只配置和解释 operation 依赖，并显示“数据将在 R4-B 关联 SDK 接入”；不能把当前独立 `tracker.startOperation(featureKey)` 宣称为已能驱动 workflow step；
- selector 只支持 `click/change`，不实现 `appeared/MutationObserver`；说明图标只在用户选中“元素交互”时出现。

### 8.3 测试

- [ ] 项目隔离、唯一 key、排序和停用；
- [ ] 原生 TAB、URL `object` 参数和可见 panel 在点击、刷新、前进/后退后保持一致；
- [ ] 所有创建、保存、启停、归档、恢复和激活操作有成功反馈；409 指向具体冲突 key，失败保留表单；
- [ ] route 高基数/动态 ID 归一化；
- [ ] 页面不能引用其他项目功能模块；
- [ ] 模块选择器只展示可选模块，新增页面带入当前模块，移动页面创建新 revision；
- [ ] 停用/归档依赖检查、恢复、默认过滤、唯一 key 占用和历史引用通过 API 与 UI 测试；不存在产品内物理删除入口；
- [ ] 模块级关键度在 UI/DTO/API/schema/seed 中不存在，页面级关键度仍可用；
- [ ] 展示字段和语义字段均可在启用态编辑；语义字段开始修改时显示指定提示，保存形成新的 effective window，历史查询不漂移；
- [ ] 工作流步骤 2–20、顺序唯一、终态合法；
- [ ] 普通 class 显示脆弱性提示；
- [ ] 每种步骤达成条件生成正确的自然语言预览，helper/tooltip/说明面板支持键盘；
- [ ] selector 只接受 `click/change`；未选择“元素交互”时无 D6 图标，选择后图标和上下文说明均可用；`appeared` 不出现在 UI/API；
- [ ] operation 终态必须包含已登记 `operationKey` 和 `succeeded/failed/canceled`，不能只保存状态；UI 能说明独立 operation 当前不能驱动 workflow step；
- [ ] 显式 SDK 只读示例与 operation 关联示例可复制且不包含业务 ID；
- [ ] viewer 写 API 返回 403；
- [ ] 每次修改有审计且无敏感 payload。

### 8.4 阶段门

一个 admin 能在指标管理内完成“选择功能模块 → 管理所属页面 → 配置工作流步骤”的任务，并能从页面说明回答每一步“谁在什么条件下让步骤达成、它是否等于工作流终态、当前版本是否已经可采集”；viewer 能查看但不能写。生命周期操作不破坏历史引用，启用态修改有 revision，TAB 与 URL 状态一致，所有写操作有明确结果反馈；R1-A 不要求已有工作流事实数据，operation 关联采集明确归 R4-B。

### 8.5 评审和实施顺序

文档评审分支：`agent/v1-8-r1a-ux-design-review`，从 `refactor` 创建，只修改需求和开发计划。

实施顺序：

1. 已在独立 R1-A 分支修复手工验收确认的 TAB 状态、重复 key 提示、操作反馈和工作流布局缺陷；
2. 在文档 PR 中确认 `D1-A / D2-A / 调整后的 D3-A / D4-A / D5-A / D6-A` 及 operation 关联边界；
3. 文档评审通过后，从已验收的 R1-A 代码创建后续实施分支，不从文档分支开发代码；
4. 先删除模块关键度并实现停用/归档、module/page revision，再实现模块主从页面 UI 和未归类临时入口；
5. 最后实现工作流术语、判定预览、上下文说明、条件式 D6 图标、SDK 示例和 operation 可用状态；
6. 更新 API/DB/fixture/E2E/手工验收后重新执行完整 R1-A 阶段门。

Stop 条件：文档评审未通过、revision effective window 仍可能重写历史、operation 仍可只选状态而无稳定标识，或 UI 把未关联的独立 operation 宣称为 workflow 事实。任何一项存在时不得开始或通过后续实现。

## 9. R1-B：指标管理——指标字典、版本与公式

建议分支：`agent/v1-8-r1b-metric-library`

### 9.1 后端

- [ ] 将当前 `METRIC_CATALOG` 重建为只读系统指标目录；
- [ ] 注册需求 v1.8 §2.6 的全部附件保留 key，分为 usage/operation/performance/stability/organization；
- [ ] 每个定义保存中文名、公式、分子、分母、去重键、单位、分位数、上报时机、scope、minimum sample、missing policy、owner、版本和 implementation status；
- [ ] implementation status 只允许 `implemented/partial/not_collected`；`partial/not_collected` 查询不能返回伪造的 0；
- [ ] `main` 独有且仍有价值的指标使用独立扩展 key；不得给近似公式套用附件保留 key；
- [ ] 删除 `page_views/active_accounts/active_browsers/sessions` 等旧 catalog key；
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
- [ ] 系统默认指标显示附件规范 key、中文名、实施状态和数据可用起点；
- [ ] `not_collected` 指标可以查看定义和计划阶段，但不能加入已激活分数或展示绑定。

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
- [ ] 附件保留 key 不可被用户创建、覆盖或改义；
- [ ] 旧 key/alias 请求返回稳定错误，不自动改写为新 key。

### 9.4 阶段门

附件全部保留 key 已注册且元数据完整；固定 fixture 中至少 3 个用户业务指标与手算完全一致；激活版本不可修改；修改会创建新草稿；页面尚未消费 `not_collected` 指标不影响本阶段验收，但 UI 必须如实显示状态。

## 10. R1-C：指标管理——分数与质量指标

建议分支：`agent/v1-8-r1c-score-management`

### 10.1 运营分数

- 将当前运营指数四维公式迁入 `operational_score` score definition；
- 保持 30/25/30/15 默认权重和现有 eligibility/coverage 语义；
- UI 改称运营分数，并删除 `project_operational_index` key；
- 总分、维度、原始值、目标、样本、原因、贡献和版本完整。

### 10.2 质量指标

新增/注册系统原子与派生指标：

- 附件规范 `js_error_rate/resource_error_rate/api_error_rate`，未具备分母前状态为 `partial`，不得用每千 PV 近似替代；
- `lcp`、`inp`、`cls`、`fcp`、`ttfb` 的 sample、规定分位数和 poor rate；
- error occurrences、affected user/device/page、error group severity 等扩展诊断指标；
- release/error correlation evidence；
- telemetry freshness 只作为 gate。

### 10.3 质量分数

- 默认四维：JS 稳定性、资源稳定性、API 稳定性、页面性能；
- 每维使用可配置 lower_better/target_range；
- 规范 key 为 `quality_score`，与 `operational_score` 使用独立 metric library version；
- 没有足够 PV/性能样本时不可用；
- “没有错误事件”但链路无数据时不能得到 100；
- 默认模板先通过 demo fixture 手算，再允许新项目向导选择激活。

### 10.4 测试

- [ ] 运营分数与当前固定 fixture 等价；
- [ ] `js_error_rate/api_error_rate/resource_error_rate` 分别使用附件规定的 PV、API 请求总数和资源请求总数分母；
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

## 13. R4-A：业务分析——功能模块指标

建议分支：`agent/v1-8-r4a-business-analysis`

### 13.1 后端

- [ ] 功能模块列表；
- [ ] 功能模块指标 read model；
- [ ] 按功能模块聚合 page/task 指标；
- [ ] 排除未归类/停用页面；
- [ ] 指标 display bindings；
- [ ] `module_penetration`：去重 `userId` / 系统总用户数，返回分母来源与目录版本；
- [ ] 90 日活跃用户近似分母只能显式标记 `estimated`，不能静默冒充编制人数；
- [ ] `pv/uv/task_duration/operation_fail_rate` 等可聚合指标按附件 key 返回；
- [ ] 功能模块趋势逐桶公式；
- [ ] 功能模块 data status 和 sample。

### 13.2 前端

- [ ] 功能模块单选；
- [ ] 运营指标卡；
- [ ] 同源趋势；
- [ ] 无配置、无数据、部分数据；
- [ ] 指标定义/版本入口；
- [ ] 工作流区先显示定义和“数据将在 R4-B 接入”的明确状态。

### 13.3 阶段门

同一功能模块的卡片、趋势和原始页面汇总手算一致；`module_penetration` 的分子、分母和目录版本可解释；切换功能模块和时间范围后 URL 可恢复。

## 14. R4-B：业务分析——多阶段工作流

建议分支：`agent/v1-8-r4b-workflow-tracking`

### 14.1 SDK/contract

- [ ] contract v3 schema/types/golden fixtures；
- [ ] `startWorkflow(workflowKey)` handle；
- [ ] `reachStep(stepKey)`；
- [ ] workflow handle 增加 `startOperation(operationKey, payload?, interactionType?)`（或 ADR 确认的等价嵌套 API），同时生成随机 operation/workflow instance 关联；业务方不能传 instance ID；
- [ ] 保留独立 `tracker.startOperation(featureKey)` 的单次 operation 能力，但未显式绑定 workflow handle 时不得驱动 workflow step；
- [ ] 已登记且 `operationLifecycleEnabled=true` 的 `featureKey` 收敛为工作流配置中的 `operationKey` 来源，不建立双 key；参数/DTO 的最终规范名由 breaking Pre-1.0 ADR 冻结；
- [ ] operation 终态使用 `succeeded/failed/canceled`，`completed` 只表示 workflow 成功；关联 operation 终态按激活定义中的 `operationKey + state` 达成对应步骤；
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
- [ ] operation/workflow 显式关联校验；拒绝无关联实例、错误 `operationKey/state` 和跨项目/跨版本匹配；
- [ ] 禁止按同一 session、最近事件或时间邻近关系推断 operation 属于哪个 workflow instance；
- [ ] ClickHouse 新字段；
- [ ] 重复、乱序、冲突终态诊断；
- [ ] 日志/死信无 payload；
- [ ] 完成 v3 后删除 v1/v2 接收测试。

### 14.3 查询

- [ ] started、每阶段到达、终态；
- [ ] 阶段到达率和流失；
- [ ] `task_duration` 总耗时按任务类型输出 P50/P90，并同时提供 P75/P99；
- [ ] 工作流阶段耗时作为独立扩展指标，不占用 `task_duration` key；
- [ ] 并发实例；
- [ ] 超时后 approximate abandonment；
- [ ] availableFrom 和 definition version；
- [ ] `path_steps`：任务完成前去重页面数、总步数和回退步数；
- [ ] 任务前功能模块跨度作为扩展诊断字段。

### 14.4 E2E 与阶段门

受控 demo 覆盖：

1. 显式 `reachStep`：action → action → API success；
2. action → page lifecycle；
3. 关联 operation：`workflow.startOperation("model_download")` 分别 `succeed/fail/cancel`，只达成配置了相同 `operationKey + state` 的步骤；
4. 同一 workflow 三个并发实例和同 key 的三个并发 operation 不串线；
5. 独立 `tracker.startOperation` 即使 key 和时间相同，也不能驱动未关联的 workflow step；
6. 超时前不算放弃、超时后近似放弃；
7. selector 变化不影响显式 SDK step；
8. token、query、DOM text、业务 ID 和调用方提供的 instance ID 不出现在 payload。

阶段门：所有实例与人工手算一致，业务开发者能从接入示例区分直接 `reachStep` 与关联 operation；同 session/同 key 并发不串线，且工作流追踪不影响宿主页面。

## 15. R4-C：业务分析——操作效率与组织维度

建议分支：`agent/v1-8-r4c-operation-organization`

### 15.1 操作效率事实

- [ ] `form_efficiency`：`trackForm(formId)` 只汇总字段 key 的 change 次数、重置、提交尝试和校验失败，不采集输入值；
- [ ] `operation_fail_rate`：显式业务请求适配器上报业务成功/拒绝，不能从 HTTP 状态或 workflow failed 推断；
- [ ] `repeated_operation_rate`：业务对象引用在客户端/ingest 使用项目级不可逆处理，按 `userId + bizRef + 24h` 聚合；
- [ ] `task_duration` 和 `path_steps` 复用 R4-B 事实，不建立第二套 operation 链路；
- [ ] 每个比率返回 numerator、denominator、sample、coverage、status 和 definition version；
- [ ] collector 单独 opt-in、可关闭且异常不影响宿主。

### 15.2 组织目录与聚合

- [ ] 定义版本化 eligible user/department/role directory snapshot；
- [ ] `deptId`、`roleId` 优先在服务端根据受治理 `userId` 补充，不允许业务页面上传姓名或组织文本；
- [ ] 实现 `dept_usage`、`role_usage` 的活跃人数、编制人数、比率和功能分布；
- [ ] 实现 `role_feature_profile` 的角色 × 功能模块 PV/有效时长 Top N；
- [ ] 小群体门槛、抑制、目录版本和数据可用时间；
- [ ] 所有组织结果只用于产品落地和权限/菜单分析，不进入个人绩效。

### 15.3 UI、测试与阶段门

- [ ] 业务分析增加“操作效率”和“组织维度”页内子区，不新增一级导航；
- [ ] 无业务适配器、无目录、样本不足和权限不足分别显示；
- [ ] 表单值、原始工号、业务对象 ID、部门/角色文本不出现在事件、Kafka、ClickHouse、日志或 UI；
- [ ] 业务拒绝与 `api_error_rate` 的固定 fixture 证明互不混淆；
- [ ] 重复操作阈值 2/3/4 边界、跨用户/对象/日期和迟到事件测试；
- [ ] viewer 只能查看经过授权和小群体保护的聚合结果。

阶段门：五个操作效率 key 与三个组织 key 的公式、分母和隐私验证通过；缺少正式目录时组织指标保持 `not_collected`，不以当前活跃用户静默冒充分母。

## 16. R5-A：页面分析——性能与稳定性 collector/指标

建议分支：`agent/v1-8-r5a-quality-collectors`

### 16.1 性能 collector

- [ ] 将 `web_vital` + 大写 vitalName 切换为 `event=performance`，`payload.metric` 使用 `lcp`、`inp`、`cls`、`fcp`、`ttfb`；
- [ ] `lcp`、`inp`、`cls`、`fcp`、`ttfb` 按附件输出规定主分位数，并保留 P50/P75/P90/P99、sample 和 threshold version；
- [ ] 增加业务显式 `first_screen_time` API；
- [ ] 增加 API 汇总适配器，形成 `api_duration`、`api_slow_top`、`api_error_rate` 的成功与失败请求分母；全局 fetch 包装默认关闭；
- [ ] 增加 `list_render_duration` 显式组件计时，行数分桶 `<100/100–1000/>1000`；
- [ ] 增加 `longtask_count`、`longtask_total`，按 `pageRoute` 在 `page_leave` 汇总；
- [ ] collector 都有开关、采样、队列大小、事件大小和宿主异常隔离。

### 16.2 稳定性 collector

- [ ] `event=error` 覆盖 JS/resource，`event=api` 覆盖 API 正常/异常汇总；
- [ ] `js_error_rate` 使用 JS 异常次数 / `pv`；
- [ ] `api_error_rate` 使用 HTTP/网络/超时异常请求 / API 请求总数；
- [ ] `resource_error_rate` 增加资源请求总数汇总后才激活；
- [ ] `blank_screen_rate` 按页面模板 opt-in，返回启用检测 PV 分母、规则版本和 coverage；
- [ ] `breadcrumb` 环形缓冲最多 50 条，仅随错误发送，只含页面跳转、安全 action、脱敏 API 和允许的生命周期；
- [ ] 保留稳定 error group、指纹限流和安全堆栈，不因字段改名降低现有隐私保护。

### 16.3 查询、容量与阶段门

- [ ] 所有 rate 的 numerator/denominator、0 分母、缺失 collector、样本不足和 partial 时段 golden fixture；
- [ ] Chromium/WebKit 的 PerformanceObserver 支持与降级；
- [ ] API/resource 成功分母新增后的事件量、20/200 events/s 链路和 ClickHouse 扫描预算；
- [ ] collector 开关组合、重复安装/销毁、页面切换结算顺序和 Beacon flush；
- [ ] token/query/header/body/form/DOM/raw userId 的全链路负向 fixture；
- [ ] 指标查询只能返回附件 key，旧 event/metric alias 被拒绝。

阶段门：性能与稳定性字典指标均为 `implemented` 或有经评审的 `not_collected` 原因；任何称为 rate 的指标都有真实分母；SDK 对宿主业务的同步耗时、包体和异常隔离通过预算。

## 17. R5-B：页面分析——质量 TAB UI

建议分支：`agent/v1-8-r5b-page-quality-ui`

### 17.1 数据与 API

- [ ] 标准化 error category：api/resource/vue/react/promise/js/other；
- [ ] 保留 stable error group；
- [ ] 增加按 `pageRoute/timestamp/category` 的 occurrence read model；
- [ ] cursor pagination；
- [ ] sanitized stack frames；
- [ ] safe reproduction context；
- [ ] 最新/全部实例切换；
- [ ] `release/env/browser/os` 和视口档位；
- [ ] query/headers/body/账号原值永不返回。

### 17.2 UI

- [ ] 页面分析默认 quality；
- [ ] `pageRoute` 模糊单选、custom date、category；
- [ ] 路径、时间、堆栈、复现条件、类别；
- [ ] 复现条件抽屉；
- [ ] group 折叠和分页；
- [ ] 数据状态、availableFrom、`release`；
- [ ] URL 可刷新/分享；
- [ ] 键盘可打开/关闭抽屉。

### 17.3 隐私测试

固定 fixture 包含 token、邮箱、动态 URL ID、query、header、body、DOM text 和业务编号；检查浏览器发送前、Kafka、ClickHouse、API、UI、日志和死信均无泄露。

### 17.4 阶段门

研发能按“某页面 + 某时间 + 某类别”找到错误并获得足够的安全上下文；不能为了提高复现信息量突破 v1.8 白名单。

## 18. R6：页面分析——运营 TAB

建议分支：`agent/v1-8-r6-page-operations`

### 18.1 范围

- [ ] `pv`：`page_view` 计数，不去重；
- [ ] `uv`：`userId` 去重，未登录按 `deviceId` 兜底，并明确匿名/已识别构成；
- [ ] `dau`、`wau`、`mau`：按项目时区自然日/周/月去重；
- [ ] `vv`：`sessionId` 去重和 30 分钟 idle 边界；
- [ ] `avg_usage_duration`：有效会话时长之和 / `uv`；
- [ ] `hourly_distribution`：项目本地小时的 `pv/uv`；
- [ ] `bounce_rate`：单页会话 / 总会话，只作诊断、不默认告警；
- [ ] 页面可见时长 P50/P75/P90/P99、coverage、页面深度和功能模块广度作为扩展诊断指标；
- [ ] 页面工作流/任务；
- [ ] 页面级 display bindings；
- [ ] 同源趋势；
- [ ] 页面模板和目标；
- [ ] 未归类 route 配置入口。

### 18.2 删除/迁移

本阶段完成后：

- `PagesView`、`PageDetailView` 的运营能力全部由新 TAB 替代；
- 页面相关旧导航进入 R8 删除清单；
- 不再新功能双写到旧页面 DTO。

### 18.3 阶段门

质量/运营 TAB 共享 `pageRoute` 和时间筛选；七类使用指标与指标管理版本、附件公式和手算 fixture 一致；缺失 `page_leave` 不按 0，趋势缺口不连接；UI 不再显示“活跃账号/活跃浏览器/会话”等旧主指标名替代 `uv/vv`。

## 19. R7：设置

建议分支：`agent/v1-8-r7-settings`

### 19.1 接入指南

- [ ] 项目基础设置、成员、Origin；
- [ ] 当前推荐探针的最小代码；
- [ ] CSP/endpoint/`appId`；
- [ ] 测试事件和数据状态；
- [ ] admin/viewer 边界；
- [ ] 将创建项目移至入口页。

### 19.2 探针版本

- [ ] probe policy CRUD；
- [ ] recommended/supported/deprecated/blocked；
- [ ] 从事件按版本统计占比和最后观测；
- [ ] release notes/升级建议；
- [ ] contract version；
- [ ] 不实现远程自动升级；
- [ ] blocked 策略有审计和显式确认。

### 19.3 接口管理

- [ ] metric snapshot/trend/error summary/Prometheus 类型；
- [ ] 默认关闭；
- [ ] 创建、启用、停用、轮换和撤销；
- [ ] token 只显示一次，DB 保存 hash；
- [ ] 参数 tooltip、分页、最近调用；
- [ ] per-project/interface/range scope；
- [ ] 限流、request ID 和审计；
- [ ] 禁止任意字段/SQL/group by；
- [ ] Prometheus 标签基数 allowlist；
- [ ] `appId` 不能作为凭证。

### 19.4 异常访问规则

- [ ] `abnormal_access` 固定首版规则：非工作时间高频、个人历史操作量异常、多 IP/多设备和无权限路由拦截异常；
- [ ] 规则、阈值、适用范围和可见角色必须经管理层/安全评审并版本化；
- [ ] 只返回调查证据和审计入口，不生成个人评分或绩效排名；
- [ ] 小样本、共享账号、时区和出差/值班例外处理；
- [ ] 规则命中、查看和导出均有审计。

### 19.5 安全测试与阶段门

- 跨项目 token、过期/撤销 token、接口停用、超范围、暴力限流；
- Prometheus 输出无 `pageRoute/error message/userId` 高基数标签；
- 接口错误不暴露 SQL/Secret；
- viewer 不能创建或查看明文 token；
- 设置页接入指南、探针版本、接口管理和异常访问四组目标任务全部通过。

## 20. R8：清理、回归和最终验收

建议分支：`agent/v1-8-r8-cleanup-acceptance`

### 20.1 删除

- [ ] 旧路由和导航；
- [ ] 旧 views；
- [ ] 旧页面专用 DTO/API；
- [ ] 旧 M5/M6/M8 产品 E2E 中已被新流替代的断言；
- [ ] 旧默认入口和旧 UI 术语；
- [ ] v1/v2 contract 和 fixture；
- [ ] 旧公共字段、旧 event alias、旧 metric key 和 DTO alias；
- [ ] business domain/业务域同义模型和迁移残留；
- [ ] 临时 feature flag、placeholder 和兼容 adapter；
- [ ] 漂移的文档链接。

执行 canonical-name 扫描：历史文档、差异说明和负向 fixture 使用显式 allowlist；除此之外 `projectKey/eventName/eventTime/visitorId/accountRef/route/properties/page_views/active_accounts/active_browsers/sessions/project_operational_index` 等旧名命中数必须为 0。

保留仍有价值的底层单元/集成测试，不因删除旧页面而删除数据正确性证据。

### 20.2 全量自动化

- [ ] `pnpm check`；
- [ ] contract v3；
- [ ] canonical-name manifest、生成类型和旧名负向扫描；
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

### 20.3 最终手工验收

新增 `docs/guides/v1.8-local-acceptance-macos.md`，按以下顺序：

1. 空库重建与登录；
2. 入口页创建和查找项目；
3. 指标管理配置功能模块、页面和工作流；
4. 创建并激活运营/质量指标版本；
5. 查看项目概览两类分数；
6. 查看功能模块指标；
7. 执行多阶段工作流；
8. 触发错误和性能样本；
9. 页面质量/运营分析；
10. 探针与外部接口；
11. viewer 只读；
12. 数据状态、隐私、故障和恢复。

### 20.4 最终 Go

- 六模块是唯一正式信息架构；
- 所有新页面从同一指标版本服务取值；
- 附件保留指标 key 均有正确实施状态，页面不再消费旧 key；
- 两类分数与手算一致；
- 工作流并发和阶段耗时正确；
- 错误复现上下文无敏感数据；
- 外部接口默认关闭且凭证受控；
- 旧测试数据清理后系统可完整重建；
- GitHub Actions 全部通过；
- P0/P1 阻断缺陷为 0。

## 21. 测试矩阵

| 层级 | 关键覆盖 |
| --- | --- |
| 静态 | 类型、lint、workspace、catalog/DAG 静态校验 |
| 单元 | formula AST、单位、null、score、色带、range、workflow reducer |
| 契约 | v3 valid/invalid、边界、拒绝码、敏感字段 |
| 浏览器 | history/hash、visibility、selector adapter、并发 workflow、destroy |
| 集成 | MySQL baseline、Kafka、consumer、ClickHouse 新字段 |
| 数据正确性 | 附件指标、扩展指标、两类分数、功能模块、页面、工作流 |
| API | 授权、分页、范围、版本、availableFrom、错误码 |
| 前端 | 6 模块、URL、状态、表格/图表等价、键盘 |
| 隐私 | payload、Kafka、ClickHouse、API、UI、日志、死信 |
| 外部接口 | token、scope、限流、撤销、Prometheus 基数 |
| 性能 | SDK、ingestion、项目汇总、13 个月查询 |
| 运维 | reset、负载、故障、备份恢复 |

修改 golden fixture 时必须同时说明业务口径变化，不能只更新 snapshot 使测试变绿。

## 22. 查询与性能计划

### 22.1 项目入口

- 批量获取项目授权、状态和 active score version；
- ClickHouse 按项目一次聚合所选窗口；
- score evaluator 批量执行；
- 记录项目数、扫描量、查询时间；
- 20 项目下 p95 ≤2 秒；
- 禁止逐项目 HTTP/SQL N+1。

### 22.2 长时间范围

- 7/30 天为 day；
- 90 天为 week；
- 180/365 天为 month；
- 自定义范围按跨度选择安全粒度；
- trend query 返回缺口，不用 0 补齐；
- 同一 business metric 逐桶计算 AST。

### 22.3 物化触发

只有默认查询 p95 连续 3 天超过 2 秒、扫描负载影响其他查询或单项目事件量超过已评审阈值时，才设计 AggregatingMergeTree。

UV 使用可合并去重状态，p75 使用可合并 quantile 状态；不能直接相加或平均预聚合结果。

## 23. 风险登记

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
| 外部接口泄露数据 | 中/高 | 复用 `appId`/无限范围 | hash token、scope、限流、审计 |
| Prometheus 高基数 | 高/高 | `pageRoute/error message/userId` 成标签 | 标签 allowlist 和测试 |
| 旧页面长期共存 | 高/中 | 新旧术语和公式同时出现 | 每阶段删除清单，R8 强制清理 |
| 规范名再次漂移 | 高/高 | SDK/SQL/DTO/UI 出现不同 key | machine-readable manifest、生成类型、负向旧名扫描 |
| 近似指标冒充附件指标 | 高/高 | rate 无真实分母或换名即“完成” | implementation status、公式/分母 golden、`not_collected` |

## 24. Stop 条件

出现以下任一情况，暂停对应里程碑并提交产品/技术决策：

- 业务指标需要访问当前目录以外的任意字段或原始 SQL；
- 任一附件 rate 指标没有真实、可审计的分母却准备标记为 `implemented`；
- 实现准备保留旧字段 alias、双读或自动 normalizer；
- 质量分数没有可确认的目标/ceiling/minimum sample owner；
- 工作流成功不能由业务提供可靠终态；
- 需要业务敏感 ID 才能关联 workflow instance；
- 复现问题被要求采集正文、header、DOM 或录屏；
- 13 个月查询在固定查询和合理粒度下仍无法满足预算；
- Prometheus 必须使用高基数标签才能满足外部需求；
- 一批改动必须同时修改三个以上未交付页面才能“看起来完整”；
- 当前里程碑回归未通过却准备开始下一分支。

## 25. 变更控制与防熵规则

1. 指标变化先改定义、fixture 和 version，再改计算和 UI；
2. contract 变化先改 schema/fixture，再改 SDK、ingestion、consumer；
3. 字段/事件/指标命名先改 canonical-name manifest 和生成物，禁止调用方自行定义 alias；
4. 激活的 metric/workflow/score version 不原地修改；
5. 任何卡片和图表都能定位 metric key 和 read model；
6. 前端不独立实现分数或公式；
7. 0、null、insufficient、missing_target、not_collected、delayed 不合并；
8. 未归类页面不静默进入功能模块或分数；
9. 数据状态不作为业务质量正向加分；
10. 外部接口默认关闭，`appId` 永远不是秘密凭证；
11. 不以缓存掩盖错误公式或高扫描查询；
12. 每个里程碑结束清理临时 flag、重复 DTO 和漂移文档；
13. 只有前一阶段合入并验收后才开始下一阶段；
14. 最终 `main` 不保留两套正式 IA、两套术语或两套公式；
15. 允许清理测试数据不等于允许降低隐私、权限或恢复安全。

## 26. 最终 Go / No-Go 模板

| 问题 | Go 条件 |
| --- | --- |
| 产品入口是否唯一？ | 登录 → 全部项目 → 项目 5 模块 |
| 页面职责是否清晰？ | 概览、业务、页面、指标、设置不重复 |
| 指标是否正确？ | 附件保留 key、catalog、AST、分母、趋势、血缘和 fixture 一致 |
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
