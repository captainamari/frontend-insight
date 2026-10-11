# D1 错误诊断接入与手工验收

本批为 D0 基础上的首个可试用错误诊断闭环。仅包含错误消息、编译栈、cause/AggregateError、按实例受限详情和实验室；不包含 console 回溯、请求正文、完整时间线、SourceMap、导出和策略设置界面。D2–D7 仍未完成。

## 1. 发布与启用

先按 [D0 升级说明](runtime-diagnostics-d0.md) 完成数据库/consumer/API；再发布 D1 API、管理页面、SDK 与实验室。D1 没有新数据库迁移；继续使用 contract v3、diagnosticVersion 1。旧 D0 原文入口可用，旧 SDK 可继续发基础事件。

诊断提取器是明确启用的独立入口，不自动增加所有接入方的下载量：

```ts
import { createTracker } from "@frontend-insight/web-tracker";
import { createErrorDiagnostics } from "@frontend-insight/web-tracker/errors";

const tracker = createTracker({
  appId: "fi_your_project", // 替换为项目设置中的 appId
  env: "dev",
  release: "d1-example",
  endpoint: "https://your-collector.example/v1/events", // 替换为部署地址
  errorDiagnostics: createErrorDiagnostics(), // 每个 tracker 创建一份
  observability: {
    enabled: true,
    captureJsErrors: true,
    captureResourceErrors: true,
    captureWebVitals: false,
  },
});

const error = new TypeError("token=synthetic\n图表渲染失败", {
  cause: new Error("synthetic upstream failure"),
});
tracker.captureException(error);
await tracker.flush();
```

已有 `createQualityCollectors({ jsErrors: true })` 的接入继续配置 `quality: quality.factory`，并在 tracker 上添加 `errorDiagnostics`。两条路径经同一 reportError 提取原文。未添加该选项时保持旧摘要模式，不会恢复此前丢失的信息；D0 的 `captureDiagnostic` 仍是显式 JSON 信封入口，不能对同一次异常再同时调用它。

相同配置重复 createTracker 返回已有实例；destroy 后才重新创建。事件对象身份消除多个全局监听入口；同一 Error 在当前任务跨来源传播视作同一次异常。相同文本的新 Error、重复同来源显式捕获和后续任务再次抛错保留基础计数。不要用同一个 Error 对象表示当前任务中不同来源的多个独立业务故障，应为每次故障创建独立 Error。

### Vue 接入

在 mount 前安装，已有处理器仍收到原 receiver、参数，返回/抛错行为保留；没有旧处理器时保留控制台错误输出。安装器返回卸载函数，且不会覆盖之后另行替换的处理器。

```ts
import { createApp } from "vue";
import { installVueErrorHandler } from "@frontend-insight/web-tracker/errors";
import App from "./App.vue";

const app = createApp(App);
const restore = installVueErrorHandler(app, (error, source) => {
  tracker.captureException(error, source);
});
app.mount("#app");
// 应用退出时：restore(); app.unmount(); tracker.destroy();
```

可执行实例在 `apps/demo-app/src/App.vue`：点击“Vue 框架捕获”会从实际 Vue 事件处理器抛错并进入适配器。

### React 接入

把适配器接到已有 ErrorBoundary.componentDidCatch 或 root 错误回调，传入已有应用处理器，保留其行为。无需全局替换 React、也不修改 fallback UI：

```tsx
import React from "react";
import { createReactErrorHandler } from "@frontend-insight/web-tracker/errors";

const report = createReactErrorHandler(
  (error, source) => tracker.captureException(error, source),
  (...args) => console.error(...args), // 替换/保留原应用处理器
);

export class Boundary extends React.Component<
  React.PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    report(error, info);
  }
  render() {
    return this.state.failed ? <p>页面加载失败</p> : this.props.children;
  }
}
```

自动化验证适配器的真实浏览器回调与 receiver/参数/返回/抛错行为；实验室“React 适配器捕获”是显式回调示例，并非挂载了 React 应用。不要将其表述为真实 React 渲染树覆盖。

## 2. 原文、派生字段与限制

- 原文位于 `diagnostic.raw.error`；包括 name、message、stack、cause、errors 及非 Error 对象的自有数据。`raw.extraction.issues` 标明不可读取、循环引用、非 JSON 值及截断位置。消息含 token=、query、换行或 HTML 文本均保留，不做内容脱敏。
- 原文不进入普通列表、基础 payload、日志、Prometheus、DLQ 元数据。派生消息为不含原文的分组标识；结构化帧由受限 API 派生，不取代原始编译栈。无 SourceMap 映射。
- 信封保持 64 KiB UTF-8、每个栈 16 KiB/32 帧、cause 最深 4 层；对象最多 256 个处理节点、深度 8、每对象/数组最多 32 项；消息等字符串最多 16 KiB，并受整体序列化预算限制。业务自定义 getter/toJSON 不执行；原生 Error.stack 读取异常时标记 unreadable。
- 超限或不可读取会标记 truncated，保留可读部分；D0 整体保护仍可能标记 too_large。每页面每分钟最多 20 个完整详情，后续为 rate_limited；基础错误仍计数。
- 非 Error rejection 不伪造调用栈：null/数字/字符串和对象原样表达；浏览器没有提供的调用栈显示 unavailable。

## 3. 权限和页面

admin 或当前项目成员且具备 diagnostics.read 才能读详情。授权方式沿用 D0 admin API：

```http
PUT /api/projects/:projectId/diagnostics/grants/:userId
Authorization: Bearer <平台登录 accessToken>
Content-Type: application/json

{"read":true,"export":false}
```

普通 viewer、跨项目、未登录、现有外部 token 无原文读取权。撤权使用 read=false；移除成员同时删除旧授权，重新加入不会恢复。

在“页面分析 → 质量”选择 **dev** 和覆盖当前时间的范围，点击错误实例的“复现条件”按钮，打开“错误诊断详情”。上半部分按需读取原文，下面保留原有摘要上下文。展开原始栈、结构化函数/文件/行列号、cause/子错误和截断说明；消息与栈均可复制。复制前重新服务端授权；浏览器禁止剪贴板时显示手工复制提示。

响应 no-store。关闭、切换实例/项目、失焦、登录失效清空原文；打开时每秒核对权限。撤权后的服务端读取立即失效，已打开页面在下一次轮询往返清空。已经发送给浏览器的字节不能承诺零延迟擦除；没有使用推送撤回或浏览器持久缓存。

| 层次/状态                            | 中文含义                                             |
| ------------------------------------ | ---------------------------------------------------- |
| 存储 ready                           | 详情已就绪                                           |
| not_enabled                          | 历史事件或接入未启用诊断；有 legacy 时仅展示已存摘要 |
| pending / write_failed               | 正在入库 / 写入失败等待重试                          |
| expired / unavailable                | 已过保留期 / 没有可用详情                            |
| 采集 complete / truncated            | 已完整提取 / 有内容被截断、省略或不可读取            |
| rate_limited / too_large             | 详情限流 / 超过容量；基础计数仍保留                  |
| 解析 parsed / partial / parse_failed | 已解析 / 部分帧失败 / 格式无法解析；原始栈仍可看     |
| 解析 unavailable                     | 没有提供调用栈                                       |
| not_applicable                       | 资源加载失败“不适用 JS 调用栈”，展示已取得的资源地址 |
| 访问 forbidden                       | 无当前项目诊断权限或成员关系失效                     |

历史数据可能只存了脱敏消息或首帧，明确显示 legacy 提示；不能恢复当时未采集或已删除的信息。

## 4. 可执行手工验收

仅使用可丢弃的测试堆栈和合成值：

```bash
pnpm install --frozen-lockfile
pnpm check
M5_ALLOW_NON_ARM64=1 ./scripts/dev bootstrap # Linux 测试环境；Mac 可省略此变量
./scripts/dev up
./scripts/dev smoke
pnpm exec playwright install chromium webkit
pnpm exec playwright test -c playwright.diagnostics.config.ts
```

1. 登录管理端 `http://127.0.0.1:4173`（本地 seed admin），打开演示项目的页面质量，选择 dev、近 7 天。
2. 打开 `http://127.0.0.1:4174/observability?acceptance=fast`，输入任意模拟密码进入实验室。
3. 依次点击“模拟 JS 异常”“真实 throw”“未处理 Promise”“Vue 框架捕获”“React 适配器捕获”“模拟资源失败”。每次等约 2 秒，管理端点刷新。
4. 显式 JS：详情应显示 `Chart render failed token=FI_D1_SYNTHETIC` 与下一行中文；原始栈包含 renderChart、app.js、10:20 及 query；结构化帧对应同一文件和行列。
5. 真实 throw：显示 TypeError、`token=throw`、中文换行与 d1RealThrow 的浏览器编译栈。Vue/React 类别分别为 vue/react；Promise 显示嵌套对象，若浏览器未提供栈，说明 unavailable。
6. 资源失败：显示“不适用 JS 调用栈”，原始资源 URL 包含合成 token query；普通列表不应包含该 query。
7. 验证复制消息/栈得到原文。长文本换行和 HTML 样例以文字显示，不运行脚本。cause/AggregateError/解析失败/截断 fixture 由专项浏览器测试自动构造，可按 SDK 示例显式构造复验。
8. 给项目 viewer 开 read 权限，确认能读原文；另一个普通 viewer 或撤销 read 后应看到明确权限提示。打开详情时撤权/移除成员，等待一次轮询，原文消失；点击复制也不能继续读旧原文。切换项目或关闭抽屉后原文清空。
9. 回归 D0：`./scripts/dev verify-d0-upgrade`、`./scripts/dev verify-d0`、`pnpm test:r5a:e2e`、`pnpm test:r5b:e2e`、`node tools/r5b-storage-privacy.mjs`、`node tools/d0-log-check.mjs`。verify-d0 会故障注入，严禁生产运行。

最终通过的代码 SHA、CI 链接、包体与同步提取 p95 见 [结果记录](../progress/runtime-diagnostics-results.md)。Firefox 只有栈格式 fixture，不加入真实 Firefox CI；未完成 D7 全容量/备份恢复验证。
