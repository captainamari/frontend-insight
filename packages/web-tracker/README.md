# @frontend-insight/web-tracker

MVP npm ESM SDK。默认只采集规范化路由和显式事件；不会遍历或读取 Authorization、cookie、表单、DOM 文本、Local/Session Storage 登录内容。

```ts
import { createTracker } from "@frontend-insight/web-tracker";

const tracker = createTracker({
  projectKey: "fi_public_example01",
  endpoint: "https://tracker.internal/v1/events",
  registeredFeatures: ["sales_dashboard", "report_export"],
  normalizeRoute: (url) => url.pathname.replace(/\/orders\/[^/]+/, "/orders/:id"),
});

tracker.setAccount(currentUser.analyticsRef);
tracker.featureExposed("sales_dashboard");
tracker.featureSucceeded("sales_dashboard");
```

`setAccount` 只接受业务生成的不透明引用。不得传 token、姓名、邮箱或手机号。初始化失败会返回安全 no-op；可用 `getDiagnostics()` 查看丢弃、重试和 beacon 降级计数。
