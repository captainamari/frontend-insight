# ADR-019：分数快照、评审与观察范围

> **手工验收与 R2 继承更新 · 2026-09-11**：Jesse 在本会话明确确认“本次手工验收通过”，对应 R1-C `d37059bb32daf2c857747905d0873b719c323de8`，其 [Actions](https://github.com/captainamari/frontend-insight/actions/runs/34451705146) 为 success。已由用户合入 `refactor`；R2 从合并提交 `cfd90863827b7dad64007bcfd681f0b7d29e3489` 创建 `agent/v1-8-r2-project-entry`。下文旧“待手工验收/不进入 R2”保留为历史，已由本确认解除，不再阻断 R2；未补写任何未执行的手工用例。这不代表 R2 已验收，也不代表 R4-B/R5-A/R6 事实已交付。不授权代理合并或修改 refactor/main。

状态：已实现；完整产品门禁在 `0fb2f79` 通过，最终提交继续同 SHA 复核。依据 Jesse 2026-09-09 已批准的 Q04/Q05/Q12、D2、D3-A、D4-A；手工验收待确认。

## 决策与依据

R1-C 继续使用 R1-B 的目录、AST/DAG/evaluator 和两类独立指标版本。`score_definitions` 在其 metric library version 下唯一，配置和分析对象依赖作为完整 JSON 快照，同时写入 dimension/item 引用用于既有 impact/lineage。系统默认模板版本固定，业务 owner Jesse 不等于系统权限账户。

`createDraft` 在项目行锁下复用唯一工作草稿并克隆分数引用；`activateVersion` 在同一锁和事务中校验完整配置、评审摘要、切换唯一 active、记录审计与生效区间。激活和重激活都必须经过相同校验。草稿变化后先前评审不能再使用。指标版本库中含分数的版本转到统一分数评审入口。

历史试算通过显式管理员 API 执行并独立保存完整结果与查询上下文，不改变原始事实或旧结果标签。结果包含项目、env、metric set、definition、范围、时区、粒度和 effectiveAt。未提供缓存；未来缓存必须使用相同完整身份。跨版本窗口没有单一总分，无事实不制造趋势分段或事实血缘。

## Q04/Q05 的可继承边界

依据当前 `analytics.ts` 的 `deduplicatedEventsWhere`、`sessionOperationalRows`、`expectedLocalDates`：查询先筛选 [from,to) 事实，再按已有 sessionId 聚合；项目本地日期从该相交窗口展开。会话 ID 由既有 30 分钟无操作规则产生，午夜不是切分点。`score-observation.ts` 复用日期助手并固定该样本合同；不提前实现 R6 collector。

反例：同一会话在 23:55 访问 A，00:05 访问 B。跨两日期的窗口得到深度 2；各天查询分别观察到 1。平均两个每日 P50 得到 1，与窗口会话样本不等价。部分日期也只使用窗口内事实，并显示实际时间范围；未结束窗口、未收到的结束事实和曝光完整性不能自动当作完整样本。范围内只覆盖一个项目本地日期时，跨日持续项不可参与计算，原因是无法观察跨日，而不是 0 分。

工作流实例所属窗口和事实完成性由 R4-B 的正式事实服务交付；R1-C 只固定已批准的池化加权 nearest-rank 算法及每类型 P50/P90。没有添加步骤部分完成度或独立 operation 近似。

## 事实状态与测试边界

实际查询不使用 fixture；当前规范工作流、质量真分母、完整使用事实及 env 曝光未齐，结果如实不可用。配置可以通过 D4-A 激活，但不能把配置成功写成事实可用。JS/Vitals partial、API/resource rate not_collected 保留。

固定示例、真实 MySQL/API、Chromium/WebKit、R1-A/B 回归各自保留证据。验收 fixture 会改变 active/draft，因此 workflow 先完成既有 R1-A/B 回归，再完成 R1-C 集成与产品测试；所有步骤在同一 checkout、同一真实测试栈执行，不跳过失败。
