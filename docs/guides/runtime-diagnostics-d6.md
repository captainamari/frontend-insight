# D6 采集策略、运行维护与接入交付

本批实现状态、精确验证代码和CI结果以[结果记录](../progress/runtime-diagnostics-results.md)为准。开发中的页面或脚本不是通过证据，自动化也不代替 Jesse 手工验收。D7 全路线负载和发布验收单独保留。

## 页面与角色

管理员进入项目“设置 → 诊断策略与维护”（`/projects/:projectId/settings?tab=diagnostics`）：读取当前版本，修改后保存并发布。发布失败不显示生效；409表示并发编辑冲突，重新读取并核对后再发布。页面仅声明服务端已发布，不能推断全量客户端已同步。

同页对当前成员授予/撤销 read 和 export；export依赖read，撤read同时撤export。普通viewer仍可看质量统计，获read者可查看D4详情/搜索/稳定链接；获得read不带来任何业务、指标、设置或成员写权限。仅read不能导出；read+export才可复制/下载派生证据和整map。即时权限检查、no-store和元数据审计沿用D0–D5。

维护者查看容量、接收状态、健康快照与清理记录。接入开发者在部署实验室 `/observability?d6AppId=<测试项目appId>` 初始化D6 SDK、同步、模拟配置断网、触发日志后错误或限流、销毁；这些操作使用部署API/Kafka/consumer，不使用静态mock响应。使用隔离项目并配置实验室Origin。D5压缩源码场景继续可用。

## 策略字段和覆盖关系

生效范围：本地安装且显式授权的模块 ∩ 服务端已发布策略 ∩ 编译/合同硬预算；服务端准入再独立校验。不能利用伪报policyVersion突破预算或权限。策略响应只有配置元数据，不包含成员、凭证、原文或源码。

| 字段               | 兼容默认         | 可配置边界与单位                  | 作用层                                            |
| ------------------ | ---------------- | --------------------------------- | ------------------------------------------------- |
| enabled            | true             | boolean                           | SDK停止原文上下文；服务端抑制新详情               |
| level              | context          | errors/context                    | errors仅错误原文；context仅本地已授权上下文       |
| consoleLevels      | 全5级允许        | error/warn/log/info/debug，无重复 | 与本地级别相交；本地默认warn/error                |
| requestRoutes      | /**              | 0–32条，每条≤256字符              | 请求URL pathname匹配，0条禁请求证据               |
| successBodyRoutes  | /**              | 同上                              | 与本地successBodyRoutes相交；本地默认不采成功正文 |
| envelopeBytes      | 65536            | 1024–65536 UTF-8 JSON字节         | SDK/服务端整体信封准入                            |
| envelopesPerMinute | 20               | 1–20，单pageView每分钟            | SDK保护及服务端持久窗口计数                       |
| retentionDays      | 14，继承已有D0值 | 1–90天                            | 新准入证据首次固定expires_at                      |

`/api/order`是精确pathname；`/api/**`匹配`/api`及其斜杠子树，不匹配`/apix`。不解码、不含query/hash/origin、不支持正则。规范页面route用于业务统计，完整请求URL用于原文，不能混用。远端默认允许不等于自动安装/开启：例如应用没有console选项就完全不安装console wrapper。

保留期修改只作用新准入记录，重试保留原首次到期时间；不恢复历史未采集、已删除或已过期内容。关闭采集、撤读取权限、删除历史是三个独立动作。旧SDK不会同步D6策略，仍受服务器最新准入限制；页面与健康无观测时准确显示未知。

## SDK 接入及同步

可选入口独立计费包体，基础入口仍限12KiB。发布应使用同版本的base/errors/console/requests/policy模块；实际大小见构建生成的`policy-bundle-report.json`。不把可选模块算零。

```ts
import { createTracker } from "@frontend-insight/web-tracker";
import { createDiagnosticPolicy } from "@frontend-insight/web-tracker/policy";
const appId = "fi_your_project";
const policy = createDiagnosticPolicy({
  appId,
  env: "dev",
  endpoint: "https://collector.example/v1/events",
  console: { levels: ["error", "warn", "info"] },
  requests: { successBodyRoutes: ["/api/report"] },
});
const tracker = createTracker({
  appId,
  env: "dev",
  release: "release-1",
  endpoint: "https://collector.example/v1/events",
  errorDiagnostics: policy.errorDiagnostics,
  observability: { enabled: true, captureJsErrors: true, captureWebVitals: false },
});
await policy.sync();
console.log(policy.status());
tracker.captureException(new Error("synthetic example"));
await tracker.flush();
// 应用退出时 tracker.destroy() 同时结束同步、监听和缓冲；policy.destroy()也可单独停诊断。
```

复用R4-B的`POST /v1/events/workflow-config`获取当前诊断策略，首次及每60秒同步；本客户端可显式sync。超时5秒，响应最多64KiB；失败用最后有效配置，首次无有效配置用明确兼容默认。状态含版本、最后尝试/成功时间、enabled、未安装/不支持项。销毁中止未完成同步，项目固定在创建参数，不跨项目复用adapter。重复初始化遵循base已有实例管理，跨tracker复用句柄不授权采集。

策略改变重建上下文collector并清空旧环形缓冲，进行中请求继续执行业务，但旧collector晚到内容不进入新缓冲。已冻结、排队或重试事件不改写；其policyVersion保留采集时版本，服务端最新准入可能拒收详情。关闭恢复console原方法和释放缓冲，不取消业务fetch，不消费业务流；质量监听/计数独立保留。重新开启只安装一次当前collector。

### Vue、React 与请求

Vue使用D1实际导出`installVueErrorHandler(app,(error,source)=>tracker.captureException(error,source))`；保存返回的restore，在卸载时调用。已有handler的receiver/参数/返回和抛错行为保留。[D1指南](runtime-diagnostics-d1.md)包含完整可执行示例。

React继续将`createReactErrorHandler`放在`ErrorBoundary.componentDidCatch`，保留原handler；完整class示例见D1。Boundary覆盖React捕获的渲染错误，不替代浏览器全局异常、Promise或事件handler错误；实验室的React回调不是完整React应用树验收。

```ts
const fetchEvidence = policy.bind({ requestId: "req_synthetic" }).wrapFetch(fetch);
const response = await fetchEvidence("/api/report");
const text = await response.text(); // 业务本来需要读取；SDK没有代读
policy.responseText(response, text); // 明确提供已读文本，不clone/tee
if (!response.ok) tracker.captureException(new Error("report failed"));
```

`quality.observeApi`继续是对应API基础事实的唯一入口，证据adapter不自行创建API事实；完整受控请求和operation/workflow确定关联示例仍见[D3指南](runtime-diagnostics-d3.md)。XHR保留已有质量观察能力，没有自动XHR原文接口。应用可显式`captureDiagnostic`提供其已取得的JSON证据，但这会产生一条独立错误事实，不得对同一故障再重复captureException。不要虚构XHR wrapper或将fetch adapter用于XHR。

D5 `withSourceMapIdentity(policy.errorDiagnostics, manifest)` 可在采集时冻结真实构建身份；使用正式`tools/sourcemaps.mjs issue/upload`上传同一构建产物，具体签名、manifest与CLI参数见[D5指南](runtime-diagnostics-d5.md)。完整DevTools不在承诺内：不可见headers、跨域、应用没读的正文、二进制/流、无栈、未安装模块和历史缺身份都有边界；不补读远端URL或本地源码。

## 生命周期与维护

容量口径：接收状态查询最近7天最多10000条receipt；逻辑JSON字节不等于磁盘占用，不等于全项目历史总量。已过期数另列；ready与deleted/disabled等分开。SourceMap账面值来自项目制品元数据，含待物理清理项；共享ClickHouse磁盘无法精确归属项目，diskBytes=null。读取失败显示错误，不显示零。统计时间来自服务端。

单实例删除需明确项目和eventId，并勾选影响确认。`DELETE /api/projects/:projectId/diagnostics/instances/:eventId`先写持久墓碑，再改receipt；不存在receipt也保留墓碑以阻止晚到写入。重复删除返回同一任务id。不会删除raw_events或SourceMap，不改分母/错误率/评分。详情、复制、导出和源码派生读取检查墓碑；搜索只允许有效receipt。

后台每5分钟做有界清理，ClickHouse TTL物理删除仍异步。单个删除批次最多100个墓碑，每个mutation有5秒执行预算；墓碑保留防重放，清理重新巡检以回收晚到写入。SourceMap沿用D5每批1000目录/元数据预算、1小时孤儿回收、删除先墓碑。失败只记固定错误码，下次重试；清理最近成功/失败属于全服务，不冒充单项目任务执行。SourceMap删除独立确认，上传凭证可按UUID撤销；签发仍走D5 CLI和独立项目用途接口，普通设置不返回明文凭证。

## 健康观测

`POST /v1/events/diagnostics-health`仅收有限枚举、版本和累计计数。客户端每60秒至多一次，失败指数退避至15分钟；不通过console或业务错误递归上报，无质量事件副作用。数据是客户端自报，不能当作可信授权或全量客户端覆盖率。

维护页显示最近24小时最多100个客户端的最新快照：collectorErrors、syncFailures、suppressed、truncated累计数；同clientId/递增sequence覆盖，乱序/重复/一分钟内重复不累加。每项目最多1000个存活记录，过一天清理。一次实例生命周期的累计值不能跨实例加总成事件精确总量；历史未上报保持未知。

服务端拒收详情原因由receipt区分disabled/policy_suppressed/rate_limited/too_large等；pending与write_failed分别表示等待和失败。入库延迟从服务端首次准入created_at到persisted_at，单位毫秒，重试后持久化一次，平均值只覆盖有持久化时间的样本；旧记录无时间为null。日志、审计和Prometheus不能写入原文、query、源码或任意高基数标签。

## 增量发布、备份、恢复和回滚

新增MySQL迁移011，旧迁移不改；无reset/seed升级。先备份→增量011→consumer/API→管理端→可选SDK接入。旧项目config=null按兼容值解释，并继承D0 retention；revision从0开始。服务端发布用revision比较并在事务内加锁，旧编辑不能覆盖新版本。

现有`./scripts/production backup NAME`完整MySQL dump自动包含策略、grants、墓碑、健康与维护状态；ClickHouse detail和私有map归档继续使用D5同停写窗口。恢复必须同时还原receipt/detail/map，合法空Native表按空表处理；缺归档/校验失败不得宣称成功。实际破坏恢复证据在results，不能仅凭脚本存在宣称通过。

恢复旧备份可能恢复旧read/export授权、上传凭证和已删除数据。开放服务前核对成员、授权、凭证、删除任务及策略，重新执行备份后发生的撤权/删除/轮换，确认详情和源码定位。系统不能自动保留旧备份之后的所有撤销。

回滚应先停止D6策略客户端、停写并排空队列，然后回滚匹配的API/consumer/UI。保留011表/列、receipt和私有卷；旧服务不理解D6新状态与删除墓碑，**不得开放旧诊断原文读取端点**，直到升级恢复或按受限运维流程确保已删除原文被物理回收。基础统计沿用旧版本，但旧版不再执行D6策略，不承诺关闭策略仍生效。不要直接删除新增表。

## 最短手工验收

1. 隔离项目设置中编辑级别/路由/2天保留并发布，核对版本递增，旧revision提交409。
2. 实验室初始化并同步，确认实际版本、collector；触发日志后错误，从eventId稳定链接查看真实原文。
3. 模拟同步失败，再发布关闭；失联客户端保持旧版本，但服务端新详情显示disabled，基础错误仍增加。恢复同步后collector为空；重新开启后只采新上下文。
4. 设置中给viewer read，详情可读但设置/删除拒绝；撤销后立即拒读，已打开详情按既有轮询清空。
5. 输入具体eventId并确认删除，详情deleted，复制/导出不返回旧原文；基础质量仍保留。删除SourceMap只改变映射，不删除编译栈。
6. 查看容量口径、健康快照、清理时间；无观测不是零。由维护者在隔离环境执行备份、破坏和恢复脚本，并核对权限/策略/墓碑及D5固定源码位置。

D7继续执行全路线压力、长期容量、完整发布验收与最终手工确认；本批不将它们标成完成。
