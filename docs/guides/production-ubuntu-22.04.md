# Ubuntu 22.04 单机生产部署

适用分支：`agent/v1-8-r7-settings`。本次部署适配不表示 R6 已手工验收、R7 异常规则已获批准，或已经部署到真实服务器。真实环境启用前仍由 Owner 确认发布范围。

## 目标机器与容量

2026-10-08 提供的主机：Ubuntu 22.04.4、Linux 5.15、amd64、8 核、Docker 27.3.1、Compose 2.32.2，Docker 可见内存 16,692,449,280 字节（15.55 GiB），采样可用内存 11.11 GiB，所检查文件系统空闲 42.15 GiB。

不要求安装或降级宿主 Node/pnpm。镜像内使用 Node 24 和 pnpm 11.15.1，数据库继续沿用 MySQL 8.4、ClickHouse 25.8、Kafka 4.1.1。生产入口是 `scripts/production`；不要使用有 Apple Silicon 门禁和重置操作的 `scripts/dev`。

容量预检读取当前 Docker daemon，而不是把宿主内存与远程 daemon 混为一谈：至少 15 GiB 可见总内存，允许标称 16 GiB 主机的内核保留差额；不计 swap。仓库与可见 Docker 数据目录分别要求 20 GiB 空闲。主要常驻容器内存上限合计 9.875 GiB，构建、迁移、系统及其他业务另占资源。低于 11 GiB 可用内存会提示检查共享负载，已有运行实例的内存不能再作为首次部署空闲量解读。不能以 `FI_ALLOW_CONSTRAINED_HOST=1` 作为生产部署解决方案。

本入口使用本机 Unix socket Docker；远程 TCP/SSH Docker context 不支持文件型 secret 自动传输。确认当前 context 与目标机器一致。镜像仓库及 npm 下载必须可达；下载超时应处理公司代理/镜像源，不直接降依赖版本。当前脚本在目标机构建，不声称已经支持离线镜像发布。

## 首次部署

在正确的仓库根目录执行，先确认提交和本地改动，不要重置已有工作区：

```bash
git status --short
git rev-parse HEAD
sudo bash scripts/production init-secrets --confirm-create
sudo bash scripts/production doctor
```

`init-secrets` 只创建一次，已有完整或部分文件都拒绝覆盖。密钥目录为 `.secrets/production`，root 所有、700；六个文件为 root:10001、440。应用仍是非 root 的 node 用户，通过附加 GID 10001 读取授予自己的文件。目录在宿主上不开放遍历；不要 chmod 777 或将密钥内容贴到日志。`.dockerignore` 排除 `.secrets`、`.runtime` 和 `backups`，它们不会进入镜像构建上下文。

也可使用仓库外密钥目录，但每个运维命令都必须显式传入相同的 `FI_SECRETS_DIR`，例如 `sudo FI_SECRETS_DIR=/etc/frontend-insight/secrets bash scripts/production doctor`。不要把密钥放到仓库内任意其他目录。file secret 的所有权来自宿主文件，不能仅靠 Compose 的 uid/gid/mode 声明修复。

检查自动生成的 `.env.production` 中端口、限流与 Kafka 保留期；不要放入密码。首次发布建议使用包含提交短 SHA 的唯一发布名，避免覆盖回滚镜像：

```bash
sudo bash scripts/production deploy "r7-$(git rev-parse --short=12 HEAD)"
sudo bash scripts/production bootstrap-admin
sudo bash scripts/production verify
sudo bash scripts/production status
```

`deploy` 先构建，再以真实非 root 容器用户检查 secret 可读性，随后启动数据库、迁移、API/consumer/web 并检查就绪。`bootstrap-admin` 交互输入邮箱、显示名和密码，密码不回显；复用已有管理员创建逻辑，数据库必须尚无用户，不会写入演示项目、测试账号或审批 fixture。密码至少 12 字符且 UTF-8 不超过 72 字节。已初始化环境不要重复创建，也不要用此命令重置密码。

受控自动化可以通过 stdin JSON 提供 `email`、`displayName`、`password`：`sudo bash scripts/production bootstrap-admin --stdin-json < /受控路径/admin.json`。该文件应限制权限并由操作者在使用后安全清理；不要将密码写入命令行、环境变量或仓库。并发初始化使用 MySQL advisory lock 串行化；重复调用明确拒绝且不改旧密码。

## 已有密钥与已有数据库

已有旧版 root:root/600 密钥时不要重新生成，执行：

```bash
sudo bash scripts/production secure-secrets --confirm-permissions
sudo bash scripts/production doctor
```

这个命令只改目录/文件权限与所有权，不改密钥值，也不会改变数据库内密码。已有数据卷必须继续使用原密钥。若曾在密钥目录未排除时构建镜像，应由环境 Owner 检查镜像流转范围，并在维护窗口制定密钥轮换方案；本次不会自动轮换数据库密码或登录签名密钥。

这是同一 v1.8 数据库基线上的追加部署指南；不得把更早、非兼容数据库挂回后通过删卷“解决”迁移问题。已有业务数据升级先备份并检查当前版本，严禁运行 `scripts/dev reset`、`down -v` 或生产 `synthetic` 作为初始化流程。

## HTTPS 与接入

Compose 只在 `127.0.0.1:4173` 暴露 Web，API/consumer 调试端口也仅在回环地址。外部通过运维管理的 HTTPS 反向代理访问 Web。生产刷新 Cookie 固定 Secure/HttpOnly；不能用关闭 Secure 来掩盖 HTTP 部署错误。

宿主 Nginx 中的示例（替换域名和实际证书路径，并按公司规范接入现有日志策略）：

```nginx
server {
    listen 443 ssl;
    server_name insight.example.com;
    ssl_certificate /etc/nginx/certs/insight/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/insight/privkey.pem;
    # 外层代理同样不能记录 query、header 或完整 request。
    access_log off;
    error_log /dev/null;
    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

若外层 Nginx 在另一个容器中，127.0.0.1 指向的是该代理容器，需由运维显式配置共享网络或宿主访问地址，不能直接照搬宿主配置。

通过 HTTPS 登录、刷新页面与会话，再在入口创建真实项目。项目允许 Origin 应包含被监测业务系统的精确 Origin；设置页的测试按钮从管理站发请求，测试时也需允许管理站 Origin。按设置页生成的当前 SDK 示例和 CSP 配置接入，确认“已接收 → 异步入库 → 可查询”，仅有 HTTP 202 不表示落库成功。

## 验证与问题定位

新增 `production-deployment.yml` 使用 Ubuntu 22.04、真实生产 Compose、root 初始化密钥、非 root/只读应用容器和真实 MySQL/Kafka/ClickHouse，验证：

- 目标内存值与边界；旧密钥权限迁移不改值；重复生成拒绝；真实读取失败 fixture 和修复。
- 应用/Web 所有镜像层均不含实际 CI 密钥、密钥/备份/状态目录。
- 无测试数据的首次管理员初始化、重复拒绝。
- 隔离自签名 HTTPS 代理上的 Chromium/WebKit 登录、Secure Cookie 刷新、真实 SDK 与测试事件入库查询。
- 停止后保留卷重新部署，账号、项目和事件仍可查询。

与 R7 全套回归分别保留证据，不能把开发栈成功代替生产验证。CI 的 Docker/Compose 实际版本另行记录；不声称它与目标机版本完全一致。CI 自签名证书仅用于隔离测试，目标机真实证书、网络、容量、备份恢复及生产负载仍需环境验证。最新执行结果见 R7 results，运行未通过时不得视为可部署交付。

若失败，保留失败阶段和脱敏错误，采集：

```bash
sudo bash scripts/deployment-info > deployment-info.txt
sudo bash scripts/production status
```

不要上传 `.env.production`、secret 文件、完整 inspect/config 或未审查的全部日志。`doctor` 仅为预检，完整部署成功仍需 `deploy`、`verify` 与浏览器链路验证。
