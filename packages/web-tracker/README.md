# @frontend-insight/web-tracker

当前 SDK 0.8.0，使用 contract v3。身份为受治理的不透明引用；路由须规范化。基础页面采集不读表单值、DOM文本、cookie或登录存储。效率、重复操作及覆盖诊断均独立 opt-in。

```ts
import { createTracker } from "@frontend-insight/web-tracker";

const tracker = createTracker({
  appId: "fi_public_example01",
  env: "prod",
  release: "2026.10.1",
  endpoint: "https://collector.example.invalid/v1/events",
  initialUserId: "u_opaque_business_user_0001",
  registeredFeatures: ["save"],
  usageCoverage: { enabled: true },
  forms: { enabled: true, definitions: [{ formId: "edit", fieldKeys: ["status"] }] },
  businessOperations: { enabled: true, operationKeys: ["save"], sampleRate: 1 },
});

const form = tracker.trackForm("edit");
form.change("status");
const attempt = form.submit();
// 校验失败时调用 attempt.validationFailed()，不传文案或输入值。
form.destroy();
// 业务请求采用 observeBusiness("save", execute, classify)。
// classify 只返回 success/rejected/technical_failure/canceled/unknown。
// 不从 HTTP 200、网络异常或独立 operation.fail 推断业务结果。
```

已有登录身份应通过 initialUserId 随首条页面事件发送；身份变化继续使用 setUser。未登录或未归类活动不会成为规范业务人数，缺失身份会阻断正式覆盖。SDK不会自动认证浏览器的身份声明，业务系统需治理引用并与目录一致。

C07 接入流程：管理员发布完整组织目录，登记所有业务页面/功能，确认全量未采样部署后，在现有指标管理入口发布接入声明（env、release、有效期）。SDK 0.8 的 usageCoverage 仅发送累计 droppedEvents、failedBatches 和实际业务采样率，不发送业务内容；旧SDK、关闭诊断、已知丢失、采样及源版本不匹配保持partial。诊断不能证明未安装的客户端不存在，完整部署仍由管理员背书。未成功送达的最后一批诊断也不能凭空推知。

源声明与目录均只向后生效；更改页面/module revision、功能或发布版本后重新声明；发现缺失发布 interrupted。SDK声明不是自动完成目录或指标激活，三个步骤分别可追溯。正式组织活动为已识别、已归类页面访问或受控登记功能成功；开始、拒绝、取消与未知不能当成功。时长需真实匹配page_leave，缺失不补0。

完整的可信业务后端引用接入、版本review、三类状态及Mac手工步骤见 [R4-C接入与验收指南](../../docs/guides/v1.8-r4c-local-acceptance-macos.md)。默认保留数据，不执行reset，不自动进入R5。

### R6 page usage settlements

The default SDK emits controlled `usageVersion: "r6-1"` on page views and leaves. Each visible segment has `usageSequence`; route exit, pagehide and destroy mark `usageClosed: true`. A visibility hide alone is not a terminal settlement. Duplicate terminal callbacks are suppressed, and BFCache restoration opens a fresh page view. These fields are immutable under `beforeSend`; no content or identity fields are added.

R6 duration queries require an observed page view plus contiguous settlements through a terminal. Legacy or incomplete facts remain unavailable, with sample/coverage diagnostics; they are not backfilled as zero. Exactly 30 minutes idle starts a new session on the next active event, while a leave retains the previous session. Anonymous UV uses deviceId fallback and is reported separately from identified users.

## D1 可选错误原文诊断

通过 `@frontend-insight/web-tracker/errors` 导入 `createErrorDiagnostics`，在 createTracker 中配置 `errorDiagnostics: createErrorDiagnostics()`。全局/Promise/显式/Vue/React 错误共用有界提取器；基础计数不因详情限流减少。旧接入未启用时仍只发原摘要。框架适配器、预算、源格式、权限与可执行示例见 [D1 指南](../../docs/guides/runtime-diagnostics-d1.md)。基础包仍受原 12 KiB 门禁，启用后另计 errors 下载量，完整数据见构建报告。

## D2 可选 console 上下文

从 `@frontend-insight/web-tracker/console` 导入 `createConsoleDiagnostics`，配置 `errorDiagnostics: createConsoleDiagnostics({ scope: { appId } })`，替代 D1 的 `createErrorDiagnostics()`。默认 error/warn，log/info/debug 显式启用；本模块复用 errors 下载，不另加全局异常监听或上传通道。console.error 自身不计为 JS 异常。

scope 是应用对全局 console 项目所有权的明确声明，多项目冲突停止采集；每 tracker/pageView 独立。最多 50 条/24 KiB/60 秒，单条连元数据不超过 2 KiB；配置只能收紧。参数调用时取值、异常时冻结、后续修改不回写。基础包仍受 12 KiB 门禁，下载量见 `dist/console-bundle-report.json`（含所有实际组合）。完整配置、能力边界、升级、权限和验收见 [D2 指南](../../docs/guides/runtime-diagnostics-d2.md)。

## D3 可选请求上下文

`./requests` 导出 `createRequestDiagnostics`，配置 `errorDiagnostics: diagnostics.errorDiagnostics`（已组合D1/D2）。每个tracker独立创建，初始化后通过 `diagnostics.bind(operation.getContext?.()).wrapFetch(window.fetch)` 调用受控请求；action/context及workflow实例/step/attempt显式绑定。诊断不重复发API或JS事实，质量分母仍通过一次quality.observeApi。

响应正文使用 `diagnostics.responseText(response, originalText, explicitBusinessFailure?)`，传业务已经读取的原始文本。SDK不clone/tee、不读取或锁业务流；未提供显示host_text_required。成功正文按successBodyRoutes精确路由开启，失败提供文本后默认采集。异常即时冻结pending状态，晚结果不补传；XHR自动捕获未实现。完整代码、状态、预算、宿主Promise语义、升级与手工验收见 [D3指南](../../docs/guides/runtime-diagnostics-d3.md)。各独立模块和实际启用组合体积见构建的requests-bundle-report.json。
