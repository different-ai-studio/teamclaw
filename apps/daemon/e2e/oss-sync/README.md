# OSS 多节点同步 E2E

2 个真实 amuxd Linux 容器加入同一真实 team，经 cloud FC + 阿里云 OSS 互相同步，验证收敛与冲突处理。

## 前置
- Docker + docker compose
- Node >= 20.6
- **无需测试账号**：harness 每个用例自 signup 一个全新临时 owner（cloud FC 限制"一账号一团队"）。`.env.local` 只需 `CLOUD_API_URL` + 端口（都有默认；`cp .env.local.example .env.local` 即可）。

## 跑
1. 构建镜像（首次 / daemon 源码变更后）：`docker compose build node-a`（多阶段，镜像内编 Linux amuxd，需 `protobuf-compiler`，已在 Dockerfile）。
2. 纯逻辑单测（无需 docker/网络）：`pnpm test:unit` 或 `node --test 'tests/unit-*.test.mjs'`。
3. 默认场景套件（轻量，真实 cloud FC）：`pnpm test:scenarios` 或 `node --env-file=.env.local --test 'tests/[0-9][0-9]-*.test.mjs'`。
4. 单个场景：`node --env-file=.env.local --test tests/01-one-way.test.mjs`。
5. 三节点：`RUN_THREE_NODE=1 ...`（09 基础 / 16 三节点冲突）。
6. **重场景**（多文件 / 多步：10 嵌套多前缀、11 重命名、12 离线追赶、13 删后重建）：`RUN_HEAVY=1 ...`。

### 并发安全（每个用例隔离）
`node --test` 把**每个测试文件**跑在独立子进程里。harness 据此给每个进程分配**唯一 compose
project**（`amuxd-oss-e2e-<pid>-<rand>`，见 `harness/docker.mjs` 的 `composeProject()`）+
**临时 host 端口**（compose 发 `127.0.0.1::8787`，跑完用 `docker compose port` 动态发现），
所以场景**可安全并行**——容器名 / 端口 / `/root/.amuxd` 互不冲突。

- 默认 `pnpm test:scenarios` 按 runner 默认并发（≈CPU 核数）跑;**打 prod cloud.ucar.cc 时建议降并发或串行**以免放大限流:`--test-concurrency=1`(串行)或 `--test-concurrency=2`。
- 对**本地非限流 FC 栈**,并行能大幅加速(尤其重场景)。
- 想用固定 project / 端口调试单个用例:`COMPOSE_PROJECT_NAME=amuxd-oss-e2e-dbg node --env-file=.env.local --test tests/01-one-way.test.mjs`,再 `docker compose -p amuxd-oss-e2e-dbg port node-a 8787` 看端口。

> 历史踩坑:此前所有场景共用固定 project + 固定容器名(node-a/node-b)+ 固定端口
> (18081/18082)+ 共享 `/root/.amuxd`,并行跑必撞("container name already in use" /
> 端口占用 / 共享 daemon.toml 出现重复 `[http]` 致 `load daemon config` 500 / before-hook
> 超时),整套 0 通过。隔离后此问题消除。

## ⚠️ prod FC 限流约束（重要）
cloud.ucar.cc **限流非常激进**。单个场景一拍会发多次 FC 调用（signup + 建 team + 2 invite + 2 claim + 多次 sync，每次 sync 内含 manifest/upload/download 多次调用）。

- **轻量 / 单操作场景**（01/02/03/04/05/06/07/08/09/14/15/17/18）在 prod 上稳定通过。
- **重场景 / 多文件多步**（10/11/12/13、三节点冲突 16）即便 harness + daemon 都加了 429/瞬时错误退避重试，也会因持续限流把单场景拖到数分钟而**超时**——不是 daemon bug，是共享 prod FC 的基础设施约束。故这些场景**默认 skip**，仅 `RUN_HEAVY=1` / `RUN_THREE_NODE=1` opt-in。
- 要可靠跑重场景，应对**非限流后端**：本地 docker 起 `postgres + minio + FC(BACKEND_KIND=postgres)` 栈，把 `CLOUD_API_URL` 指向它。重场景代码本身是对的（与轻量场景同机制），只是 prod 限流跑不动。

## 清理
- 每个用例全新临时 team（`e2e-oss-<ts>`）+ 全新 throwaway owner 账号，跑完 `compose down -v` 销毁容器并 best-effort 移除成员。
- **cloud FC 无删除 team 端点**：临时 team / owner 账号会残留（按时间戳命名便于识别）；OSS blob 按 `teams/<teamId>/` key 前缀隔离，可定期手动清理。

## 已知风险 / 注意
- 真打生产 FC + 真 OSS：有真实写入与少量成本，故非默认 CI，仅手动/按需（`.github/workflows/oss-e2e.yml` 手动触发）。
- 场景 03（并发改）/05（远端删除）是 daemon 两个 bug 修复的回归守卫，断言"修复后正确行为"（改动保留为 sidecar / 删除传播）。
