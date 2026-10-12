# D2 console 上下文：接入与验收

D2 在 D0/D1 错误诊断闭环上增加异常前的 console 上下文。不是独立日志检索产品，也不包含请求正文、完整关联时间线、SourceMap、批量导出或完整策略设置。D3–D7 未完成。交付代码、CI 和性能实测以 [结果](../progress/runtime-diagnostics-results.md) 为准；自动化通过不代替用户手工验收。

## 启用与升级

先完成 [D0 基础升级](runtime-diagnostics-d0.md)，部署 D2 API/管理页面，再发布新 SDK。D2 无数据库迁移，仍为 contract v3 / diagnosticVersion 1。旧 SDK、旧错误事件和 D1 原文继续可读；缺失的旧日志不能补回。新版 SDK 的诊断模块使用配套新版基础包，不混用 D1 基础包和 D2 console 入口。

```ts
import { createTracker } from "@frontend-insight/web-tracker";
import { createConsoleDiagnostics } from "@frontend-insight/web-tracker/console";

const appId = "fi_your_project";
const tracker = createTracker({
  appId,
  env: "dev",
  release: "d2-example",
  endpoint: "https://collector.example.invalid/v1/events", // 替换成实际地址
  errorDiagnostics: createConsoleDiagnostics({
    scope: { appId },
    // 默认只收 error/warn；需要其他级别时显式配置：
    levels: ["error", "warn", "log", "info", "debug"],
  }),
  observability: { enabled: true, captureJsErrors: true, captureWebVitals: false },
});

const order = { id: "synthetic-order", count: 3 };
console.info("token=synthetic\n准备提交订单", order);
console.warn("库存不足", { available: 2, requested: 3 });
order.count = 4; // 已记录日志仍是 3
tracker.captureException(new Error("订单提交失败 token=synthetic"));
console.error("异常后的处理日志"); // 不会修改刚才异常的快照
await tracker.flush();
// 退出应用时 tracker.destroy()；最后一个实例退出才恢复仍由 SDK 拥有的 console 方法。
```

`createConsoleDiagnostics` 已组合 D1 错误提取器，直接替代 `createErrorDiagnostics()`；不要为同一次异常再调用 captureDiagnostic。已有 quality collector 继续配置 `quality: quality.factory`；原生全局错误、未处理 Promise、显式 capture、Vue/React 适配器都沿用 D1 reportError 与去重。框架接入代码见 [D1 指南](runtime-diagnostics-d1.md)。

仅 `console.error()` 不增加 JS 异常计数，也不单独发网络请求。只有异常触发时日志快照随 diagnostic.raw 上传，详情仍受每页面每分钟 20 份的限流；基础错误计数独立保留。

## 归属、隔离与行为边界

- `scope.appId` 是接入方明确声明“该 realm 全局 console 属于此项目”，必须与 tracker appId 一致。SDK 无法从普通 console 参数可靠推测业务项目。
- 同一个 console 对象只安装一套共享包装。同项目多个 tracker 各有独立缓冲、配置和异常快照。不同 appId 同时启用时清空旧缓冲，并以 scope_conflict 暂停采集；冲突解除后的下一条业务日志恢复采集。多项目同时运行应使用独立 realm（例如各自 iframe），或只给明确的页面所有者启用全局 console。
- 每条日志保留采集时 pageViewId；route/pageView 改变后下一次记录或异常冻结会清空旧页缓冲。destroy/reinitialize 不继承前一实例日志。
- 原参数、顺序、this、返回值、原方法抛错不变。调用前完成参数快照，原方法正常返回后才提交日志；原方法抛错时不把未完成的调用记为前置日志。异常提取前冻结快照，不把框架处理器随后输出倒写成异常前日志。
- 已有第三方包装仍被调用；后安装的第三方方法不会被 destroy 覆盖。方法缺失、不可写、console 不可访问时安全退化，记录不可包装的级别。
- SDK 自身 warning 通过预先捕获的输出函数，不按文本前缀过滤业务日志。collector 内递归 console 不再重复采集。不是复制整个 DevTools：浏览器内置信息、扩展隔离世界或其他不可访问来源不保证获得；来源不确定时为 unknown。
- 不主动读取 cookie/localStorage、密码框、全部 DOM 或其他标签页。只对本次实际传入 console 的参数取快照。

## 预算与参数表达

| 范围             | 上限 / 实际计量                                                                |
| ---------------- | ------------------------------------------------------------------------------ |
| 保留条数         | 50；超限先淘汰最旧记录                                                         |
| console 数组     | 24 KiB，含 JSON、转义、每条元数据及数组分隔符                                  |
| 回溯窗口         | 60,000 ms；异常时再次清理过期记录                                              |
| 单条记录         | 2 KiB，包含参数与时间/级别/序号/页面/说明；不是额外给参数 2 KiB                |
| 单个诊断信封     | 64 KiB；错误消息/编译栈优先，空间不足淘汰较旧 console                          |
| D1 错误预算      | 栈最多 32 帧/16 KiB、cause 最深 4 层，保持原合同                               |
| console 参数遍历 | 最多 128 节点、深度 8、每对象/数组或参数列表最多 32 项；受记录剩余字节再次约束 |

`maximumEntries`、`maximumBytes`、`windowMs`、`entryBytes` 可以调小；大于批准上限的值会被限制到上限。`enabled:false` 关闭 console，保留 D1 错误诊断。不要通过修改基础事件合同或绕开权限上传原文。

字符串、嵌套对象、数组、Error（name/message/stack/cause/errors）、null 等保留可读值；undefined、BigInt、函数、Symbol、非有限数、循环、特殊对象和不可读取值使用明确的标记，并记录 issues。不会执行 getter、toJSON、迭代器或业务转换函数，不修改/冻结业务对象。自定义 Error.prepareStackTrace 存在时，不通过原生延迟 stack getter 触发业务格式化器；显示 unreadable_stack_formatter。

Proxy 的反射操作本身会调用宿主陷阱，普通 JS 不能抢占一个永不返回的同步 trap。实现限制反射/遍历次数、处理抛错和递归；不承诺能中断恶意无限循环或撤销业务 trap 自身副作用。

`raw.consoleCapture` 保存 state、capturedAt、levels、limits、count、bytes、unavailableLevels、removed 和 envelopeOmitted。每条 `relativeMs = timestamp - capturedAt`，以 SDK 进入异常采集入口的时刻为参照，序号用于同毫秒内排序；不冒充引擎内部最初抛出/Promise 拒绝时刻的精确测量。参数按调用时取值，异常拥有独立副本。

- `bytes`/`count` 是实际保留数组的 JSON UTF-8 字节/条数。
- removed.window/capacity/bytes/scope/entry 分别是窗口、条数、总字节、作用域冲突和记录预算导致的淘汰条数；不是字节数字。
- 每条 omittedBytes 表示已知省略字节；omittedBytesExact=false 表示只知道下界，无法读取或未遍历部分不伪造精确大小。超过遍历限制的对象、超长字符串会明确说明。
- 截断、省略、不可读都不等于脱敏。`token=`、query、换行、HTML 字符串保持可采集部分原文。消息、编译栈与日志是否截断分别看各自说明。

## 页面、访问与状态

“页面分析 → 质量 → 错误实例 → 诊断上下文”打开错误诊断详情。console 区显示级别、序号、时间、相对毫秒、页面归属及有序参数。Error 参数以 JSON 文本呈现消息和编译栈。支持逐条展开/收起、级别过滤，当前条件和显示条数始终可见。复制按钮复制当前过滤后的记录与采集说明，先重新请求受限 API 验证权限。

| 情况                               | 展示                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| 新版接入没有启用 console           | not_enabled：console 上下文未启用                       |
| 已启用但窗口内无符合配置级别的日志 | empty；不是基础错误不存在                               |
| 历史记录没有采集状态               | legacy：不能恢复旧数据                                  |
| 已采集，但 UI 所选级别没有结果     | 明示当前过滤下无结果，保留总采集条数                    |
| 归属冲突 / console 不可访问        | scope_conflict / unavailable                            |
| 部分截断、省略、不可读取或淘汰     | capture.status=truncated，保留 issues 和计量说明        |
| pending / write_failed / expired   | 沿用详情正在写入、失败重试、超过保留期；不捏造日志      |
| rate_limited / too_large           | 沿用既有采集状态，基础错误仍计数                        |
| forbidden                          | 当前无 diagnostics.read、成员失效或登录过期；原文不可见 |

仅按实例受限 API 按需返回原文，普通列表不含 console。服务端每次检查当前成员关系和 diagnostics.read，admin 也审计，响应 no-store。关闭、切换实例/项目、退出、失焦清空原文；打开期间每秒续验权限，并在轮询检查详情到期。撤权的新请求立即拒绝，已展示页面在下一次轮询往返后清空；不声称能收回已经返回客户端的字节。复制会重新授权，不用撤权前缓存。所有参数以文本/pre 渲染，不运行 HTML 或脚本。

## 可执行验收

仅在隔离测试环境使用合成值，按 D0/D1 指南启动服务：

```bash
pnpm install --frozen-lockfile
pnpm check
M5_ALLOW_NON_ARM64=1 ./scripts/dev bootstrap
./scripts/dev up
./scripts/dev smoke
pnpm exec playwright install chromium webkit
pnpm exec playwright test -c playwright.diagnostics.config.ts
# 以下有故障注入，仅可在可丢弃测试环境执行：
./scripts/dev verify-d0-upgrade
./scripts/dev verify-d0
```

1. 管理端 `http://127.0.0.1:4173` 使用测试 seed admin 登录，进入演示项目“页面分析 → 质量”，选择 dev 和近 7 天。
2. 实验室 `http://127.0.0.1:4174/observability?acceptance=fast`，输入任意模拟密码进入。分别点击“模拟 JS 异常”“真实 throw”“未处理 Promise”“Vue 框架捕获”“React 适配器捕获”。等待约 2 秒，刷新质量页面，打开对应实例。
3. 错误消息/文件/函数/行列号应继续符合 D1 指南；console 最后 3 条按 info → warn → error 顺序显示“开始加载图表”“库存不足\n准备重新计算”“绘图数据无效”。参数有 query 的合成 token、库存数字和嵌套对象；时间相对异常均不为正。
4. 选择 warn，仅显示警告；选择没有采集到的级别时明确为过滤后无结果。收起/展开任意记录；复制当前条件得到相同有序参数。HTML 参数只显示文字。
5. 点击“只有 console.error”，刷新后 JS 错误次数不因此增长。
6. 点击“console 快照与预算”：对象 state 为“修改前”，而非后改的“修改后”；循环/BigInt 有标记；Error 参数有 prepareChart、d2.js:15:6 编译位置；超长参数有截断；采集说明有 capacity 淘汰，保留最近日志。
7. 使用上面的 SDK 示例连续捕获两次异常；第二次之后新增日志，不得改变第一次详情。切换路由后再捕获，前一 pageView 日志不进入新页；destroy 后重新初始化同样为空。
8. admin 通过 D0 grants API 给项目 viewer read 权限，确认原文可见；普通 viewer、跨项目、未登录与旧外部 token 拒绝。打开详情后撤权或移除成员，等待一次权限续验，原文清空；复制重新请求也应拒绝。重新授权后换实例、换项目、关闭详情或退出，旧原文不残留。

浏览器专项逐字段比较 SDK→ingestion→Kafka→consumer→存储→受限 API→UI 的参数/级别/顺序/时间，同时保持 D1 消息与编译帧断言。真实浏览器为 Chromium/WebKit；Firefox 仍只有栈格式 fixture。剪贴板自动化使用浏览器 sink，未宣称操作系统剪贴板集成。

性能测量包含普通日志、10,000 次持续调用、32 项嵌套对象、满缓冲异常冻结，披露采样数、浏览器版本、时钟分辨率和 p50/p95。原 console 使用 no-op，测的是同步采集本身，不能推导 DevTools 渲染成本或网络时延；低于分辨率不写成零开销。本批不是 D7 的长期负载、20/200 events/s、完整备份恢复验收。
