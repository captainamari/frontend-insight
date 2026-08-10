# 16. M8 前端可观测性

## 1. M8 的边界

M8 提供受控的错误、性能、发布和影响范围证据，但不是完整 Sentry：

- 没有 SourceMap；
- 没有完整堆栈、源码、DOM、录屏；
- 没有任意查询/告警 DSL；
- 告警只读，没有确认、关闭和通知状态；
- 不自动修复；
- 不把错误/性能加入项目运营指数 v1；
- 不把时间重合解释为因果。

读模型使用独立版本 `observability_v1.0.0`。

## 2. SDK opt-in

`TrackerConfig.observability` 必须显式启用并提供 `releaseVersion`：

```ts
createTracker({
  projectKey,
  endpoint,
  observability: {
    enabled: true,
    releaseVersion: "2026.08.1",
    deploymentEnvironment: "production",
    captureJsErrors: true,
    captureResourceErrors: true,
    captureApiErrors: false,
    captureWebVitals: true,
  },
});
```

默认：

- JS error：开；
- resource error：开；
- Web Vitals：开；
- 全局 fetch 包装：关。

请求层优先显式调用 `captureApiError`，因为全局 fetch monkey-patch 可能改变宿主行为或与其他 instrumentation 冲突。

## 3. 四类事件

| 事件 | 当前必要证据 | 明确不采集 |
| --- | --- | --- |
| `error_js` | errorName、脱敏 message、脱敏 top frame、release/environment | 完整 stack、source、DOM |
| `error_resource` | resourceType、归一化 requestPath、release/environment | 完整 URL、header、正文 |
| `error_api` | method、path、status、duration、release/environment | query、header、request/response body |
| `web_vital` | LCP/CLS/INP/FCP/TTFB、value、rating、navigation type | PerformanceEntry 原对象 |

所有事件还可带 browserFamily、osFamily、viewportBucket。SDK 在内存中解析 User-Agent，但只发送粗粒度结果，不发送原文。

## 4. 浏览器端隐私处理

`packages/web-tracker/src/observability.ts` 在发送前：

- Bearer/JWT/credential assignment 替换为 redacted；
- 邮箱替换；
- URL 只保留 pathname；
- 数字、长 opaque token、UUID 等动态 path segment 归一为 `:id`；
- 字符串截断；
- status/duration 数值裁剪；
- release 只接受安全字符和长度；
- observability 保留属性与 staticProperties 冲突时 tracker fail-closed；
- 启用 observability 后为标准属性预留 9 个 property key。

`beforeSend` 仍受 restricted merge 约束，不能修改 event ID、route、account 等核心字段，也不能绕过凭据扫描。

## 5. Web Vitals 采集

`BrowserObservability`：

- FCP：paint observer 发现后发送；
- TTFB：navigation responseStart；
- LCP：记录最后/最大候选，隐藏或 pagehide 时 flush；
- CLS：排除 hadRecentInput 的 layout shift 后累加；
- INP：event entries 的最大 duration；
- 不支持的 PerformanceObserver type 被忽略，不影响宿主；
- `rateWebVital` 使用固定 good/poor 阈值。

当前服务端按 route + vitalName + release 聚合 P75、sample、poor count/rate。v1.7 的 P50/P90、coverage 和更细状态尚未实现。

## 6. Consumer 映射与错误组

ClickHouse migration 005 为 raw_events 增加：

- release/environment/browser/OS/viewport；
- error type/name/message/frame/group；
- request method/path/status/resource type；
- vital name/value/rating/navigation type；
- error group/release bloom filter index。

consumer 从低基数 properties 映射到独立列。错误组 ID 使用脱敏稳定特征的 SHA-256：

- JS：类型、name、message、top frame；
- resource：resourceType、path；
- API：method、path、HTTP 状态段等稳定特征。

账号、visitor、route、release 和时间不进入 group ID，所以同一根因可以跨页面/版本聚合；它们仍作为影响范围维度。

## 7. 固定读模型

`ObservabilityStore` 提供：

| 方法 | 输出 |
| --- | --- |
| `overview` | 摘要、Top 错误、vitals、releases、alerts、trend、边界 |
| `errors` | 错误组列表 |
| `errorDetail` | 错误摘要、趋势、route × release impact、隐私说明 |
| `webVitals` | route × metric × release 的 P75/poor rate/sample |
| `releases` | 发布关联证据 |
| `alerts` | 固定只读规则结果 |

每个响应带 range、dataStatus、updatedAt、availableFrom 和 definitionVersion。查询仍在 raw_events 上按 eventId 去重。

## 8. 固定告警

### 8.1 错误

- warning：occurrences ≥5 且 browsers ≥3；
- high：occurrences ≥10 或 browsers ≥5；
- critical：occurrences ≥50、accounts ≥10，或 5xx occurrences ≥20。

### 8.2 Web Vitals

- sample ≥20 且 poor rate ≥30%：warning；
- poor rate ≥50%：high。

### 8.3 链路

- delayed：warning；
- broken：critical。

告警 ID 由 rule + entity key 构造，在同一查询范围内可重复生成；当前没有持久化 lifecycle。

## 9. 管理端页面

`ObservabilityView.vue`：

- 顶部明确指数 v1 未变化、SourceMap 未启用；
- 摘要卡区分错误次数/组/影响账号/影响浏览器/poor 样本/告警；
- 错误与 poor trend 并列但有非因果提示；
- 可按 error type/severity 过滤；
- drawer 展示脱敏详情、浏览器/OS/viewport、route × release；
- Web Vitals 展示 p75、poor rate、sample；
- fixed rule 只读；
- viewer 与 admin 都能读，没有写告警入口。

`tests/m8/product-flow.spec.ts` 在 Chromium/WebKit 验证 demo 四类事件、隐私和页面下钻。

## 10. 当前能力与 v1.7 新采集的差异

| v1.7 目标 | 当前 `main` | 实施含义 |
| --- | --- | --- |
| API duration/success/error/slow rate | 只采 `error_api`，没有全部请求分母 | 必须新增 summary 事实，不能从错误事件反推失败率 |
| resource failure rate | 只采资源错误，没有总资源请求分母 | 当前只能显示次数/影响，不能显示失败率 |
| first screen readiness | 不存在 | 需要显式业务 API |
| list render P90 | 不存在 | 需要组件适配器和 row bucket |
| long task | 不存在 | 需要 observer 汇总和容量 gate |
| blank candidate | 不存在 | 需要模板/adapter，不能用通用 DOM 猜测 |
| breadcrumb | 不存在 | 需要环形 allowlist 和独立隐私评审 |
| `not_collected` | M8 主要以无数据/availableFrom 表示 | 需要统一状态契约 |

这说明 M8.1-B 是新增 collector 产品线，不是给现有 M8 表多加几列。

## 11. 代码精读入口

1. `packages/web-tracker/src/types.ts` 的 ObservabilityConfig；
2. `packages/web-tracker/src/observability.ts`；
3. `packages/event-contract/schema/event-batch-v2.schema.json`；
4. `apps/consumer/src/index.ts` 的 observability 映射与 group ID；
5. `infra/clickhouse/migrations/005_observability.sql`；
6. `packages/server-core/src/observability.ts`；
7. `apps/api/src/observability.controller.ts`；
8. `apps/web/src/views/ObservabilityView.vue`；
9. `packages/server-core/test/observability.test.ts`、`tests/m8/product-flow.spec.ts`。

