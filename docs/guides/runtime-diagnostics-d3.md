# D3：请求、操作与工作流关联

D3 扩展 D0/D1/D2 的按实例诊断。真实交付状态、代码 SHA、CI 和测量见 [results](../progress/runtime-diagnostics-results.md)。不包含 D4 全文检索/导出、D5 SourceMap、D6 策略 UI、D7 全量压测。

## 接入方式与正文边界

本批实现**受控 fetch**，不安装新的全局 fetch/XHR 包装，不改 XHR open/send/事件。原有 observability fetch 包装和 quality.observeApi 保持原合同；诊断模块本身不发 API/JS 事实。需要分母时，每次真实请求只调用一次 quality.observeApi，不再为它手工调用 captureApiError。不把 HTTP 503 fulfilled 改成 Promise rejection；请求失败自身不创建 JS 异常。

SDK 保存请求 URL/query、方法、开始/结束/耗时、可访问 headers、显式关联；请求正文支持调用时的字符串快照。Request 对象只用原生 getter 获取元数据，不消费 body；URL 对象使用原生 href getter。headers 支持普通自有字符串数据属性和原生 Headers，访问器/其他类型明确不可读。

**响应正文必须由应用提供其业务本来就需要读取的原始文本**。SDK 不调用 response.text/json、不建立 clone/tee，也不在后台读取流。仅凭 Content-Length 不能保证 tee 的另一分支有界，因此没有把“全部读完后截断16KiB”包装成安全读取。默认保存应用已提供的失败响应文本；成功响应正文仅按精确路由 opt-in。若应用只调用 response.json()，应在接入层用原始 text 后自行 JSON.parse；不能用 JSON.stringify(已解析对象) 冒充线上文本，也不要为诊断读取业务不需要的文件/无限流。

没有提供正文时显示 host_text_required；SSE/NDJSON、二进制、opaque 各有状态。没有自动文本抓取或 XHR 支持的承诺。浏览器提供的是解码后的可访问内容，headers 大小写/合并受浏览器影响，Set-Cookie 等隐藏头无法获得；只保留实际响应 URL/redirected，不重建完整重定向链。

```ts
import { createTracker } from "@frontend-insight/web-tracker";
import { createRequestDiagnostics } from "@frontend-insight/web-tracker/requests";
import { createQualityCollectors } from "@frontend-insight/web-tracker/quality";

const appId = "fi_your_project";
const diagnostics = createRequestDiagnostics({
  scope: { appId },
  console: { levels: ["info", "warn", "error"] },
  successBodyRoutes: ["/api/report/preview"], // URL pathname 精确匹配
  excludeRoutes: ["/api/upload"],
});
const quality = createQualityCollectors({ api: true, jsErrors: true });
const tracker = createTracker({
  appId,
  env: "dev",
  release: "d3-example",
  endpoint: "https://collector.example.invalid/v1/events",
  errorDiagnostics: diagnostics.errorDiagnostics,
  quality: quality.factory,
  registeredFeatures: ["report_export"],
  observability: {
    enabled: true,
    captureJsErrors: true,
    captureApiErrors: false,
    captureWebVitals: false,
  },
});
// 在 createTracker 之后绑定；每个 tracker 一份 diagnostics。
const operation = tracker.startOperation("report_export");
const bound = diagnostics.bind({
  ...operation.getContext?.(),
  // 若有真实业务 request/trace ID，再显式传入；本地 ID 不冒充服务端 ID。
  stepKey: "submit",
  attemptId: "attempt_1",
});
const fetchWithEvidence = bound.wrapFetch(window.fetch);
bound.action("提交报表", "export-button", { report: "monthly", token: "synthetic" });
console.info("提交开始");
const response = await quality.observeApi(
  "/api/report", // 既有质量合同：规范路径模板，不带query
  () =>
    fetchWithEvidence("/api/report?token=synthetic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{ "report": "monthly" }',
    }),
  "POST",
);
const originalText = await response.text(); // 应用自己的读取，诊断不另读一次
const data = JSON.parse(originalText); // 如业务确实需要 JSON
// 第三个参数只能来自应用自己的明确业务规则，SDK不猜success/code字段。
diagnostics.responseText(response, originalText, false);
if (!response.ok) {
  operation.fail("technical_failure");
  // 这里只在应用确实遇到/捕获异常时调用；不要为每个HTTP失败造异常。
  // bound.capture(tracker, caughtError);
} else operation.succeed();
void data;
```

`bound.capture(tracker, error, source)` 复用 D1 原有错误入口及去重，支持 explicit/vue/react/promise 等已定义来源。普通 tracker.captureException 和全局/Promise 监听也会附带同页窗口证据，但没有显式异常关联时仅标“时间邻近”。非对象 rejection 无对象身份绑定，仍保留时间邻近证据，不猜因果。

工作流应先 `const workflow = tracker.startWorkflow(key)`，在自己的步骤执行路径 `workflow.reachStep(step)`；通过 `workflow.getContext()` 与 `workflow.startOperation(...).getContext()` 取得真实实例 ID，连同 stepKey/attemptId 传给 bind。两个并发操作分别持有自己的 bound，不设置全局“当前操作”。同名 step 本身不能证明同一工作流。此 API 只读，不完成工作流、不改变统计口径。

## 宿主行为、生命周期与归属

- 调用原 fetch 时保留 this、参数顺序/引用、AbortSignal；响应对象/拒绝原因身份保持，原函数同步抛错原样抛出。观察中的 native Promise 会返回派生 Promise，以保留应用边界的拒绝语义；不承诺 Promise 对象引用与原函数返回完全相同。非原生 thenable/自定义返回对象原样返回，不调用其 then getter，结果证据保持 pending。诊断不等待正文、不引入孤立 observer rejection。
- 本模块不替换全局方法，因此不需要在 destroy 覆盖宿主/第三方方法。重复包装已知受控函数不叠加；跨绑定/项目显式重新包装时移除本模块原观察层，仅归属新绑定；每个绑定对同一原函数/来源缓存 wrapper。第三方修改 window.fetch 后，已经拿到的 wrapper 仍指向原先函数；应显式重新取得 wrapper，不能假装自动追踪任意拦截器替换。
- 同一 realm 多项目分别创建 diagnostics 并通过自己的 bound 发请求；不将一个请求正文广播给所有 tracker。不能把同一个 diagnostics 配给多个 tracker；后续实例不接管原实例缓冲。console 仍遵循 D2 realm 所有者冲突规则。
- 请求归属于发起页面。新页面第一次采集/冻结/查看 stats 时清空旧缓冲；不会把晚到结果挂新页。页面边界识别复用 tracker 的 pageViewId。没有额外轮询计时器；闲置缓冲最多既定容量，下一次访问按时间窗口淘汰，destroy立即清空。已发业务请求不被 SDK 取消。
- enabled=false 只关闭请求/操作诊断，console 的开关在 console.enabled；quality/基本错误统计仍独立。
- SDK ingestion 端点按 origin/path 排除；文件上传按显式 source="upload"、已知路由、FormData/Blob/ArrayBuffer 类型排除。`bound.wrapFetch(fetch, "sdk")` 明确排除 SDK 来源。排除只影响诊断；是否计入质量分母由既有质量观察决定。

## 时间模型和预算

异常立即冻结请求集合、action、console及页面，既有正文同步复制入信封。请求发起 timestamp、HTTP响应 endedAt、应用提供正文 bodyCapturedAt、异常 requestCapture.capturedAt 分开；未完成保留 pending。后续完成/修改对象/导航/第二次异常不能改写旧信封，不等待、不补传。timeline按时间和序号稳定排列；同一毫秒跨来源顺序只是确定展示顺序，不声称更精确的因果顺序。

| 层次         | 上限与说明                                                                         |
| ------------ | ---------------------------------------------------------------------------------- |
| 单信封       | 64KiB JSON UTF-8；基础错误/栈优先，其后相关请求，再保留最近日志                    |
| 请求集合     | 20条/32KiB/60秒；单条24KiB；最多4个 pending 请求记录                               |
| 字段         | 请求/响应正文各16KiB、headers各4KiB，含字段状态和值的JSON；单条/集合可能进一步裁剪 |
| 操作/导航    | 30条/8KiB、单条2KiB；显式context快照有节点/深度限制                                |
| console      | 继承D2：50条/24KiB/60秒、整条2KiB                                                  |
| 后台正文任务 | 0个reader、0个待读任务、0个clone/tee、无SDK读取计时器                              |
| 详情限流     | 继承每页面每分钟20份；基础错误/API/工作流事实独立                                  |

maximumEntries/maximumBytes/windowMs 只能收紧。按 JSON 转义后的 UTF-8 计量；UTF-16切片不切断合法代理对。未遍历内容不伪造精确原始字节：omittedBytesExact=false 表示下界。缓冲 window/capacity/bytes/scope/excluded 与字段 truncated/unreadable 分开。正文来自应用已经读取的字符串，不把业务自身的完整读取内存归因于SDK，也不为诊断要求应用读取无限流。

## 状态、权限与页面

在“页面分析 → 质量 → 错误实例 → 复现条件”打开授权详情，下方“请求与操作时间线”显示异常时点、开始/结束/耗时、相对时间、显式关联/时间邻近、本地观察ID及 operation/workflow/step/attempt。展开查看 URL、headers、原始正文及每个字段状态。类型/失败过滤有当前条件与结果数；复制按钮复制该实例请求上下文并重新授权，不是全文搜索或批量导出。

| 状态                                                 | 含义                                        |
| ---------------------------------------------------- | ------------------------------------------- |
| legacy                                               | 历史记录无请求采集合同，不恢复缺失正文      |
| not_enabled / empty                                  | 未启用 / 窗口无匹配；排除/淘汰另有计数      |
| pending                                              | 异常冻结时请求还没有结果，不等待补全        |
| host_text_required                                   | 应用尚未提供已读取文本；SDK没有消费业务body |
| success_body_disabled                                | 成功请求正文未按路由启用                    |
| request_stream_not_read                              | Request内的流未读取，元数据仍可保留         |
| stream_not_read / binary_not_read / opaque_cors      | 流式/二进制/浏览器跨域不透明内容未读取      |
| truncated / unreadable_headers / unsupported_headers | 字段裁剪/访问失败/对象格式不支持            |

存储 pending/write_failed/expired、详情rate_limited/too_large、访问forbidden继续独立。授权仅 diagnostics.read + 当前项目成员，admin审计、no-store；普通列表/API/外部token无请求正文。服务端每次重新检查权限；前端继承每秒续验、失焦/关闭/切换/退出清理，无法收回已返回字节。全部用文本/pre渲染。

## 可执行验收

```bash
pnpm install --frozen-lockfile
pnpm check
M5_ALLOW_NON_ARM64=1 ./scripts/dev bootstrap
./scripts/dev up
./scripts/dev smoke
pnpm exec playwright install chromium webkit
pnpm exec playwright test -c playwright.diagnostics.config.ts
# 以下包含隔离环境故障注入，勿用于生产
./scripts/dev verify-d0-upgrade
./scripts/dev verify-d0
pnpm test:r5a:e2e
pnpm test:r5b:e2e
node tools/r5b-storage-privacy.mjs
node tools/d0-log-check.mjs
```

1. 演示页 `http://127.0.0.1:4174/observability?acceptance=fast`，输入模拟密码，点击“D3 请求 503 → 异常”。管理端选择dev和覆盖当前时间的范围并刷新。
2. 详情应看到 `FI_D3_SYNTHETIC failure 请求后渲染失败`、前置console、POST完整query、`x-request-token`/`x-fixture-token`、原始请求换行和响应JSON空格/嵌套/HTML文本；标记显式operation关联、本地ID和HTTP503。
3. “D3 仅请求失败”不增加JS错误数。success启用正文；business为应用显式业务失败；abort/timeout/network不伪造HTTP状态。large有明确截断；binary/stream无伪造正文；redirect只显示最终URL/redirected。
4. 展开/收起请求、切换过滤、复制请求上下文，确认HTML只显示文字；普通viewer不能读。授权viewer打开后撤权/移除成员，下一次请求403，页面在续验后清空，复制须再次授权。
5. 在“D3 仅请求失败”后依次使用实验室既有 Promise、显式 capture、Vue 和 React 适配器按钮，查看同页时间邻近请求；没有显式 bound.capture 关联时不要把它标成因果。React 仍为显式接入回调。
6. 自动化补充 pending/晚到正文冻结、跨路由、真实SSE业务reader取消、opaque、真实工作流句柄、API分母单计及完整原文往返；unit覆盖并发乱序/多实例绑定、边界/访问器/零读取。Firefox只有继承栈fixture；React为D1显式适配器，未新增React渲染树。

## 发布与回滚

无数据库迁移。先部署API/consumer（包含新请求集合schema/预算/归属校验）和UI，再部署配套基础SDK+errors+console+requests，quality按需加载。旧v3和合法D0–D2诊断继续可读。旧raw.request字符串预算收紧为JSON字节；已入库旧详情仍可读，但边界数据再次上报可能被拒绝，应升级采集器裁剪。

回滚先关闭新SDK并等待新信封消费完毕，再回滚服务；旧服务无法安全校验D3集合，不把新SDK继续发送作为兼容承诺。无历史补采，保留D0 TTL、重试幂等和部分写入恢复机制。D3合并后再核实最新refactor，进入D4，不自动合并。
