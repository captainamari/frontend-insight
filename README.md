# Frontend Insight

内部 Web 产品运营分析系统。它回答页面和功能是否真正被看见、持续使用，关键任务是否完成，以及停留和操作耗时是否符合显式业务目标；同时明确区分账号、匿名浏览器和会话。

v1.8 使用 contract v3 和版本化指标服务。登录后进入全部项目，项目内只有项目概览、业务分析、页面分析、指标管理和设置五个正式模块。运营分数与质量分数独立，缺失事实与真实零值分开；SDK 当前部署版本 0.8.0。

## 本地快速开始

Apple Silicon Mac + Docker Desktop/Compose v2，使用可销毁测试环境：

```bash
./scripts/dev doctor
./scripts/dev bootstrap
./scripts/dev up
./scripts/dev smoke
./scripts/dev status
```

- 管理后台：<http://127.0.0.1:4173>
- 受控 demo：<http://127.0.0.1:4174>
- 测试管理员：`admin@example.invalid` / `LocalAdmin-1234`
- 测试 viewer：`viewer@example.invalid` / `LocalViewer-1234`

完整命令、十二步走查、失败排查见 [v1.8 Mac 验收指南](docs/guides/v1.8-local-acceptance-macos.md)。`./scripts/dev down` 保留卷；`./scripts/dev reset --confirm-local-data-loss` 只用于已确认可删除的本地测试数据。不要对生产运行 reset、seed 或故障注入。

## Ubuntu 22.04 生产部署

按 [生产指南](docs/guides/production-ubuntu-22.04.md) 配置容量、独立密钥、管理员及 HTTPS，不使用测试 seed 或演示账户，不要求宿主 Node 26。

```bash
sudo bash scripts/production init-secrets --confirm-create
sudo bash scripts/production doctor
sudo bash scripts/production deploy "r8-$(git rev-parse --short=12 HEAD)"
sudo bash scripts/production bootstrap-admin
sudo bash scripts/production verify
```

已有密钥只迁移权限、不改值；已有数据卷保留，升级前按指南备份。R8 备份格式包含原始事件及长期重复操作证明，短引用不备份。目标 Docker/Compose 与 CI 的版本差异及未实测项目在结果中明确记录。

## 产品和工程边界

- 指标管理发布不可变运营/质量版本、受控公式、分数、绑定和血缘；正式分析页面复用同源读模型。
- 工作流支持显式实例关联、并发、乱序、首个终态与近似超时；不使用业务敏感 ID。
- 页面质量/运营分别保留安全复现上下文、真实分母、匿名兜底、时区/DST/会话及有效时长覆盖。
- 设置收拢项目/成员/Origin、实际 SDK 接入、探针策略和受限外部凭证；第三方接口默认关闭，凭证仅一次明文。
- 异常规则真实管理层/安全批准尚待完成，multi_ip 与 permission_denied 缺可信事实；保持关闭/不可计算，不以测试审批代替。
- 旧功能采用、页面访问、运营概览和接入等入口已移除；历史验收记录保留在 docs，不作为当前操作说明。

R6 朋友验收、R8 统一手工验收和 R7 真实业务批准仍须独立完成；不能因 CI 通过就宣布最终 Go。

## 开发者自检

不启动容器可以执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm exec playwright install chromium webkit
pnpm test:browser
```

当前 v1.8 只提供“全部项目 → 项目概览、业务分析、页面分析、指标管理、设置”正式入口。旧页面路由与专用 API 已移除。

```bash
pnpm check
pnpm test:r8:e2e
```

完整回归由 `.github/workflows/v1-8-r8.yml` 执行 R1–R7、真实 SDK/存储、双浏览器、性能、隐私、负载与故障恢复；Ubuntu 22.04 生产 Compose 独立验证。执行方法见 [v1.8 最终 Mac 验收](docs/guides/v1.8-local-acceptance-macos.md) 和 [Ubuntu 生产指南](docs/guides/production-ubuntu-22.04.md)。当前工程/自动化/手工验收/业务批准分别见 [R8 results](docs/progress/v1.8-r8-results.md)。Linux CI 不能替代目标 Mac、目标服务器或真实规则批准。
