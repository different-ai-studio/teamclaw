# TeamClaw 完整后端系统部署指南

**Audience:** 运维 / 平台 / 后端  
**Status:** Living document — 以仓库内脚本与 `deploy/self-host/` 为准  
**API 契约:** [`docs/openapi/teamclaw-api.v1.yaml`](../openapi/teamclaw-api.v1.yaml)

---

## 1. 后端由哪些部分组成

TeamClaw 的后端不是单一服务，而是一套协作组件。客户端（Desktop / iOS / Mobile）**只通过 Cloud API 访问业务数据**，不直连 Supabase。

```
┌─────────────┐     HTTPS       ┌──────────────────────┐
│   客户端     │ ──────────────► │  Cloud API (FC)      │
│ Desktop/iOS │                 │  services/fc         │
└──────┬──────┘                 └──────────┬───────────┘
       │                                   │
       │ wss/mqtt                          │ 内部 HTTP
       ▼                                   ▼
┌─────────────┐                 ┌──────────────────────┐
│    EMQX     │                 │  Supabase 栈          │
│  MQTT 总线   │                 │  Auth + PostgREST +   │
└──────▲──────┘                 │  Realtime + Storage   │
       │                         └──────────┬───────────┘
       │ mqtt                               │ SQL
       │                                    ▼
┌─────────────┐                 ┌──────────────────────┐
│  amuxd      │                 │  Postgres (amux 库表) │
│  Agent 宿主  │                 └──────────────────────┘
└─────────────┘

可选：
  • 阿里云 OSS — 团队工作区文件同步
  • LiteLLM — AI Gateway / 团队 LLM Key 与用量
  • 定时任务 — OSS 清理、abandon session 等
```

| 组件 | 代码路径 | 职责 | 是否必需 |
|------|----------|------|----------|
| **Cloud API (FC)** | `services/fc/` | 唯一客户端业务入口：`/v1/*` 团队/会话/消息/邀请/bootstrap | **必需** |
| **Postgres + amux schema** | `services/supabase/migrations/` | 业务表、RLS、RPC | **必需** |
| **Supabase Auth (GoTrue)** | self-host 或托管 Supabase | 登录、JWT、refresh token | **必需** |
| **PostgREST + Kong** | self-host 栈 | REST 层；FC 内部 passthrough | **必需**（`BACKEND_KIND=supabase` 时） |
| **Realtime** | self-host 栈 | 部分补偿/订阅（主 live 走 MQTT） | 推荐 |
| **Storage** | self-host 栈 | 附件 bucket | 推荐 |
| **EMQX** | self-host 栈 / 独立部署 | Session 内实时消息 | **必需** |
| **Caddy / 反向代理** | self-host 栈 | TLS、域名路由 | 生产必需 |
| **阿里云 OSS** | FC 环境变量 | 团队 share / 工作区同步 | 可选（无则 sync 不可用） |
| **LiteLLM** | 独立服务 | `POST /v1/teams/:id/litellm/setup`、用量统计 | 可选 |
| **amuxd** | `apps/daemon/` | Agent 运行时；通常跑在用户设备而非中心机房 | 按场景 |
| **Cron** | FC timer / compose profile | OSS GC、abandon sessions | 推荐 |

---

## 2. 两条主流部署路径

### 路径 A：Self-Host（Docker Compose 一键栈）

**适用：** 私有部署、验收环境、完整可控栈。  
**启动文档（详细）：** [`deploy/self-host/README.md`](../../deploy/self-host/README.md)

```bash
cd deploy/self-host
cp .env.example .env
# 填写 JWT_SECRET、POSTGRES_PASSWORD、五个域名
# 本地 Podman/macOS：CADDY_TLS_MODE=off
./bootstrap/gen-secrets.sh
./bootstrap/up.sh          # 推荐；Podman 必需
# Docker Desktop 也可：docker compose up -d
```

**Podman 本地访问：** Caddy `http://api.example.com:8080`，FC 直连 `http://127.0.0.1:9000`。

**CI 自动部署：** push 到 `main` 且改动 `deploy/self-host/**`、`services/fc/**`、`services/supabase/migrations/**` 时，`.github/workflows/self-host-deploy.yml` 会 SSH 到 ECS 重建 FC 并跑 E2E。

### 路径 B：阿里云生产（拆分托管）

**适用：** 当前 ucar / belayo 生产形态 — 各组件独立运维。

| 层 | 典型形态 |
|----|----------|
| 数据库 | 阿里云 RDS Postgres（库名 `supabase_db`，schema `amux`） |
| Supabase | 自建 Docker 栈或 saas-mono，Kong 对外 |
| Cloud API | 阿里云 Function Compute `teamclaw-sync`（`services/fc/s.yaml`） |
| MQTT | 独立 EMQX 或与 self-host 相同模式 |
| LiteLLM | 独立 Docker（如 `ai.ucar.cc`） |
| OSS | 阿里云 RAM + Bucket |

**FC 手动部署脚本：** `services/fc/deploy-aliyun-fc.sh`（默认拒绝部署到 `teamclaw-sync`，需 `FORCE=1`）。

**Schema 迁移（test → live）：** `services/supabase/s4/BELAYO-LIVE.md`

> **注意：** `services/fc/**` 合入 `main` **不会**自动更新 FC 生产函数。部署 FC 需走当前团队约定的发布流程（Serverless Devs / 手动脚本 / 自托管 compose rebuild）。

---

## 3. 部署前准备清单

### 3.1 基础设施

- [ ] **域名与 DNS**：至少 5 个子域（FC / Supabase / MQTT / Studio / EMQX Dashboard），或 self-host 使用 `CADDY_TLS_MODE=internal` 做本地验收
- [ ] **TLS**：Let's Encrypt（`acme`）或内网 CA（`internal`）
- [ ] **Postgres 15+**：Self-host 用 Supabase fork 镜像；生产可用 RDS
- [ ] **出站网络**：FC 需访问 Supabase、MQTT、OSS；若在 VPC 内需配置 `s.yaml` 中的 `vpcConfig`
- [ ] **端口**：Self-host 仅 Caddy 暴露 80/443

### 3.2 密钥与账号

| 变量 / 凭证 | 用途 |
|-------------|------|
| `JWT_SECRET`（≥32 字符） | Supabase + EMQX JWT 共用；Self-host 一切 derived key 的根 |
| `POSTGRES_PASSWORD` | 数据库 superuser |
| `ANON_KEY` / `SERVICE_ROLE_KEY` | Supabase API；可由 `gen-secrets.sh` 派生 |
| `ACCESS_KEY_ID` / `ACCESS_KEY_SECRET` | 阿里云 OSS + FC 部署 AK |
| `ROLE_ARN` | OSS STS 扮演角色 |
| `MQTT_SERVICE_TOKEN` | FC 连 EMQX 的服务 JWT |
| `PUSH_WEBHOOK_SECRET` | 推送 webhook 校验 |
| `APNS_*` | iOS 推送（生产必需则填真实值） |
| `CRON_TRIGGER_SECRET` | Self-host cron profile |
| `LITELLM_MASTER_KEY` | 团队 LiteLLM 开通 |
| `AUTH_SECRET` | Better Auth（phone/OAuth 等，FC env） |

### 3.3 数据库 Schema

**新库（空 Postgres）：**

```bash
# 一次性 baseline
psql "$DATABASE_URL" -f services/supabase/migrations/20260601000000_baseline.sql
```

**已有生产库（历史 incremental）：** 不要重跑 baseline，只应用 baseline **之后**的新文件（见 [`services/supabase/migrations/README.md`](../../services/supabase/migrations/README.md)）。

**Self-host：** `migrate` 容器自动跟踪 `public.schema_migrations`，幂等。

**PostgREST 必须包含 `amux`：**

```dotenv
PGRST_DB_SCHEMAS=public,storage,graphql_public,amux
```

belayo live 迁移后还需在 RDS 执行 grant + `NOTIFY pgrst, 'reload schema'`（见 `BELAYO-LIVE.md`）。

---

## 4. 分组件部署步骤

### 4.1 Supabase 栈

Self-host 已打包：`db`、`auth`、`rest`、`realtime`、`storage`、`kong`、`studio` 等。

**关键配置：**

- 内部 URL：`SUPABASE_URL=http://kong:8000`（FC 容器内）
- 对外 URL：`SUPABASE_PUBLIC_URL=https://${SUPABASE_DOMAIN}`
- GoTrue SMTP：默认 placeholder，真实邮件需配置 SMTP
- Storage：依赖 `imgproxy`；附件 smoke 见 `deploy/self-host/smoke/image-upload.sh`

**托管 / saas-mono 额外步骤（若从旧环境迁移）：**

1. 确认 `public.users` 有 `auth_user_id`、`org_id` 及 `ensure_personal_org` 依赖的索引
2. `public.claim_team_invite` RPC 存在
3. JWT secret 与 FC / EMQX 一致
4. GoTrue custom access token hook（若托管方支持）：`amux_access_token_hook`

### 4.2 Cloud API (FC)

**构建与运行：**

```bash
cd services/fc
npm install
npm run build
# Self-host: docker compose build fc
# Aliyun: ./deploy-aliyun-fc.sh <function-name> .env.xxx.local
```

**核心环境变量**（完整列表见 [`services/fc/s.yaml`](../../services/fc/s.yaml)）：

| 变量 | 说明 |
|------|------|
| `BACKEND_KIND` | `supabase`（默认）或 `postgres` |
| `SUPABASE_URL` | FC → Kong 内部地址 |
| `SUPABASE_PUBLIC_URL` | 返回给客户端的 Supabase 公网 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | FC 服务端操作 |
| `SUPABASE_ANON_KEY` | Auth proxy |
| `MQTT_BROKER_URL` | FC 发布 MQTT ping |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | 服务账号 |
| `DATABASE_URL` | `BACKEND_KIND=postgres` 或跑 migration 时用 |
| `AUTH_BASE_URL` | OAuth / Better Auth 对外 base（默认 `https://cloud.ucar.cc`） |

**定时触发器（Aliyun FC）：** `s.yaml` 内已配置 OSS abandon / GC cron；Self-host 用 `--profile cron`。

### 4.3 EMQX

- 认证：**HS256 JWT**，密码字段传 Supabase session JWT 或 `MQTT_SERVICE_TOKEN`
- `EMQX_JWT_SECRET` = `base64(JWT_SECRET)`（`gen-secrets.sh` 自动处理）
- 对外：`wss://${MQTT_DOMAIN}/mqtt`（Caddy 反代 8083）
- 对内：`mqtt://emqx:1883`

客户端 bootstrap：`GET /v1/config/bootstrap` 返回 broker URL 与连接参数。

### 4.4 阿里云 OSS（团队同步）

在 FC 环境配置：

```dotenv
ACCESS_KEY_ID=...
ACCESS_KEY_SECRET=...
ROLE_ARN=acs:ram::...:role/teamclaw-oss
BUCKET=teamclaw-team
REGION=cn-shenzhen
ENDPOINT=https://oss-cn-shenzhen.aliyuncs.com
```

未配置时 FC 正常启动，**团队工作区 OSS 同步不可用**。

### 4.5 LiteLLM（可选 AI Gateway）

- FC 通过 `LITELLM_URL` + `LITELLM_MASTER_KEY` 调用 LiteLLM Admin API
- 团队开通：`POST /v1/teams/:id/litellm/setup`
- Token 用量：FC 直连 RDS 上 `litellm` 库（`LITELLM_DB_NAME`），见 [`docs/specs/2026-06-15-litellm-token-usage-rds-design.md`](../specs/2026-06-15-litellm-token-usage-rds-design.md)

Self-host `.env` 示例：

```dotenv
LITELLM_URL=https://ai.example.com
LITELLM_MASTER_KEY=sk-...
```

### 4.6 amuxd（Agent 宿主）

**通常不在中心后端部署**，而是：

- Desktop 安装包自带 + launchd/systemd 服务
- Self-host 可选：`docker compose --profile daemon up -d --build amuxd`
- 开发机：`scripts/deploy-daemon.sh`

Daemon 需要：

1. 有效的 team invite token（`./amuxd/mint-invite.sh`）
2. Cloud API URL（bootstrap 拉 MQTT）
3. LLM 端点（`OPENCODE_*`）才能跑 agent session

---

## 5. 客户端对接

桌面 / iOS 构建时 baked 的 Cloud API 地址来自 `build.config.production.json`：

```json
{
  "cloudApiUrl": "https://api.teamclaw-dev.ucar.cc"
}
```

| 环境 | 典型 URL |
|------|----------|
| 生产（legacy） | `https://cloud.ucar.cc` |
| 生产（当前 build config） | `https://api.teamclaw-dev.ucar.cc` |
| Self-host | `https://${FC_DOMAIN}` |

**发布桌面版前：** 若 Cloud API 有 breaking 变更，需先部署 FC + migration，再发客户端。见 [`docs/release/desktop.md`](../release/desktop.md)。

Web 开发可覆盖：`VITE_CLOUD_API_URL=...`

---

## 6. 推荐部署顺序

适用于**从零搭建**或**版本升级**：

```
1. Postgres + 跑 migration（baseline 或 incremental）
2. Supabase 栈（Auth / REST / Realtime / Storage）
3. 确认 PostgREST 已加载 amux schema
4. EMQX + JWT 认证配置
5. 部署 Cloud API (FC)，填入 Supabase / MQTT / OSS env
6. Caddy / 域名 / TLS
7. Smoke：healthz → bootstrap(401) → auth → create team
8. （可选）LiteLLM、OSS cron、daemon profile
9. 更新客户端 cloudApiUrl 并验证端到端
```

**FC 与 DB 顺序：** `deploy-aliyun-fc.sh` 在 `DATABASE_URL` 存在时会先跑 `services/supabase/migrations/*.sql`（跳过 baseline），再 `s deploy`。

---

## 7. 验收与监控

### 7.1 Health / Smoke

**Self-host：**

```bash
# FC
docker compose exec -T fc node -e "fetch('http://localhost:9000/healthz').then(r=>r.text()).then(console.log)"

# 公网
curl -s https://${FC_DOMAIN}/healthz

# E2E 套件
cd services/fc && sh ../../deploy/self-host/smoke/run-e2e.sh

# Storage
./smoke/image-upload.sh
```

**生产 Canary（GitHub Actions）：** `.github/workflows/prod-canary.yml` 每 30 分钟探测：

- `GET /v1/config/bootstrap` → 401
- `POST /register` → 400
- `POST /token` → 400

### 7.2 SQL 验收（amux）

```sql
SELECT count(*) FROM information_schema.tables
 WHERE table_schema='amux' AND table_type='BASE TABLE';  -- 期望 ~37

SELECT count(*) FROM pg_policies
 WHERE schemaname='amux' AND policyname='teams_org_guard';  -- 期望 1
```

### 7.3 业务 Smoke（REST via amux profile）

```bash
curl -sS "https://${SUPABASE_DOMAIN}/rest/v1/teams?select=id&limit=1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Accept-Profile: amux"
```

### 7.4 FC 单元 / 集成测试

```bash
cd services/fc && npm test
cd services/supabase && npm test   # pgTAP（若已配置）
```

---

## 8. 运维与常见问题

| 现象 | 排查方向 |
|------|----------|
| 客户端报 schema 过旧 / `disable_team_share` | FC 与 Supabase migration 未同步部署 |
| MQTT 连不上 | 检查 `MQTT_PUBLIC_BROKER_URL`、Caddy WS 路由、JWT secret 一致性 |
| PostgREST 404 on `amux.*` | `PGRST_DB_SCHEMAS` 缺 `amux` 或未 reload |
| LiteLLM 503 `litellm_unavailable` | `LITELLM_MASTER_KEY` 未配置 |
| OSS sync 失败 | RAM 角色、`ROLE_ARN`、Bucket 权限 |
| Agent 不在线 | amuxd 未运行 / 未 claim invite / 需重启 daemon 重新 advertise |
| 部署成功但 API 异常 | 参考 prod-canary；检查 FC memory/cpu、env 是否完整 |

**日志：**

- Self-host：`docker compose logs -f fc`、`emqx`、`auth`
- FC Aliyun：函数计算控制台日志 / `s logs`

**回滚：**

- Self-host：`docker compose down`（加 `-v` 清数据）
- Schema：`services/supabase/s4/belayo-live.sh rollback`（仅 amux + claim RPC）

---

## 9. 相关文档索引

| 文档 | 内容 |
|------|------|
| [`deploy/self-host/README.md`](../../deploy/self-host/README.md) | Self-host 完整操作手册 |
| [`services/fc/s.yaml`](../../services/fc/s.yaml) | FC 环境变量权威列表 |
| [`services/fc/deploy-aliyun-fc.sh`](../../services/fc/deploy-aliyun-fc.sh) | 阿里云 FC 手动部署 |
| [`services/supabase/migrations/README.md`](../../services/supabase/migrations/README.md) | Migration 策略 |
| [`services/supabase/s4/BELAYO-LIVE.md`](../../services/supabase/s4/BELAYO-LIVE.md) | test → live schema 克隆 |
| [`docs/architecture/v2.md`](../architecture/v2.md) | 架构总览 |
| [`docs/openapi/teamclaw-api.v1.yaml`](../openapi/teamclaw-api.v1.yaml) | API 契约 |
| [`CLAUDE.md`](../../CLAUDE.md) | FC 端点与版本发布约定 |

---

## 10. 最小可用 vs 完整能力对照

| 能力 | 最小部署 | 完整部署 |
|------|----------|----------|
| 登录 / 团队 / 会话 / 消息 | Supabase + FC + EMQX + migration | 同左 |
| 实时聊天 | EMQX | EMQX |
| 附件 | + Storage | + Storage |
| 团队文件同步 | + OSS + cron | + OSS + cron |
| AI Gateway / 用量 | + LiteLLM + RDS litellm 库 | 同左 |
| iOS 推送 | + APNS 全套 env | 同左 |
| 中心机房 Agent | + amuxd daemon profile | 同左 |
| Apps 模块 FC 运行时 | + `APPS_DB_ADMIN_URL`、CodeUp 等 | 见 apps specs |

**最小 Self-host 四步：** `.env` → `gen-secrets.sh` → `up.sh` → `curl http://127.0.0.1:9000/healthz`（或 `:8080` 经 Caddy）。
