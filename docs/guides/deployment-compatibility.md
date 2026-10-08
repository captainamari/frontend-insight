# 部署兼容性信息采集

在部署机器的仓库目录执行：

```bash
umask 077
bash scripts/deployment-info > deployment-info.txt
```

默认检查 Compose 项目 `frontend-insight-production`。若检查 Mac 本地验收栈，使用 `bash scripts/deployment-info frontend-insight-m5`。脚本不安装、升级、降级、拉取镜像、启动或停止容器，不需要 sudo。没有 Docker 或无访问权限时记录 unavailable 后继续。Linux 有 timeout 时单个外部命令最多15秒；其他系统连接失效时可以 Ctrl-C。输出是执行该命令的主机和当前 Docker daemon 信息，二者可能不是同一机器。

提供输出文件、实际部署命令、出错阶段（安装 Docker／构建镜像／启动容器／运行应用）和原始报错的脱敏片段。不要提供 `.env`、secret 文件、完整 `docker inspect`、完整 `docker compose config` 或全部日志。脚本已经只选择内核、架构、CPU 指令、资源、Docker/Compose 版本、cgroup、存储驱动、镜像平台和退出状态等字段，不读取容器环境或日志。

## 本仓库实际依赖边界

| 环节             | 当前实现                                                | 判断方式                                                                                        |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 生产入口         | `bash scripts/production deploy <release-id>`           | Docker Compose 插件；没有 Apple Silicon 限制；16 GiB级主机（daemon可见≥15 GiB）、20 GiB空闲空间 |
| Mac 本地验收入口 | `scripts/dev`                                           | 默认限制 Apple Silicon；报架构门禁不是容器内依赖不兼容                                          |
| 应用构建/运行    | `node:24-alpine`，镜像内 pnpm 11.15.1                   | 生产脚本不在宿主执行 pnpm install；宿主缺 Node/pnpm 不应阻挡该路径                              |
| Web 构建/运行    | Node 镜像构建，`nginx:1.29-alpine`运行                  | 前端构建版本与宿主 glibc 版本不能混为一谈                                                       |
| 数据服务         | MySQL 8.4、ClickHouse 25.8、Kafka 4.1.1                 | 需结合具体镜像平台、CPU、内核、资源与容器报错核实                                               |
| Compose 参数     | `up --wait --wait-timeout`、健康依赖、secrets、资源限制 | 仅显示“Compose v2”不足以证明支持所有参数；需实际版本和错误                                      |

先定位不兼容发生在哪一层，再选择升级运行时、调整构建目标或替换兼容镜像。不要先统一降低 package.json 的版本；数据库也不能简单换低版本镜像后挂回已有数据卷。任何兼容改动须验证保留升级和本项目真实服务门禁。

Docker 封装应用及用户态依赖，但 Linux 容器仍使用 Docker daemon 所在系统的内核，并依赖对应 CPU 架构；Mac Docker Desktop 的 daemon 在 Linux VM 内。因此 Docker 无法自动解决所有内核、CPU 指令、镜像架构、运行时或资源问题。

参考官方说明：[容器与虚拟机](https://docs.docker.com/get-started/docker-concepts/the-basics/what-is-a-container/)、[多平台镜像](https://docs.docker.com/build/building/multi-platform/)。2026-10-08 已收到 Ubuntu 22.04 主机诊断，尚无具体失败命令/错误。已识别生产脚本内存门槛、密钥权限与构建隔离问题，修复与操作见 [Ubuntu 22.04 生产部署](production-ubuntu-22.04.md)。不能据此判断运维人员能力，也不能承诺“降依赖”就是正确修复。
