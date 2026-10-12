# 运行时诊断决策记录

## D0（2026-10-10）

依据：Jesse 本次实施授权、ADR-021 和已批准开发计划。基线为 `refactor` 的 `8ff28a6140f62d8376d84a0a2e56fb93a5ff1b1e`。不实施 D1–D7，不自动合并或操作生产。

| 决定               | 实施与理由                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保持 contract v3   | 增加可选的顶层 `event.diagnostic`，独立 `diagnosticVersion: 1`。生成源与生成物一起更新；没有扩展的旧 SDK 数据不变。旧服务不认识新字段，必须先升级存储、consumer/API，再启用新 SDK。                                                                                                                                              |
| 原文与派生字段分离 | 只有精确位置 `events[i].diagnostic.raw` 豁免递归凭据扫描。信封元数据、基础 payload、项目、事件结构、大小继续验证。原文不复制进 `raw_events.payload_json`。原有 collector 保持历史行为，D1 再统一提取。                                                                                                                           |
| 传输容量调整       | 保留基础事件 8 KiB；信封 64 KiB UTF-8；批次从 64 KiB 调至 128 KiB，避免信封加基础事件后永远无法发送。50 事件上限不变，API/ingestion/Nginx 一致。Kafka topic 256 KiB（含服务端 enrichments），broker 1 MiB。这只增加封装余量，不扩大原文预算。                                                                                    |
| 客户端生命周期     | 正常 flush 按 128 KiB 拆批；大于 60 KiB 的批次不用 Beacon/keepalive，使用普通 fetch。接入方应主动 await flush；不保证浏览器关页时完成大批次传输。没有虚构持久离线队列。                                                                                                                                                          |
| 有限原文           | 整信封 64 KiB，保留 stack/cause/console/request 子预算常量与校验。最小入口超限以 `too_large` 空原文信封保留基础错误；不会悄悄截断。精细优先级裁剪、不可序列化对象提取、console 回溯由 D1–D3 实施。                                                                                                                               |
| 限流与幂等         | SDK 按页面窗口最多 20 个；服务端用 MySQL 项目锁和页面分钟桶再次限制，多 API 实例共享。超限事件仍发布并计入基础错误，只把详情改为 `rate_limited`。同 project/event 重投复用摘要、准入与到期时间；内容冲突 409。                                                                                                                   |
| 故障一致性         | 基础事实先写，详情后写，最后提交 Kafka offset。详情失败写 `write_failed` 并重试；已有质量/聚类查询按 eventId 去重。详情 ReplacingMergeTree + FINAL 处理写成功但回执失败；不采用双库分布式事务。原文不写 MySQL 状态表。                                                                                                           |
| TTL                | 明细默认 14 天，项目策略可设 1–90 天，仅影响新准入事件。API 到期立即拒绝返回原文，ClickHouse 后台 TTL 物理删除；状态墓碑在到期后再保留 90 天，清理每次活跃 consumer 批次最多每分钟一次。                                                                                                                                         |
| Kafka 保留期       | 事件 topic 显式限制为 24 小时、segment 1 分钟，避免最短 1 天项目策略下原文在 broker 默认 7 天队列中继续保留。**影响：整个事件 topic（含基础事件）的故障重放窗口缩短到约 24 小时**；部署时应检查消费延迟，超过窗口可能丢失未消费基础事件。物理删除仍受 broker 清理周期影响。既有 ClickHouse 统计 90 天保留不变。                  |
| 权限               | 当前账户 active + 当前项目关系 + 显式 read；export 必须同时 read。平台 admin 也重新读当前数据库角色。成员移除级联删除授权，重加成员不会恢复旧权限。现有外部 token/public appId 不提供读取权限。                                                                                                                                  |
| 管理与审计         | 提供 admin-only grants/policy 后端，写入和成功审计同 MySQL 事务。读及拒绝审计保存 actor/project/event/action/result/time，不含正文。未登录/外部 token 由 AuthGuard 拒绝并记录匿名结果。详情所有响应 no-store；无 D4 导出端点、无 D6 设置 UI。                                                                                    |
| 浏览器及 CI 预算   | D0 专项 Chromium/WebKit 各一条 SDK 全链路；继承 R5-A/B 浏览器与统计回归；job 上限 45 分钟，重试 0。Firefox 在 D1 加栈格式 fixture；本路线 D0–D7 不加入真实 Firefox CI，真实浏览器固定 Chromium/WebKit，后续若扩展 Firefox 须另列预算，不声称已有真实 Firefox 覆盖。仅上传小型 JSON 证据，保留 7 天，无 trace/body/log artifact。 |

## 历史断言调整

- 不删除历史脱敏/项目隔离/日志负向测试。旧采集器未迁移到新信封，现有测试继续适用。
- 新诊断字段单独新增原文一致性正向测试；把原文放回普通 payload、冒充别的位置、改变元数据、跨 appId 仍拒绝。
- 迁移清单由 MySQL 1–7 / ClickHouse 1–4 增加到 1–9 / 1–5；原升级脚本预期新增版本 8、9，不修改旧 SQL/checksum。
- 页面摘要仅新增公开关联 `eventId`，原文仍不进入列表；不会用详情缺失推断基础错误不存在。

## D0 复核补充

增加独立的 MySQL 009 迁移，receipt 保存不含 raw 的 capture_metadata，读取状态时同时返回 suppressed/omittedBytes/source/policyVersion/correlation。保持已提交 008 不变，避免重写迁移历史；空原文状态仍不需要保存诊断正文。

## D1 实施决定（2026-10-11，进行中）

- 继承已合并 D0；原文只放 diagnostic.raw。D1 提取器通过显式 `errorDiagnostics: createErrorDiagnostics()` 加载，`./errors` 为可选入口；未启用时保留旧摘要采集。两条 SDK 路径通过同一个 tracker reportError 汇合。
- 独立错误不能因消息相同被丢弃：删除 quality 原有五次指纹上限。开启诊断后，使用事件对象身份消除多个监听入口的重复；同一 Error 的跨来源传播只在当前任务内合并。重复显式调用和下一任务再次抛错保留计数。
- 原文结构采用 raw.error 与 raw.extraction.issues；保留 name/message/stack/cause/errors、自有对象数据。自定义访问器不执行；运行时原生 Error.stack 访问器单独识别，失败仍标记 unreadable。循环、函数、BigInt、深度/数量/字节限制均有明确标记。
- 历史质量 collector 的脱敏负向断言保留（未启用原文模式）；基础错误数原来的 5/10 断言改为 10/10，理由是 D1 禁止详情控制减少计数。新增原文模式正向一致性与基础 payload 无原文的负向断言，不删除整个测试组。
- 受限详情分别返回存储 state、capture.status、view.stack.state；历史摘要明确标识 legacy，无法还原此前删除或脱敏的信息。

### D1 页面访问与包体补充

- 原文仅在打开实例后读取，不放入项目/列表缓存；关闭、项目/实例切换、失焦和登录失效清空。详情打开期间每秒重新核对服务端能力；撤权和移除成员从下一次服务端请求立即拒绝，页面在一次轮询往返内清空。远端撤权无法令已发送到浏览器的字节瞬间消失，不宣称推送式零延迟擦除。复制操作再次请求受限详情，不能使用撤权前缓存。
- 轮询只续验访问权限，不反复重建已展开的 cause/栈；pending/write_failed 才重试加载正文。所有正文使用 Vue 文本插值/pre，不注入 HTML。
- 复用现有基础包 12 KiB 门禁；通过共用报告通道、移除无用方法/包装和精简配置转发消重。可选入口单独测量下载量，没有把诊断模块记作免费或隐藏在基础包预算外。启用诊断需要明确配置，旧接入仍使用旧摘要行为。

### D1 收尾边界

- 序列化预算计算 JSON 转义成本，避免 NUL/换行等转义后越限；省略位置元数据也限长。栈/消息原文仅因明确技术预算截断。
- 去重状态按 tracker 的规范配置对象隔离；同一个提取器被多个项目复用或 destroy 后重建，不共享事件去重集合。
- 原文 API 返回 expiresAt；已打开页面在权限续验周期检查到期并重新读取 expired 状态，不能无限保留已到期的正文。
- 真实 CI 的剪贴板测试使用浏览器 sink 验证按钮重新授权和准确文本，未冒充操作系统剪贴板集成。实际 Vue 框架事件在实验室覆盖；React 为显式适配器回调覆盖，没有挂载 React 渲染树。Firefox 仅解析 fixture。

## D1 最终确认与合并影响

- 最终代码 `c98f322c0ee078f88a8aa9124a586830e76045bf` 的 [CI 38114551404](https://github.com/captainamari/frontend-insight/actions/runs/38114551404) 全部通过；没有新的预算上调待决策项。原始批准的所有结构/项目/非诊断校验保持，只有指定 raw 保留原文。
- 基础包 12,276 / 12,288 bytes；可选 errors 1,948，连同 quality 总计 19,463 bytes。可选方式会增加启用后的实际下载量，接入方需要明确导入/配置；旧接入不自动获得完整原文。
- 去掉 quality 原有“同指纹超过五次不再计数”后，高频同类错误的基础计数可能高于旧版。这是补回独立错误，不是修改指标公式或分母；详情继续限制每页面每分钟 20 份。
- 原文和解析/访问状态的产品闭环已完成；仍需 Jesse 手工验收/评审并合并，代理不自动合并。D2–D7 继续未完成，D2 不应以本次成功推断完整诊断路线已经结束。

## D2 实施决定（2026-10-11，进行中）

- 合同实际是整条 console JSON 记录最多 2 KiB（不只是参数）。保持此更严格上限，参数扣除时间、顺序、页面及说明空间；50 条、24 KiB 数组、60 秒、64 KiB 信封均不提高。可配置值仅收紧。console 不满足预算时裁剪/淘汰最近记录之前的旧记录，不直接牺牲错误消息/栈。
- 显式 `createConsoleDiagnostics({ scope: { appId } })` 作为 D1 errorDiagnostics 的可选替代，默认 error/warn；其他级别显式配置。scope 是接入方声明的 realm 全局 console 所有者，SDK 不推测每条 console 的业务项目。不同 appId 同时声明时清空并暂停采集，状态 scope_conflict；同项目不同实例独立缓冲。需要多个项目的应用应按 realm 隔离或只为明确的页面所有者启用。
- 在原 console 调用前取参数快照，只有原方法正常完成才提交到缓冲；异常提取前冻结。框架捕获后的 handler 输出不会倒写成该异常前置日志。原 this/参数/返回/抛错保留；collector 内递归不重复采集，SDK 自身 warning 使用安装前捕获的原输出函数，不按消息前缀排除业务日志。
- 不运行 getter/toJSON/iterator/业务转换。原生 Error.stack 的延迟访问若检测到自定义 prepareStackTrace，标记 unreadable_stack_formatter，不调用业务格式化器。Proxy 的反射陷阱无法由 JS 抢占或保证不执行；限制反射次数/节点、捕获异常、防递归，不能承诺中断宿主自定义的无限循环 trap。
- 记录字节/数量是实际序列化值。未遍历/无法读取的值无法得到精确原始字节；omittedBytesExact=false 时数值仅为已知下界，不能伪造精确总数。超长字符串避免为计量先分配整个 JSON/UTF-8 副本。
- 基础包 12 KiB 门禁不变。共用字节计量、合并生命周期重复代码；esbuild 仅压缩明确列出的 BrowserTracker 私有生命周期属性，不改公共 API、事件合同或配置名。源码保留原命名，source map 可追溯；真实浏览器使用构建后产物回归此优化。

### D2 包体方案比较与兼容

- 直接放入基础入口会让所有接入方下载 console；不可接受原门禁，因此采用显式独立入口。console 通过相对 ESM 引用共享 errors.js，无重复内嵌；所有模块下载都计入组合报告。
- 初版加入生命周期后基础包 12,328 bytes，超过 12,288 上限；共用字节函数/生命周期消重仍在 12,310 左右。最终构建只对明确列出的私有生命周期成员压缩（不混淆公共字段），基础降至 12,258。无必需功能删除、无预算上调待决策项；构建后 SDK 已由真实浏览器链路验证。
- 单条 console 为字符串时，合同字节函数现在也计算 JSON 引号/转义，而非裸字符串长度。这收紧了以前字符串条目的两字节/转义计量误差，符合已批准“整条 JSON 记录”口径；D2 对象记录与既有 D0/D1 合法数据保持兼容。明确增加边界测试，不删除旧安全测试。
- 诊断 view 新增 console 字段。D1 新采集明确标记 not_enabled；历史没有 consoleCapture 的记录为 legacy，不能区分当时未采集与未保存，故不伪造原因。D0/D1 历史交付证据不改写。
- UI 复制当前过滤结果及采集说明；不是批量导出，不新增 export 能力接口。仍逐次重新读取授权详情。

### D2 最终确认

最终代码 `f4cde46088c5525c7b33d1ec481ba043aff49172` 的 [CI 38119220688](https://github.com/captainamari/frontend-insight/actions/runs/38119220688) 全部成功。基础12,258 bytes，errors/console/quality为1,971/2,706/5,239，完整组合22,174；不提高原12KiB基础门禁。最终同提交p50/p95与覆盖边界已写入results，不采用首轮更小读数替代最终测量。D2交付等待Jesse验收/评审，PR #31保持Draft，不把它等同于整条诊断路线完成。

## D3 实施决定（2026-10-11，进行中）

- 已核对 D2 PR #31 合并：refactor `e51b63523103597822df7acfa3dd1911e93109a5`，包含 `32678e1` 文档和 `f4cde46` 代码。合并不替代人工验收。
- 采用可选 `./requests` 受控 fetch 适配器，每个 tracker 创建独立实例；没有新增全局 fetch/XHR 包装。保留原有第三方/质量包装。诊断模块不发 API 或 JS 基础事实；质量分母继续由一次 `quality.observeApi` 产生，不能重复嵌套质量入口。
- **正文读取方案**：不对 Fetch 的 Request/Response body 建立 clone/tee。未知/不可信 Content-Length、超大 chunk、无结束/慢流下，tee 另一分支的排队不能仅靠截取最终文本保证有界。SDK 默认记录可读 headers 和请求字符串；响应正文由应用将业务自身已读取的文本通过 `responseText(response, text)` 提供，失败默认保存、成功仅精确路由 opt-in。SDK 不调用 text/json、不解析后重序列化冒充原文；不启动后台 reader（读取并发/排队均为 0）。未提供文本标 host_text_required；不是宣称所有 fetch 正文自动采集。XHR 自动包装未实现，本批支持受控 fetch。浏览器仅提供已解码可访问文本/headers，不提供线上原始字节或隐藏 header。
- 异常即时冻结，不等待异步正文；记录请求开始、响应可用、应用提供正文和异常时间。pending 保留当时状态，不补传、不修改已排队/重试信封。跨页面和 destroy 后回调不回挂到新页面。
- 请求最多20条/32KiB/60秒，单条24KiB，最多4个未完成请求记录；操作/导航最多30条/8KiB/单条2KiB；每字段仍受正文16KiB/headers4KiB和总信封64KiB上限。超大值仅处理预算内前缀，不为计量先构造完整 UTF-8 副本；未读取余量只报已知下界。响应观察闭包只持有本地 ID，容量淘汰释放大字段，晚回调查不到记录则忽略。
- 关联来自显式 bind 参数和 operation/workflow 的只读 getContext 句柄；同名 step 不能单独证明因果，冲突实例 ID 不能标显式。未绑定异常只显示同页窗口时间邻近。local_ 标为本地观察 ID，不注入 headers，不改变 CORS。
- SDK端点按 origin/path 排除，上传按明确 source 或 FormData/Blob/ArrayBuffer 类型排除，可配置精确路由排除；仅影响诊断，原有质量观察是否计数仍由接入方显式包裹决定。
- 服务端维护生成源，新增 raw.requests/raw.timeline 结构及逐项预算/归属校验。原 raw.request 的字符串预算由裸文本改为 JSON UTF-8（引号/转义也计入）；边界有收紧，需先更新 API/consumer，再发布新 SDK。无新数据库迁移。
- 基础SDK仍执行12KiB门禁；继续使用有范围的私有成员名压缩，不改公共API/事件字段、不删功能。不把可选模块当成零下载成本。

### D3 有界性复核

成功请求的调用时request body在有限环形缓冲内保留，用于应用随后明确判定业务失败；冻结普通成功请求时不发送该正文。它计入同一32KiB缓冲，禁止另建不计量的私有正文缓存。响应对象关联使用弱引用且随环形记录淘汰/销毁删除，关联表不强持有Response/body，不超过请求记录数。没有WeakRef的旧环境不建立正文关联，保留元数据；本次真实支持范围为指定Chromium/WebKit。

容量淘汰优先移除成功请求，尽量保留失败证据；字段裁剪和整体省略状态分别记录。冻结前为relativeMs预留字节，总信封额外留出状态/计数变化余量，避免边界处因为添加元数据导致整条详情被D0降级too_large。

### D3 构建压缩的合同保护补充

实测发现仅凭TypeScript private声明不够：同名公开JSON字段也会被esbuild mangleProps重写。D3追加压缩中误含usageSequence/usageClosed，已删除；只使用内部方法名，并在每次build按生成schema的所有properties检查白名单交集，重名立即中止。跨路由page_leave仍使用原v3字段，不修改指标或为过门禁放宽schema。修复后12,273 bytes基础包仍低于12,288，完整组合27,111 bytes。
