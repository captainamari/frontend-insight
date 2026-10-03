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
