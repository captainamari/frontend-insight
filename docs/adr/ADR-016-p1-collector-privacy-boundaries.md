# ADR-016：P1 采集器、分母与隐私边界

- 状态：Accepted
- 日期：2026-08-13
- 对应范围：M8.1-B / P1
- 关联文档：`requirements-v1.7.md`、`mvp-plan-v1.4.md`

## 背景

页面分析已经能显示页面访问、错误和 Web Vitals，但 API/资源失败率、首屏、列表渲染、长任务影响率、白屏候选和错误 breadcrumb 缺少可靠分母或显式业务语义。若直接启用全局 hook、DOM 推断或详细请求信息，会把误报、宿主兼容和员工数据保护风险带入默认链路。

## 决策

1. 七类能力分别配置：API、资源、首屏 readiness、列表渲染、长任务、白屏候选、breadcrumb。每类都有独立 `enabled` 和 `sampleRate`，新项目和无配置项目全部默认关闭。
2. SDK `0.4.0` / schema v3 是唯一运行时契约。项目配置使用 clone-on-write 版本；SDK 推荐在启动前通过注册 Origin 拉取有效版本。读取失败时基础 page/feature 采集继续，P1 全部失败关闭。
3. API 优先使用宿主请求层显式 `captureApiRequest`；全局 `fetch` 包装必须另行启用，默认关闭，且不能截获 collector 自身请求。只发送 method、归一化 path、status、duration、慢阈值、分子、分母和采样率；不发送 query、header/body 或主机名。
4. 资源和长任务在 pageView 结束时各发送一个汇总。资源保留总请求/失败请求/总耗时/观测 PV；长任务保留数量/总时长/最大时长/观测 PV。不发送资源原 URL、脚本 URL或 attribution。
5. 首屏与白屏共享业务显式 `markPageReady` 适配点，但保留两个独立开关与 collected 标记。白屏只能叫“候选”；Canvas、Cesium、骨架或异步页面没有模板 adapter 时保持关闭。每个 pageView 只接受第一次 readiness。
6. 列表渲染由组件显式 begin/end，只发送页面 route、duration 和 `<100`、`100-1000`、`>1000` 行数桶；list key 和行内容不发送。
7. breadcrumb 使用最多 50 条的内存环，仅允许 route change、allowlist action key、归一化 API path/method/status；只附在错误事件上。禁止 DOM 文本、selector、输入/剪贴板、console、query、header/body、原始 URL 和业务对象 ID。
8. 比率必须同时返回分子和分母；采样结果必须返回采样率与相对 pageView coverage。未启用/无观测返回 `not_collected`，分母为 0 返回 null 比率，不能显示成 0。时长 P50 至少 5 样本，P90 至少 20 样本，否则返回 null 与 `insufficient_sample`。
9. P1 不进入项目运营指数 v1。它是页面分析的独立证据层；相关性不自动解释为因果。

## 客户端与容量边界

- 禁用 collector 时不注册对应 PerformanceObserver 或全局 wrapper。
- breadcrumb ring 上限 50；SDK queue 上限 100、传输批上限 50 个事件 / 64 KiB、单事件 8 KiB。
- observer 回调只做有界计数与求和；资源和长任务不保留 entry 明细。
- SDK 内部异常不得抛入宿主。全局 fetch 仅在显式启用时替换，并在 destroy 时仅当仍持有自己的 wrapper 才恢复，避免覆盖宿主后续修改。
- 每类 collector 上线前必须分别记录事件数、事件大小、Kafka lag、consumer throughput 和 ClickHouse 扫描量；逻辑验收不能替代目标环境容量演练。

## 回滚

项目管理员发布一个所有 `enabled=false` 的新配置版本即可关闭 P1，不影响基础 page/feature 事件。若全局 fetch 出现宿主问题，先单独关闭 `api.globalFetch`，保留显式 API adapter。代码回退不回写旧 schema；测试环境按对应基线重新建立。

## 后果

我们获得了可解释的分母、coverage 和长尾时长，同时承担显式业务接入与模板配置成本。没有 adapter 的页面会诚实显示“未采集”，不会由平台猜测。高风险能力（DOM/表单/SourceMap/业务轨迹）不因本 ADR 获得授权。
