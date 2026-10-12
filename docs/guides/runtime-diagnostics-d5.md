# D5：SourceMap 与源码定位

本页说明D5实现；最终验证状态以[结果](../progress/runtime-diagnostics-results.md)和Draft PR #34为准。D6完整设置UI、D7全路线验收未实施，自动化不代替Jesse手工验收。

## 1. 产品入口与匹配合同

项目 → 页面分析 → 质量 → 错误组 → 实例 → 诊断上下文；或D4稳定实例链接。原始消息和编译栈始终保留，下面新增“源码定位（服务端派生视图）”。每帧标注根错误/cause/子错误路径、匹配状态、原始文件/函数/行列和最多前后2行的源码片段。Map没有名称时明确显示“未提供函数名”，不能猜出原始函数名。没有sourcesContent仍显示文件和位置。

`sourceMapping`是派生对象，绝不覆盖`diagnostic.raw`或`storedEnvelopeJson`。复制源码定位会重新读授权详情；JSON/文本导出包含派生标识、制品身份和状态，仍需read+export且总量不超过512KiB。前端切实例/项目、失焦、退出清空，generation隔离晚到结果；已打开详情每秒续验权限及当前文件状态。已交付/下载内容不能远程收回。

身份由以下字段共同确定：

| 字段        | 来源与含义                                              |
| ----------- | ------------------------------------------------------- |
| project     | 上传API路径解析的项目UUID；上传凭证只能操作此项目       |
| release     | 应用部署版本，与基础事件release严格相同                 |
| build       | 构建流水线唯一ID；实验室用压缩JS的SHA256                |
| asset       | 部署后的编译JS绝对HTTP(S) URL                           |
| assetSha256 | 对最终发布JS字节计算SHA256，上传时服务端用JS字节再计算  |
| mapSha256   | 对对应map文件字节计算SHA256，上传与后续磁盘读取再次校验 |

同project/release/build/asset不可静默换内容：完全相同幂等，不续期；任一checksum不同409。已删除/到期身份保留墓碑，不能借重试复活；重新发布必须新build。Map校验和用于文件完整性，JS校验和用于事件与发布内容匹配，二者不能替代。

URL使用WHATWG规则保留origin、路径及完整query，仅去fragment；不同域名/CDN/query不互相回退。相对路径须有事件清单中的绝对baseUrl，不猜当前服务器地址。禁止凭据URL、反斜线、控制字符及显式点路径。Unicode路径可由构建工具保留为百分号编码，输出保持map中的文件标识。多CDN部署应分别上传其实际URL并在对应应用清单中声明；不自动剥前缀，不选“最新map”。

历史没有build/资产校验和时显示identity_missing。只有所需身份完整且唯一才匹配；根错误成功不表示cause/子错误成功，整棵错误树共用32帧/32个错误节点预算，各节点另列编译栈解析状态，没有栈或解析失败的子错误不冒充已映射。

## 2. 凭证与命令行

Node >=24，无CLI额外依赖。命令在仓库根目录执行。上传专用凭证只用于上传，不能读取诊断、下载文件、签发凭证、修改成员或设置；采集appId、旧外部token、会话token均不能代替上传凭证。

管理员会话从安全环境提供，勿写进命令参数、URL、前端或提交文件。以下变量由部署密钥管理注入；示例只含变量名。

```bash
# FI_SESSION_TOKEN 已由安全环境提供；先在项目内确认管理员会话。
node tools/sourcemaps.mjs issue \
  --api https://insight.example.invalid --project "$PROJECT_ID" \
  --days 7 --credential-file /secure/ci.sourcemap-credential.json
```

凭证明文仅本次返回。CLI新建0600文件（已存在拒绝覆盖），标准输出仅id/expiry/purpose。服务端存token的SHA256，不可读回，1–30天有效；签发管理员被禁用/降权后也不可上传。上传环境可用`FI_SOURCEMAP_TOKEN`，或受限凭证文件。

```bash
# 在业务自身构建命令之后上传最终JS及配套map，不上传源码目录。
node tools/sourcemaps.mjs upload \
  --api https://insight.example.invalid --project "$PROJECT_ID" \
  --release "$RELEASE" --build "$BUILD_ID" \
  --asset-url https://cdn.example.invalid/assets/app.js \
  --js dist/assets/app.js --map dist/assets/app.js.map \
  --days 30 --credential-file /secure/ci.sourcemap-credential.json

# 查询和删除需当前管理员会话；输出不含源码或map正文。
node tools/sourcemaps.mjs list --api https://insight.example.invalid --project "$PROJECT_ID"
node tools/sourcemaps.mjs delete --api https://insight.example.invalid --project "$PROJECT_ID" --id "$ARTIFACT_ID"
node tools/sourcemaps.mjs revoke --api https://insight.example.invalid --project "$PROJECT_ID" --id "$CREDENTIAL_ID"
```

上传成功输出`id/assetSha256/mapSha256/bytes/state/idempotent`；失败退出非0。网络/429/502/503/504最多尝试3次，每次15秒超时，短暂退避；409不盲目重试。单次只上传一个JS/map对，不递归遍历或处理压缩包。一个发布有多个文件时由流水线逐个调用，任一失败阻止发布。

相应接口均在`/api/projects/:projectId/diagnostics/sourcemaps`：POST `/credentials`、DELETE `/credentials/:id`、POST `/upload`、GET根路径、DELETE `/:id`、POST `/:id/download`。管理操作要求当前有效admin；整map下载要求项目成员read+export（admin沿既有权限）。普通read可查看有界片段，但不能下载整份map。全路径private/no-store；审计只有操作者/上传凭证ID、项目、制品ID、行为、格式/结果，不写正文。

## 3. 采集身份接入

基础SDK保持12KiB门禁，解析库与源码都不进入SDK。生成manifest后，在可选errors入口组合`withSourceMapIdentity`，在异常采集阶段冻结可选身份。beforeSend保持不允许改写诊断证据的既有边界：

```ts
import {
  createErrorDiagnostics,
  withSourceMapIdentity,
} from "@frontend-insight/web-tracker/errors";

const errorDiagnostics = withSourceMapIdentity(createErrorDiagnostics(), {
  release: RELEASE,
  build: BUILD_ID,
  baseUrl: location.origin + "/",
  assets: [{ url: ASSET_URL, sha256: ASSET_SHA256 }],
});
const tracker = createTracker({
  appId: APP_ID,
  env: "prod",
  release: RELEASE,
  endpoint: COLLECTOR_URL,
  errorDiagnostics,
});
// 已启用D3时可把requestDiagnostics.errorDiagnostics作为第一个参数；生命周期照常转发。
```

清单最多16资源/8KiB，采集时复制冻结，继续受64KiB信封限制。manifest不能包含map、源码或凭证；哈希必须来自**实际发布的最终JS**，不得从下载到的其他版本补填，不在浏览器临时抓取JS猜checksum。动态加载chunk应由构建清单显式维护，超过清单/信封预算时调整接入为当前实际相关资产，不能制造截断后仍完整的假象。`release`还须传给createTracker的基础release配置。

没有改变quality.observeApi、错误计数/分母/评分、D3请求冻结与显式关联合同。D3仍为受控fetch及应用已读取文本，没有新增clone/tee/XHR自动采集。

## 4. 支持格式、预算与失败状态

采用固定`@jridgewell/trace-mapping@0.3.31`，依据[官方API](https://github.com/jridgewell/trace-mapping)核对。仅普通v3字符串VLQ mappings；indexed/section map（含section URL）拒绝。sources/sourceRoot可作为原始文件标识，但从不抓取；没有sourcesContent不读磁盘补全。上传内容不执行。

| 层次       | 强制预算                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| 上传       | 每次1对；JS1MiB、map2MiB；HTTP JSON体4,500,000 bytes，仅上传路由放宽      |
| 项目       | 200身份、100MiB账面容量，含未清理墓碑；不能靠反复删除绕过                 |
| 保留       | 1–90天，默认30天；幂等重传不续期                                          |
| 解析       | worker 1.5秒、old64MiB/young8MiB/stack2MiB；最多2个并发，无无界队列       |
| 格式复杂度 | 2048 sources、10000 names、1MiB mappings字符串、100000 segments           |
| 映射       | 整棵错误树32帧，native/eval不猜位置；编译与展示行列均从1，解析器内部列从0 |
| 源码输出   | 每帧前后2行、JSON4KiB，整体64KiB；超限明确状态                            |
| 导出       | D4单实例JSON/text总512KiB，包含全部派生信息                               |

状态包括identity_missing、version_mismatch、asset_mismatch、checksum_mismatch、ambiguous_asset、not_found、unsupported_format、parse_failed、mapping_not_found、no_sources_content、unmappable_frame、upload_budget、project_budget、parse_budget、frame_budget、output_budget、busy、expired、deleted、storage_missing、storage_corrupt、storage_unavailable、forbidden。整体success/partial/failed/no_frames与逐帧状态分别显示，加载由现有pending状态呈现。不存在不能伪装成解析成功或空源码。

## 5. 持久化、维护与恢复

MySQL增量`010_diagnostic_sourcemaps.sql`新增元数据和凭证；不修改旧迁移。文件在API私有`sourcemap-data`命名卷，容器路径`/var/lib/frontend-insight/sourcemaps`，目录0700/文件0600，文件名只用服务端身份SHA256；不以上传名称作为路径，读取O_NOFOLLOW并校验mapSHA256。生产只读根文件系统保留该独立可写卷。

上传临时文件使用wx+fsync、原子rename后提交元数据。失败尽量清理本次未提交文件；进程中断遗留临时/孤儿文件在超过1小时后清理。文件缺失或损坏只影响诊断定位，不影响基本事实；相同上传可修复缺失文件，损坏文件拒绝静默覆盖，应从备份恢复。删除先提交墓碑再unlink；unlink失败后访问仍拒绝。

API启动及每5分钟执行受限清理；重复执行幂等。处理过期/删除文件、1小时以上孤儿和临时文件、到期后90天墓碑及过期凭证；失败下次重试。没有派生映射缓存，删除/到期每次读均查当前元数据。维护不能通过公共采集凭证调用。

生产既有`./scripts/production backup NAME` / `restore NAME --confirm-replace-data`增加私有map归档、diagnostic_details与MySQL中的凭证/权限，使用同一停写窗口与校验和。备份本身含敏感原文，沿用0700目录/0600文件，不能上传普通CI artifact。新恢复要求D5完整归档；旧备份不可凭空恢复缺失源码资料。恢复旧凭证状态可能撤回备份之后的撤销记录，维护者应在恢复后、开放上传前核对并重新撤销/轮换受影响凭证。

隔离恢复测试`node tools/d5-storage-verify.mjs`只操作固定的frontend-insight-m5栈：浏览器先产出合成事件，重启API仍可映射；备份文件/元数据/权限/原始信封，实际删除后观察详情不可用，再恢复并断言第4行第9列与片段；另测缺失、损坏、凭证到期和清理。共享生产源码归档函数，备份不作为CI artifact。执行结果必须查看results，不能因脚本存在就声称成功。

## 6. 发布、手工验收与回滚

顺序：备份 → 配置私有持久卷 → 增量迁移010 → 部署API/consumer/UI → 构建并上传业务制品 → 发布带匹配manifest的应用。Map上传成功不等于已部署JS一致，流水线须保证上传和部署用同一产物。构建输出中的map只交受限上传接口，勿复制到公开CDN。

最短隔离路径：

```bash
pnpm install --frozen-lockfile
pnpm check
M5_ALLOW_NON_ARM64=1 ./scripts/dev bootstrap
./scripts/dev up
./scripts/dev smoke
# project UUID 从管理页获得；FI_SESSION_TOKEN 来自当前隔离管理员登录。
node tools/sourcemaps.mjs issue --api http://127.0.0.1:4173 \
  --project "$PROJECT_ID" --days 1 --credential-file /tmp/lab.sourcemap-credential.json
BUILD_ID=$(node -p "JSON.parse(require('fs').readFileSync('artifacts/d5-build/manifest.json')).build")
node tools/sourcemaps.mjs upload --api http://127.0.0.1:4173 \
  --project "$PROJECT_ID" --release d5-lab-v1 --build "$BUILD_ID" \
  --asset-url http://127.0.0.1:4174/d5/fixture.js \
  --js artifacts/d5-build/fixture.js --map artifacts/d5-build/fixture.js.map \
  --credential-file /tmp/lab.sourcemap-credential.json
pnpm exec playwright install chromium webkit
pnpm exec playwright test -c playwright.diagnostics.config.ts sourcemaps.spec.ts
node tools/d5-storage-verify.mjs
```

1. 演示`http://127.0.0.1:4174/observability?acceptance=fast`模拟登录，点击“D5 压缩源码异常”；默认发到既有演示项目。若为独立测试项目，可附`&d5AppId=<该项目appId>`，并把map上传到同一项目。
2. 管理端登录，选dev/近7天，刷新并筛选release=`d5-lab-v1`；打开实例或场景显示的eventId稳定链接。
3. 原始编译栈仍指向`/d5/fixture.js:1:…`；源码定位应指向自有`examples/sourcemaps/源码场景.ts`第4行第9列，片段含`throw new TypeError(label);`；调用帧定位第7行。文件名可能按构建map显示URI编码。
4. 部分应用框架帧未上传应明确asset_mismatch，不能把整体标成全部成功。查看制品身份，核对CLI返回的两个checksum。
5. 复制源码定位/下载JSON与文本，核对派生标识与原始编译栈；read-only成员不能下载map，撤read/移除成员后已打开页面清空且后续请求拒绝。
6. 使用CLI重复上传幂等；换内容但保留身份409。删除制品后详情仍有编译栈，源码状态deleted；不能使用旧下载地址取回文件。

回滚先停止新manifest发布，再回滚API/UI/consumer；保留增量表与私有卷，不执行reset/seed或删除历史数据。恢复前使用匹配发布版本并核对SQL/归档完整性。旧服务不识别新身份也不能承诺继续映射；基本事实和原始诊断不重写。

Chromium/WebKit是实际浏览器，Firefox仅既有栈fixture。无真实业务源码、无生产故障注入；剪贴板自动化验证授权/内容使用sink，不声称系统剪贴板集成。D6下一步为完整策略/授权设置与运行维护界面，D7负责全路线负载与发布验收。

浏览器列差异：同一第 4 行 `throw new TypeError(label)`，Chromium 固定映射第 9 列（`new`），WebKit 固定映射第 13 列（构造调用）。两者保留各自真实编译列，不人为归一为同一列；CI 分别断言具体位置。
