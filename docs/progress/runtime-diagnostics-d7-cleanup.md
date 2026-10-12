# D7 仓库清理记录

基线：refactor `590c17b6e25ff3d002355705a5009a70e5d8473c`。仅处理 Git 跟踪文件，不触碰未提交文件、凭据或运行卷。

## 已实施的移动

根目录 16 个显式调用的阶段 Playwright 配置移至 `tests/config/`，保留文件名与测试范围。默认自动发现的 `playwright.config.ts` 保留根目录。更新 package scripts、所有 workflow、接入指南和维护文档中的命令；相对 testDir 改为从新配置目录指向原测试目录。CLI 从仓库根运行，artifact 的进程工作目录不变。

| 原路径 | 用途/依据 | 处理 | 替代位置 | 验证 |
| `playwright.diagnostics.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.diagnostics.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.production.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.production.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r0.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r0.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r1a.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r1a.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r1b.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r1b.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r1c.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r1c.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r2.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r2.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r3.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r3.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r4a.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r4a.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r4b.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r4b.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r4c.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r4c.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r5a.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r5a.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r5b.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r5b.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r6.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r6.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r7.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r7.config.ts` | Playwright --list / 最终真实 CI |
| `playwright.r8.config.ts` | package script 或对应 workflow 显式 `--config/-c` | 移动，仍生效 | `tests/config/playwright.r8.config.ts` | Playwright --list / 最终真实 CI |

## 检查后保留

| 路径                                                                    | 用途和调用依据                          | 决定/理由                                                        | 验证方式                           |
| ----------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| `.env.m0.example`、`spikes/m0`、`docs/spikes`                           | M0 工作流及历史可复现实验               | 保留；历史基线，不是当前接入说明                                 | workflow 路径与脚本入口核对        |
| `.env.m1.example`、`scripts/m1`                                         | m1-baseline workflow                    | 保留有效历史验证                                                 | bash -n、CI 引用                   |
| `.env.m2-m4.example`、`scripts/m2-m4`                                   | 基础组件 Compose 与旧阶段工作流         | 保留，仍是 dev/生产构建依赖的基础                                | Docker 构建/真实回归               |
| `.env.m5.example`、`infra/compose/m5.compose.yml`                       | scripts/dev、scripts/m7、恢复与负载工具 | 保留公开命令与卷名兼容，不能按 m5 判废弃                         | 隔离部署/恢复                      |
| `scripts/m7`、`tools/m7-*`                                              | R8 故障注入与恢复门禁                   | 保留实际调用入口                                                 | D7 原产品回归                      |
| `.env.example`、`.env.production.example`                               | 当前配置说明/生产脚本                   | 保留示例，不是实际凭据                                           | 配置与生产 CI                      |
| `tsconfig*.json`、`eslint.config.mjs`、`vitest.config.ts`、`.prettier*` | 编译/lint/单测/格式工具约定发现         | 保留根目录入口                                                   | pnpm check                         |
| `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`                 | workspace 安装、生成与构建              | 保留锁定依赖                                                     | 干净 checkout frozen install/build |
| `docs/adr`、`docs/progress`、旧 planning、learning 01–11                | 迁移、决策与阶段验收历史                | 原目录已按用途归档，保留可发现性；当前操作以 README/当前指南为准 | 文档导航检查                       |
| `packages/database/migrations`、契约源和 fixtures                       | 已应用迁移/生成源/测试事实              | 保留，不重写迁移历史                                             | 升级/contract:check/回归           |
| `.github/workflows`、Dockerfile、`.dockerignore`                        | GitHub 自动发现、Docker COPY            | 保留；阶段 workflow 仍可手动复验                                 | CI/容器实际构建                    |

本次 614 个跟踪文件中，未发现可证明与项目无关的日志、截图、压缩包或构建产物；没有为制造删除数量而删除文件。artifacts/dist/node_modules 已忽略。没有新增垃圾归档，也没有全仓改名。历史文档只更新已移动的执行路径，不改写历史验收结论。

## 待验证与疑点

清理结构已实施；最终清理后安装/生成/构建、脚本、双浏览器及部署结果以 D7 results 为准，不能沿用清理前的成功。旧 M0–M4 工程保留独立复现实验用途；若未来决定停止支持这些公开入口，应另批明确下线范围，当前没有删除依据。
