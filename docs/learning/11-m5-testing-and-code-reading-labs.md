# 11. M5 测试与代码精读实验

> 本文保留 M5 完成时的测试基线与实验。当前 `main` 已增加 M6/M8 Playwright、M7 负载/故障/恢复演练和对应 workflow；新增代码精读实验见 [18. M6–M8 代码精读实验](18-m6-m8-code-reading-labs.md)。

## 1. M5 的测试目标是“语义闭环”

前端页面能构建不代表产品正确。M5 至少要同时证明：

1. 纯函数没有把未知值变成 0；
2. Vue/TypeScript 与固定 API 读模型一致；
3. SDK 在 Chromium/WebKit 中遵守生命周期和隐私契约；
4. ingestion → Kafka → consumer → ClickHouse → analytics 可查询；
5. admin/viewer 的真实页面操作符合权限；
6. demo 的 token 和密码没有进入实际请求体；
7. Mac 本地命令可理解、可恢复、不会默认删数据。

这些证据分布在不同测试层，不能用一个“全量 E2E”替代所有单元和契约测试。

## 2. 当前验证矩阵

| 层              | 命令/文件                              | 主要证明                                                 | 不证明什么                        |
| --------------- | -------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| 静态与单元      | `pnpm check`                           | format、边界、契约漂移、lint、类型、Vitest、build        | 浏览器和容器真实行为              |
| Web 纯函数      | `apps/web/test/*.test.ts`              | 状态优先级、范围、趋势缺口、格式                         | Vue 模板交互                      |
| SDK 浏览器契约  | `pnpm test:browser`                    | Chromium/WebKit 的 SPA、visibility、beacon/隐私          | 管理端页面                        |
| 数据流 verifier | `./scripts/dev smoke`                  | migration、重复交付、权限、三类 golden 指标、HTTP health | 人工 UX                           |
| M5 产品 E2E     | `pnpm test:m5:e2e`                     | demo、admin 闭环、viewer 只读，双浏览器                  | M1 Mac 资源与 Docker Desktop 体验 |
| M6 产品 E2E     | `pnpm test:m6:e2e`                     | 操作域、页面详情、指数与配置任务，双浏览器               | 生产故障恢复                      |
| M8 产品 E2E     | `pnpm test:m8:e2e`                     | 错误、Web Vitals、版本与告警页面，双浏览器               | SourceMap 和告警生命周期          |
| M7 加固演练     | `bash scripts/m7 ...`                  | 负载、Kafka/ClickHouse/consumer 故障、升级/恢复姿态       | 外部发布审批与真实多机容灾         |
| 人工验收        | `docs/guides/local-full-flow-macos.md` | 文案、等待、浏览器操作、资源、重启与保留                 | 自动回归稳定性                    |

M5 完成时的自动化基线：

- 9 个 Vitest 文件、65 项测试；
- 6 项 SDK 浏览器契约；
- 3 个 M5 产品场景 × Chromium/WebKit = 6 项；
- 完整 Compose migration、seed、数据流和服务健康。

当前 `main` 的静态/单元基线已扩展到 15 个 Vitest 文件、108 项测试；SDK gzip 预算下的产物为 7,511 bytes。M5 数字保留为历史验收点，不应用来描述当前全部覆盖。

测试数量不是质量本身。更重要的是每个产品不变量至少有一个能失败的证据。

## 3. `pnpm check` 为什么按这个顺序

根脚本依次执行：

```text
format:check
→ check:workspace
→ contract:check
→ lint
→ typecheck
→ test
→ build
```

含义：

- 先处理成本低、反馈快的格式和依赖错误；
- 契约生成漂移在业务测试前失败；
- 类型和单元通过后再做 production build；
- build 再次证明 Vite/Vue SFC 和 workspace 产物可生成。

`check` 不启动 Docker，也不安装浏览器，因此本地修改纯前端逻辑时可以快速运行。涉及真实浏览器、migration、API 或 Compose 时，必须继续执行后面的层。

## 4. Web 纯函数测试应该覆盖什么

### 4.1 `presentation.test.ts`

最适合表驱动：

| loading | hasData | errorStatus | dataState | activity | gaps  | 期望        |
| ------- | ------- | ----------- | --------- | -------- | ----- | ----------- |
| true    | false   | null        | null      | null     | false | loading     |
| false   | false   | 403         | null      | null     | false | forbidden   |
| false   | true    | 500         | healthy   | true     | false | stale       |
| false   | true    | null        | no_data   | false    | false | onboarding  |
| false   | true    | null        | delayed   | false    | false | delayed     |
| false   | true    | null        | healthy   | false    | false | no_activity |
| false   | true    | null        | healthy   | true     | true  | partial     |

测试重点是优先级，而不是每个 if 单独覆盖。例如 error + data 必须在 dataState=no_data 前得到 stale。

### 4.2 `range.test.ts`

应证明：

- preset 白名单；
- 24h/7d/30d 的 from/to；
- 30d 使用 day，其余 hour；
- timezone 原样进入 query；
- `rangeSearch` 编码；
- 正常点不插 gap；
- 大间隔插入 null；
- 输入乱序后输出有序；
- percent 对 null 显示 `—`；
- date/number 格式化不会抛错。

若修改 bucket 协议，必须新增带 offset、无 offset 和 DST 的用例。

## 5. SDK 浏览器契约与 M5 E2E 为什么分开

SDK browser tests 直接验证 tracker 的底层行为：

- history API；
- visibility；
- session/pageView IDs；
- beacon/fetch；
- privacy；
- bundle 预算。

M5 E2E 验证用户可见任务：

- demo 点击后真实 payload；
- admin 登录、筛选 URL、功能/页面/接入导航；
- viewer 看得到证据但不能改配置。

如果把 SDK 细节都放进管理端 E2E：

- 失败定位困难；
- 页面文案变化会阻塞底层协议测试；
- 每个生命周期场景都要启动完整 Compose；
- 测试慢且不稳定。

分层不是重复，而是让失败位置更接近根因。

## 6. M5 产品 E2E 的三个故事

源文件：`tests/m5/product-flow.spec.ts`。

### 6.1 三场景 + 隐私

步骤：

1. 监听所有 POST `/v1/events` 的实际 body；
2. 打开 demo fast 验收入口；
3. 输入模拟密码并登录，记录随机模拟 token；
4. 完成 data success；
5. 完成 action success 和 cancel；
6. 开始/停止 long view；
7. flush；
8. 断言 payload 有 started/succeeded/failed/long_view_ended；
9. 断言 payload 没有 token、密码和 Authorization。

它把产品语义和隐私放在同一个真实发送边界验证。

### 6.2 admin 产品闭环

步骤：

1. 登录；
2. 功能采用页出现 seed 数据、转化和重复使用；
3. URL 自动有 project/range；
4. reload 后 query 保持；
5. 进入页面访问，看到昨日同时段和归一化路由；
6. 进入 onboarding，看到 project key、测试事件和隐私说明。

这不是视觉截图测试，而是验证任务导航和关键语义。

### 6.3 viewer 只读

步骤：

1. viewer 登录；
2. 能进入功能采用；
3. onboarding 显示只读；
4. 创建项目按钮不存在；
5. 项目名称 disabled；
6. 保存按钮不存在。

它验证前端体验。服务端 403 仍由 M4 权限/API 测试覆盖。

## 7. 为什么同时跑 Chromium 和 WebKit

目标用户可能使用 Chrome 和 Safari；项目又依赖浏览器行为：

- sessionStorage/Cookie；
- History API；
- Visibility API；
- sendBeacon/fetch keepalive；
- ResizeObserver；
- Canvas。

只在 Chromium 通过不能证明 WebKit 的生命周期一致。Playwright M5 配置使用：

- `fullyParallel: false`；
- `workers: 1`；
- 无重试；
- 失败保留 trace 和截图。

串行降低共享 seed/Compose 数据的竞争。没有重试让 flaky 直接暴露，而不是被“第二次通过”掩盖。

## 8. Compose smoke 与页面 E2E 的边界

`./scripts/dev smoke` 先运行底层 verifier，再在 API 容器执行 HTTP smoke：

- migration 升级与幂等；
- fixture 写入和隐私；
- Kafka 重复交付与查询去重；
- admin/viewer；
- 三类 golden 指标；
- management web、demo、API health。

页面 E2E 依赖这份已知数据。若 E2E 失败：

1. 先看 smoke 是否通过；
2. smoke 失败，定位数据链路/API；
3. smoke 通过，定位路由、组件、选择器或浏览器行为；
4. 不要直接在 E2E 中增加固定等待掩盖链路问题。

## 9. GitHub Actions 当前触发边界

当前有三条阶段性产品 workflow：

| Workflow | push 分支 | 主要覆盖 |
| -------- | --------- | -------- |
| `.github/workflows/m5.yml` | `agent/m5-*` | 静态检查、SDK 浏览器契约、M5 本地产品闭环 |
| `.github/workflows/m6.yml` | `agent/m6-*` | M5 回归 + M6 产品验收 |
| `.github/workflows/m7-m8.yml` | `agent/m7-m8-*`，以及相关代码 PR paths | M7 负载/故障/恢复 + M5/M6 回归 + M8 验收 |

纯 `docs/learning/**` 分支不会因分支名自动触发这些 push 条件，且 M7/M8 的 PR path 过滤也不包含学习文档。更新学习资料时应做 Markdown/链接/路径检查；修改对应阶段代码时使用匹配分支、相关 PR 或手工 `workflow_dispatch`。

不要把“没有失败的 CI”误读为“CI 已运行且通过”。

## 10. 实验 1：手画登录恢复状态机

### 目标

理解内存用户、sessionStorage access token 和 HttpOnly refresh cookie 的关系。

### 操作

依次推导：

1. 新标签页，无 access token，有有效 refresh cookie；
2. 新标签页，有 access token 和 saved user；
3. 普通 API 返回 401，refresh 成功；
4. 普通 API 返回 401，refresh 也失败；
5. logout API 失败但浏览器仍执行本地退出；
6. 同时三个 API 返回 401。

对每个场景写出：

```text
storage → api.restore/request → browser event → auth.state → router
```

最后解释为什么并发 401 需要 single-flight，但普通首屏暂时可接受当前实现。

## 11. 实验 2：验证 URL 是页面上下文

### 目标

确认项目/范围在导航、刷新和分享后保持。

### 操作

1. 登录；
2. 选择第二个项目和 `30d`；
3. 进入功能详情；
4. 刷新；
5. 返回列表；
6. 进入页面访问；
7. 复制 URL 到新标签页；
8. 将 `range` 手工改成非法值；
9. 将 `project` 改成不可访问 ID。

预期：

- 合法 project/range 保留；
- 非法 range 回退 7d；
- 不存在项目回退第一个可访问项目；
- 登录 redirect 保留完整 query。

思考：哪些 UI 状态不应进入 URL？例如弹窗开关、输入中的密码、临时 loading。

## 12. 实验 3：制造旧请求覆盖新请求

### 目标

亲手验证 `useRemoteData` 当前的竞争窗口，并设计最小修复。

### 操作

为 loader 创建两个可控 Promise：

1. 启动 A；
2. 启动 B；
3. 先 resolve B；
4. 再 resolve A；
5. 观察最终 `data`。

然后设计：

```ts
let requestVersion = 0;

async function load(loader) {
  const version = ++requestVersion;
  const value = await loader();
  if (version === requestVersion) data.value = value;
}
```

补充失败场景：旧请求失败也不能覆盖新请求的 error。只有在需要节约服务端资源时再加入 AbortController。

## 13. 实验 4：列出页面状态真值表

### 目标

避免新增页面时只写 `v-if="loading"` 和 `v-else`。

### 操作

为一个新“SDK 版本”页面填写：

| 请求    | 旧数据 | dataState | 范围活动 | gap  | 页面结果 | 用户行动 |
| ------- | ------ | --------- | -------- | ---- | -------- | -------- |
| loading | 无     | 未知      | 未知     | 未知 |          |          |
| 500     | 无     | 未知      | 未知     | 未知 |          |          |
| 500     | 有     | healthy   | 有       | 无   |          |          |
| success | 有     | no_data   | 无       | 无   |          |          |
| success | 有     | healthy   | 无       | 无   |          |          |
| success | 有     | delayed   | 0        | 有   |          |          |

对照 `resolveProductPresentation`，说明哪些状态可复用，哪些需要新定义。若出现“部分区域成功”，先写区域级语义再拆 resource。

## 14. 实验 5：0、null 和缺失 bucket

### 目标

从数据手算到图表呈现。

### 输入

```text
10:00 pv=4 visitors=3
11:00 pv=0 visitors=0
13:00 pv=5 visitors=4
```

手写 `fillTrendGaps` 输出，并解释：

- 11:00 的 0 必须画到 0；
- 12:00 插 null；
- 11:00 到 13:00 不能直接连线；
- tooltip 对 null 不应显示“0 次”；
- 如果后端返回带项目 offset 的 bucket，当前解析是否正确。

## 15. 实验 6：三类成功调用点

### 目标

把 demo 模式迁移到真实业务。

分别选择：

- 一个图表页；
- 一个导出按钮；
- 一个长时大屏。

为每个写表：

| 阶段            | 真实业务信号 | Tracker 调用 | 失败 code | 不能采集 |
| --------------- | ------------ | ------------ | --------- | -------- |
| exposed         |              |              |           |          |
| started         |              |              |           |          |
| succeeded       |              |              |           |          |
| failed          |              |              |           |          |
| ended/heartbeat |              |              |           |          |

必须明确：

- 图表“接口成功但渲染失败”不成功；
- 导出“点击”不成功，应以文件/任务真正开始为准；
- 大屏后台标签页不累计；
- error message、token、文件名、表单内容不能放进 properties。

## 16. 实验 7：onboarding 排障

### 目标

从一个失败测试事件定位到正确层。

依次制造：

1. 删除 demo Origin；
2. 使用错误 project key；
3. 停用项目；
4. 在 CSP 中禁止 connect-src；
5. 停止 consumer；
6. 停止 Kafka；
7. 恢复所有服务。

记录：

| 场景 | 浏览器是否有 HTTP | code/status | request ID | data-status | 第一处理动作 |
| ---- | ----------------- | ----------- | ---------- | ----------- | ------------ |

解释 202 为什么不保证已经可查询，以及为什么 Kafka 不可用时不应返回成功。

## 17. 实验 8：token 泄露回归

### 目标

验证真实发送边界，而不是只搜索源码。

### 操作

1. 在 demo 登录生成模拟 token；
2. DevTools Network 过滤 `/v1/events`；
3. 完成三个场景；
4. 导出请求 body；
5. 搜索 token、密码、Authorization、Cookie；
6. 检查 accountRef 只是不透明 analyticsRef；
7. 运行 `pnpm test:m5:e2e` 重复自动验证。

变体：故意在 feature properties 放入 `Authorization` 或 JWT 形态字符串，确认 SDK/契约拒绝且不发送。

## 18. 实验 9：viewer 双层权限

### 目标

区分“按钮不可见”和“API 不可越权”。

### 操作

1. viewer 登录；
2. 确认项目和分析可读；
3. 确认表单 disabled、写按钮不存在；
4. 在 DevTools 手工 PATCH 项目；
5. 记录服务端 403；
6. 用 admin 完成相同 PATCH；
7. 确认项目列表 refresh；
8. 尝试修改最后一个 owner，观察事务约束。

如果 UI 误显示可编辑但 API 拒绝，是体验 bug；如果 UI 隐藏但 API 允许，是安全 bug。

## 19. 实验 10：本地生命周期与数据保留

### 目标

理解 Compose 命令的恢复语义。

### 操作

```bash
./scripts/dev doctor
./scripts/dev up
./scripts/dev smoke
./scripts/dev status
./scripts/dev down
./scripts/dev up
```

确认重启后用户、项目和事件仍在。然后只在明确接受数据删除时执行：

```bash
./scripts/dev reset --confirm-local-data-loss
```

记录 reset 前列出的卷，确认只带 `frontend-insight-m5` Compose project label。禁止用 `docker system prune --volumes` 代替。

## 20. 实验 11：设计一个“SDK 版本页”

### 目标

练习从产品问题到可持续代码，而不是直接复制一个 Vue 文件。

设计说明至少包括：

- 用户要做的决定是什么；
- sdk name/version、事件数、最后接收时间的口径；
- 旧行 `unknown` 怎样显示；
- 数据状态、范围无活动和请求失败怎样区分；
- 是否需要新的固定 API，还是复用已有响应；
- URL 是否需要 version filter；
- 服务端分页还是客户端过滤；
- 类型生成/运行时校验策略；
- 单元、golden、E2E 和 M1 Mac 验收；
- 何时会因版本基数增长而需要聚合或索引。

如果页面只是把已有抽屉内容复制成表格，要先证明独立用户任务的必要性。

## 21. M5 变更 Playbook

### 21.1 新增分析指标

1. 在 PRD 写业务问题、事件、分子、分母、null、时间、身份和去重；
2. 修改 ClickHouse 固定查询；
3. 更新服务端响应与 golden 测试；
4. 更新前端读模型；
5. 更新展示、definition 和状态；
6. 增加纯函数/页面 E2E；
7. 检查旧 SDK/旧数据；
8. 运行 `pnpm check`、browser、smoke、M5 E2E。

### 21.2 新增管理操作

1. 先定义后端角色矩阵和事务不变量；
2. 增加 API 与审计；
3. 前端按同一规则隐藏/禁用；
4. 成功后 refresh 正确 cache；
5. 失败保留输入、显示稳定 code/request ID；
6. admin/viewer API 与 E2E 都测试。

### 21.3 修改路由或筛选

1. 判断状态是否值得分享/刷新；
2. 定义 URL 参数和非法值回退；
3. 保证详情/返回/登录 redirect 保留；
4. 处理快速切换请求竞争；
5. 增加 reload 和 deep-link E2E；
6. 检查 Nginx SPA fallback。

### 21.4 新增 demo 场景

1. 先在功能定义中写成功条件；
2. 使用真实业务结果触发，不以点击替代；
3. reason code 低基数、无 PII；
4. 显示预期事件解释；
5. 捕获真实 payload 做 token/密码回归；
6. seed、Origin、golden 和分析页一起更新。

## 22. 最终自测题

不看源码回答：

1. 页面为什么需要请求状态、链路状态和业务活动三套状态？
2. 为什么 `data + error` 应显示 stale，而不是清空数据？
3. 0、null 和省略 bucket 分别代表什么？
4. 为什么管理端不应计算新的权威指标？
5. 为什么测试事件成功不等于 SDK 接入完成？
6. demo 的 token 与 analyticsRef 分别用来做什么？
7. 三类功能的成功调用点分别是什么？
8. viewer 的 UI 只读与服务端 403 为什么都要测试？
9. M5 E2E 与 SDK browser tests 为什么不能合并成一层？
10. 为什么学习资料分支没有失败的阶段性 CI 不能算通过？
11. `down`、`reset` 和全局 Docker prune 的风险有什么不同？
12. 快速切换项目时当前实现有什么竞争窗口，最小修复是什么？

如果只能回答“代码就是这样写的”，回到相应实验，画出输入、状态、输出、失败和恢复路径。
