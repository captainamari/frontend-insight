# @frontend-insight/web-tracker

MVP npm ESM SDK。默认只采集规范化路由和显式事件；不会遍历或读取 Authorization、cookie、表单、DOM 文本、Local/Session Storage 登录内容。

```ts
import { createTracker } from "@frontend-insight/web-tracker";

const tracker = createTracker({
  projectKey: "fi_public_example01",
  endpoint: "https://tracker.internal/v1/events",
  registeredFeatures: ["sales_dashboard", "report_export"],
  // 仅放稳定、低基数且不含隐私的部署标签；会应用到 page_view 等自动事件。
  staticProperties: { deployment: "production" },
  normalizeRoute: (url) => url.pathname.replace(/\/orders\/[^/]+/, "/orders/:id"),
});

tracker.setAccount(currentUser.analyticsRef);
tracker.featureExposed("sales_dashboard");
tracker.featureSucceeded("sales_dashboard");

// M6：一次任务使用一个 SDK 生成的 operation handle，并发任务不会串联。
const operation = tracker.startOperation(
  "report_export",
  { source: "toolbar" },
  "click",
);
try {
  await exportReport();
  operation.succeed();
} catch (cause) {
  operation.fail("export_failed");
}
```

`operation.cancel()` 表示用户明确取消；成功、失败、取消三个终态只能提交一次，重复调用只增加 `duplicateOperationTerminals` 诊断计数。业务侧不能传入 operation ID。

`staticProperties` 会先经过与事件属性相同的扁平标量、键数量和敏感信息校验，再以不可被单次事件覆盖的方式应用到所有自动/显式事件。它适合部署环境或受控 demo 标记，不应用于账号、请求 ID 等高基数或隐私数据。`beforeSend` 仍只能删除或归一化已有字段，不能新增属性键。

`setAccount` 只接受业务生成的不透明引用。不得传 token、姓名、邮箱或手机号。初始化失败会返回安全 no-op；可用 `getDiagnostics()` 查看丢弃、重试、重复终态和 beacon 降级计数。
