# D4：排障产品流程与协作

当前验证状态、精确代码 SHA 和 CI 见 [results](../progress/runtime-diagnostics-results.md)。D4 继承 D0–D3；没有实现 D5 SourceMap、D6 完整授权/策略设置页面或 D7 全量发布验收。不代表人工验收已通过。

## 从质量问题到证据文件

1. 打开项目 → 页面分析 → 质量分析，核对环境、项目时区和起止范围。窗口为 `[from,to)`；相对范围点击页面“刷新”推进结束时间，F5 保留已有 URL 快照。
2. 选择路径、类别、Release。版本为精确匹配，留空表示全部，`__unknown__` 表示未提供版本。这些条件先过滤基础实例，再计算组数和次数；“每组最新一次”只改变展示行，不改变所选范围总次数。
3. 展开错误组 → “查看此组全部实例”。列表保留当前筛选；“返回全部错误组”返回组视图。组内可以继续更换 Release。
4. “版本与影响统计”显示所选范围及版本的首次/最近出现、错误次数，以及同窗口不同 release 的影响比较。比较表始终包含该组各版本，所选 release 的汇总单独显示。
5. 有当前项目 `diagnostics.read` 的成员可使用“授权原文搜索”。选择错误消息或已存诊断原文，输入搜索词，点击搜索。搜索结果可打开当前列表页以外的实例；结果数量不是全部错误次数。
6. 点击“诊断上下文”或“查看命中实例”，打开统一详情。查看消息、原始编译栈、结构化帧、cause/子错误、console、请求与操作时间线。栈解析失败不删除原文。只按明确 ID 显示显式关联，其他同页窗口证据标为时间邻近。
7. “复制稳定实例链接”生成 `/projects/<projectId>/diagnostics/<eventId>`，不含正文、凭据、授权或筛选搜索词。收件人必须登录并通过当前权限检查；支持刷新、新标签和登录后返回。独立实例不受列表时间范围限制，实际环境/release显示在详情中。
8. 复制消息、栈、console、请求前均重新授权。拥有 read + export 时可下载 JSON 或文本证据；下载是每次即时请求，不生成长期文件链接。

## 权限区别

| 身份                         | 质量统计/基础列表 | 原文详情与搜索 | 文件导出   | 指标/成员/设置写入 |
| ---------------------------- | ----------------- | -------------- | ---------- | ------------------ |
| 当前有效 admin               | 原有管理范围      | 允许并审计     | 允许并审计 | 原管理合同         |
| 当前项目成员 + read + export | 项目内允许        | 允许           | 允许       | 不因诊断授权增加   |
| 当前项目成员 + read          | 项目内允许        | 允许           | 拒绝       | 不增加             |
| 普通项目 viewer              | 允许              | 拒绝           | 拒绝       | 不增加             |
| 跨项目、未登录、外部 token   | 沿原合同          | 拒绝           | 拒绝       | 不增加             |

本批沿用 D0 管理 API 授权，不提供 D6 设置 UI。管理员可在隔离验收脚本中为已存在成员调用：

```http
PUT /api/projects/<projectId>/diagnostics/grants/<userId>
Authorization: Bearer <当前管理员会话>
Content-Type: application/json

{"read":true,"export":true}
```

每次服务请求重新读取当前账户、项目成员、read/export，不信任旧页面或旧 token 中缓存的角色。移除成员会删除授权，重新加入不会恢复。仅撤销 export 后仍可查看；撤销 read 后同时失去导出资格。详情和搜索结果通过一秒续验、失焦、切换、关闭、退出清理，不能宣称已交付字节能被远程撤回。

## 搜索语义与预算

`POST /api/projects/<projectId>/diagnostics/search`。查询词只在请求体，前端不放 URL、浏览器持久存储或遥测；审计只记录操作者/项目/行为/结果。搜索词不进入数据库 SQL 或参数。

- `field=message`：根 `raw.error.message`，兼容 `raw.message`。
- `field=raw`：当前保存的 `diagnostic.raw` 中全部字符串值，包括消息、栈、console 参数中的字符串、请求文本/headers/URL和业务上下文字串；不搜索键名、JSON转义表示、数值或布尔值。
- 使用解码文本的字面子串与 JavaScript `toLowerCase()`，忽略大小写；不使用正则、通配符、分词、拼音或模糊检索，不进行 Unicode 归一化。
- 项目/env/time/release/category/pageRoute/groupId 进入基础事实查询，先按 eventId 去重，再读取当前 receipt ready 且未过期的原文。历史仅有摘要、未采集、限流、尚未入库、写入失败或过期原文不参与；搜索无命中不代表没有错误。
- 最长7×24小时；搜索词2–128个UTF-16码元；最多500个基础候选、32MiB信封；每页1–50，页面25；快照最多1小时。
- 超过候选或字节预算整次拒绝，提示缩短范围，不返回貌似完整的部分命中。每次ClickHouse查询最多5秒、100万扫描行、64MiB扫描字节；搜索最多两次存储查询，执行预算最多10秒，另外有权限/receipt查询与传输时间。失败与空结果区分，不承诺固定端到端延迟。
- 返回扫描量/耗时、候选数、可搜索原文数、命中数及分页。基础事实按查询快照固定，但TTL仍优先；翻页期间到期或详情完成写入可能改变可搜索集合，可刷新重查。

现有 ClickHouse `raw_events` 排序以 `app_id` 开头，另有 `error_group` / `release` bloom_filter；项目/环境/时间条件进入实际查询，但不保证只扫描该项目。详情复用 `diagnostic_details(project_id,event_id)` 排序；扫描行/字节预算始终生效，未新增全文索引或搜索服务。候选/字节/扫描预算超限、执行超时、存储不可用分别返回稳定错误并提示重试或缩短范围。预算实际验证见 results；D7全量压力和长期容量校准仍待后续实施。

## 导出内容与限制

`POST /api/projects/<projectId>/diagnostics/instances/<eventId>/export`，请求体 `{"format":"json"}` 或 `{"format":"text"}`。上限单实例512KiB UTF-8，无多实例或异步批量平台。

JSON包含项目/实例、导出时间、存储与采集状态、规范上下文、信封、已存信封原文 `storedEnvelopeJson`、派生 `view`。文本同时包含原始信封和便于查看的诊断上下文。`storedEnvelopeJson`保留入库文本；解析对象与结构化帧明确为派生内容，不假装在线原始字节或未采集字段。

不存在返回404，详情过期410，无权限403；待入库/限流等其他状态可导出状态证据，不伪造正文。响应 `private, no-store`、attachment、nosniff；旧地址再次访问仍需即时会话/read/export。浏览器临时blob用后撤销，切换/关闭/撤权清理；**已下载到电脑的文件不能远程收回**，协作时应按项目规则交付。

## 统计口径与历史边界

- 错误次数继续基于原有 error / API失败事实，按eventId去重；详情是否存在不参与计数条件。没有新增另一套错误计数或修改quality.observeApi分母。
- 影响账号为非空user_id去重数，浏览器实例为device_id去重数，规范页面为page_route去重数；不返回身份原值。这些计量不是规范UV/VV的替代公式。
- 组统计与实例列表使用同一查询快照、环境、时间、类别、路径和选定版本；消息搜索独立展示，不改变基础影响统计。
- “所选窗口首次”只指该窗口；“系统可追溯保留历史首次”限制为同环境/路径/类别下当前保留的90天事实，可能晚于业务实际首次。TTL已删除和历史未上报的数据无法恢复。
- 未知release独立列出；比较表保持同窗口其他条件，展示最多100个版本，超限报错。每次统计查询5秒/100万行/64MiB扫描/128MiB内存预算，窗口和历史各查一次。

## 可执行手工验收

在可销毁隔离环境执行，勿对生产运行故障测试：

```bash
pnpm install --frozen-lockfile
pnpm check
M5_ALLOW_NON_ARM64=1 ./scripts/dev bootstrap
./scripts/dev up
./scripts/dev smoke
pnpm exec playwright install chromium webkit
pnpm exec playwright test -c playwright.diagnostics.config.ts
./scripts/dev verify-d0-upgrade
./scripts/dev verify-d0
pnpm test:r5a:e2e
pnpm test:r5b:e2e
node tools/r5b-storage-privacy.mjs
node tools/d0-log-check.mjs
```

最短手工路径：

1. 打开实际部署演示 `http://127.0.0.1:4174/observability?acceptance=fast`，点击“D3 请求 503 → 异常”。这是继承的真实HTTP场景，不依赖Vite开发中间件。
2. 管理端 `http://127.0.0.1:4173` 登录隔离管理员（仓库本地账号见README），进入演示项目 → 页面分析 → 质量，选择dev和最近7天，点击刷新。
3. 展开该组，核对版本比较和基础次数；打开诊断上下文，查看具体消息、console和503原文请求。无明确ID的数据须标时间邻近。
4. 搜索 `FI_D3_SYNTHETIC`，应找到保留详情；换prod无结果，缩小到对应release可命中。超过7天应明确预算错误，不能空结果装作成功。
5. 复制稳定链接，在新标签或退出后打开，登录后仍定位同一实例。链接中不得出现搜索词或原文。
6. 下载JSON和文本，打开实际文件比对消息/栈/console/请求、原始信封及截断/缺失说明。只授read的viewer按钮不可导出，直接请求也403。
7. 用管理员撤销export：已打开页面不可继续下载；撤销read或移除成员：详情清空、复制和搜索拒绝。普通viewer的质量统计仍可用。
8. 键盘Tab/Enter打开详情、Escape关闭；中文/emoji/换行/长串可阅读；`<img onerror=...>`仅显示文本。切项目/env/实例或快速导航不能出现旧原文。

Chromium/WebKit为真实浏览器；Firefox仅继承栈格式fixture。剪贴板自动化使用sink验证授权和内容，不冒充操作系统剪贴板集成。自动化通过不等于Jesse人工验收。

## 发布与回滚

无数据库迁移或数据回填，不修改已应用SQL。先部署API/server-core与UI（成套版本），SDK/consumer无D4行为改动；已有D3采集方式、冻结快照和基础12KiB门禁保持。回滚API与UI即可撤回新增入口，不需要删表或reset/seed；已下载证据文件仍存在。历史未采集、脱敏或删除的原文无法补造。

D4由用户合并后，再从最新refactor核实进入D5：按project/release/build/asset匹配SourceMap，保留原始编译栈与失败状态。不要把D4版本比较误称源码映射。
