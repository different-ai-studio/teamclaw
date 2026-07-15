# Token 用量重构：LiteLLM → RDS 直连 → 团队真实用量

> **状态（2026-07-15）：已过时。** 本文以 belayo RDS + 托管 LiteLLM 网关
> (`https://ai.ucar.cc`) 为前提设计，这两者所在的环境均已下线。当前唯一环境是
> self-host 单机栈（LiteLLM 由 `deploy/self-host/docker-compose.yml` 内置，
> FC 经 `http://litellm:4000` 访问；LiteLLM 自己的库建在同一个 Postgres 上）。
> 本文**保留为历史记录**，下文的主机名、库名与部署细节不再适用；现状见
> [`deploy/self-host/README.md`](../../deploy/self-host/README.md) 与
> [`docs/deployment/full-backend-stack.md`](../deployment/full-backend-stack.md)。

> 状态：**研究方案 (RESEARCH / DESIGN)**，待评审后分期实现
> 日期：2026-06-15
> 关联：[[project_litellm_dokploy_deploy]]、[[project_belayo_fc_deploy]]

## 1. 背景与问题

设置页「Token 用量」(`packages/app/src/components/settings/TokenUsageSection.tsx`)
当前读取的是**本工作区本地** `.teamclaw/stats.json`（`useLocalStatsStore`），
所以恒为 0、且只反映单机本地会话，**不是团队真实 AI 用量**。

真实的 AI 用量数据在 LiteLLM 网关 (`https://ai.ucar.cc`)。目标：
**Token 用量页展示「整个团队」从 LiteLLM 来的真实 token 数与费用，可按
当日 / 当周 / 当月 / 当年 切换。**

## 2. 为什么不能只用 LiteLLM HTTP API

实测线上 LiteLLM（开源非企业版）：

| 端点 | 能给什么 | 团队级 token? |
|------|----------|---------------|
| `GET /team/info?team_id=tc-{id}` | 每 key `spend`($)、`max_budget` | ✗ 无 token 数 |
| `GET /global/activity` | 全局 daily `total_tokens`/`api_requests` | ✗ 仅全局，不分团队 |
| `GET /global/spend/logs` | 全局 daily spend | ✗ 不分团队 |
| `GET /spend/logs` | 按 user/model 聚合 spend | ✗ token 字段返回 0 |
| `GET /spend/report`,`/global/spend/report` | 完整报表 | **企业版锁**（403 "Enterprise"） |

结论：**按团队拆分的 token 数，开源版 HTTP API 拿不到。** 费用($)能拿到，
但用户要的是真实 token + 费用 + 按时间范围。

LiteLLM 是开源的，所有原始数据都写在它的 Postgres 表 `LiteLLM_SpendLogs` 里
（每请求一行，含 `team_id` + `total_tokens` + `spend` + `startTime`）。
**直接查库即可绕过企业版限制，拿到任意维度的真实聚合。**

## 2.5 两个 LiteLLM 实例（重要）

| 实例 | 用途 | 部署 | 库 |
|------|------|------|----|
| **`ai.ucar.cc`** | **teamclaw 正式版**（本方案目标） | 裸 docker on host `120.76.243.206`（cn-shenzhen, `vpc-wz99g71s1yy5x7n230l7a`）：容器 `litellm` + `litellm_db`(postgres:16) + `caddy` 反代，compose 在 `/home/admin/docker-compose-litellm.yml` | `litellm_db` 容器内 pg16，库名 `litellm`，user `llmproxy` |
| `ai.service.ucar.cc` | 测试环境 | Dokploy（`deploy/litellm-compose.yml`） | 栈内 `litellm-db` |

**要迁移和接入的是正式版 `ai.ucar.cc`。** 下文「源库」均指
`120.76.243.206` 上的 `litellm_db`。

## 3. 核心约束：网络可达性（已实测）

源库 `litellm_db` 是宿主 docker 容器内的 postgres，**未对公网暴露**
（仅 `5432/tcp` 容器端口，host 未发布）。FC 跑在阿里云 cn-shenzhen，
当前连不到它。

**实测连通性（从 `120.76.243.206` 的 litellm_db 容器）**：
- → belayo RDS **公网** `pgm-wz9e7zgczy2wdp7q.pg.rds.aliyuncs.com`：通，PostgreSQL **18.3**
- → belayo RDS **私网** `pgm-wz9e7zgczy2wdp7qgo.pg.rds.aliyuncs.com`：**也通**
  → **正式 litellm host 与 belayo RDS 同 VPC**，迁移与运行期可全程走内网，
  不必公网暴露。

### 选定方案：把正式版 LiteLLM 的库迁到 belayo RDS，FC 直连

理由：
- FC 已能直连阿里云 RDS（saas-mono `supabase_db` 就在 RDS 上，见
  [[project_belayo_fc_deploy]]）。
- 避免在 Dokploy host 上对公网暴露裸 Postgres 端口（安全更好）。
- 数据集中到 RDS 后，FC 直连查询 = 最简代码、最低延迟、可做任意聚合。
- RDS 有备份/监控/高可用，比 Dokploy 单容器 + 卷更可靠。

备选（本文档不采用，仅记录）：
- A. 对外暴露 litellm-db 端口 + 防火墙白名单 FC 出口 IP —— 代码最简，
  但公网暴露数据库，且 FC 出口 IP 不稳定（FC NAT 可能漂移）。
- B. Dokploy 栈内加一个 stats 微服务（Traefik 路由，master key 鉴权，
  只读聚合 SQL）—— 不暴露库，但多一个服务要运维。
- 若 RDS 迁移暂缓，B 是临时折中。

## 4. LiteLLM 数据模型（关键表）

LiteLLM 用 Prisma 管理 schema。与用量相关的核心表：

### `LiteLLM_SpendLogs`（明细，逐请求一行 —— 我们的主数据源）

| 列 | 类型 | 说明 |
|----|------|------|
| `request_id` | TEXT (PK) | 请求 id |
| `call_type` | TEXT | completion / embedding / image 等 |
| `api_key` | TEXT | 命中的 key 的 hash token |
| `spend` | DOUBLE | 该请求花费($) |
| `total_tokens` | INT | prompt+completion |
| `prompt_tokens` | INT | |
| `completion_tokens` | INT | |
| `startTime` / `endTime` | TIMESTAMP | 用于时间范围过滤 |
| `model` / `model_group` | TEXT | 模型 |
| `team_id` | TEXT | **= `tc-{teamClawTeamId}`（关键关联键）** |
| `user` | TEXT | LiteLLM user id |
| `end_user` | TEXT | |
| `request_tags` | JSONB | |

> `team_id` 写入规则见 FC `admin-handlers.ts` / `team-provisioning.ts`：
> TeamClaw team `X` → LiteLLM team `tc-X`，成员 key
> `sk-tc-{actorId[:40]}`、`key_alias` 形如 `Owner-xxxx` / `member-xxxx`。
> 这意味着我们可同时按 `team_id` 聚合**团队总量**，按 `api_key`/alias 聚合
> **成员明细**。

### `LiteLLM_TeamTable`（团队主数据）
`team_id`、`team_alias`、`max_budget`、`spend`(累计)、`budget_duration`。
用于取团队**预算**与累计 spend（与按时间范围聚合互补）。

### `LiteLLM_VerificationToken`（key 主数据）
`token`(hash)、`key_alias`、`team_id`、`spend`、`max_budget`。
用于把 SpendLogs 的 `api_key` 反查成 `key_alias`（成员展示名）。

> 注：`LiteLLM_SpendLogs` 写入受 `general_settings` 控制。默认开源版会写
> spend logs。**迁移前需确认线上已在记录 SpendLogs**（见 §9 校验）。

## 5. 查询设计（FC 直连 RDS 后）

时间范围由 FC 按服务器时区（建议统一 `Asia/Shanghai`）计算 `[start,end)`：
当日 / 当周(周一起) / 当月 / 当年。

### 团队汇总（总 token + 总费用 + 请求数）
```sql
SELECT
  COALESCE(SUM(total_tokens), 0)       AS total_tokens,
  COALESCE(SUM(prompt_tokens), 0)      AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0)  AS completion_tokens,
  COALESCE(SUM(spend), 0)              AS total_spend,
  COUNT(*)                             AS request_count
FROM "LiteLLM_SpendLogs"
WHERE team_id = $1            -- 'tc-{teamId}'
  AND "startTime" >= $2 AND "startTime" < $3;
```

### 成员明细（按 key/alias）
```sql
SELECT
  s.api_key,
  COALESCE(v.key_alias, left(s.api_key, 10) || '…') AS alias,
  SUM(s.total_tokens) AS tokens,
  SUM(s.spend)        AS spend,
  COUNT(*)            AS requests
FROM "LiteLLM_SpendLogs" s
LEFT JOIN "LiteLLM_VerificationToken" v ON v.token = s.api_key
WHERE s.team_id = $1 AND s."startTime" >= $2 AND s."startTime" < $3
GROUP BY s.api_key, v.key_alias
ORDER BY spend DESC;
```

### 按模型明细（可选，便于成本归因）
```sql
SELECT model_group AS model, SUM(total_tokens) AS tokens, SUM(spend) AS spend
FROM "LiteLLM_SpendLogs"
WHERE team_id = $1 AND "startTime" >= $2 AND "startTime" < $3
GROUP BY model_group ORDER BY spend DESC;
```

### 预算
```sql
SELECT max_budget, spend FROM "LiteLLM_TeamTable" WHERE team_id = $1;
```

**性能**：SpendLogs 行数随用量增长，需索引：
`CREATE INDEX IF NOT EXISTS idx_spendlogs_team_time
   ON "LiteLLM_SpendLogs" (team_id, "startTime");`
（LiteLLM 自带索引不含此组合，迁移到 RDS 后补建。）

## 6. RDS 迁移 Runbook（belayo RDS，已据实测细化）

目标：belayo RDS（cn-shenzhen，PostgreSQL 18.3，与正式 litellm host 同 VPC）。
- 私网 host：`pgm-wz9e7zgczy2wdp7qgo.pg.rds.aliyuncs.com:5432`（运行期用这个）
- 公网 host：`pgm-wz9e7zgczy2wdp7q.pg.rds.aliyuncs.com:5432`（FC 若不在 VPC 用这个）
- 管理账号：`supabase_admin`（实测 `rolcreatedb=t`，可建库）
- 现有库：`rdsadmin / _supabase / supabase_db / postgres`，**无 `litellm`**，干净新建。
> 凭证存运维 vault / `.env.local`，本文档不落明文密码。

源库实测：pg16 容器 `litellm_db`，库 `litellm`，user `llmproxy`，**219 MB**，
`LiteLLM_SpendLogs` **67,373 行**（2026-03-24 → now），含真实 token + `tc-*` team_id。
（数据见 §9 校验结果。）

### 步骤
1. **建库 + 账号**（在 RDS，用 `supabase_admin`，与 `supabase_db` 隔离）：
   ```sql
   CREATE DATABASE litellm;
   CREATE ROLE litellm_app  LOGIN PASSWORD '***';   -- LiteLLM 容器读写
   CREATE ROLE litellm_ro   LOGIN PASSWORD '***';   -- FC 只读查询
   GRANT ALL PRIVILEGES ON DATABASE litellm TO litellm_app;
   ```
2. **网络白名单**：RDS 加白
   (a) 正式 litellm host 私网 `172.17.42.178`（同 VPC，走私网）；
   (b) FC 出口（FC 若同 VPC 用内网地址；否则公网 + FC 固定出口/NAT IP 白名单）。
3. **停写窗口**（短，~分钟级）：`docker stop litellm`（停网关，保 `litellm_db` 在跑做 dump 源）。
4. **数据迁移**（源 pg16 → 目标 pg18，正向兼容）：
   ```bash
   # 在 120.76.243.206 上
   docker exec litellm_db pg_dump -U llmproxy -Fc litellm > /tmp/litellm.dump
   docker exec -i litellm_db sh -c \
     'PGPASSWORD=*** pg_restore --no-owner --role=litellm_app -d \
      "postgresql://litellm_app:***@pgm-wz9e7zgczy2wdp7qgo.pg.rds.aliyuncs.com:5432/litellm"' \
     < /tmp/litellm.dump
   ```
   （或容器内一步 `pg_dump | pg_restore`。Prisma 表名含大小写，用 -Fc 自定义格式最稳。）
5. **切连**：改 `/home/admin/docker-compose-litellm.yml` 的
   `DATABASE_URL=postgresql://litellm_app:***@pgm-wz9e7zgczy2wdp7qgo.pg.rds.aliyuncs.com:5432/litellm`，
   `docker compose -f docker-compose-litellm.yml up -d litellm`（移除 `litellm_db` 依赖）。
   LiteLLM 启动自动跑 Prisma migrate deploy，校验 schema 一致。
6. **只读权限 + 索引**（连 `litellm` 库执行）：
   ```sql
   GRANT CONNECT ON DATABASE litellm TO litellm_ro;
   GRANT USAGE ON SCHEMA public TO litellm_ro;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO litellm_ro;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT TO litellm_ro;
   CREATE INDEX IF NOT EXISTS idx_spendlogs_team_time
     ON "LiteLLM_SpendLogs" (team_id, "startTime");
   ```
7. **验收**：`ai.ucar.cc` 正常出图/对话、新请求写入 RDS 的 SpendLogs
   （`SELECT max("startTime")` 在涨）、FC 用 `litellm_ro` 能 SELECT、
   旧 `litellm_db` 容器可保留观察一段再下线。

### 回滚
迁移前对源卷/或 dump 留存；切连失败把 `DATABASE_URL` 改回
`litellm_db:5432`（或容器名）重启即恢复。保留 `litellm_db` 容器至验收稳定。

## 7. FC 改动

LiteLLM 库与 FC 业务库在**同一 RDS 实例**、只是库名不同（`litellm`）。因此
**不新增连接配置**：复用 FC 既有的 `DATABASE_URL`/`POSTGRES_*`，仅把库名换成
`litellm`（`resolveLiteLlmConnString()`，可选 `LITELLM_DB_NAME` 覆盖、
`LITELLM_DB_URL` 仅作 LiteLLM 库迁到异实例时的逃生口）。
- 新模块 `services/fc/src/lib/litellm-usage.ts`：用 `postgres`(已有依赖) 跑 §5 查询。
  FC 无任何 Postgres 配置时降级（503 `litellm_usage_unavailable`）。
- 连接账号沿用 `DATABASE_URL` 的 `supabase_admin`；已在 RDS 给它 GRANT SELECT
  on `litellm` 库（表归 `litellm_app`）。`litellm_ro` 角色保留供未来收紧权限。

新增端点（OpenAPI 先行，遵循 CLAUDE.md「Cloud API 唯一客户端入口」）：
```
GET /v1/teams/:teamId/litellm/usage?range=today|week|month|year
→ 200 {
    range, startDate, endDate,
    totalTokens, promptTokens, completionTokens,
    totalSpend, requestCount,
    maxBudget,
    members: [{ alias, tokens, spend, requests }],
    byModel: [{ model, tokens, spend }]
  }
  503 litellm_usage_unavailable  // 未配置 LITELLM_DB_URL
```
鉴权：复用现有 bearer + RLS 团队成员校验
（先用 caller token 经 Supabase 校验该 `teamId` 成员身份，再用
`litellm_ro` 查 `tc-{teamId}`）。**不**走 legacy `/ai/usage`（teamSecret）。

落点（对齐现有 `setupLiteLlm` 路径）：
1. `docs/openapi/teamclaw-api.v1.yaml` 加端点。
2. `repository-contract.ts` 加 `getLiteLlmUsage(teamId, range)` 契约 + 测试。
3. `routes/team-litellm.ts` 加 route。
4. `supabase-repo.ts` 实现（成员校验 + 调 `litellm-usage.ts`）。
5. `pg-repo` 同实现或 501。
6. `services/fc/test/` 加路由/契约测试（mock litellm-usage）。

## 8. 客户端改动（packages/app）

1. `lib/backend/types.ts`：加 `LiteLlmUsage` 类型 + backend 方法签名。
2. `lib/backend/cloud-api/teams.ts`（或新 `litellm-usage.ts`）：
   `getUsage(teamId, range)` 调 `GET /v1/teams/:id/litellm/usage`。
3. 新 store/hook：按 current team + range 拉取、缓存、轮询（可选）。
4. **重构 `TokenUsageSection.tsx`**：
   - 去掉 `useLocalStatsStore` 与 `.teamclaw/stats.json` 文案。
   - 顶部加 当日/当周/当月/当年 切换段。
   - 卡片：总费用、总 Token、请求数、预算占比（有 maxBudget 时）。
   - 成员明细表（alias / tokens / spend）。
   - 可选：按模型明细。
   - loading / error / 未开通 LiteLLM(503) 三态。
5. i18n：`zh-CN.json` / `en.json` 更新 `settings.tokenUsage.*`
   （改文案 + 加 range / members / model 键，删 stats.json 相关键）。
6. 保留本地 `local-stats` 用于聊天内 per-message token（`MessageTokenUsage`），
   仅替换设置页的团队汇总来源。

## 9. 校验结果（已在正式库实测 2026-06-15）

1. ✅ **正在写 SpendLogs**：67,373 行，`startTime` 2026-03-24 → 2026-06-15，
   实时在涨。库总 219 MB。
2. ✅ **`team_id` 已落 `tc-*`**，且带真实 token + spend。Top：

   | team_id | rows | spend($) | total_tokens |
   |---------|------|----------|--------------|
   | `tc-tc-NA-68jFUKkuL` | 45,939 | 496.07 | 1,725,902,734 |
   | `tc-0MFXjnHuSxJsMLpCLS4bl` | 17,113 | 110.35 | 780,581,996 |
   | (空 team_id) | 2,826 | 2.66 | 96,343,612 |
   | `tc-p-X3xXu8RY93Wga-xyhft` | 1,229 | 0.03 | 41,807,446 |
   | `tc-tc-shWtgOmI8mLi` | 130 | 1.49 | 10,753,698 |

   **坑 1（双前缀）**：出现 `tc-tc-...`、`tc-p-...` —— FC 一律拼 `tc-{teamId}`，
   说明个别 teamId 本身就是 `tc-NA-...` / `p-X3...`。查询按 FC 实际拼法
   `tc-{teamId}` 精确匹配即可，**不要**额外去前缀。
   **坑 2（空 team_id）**：2,826 行 team_id 为空（master key / 无团队 key 调用），
   团队聚合天然不计入，符合预期；如需归属可按 `api_key` 反查
   `LiteLLM_VerificationToken.team_id`。
3. ✅ **网络**：正式 litellm host(`120.76.243.206`, 私网 `172.17.42.178`)
   与 belayo RDS **同 VPC**，私网+公网均通；FC 已能连该 RDS（belayo 部署在用）。
   `supabase_admin` 有建库权限。
4. ⚠️ **时区**：SpendLogs `startTime` 存 UTC，时间范围按 `Asia/Shanghai`
   计算 `[start,end)` 后转 UTC 再过滤（FC 侧处理）。

## 9.5 实施进度 (2026-06-15)

- ✅ **一次性迁表（开发快照）**：RDS `litellm` 库已建（`supabase_admin`），
  roles `litellm_app`(读写) / `litellm_ro`(只读) 已建，生产 67k 行 SpendLogs 已
  pg_dump→pg_restore 到 RDS（行数对齐），`(team_id,startTime)` 索引已建，
  `litellm_ro` 聚合查询实测通过。**生产 `DATABASE_URL` 未切**（仍写本地
  `litellm_db`），属开发快照；正式上线时再迁一次 + 切连（§6）。
- ✅ **FC 接口**：`GET /v1/teams/:teamId/litellm/usage?range=&date=`（OpenAPI +
  `litellm-usage.ts` + supabase/pg 两 repo + route + 测试）。bearer + 成员校验，
  服务端复用 FC 既有 RDS 连接（同实例、库名换 `litellm`），未配置时 503。
  - **无需新增 FC 配置**：自动从现有 `DATABASE_URL`/`POSTGRES_*` 派生
    （库名 `litellm`，可选 `LITELLM_DB_NAME` 覆盖）。belayo-test 的 FC 本就连
    该 RDS（`DATABASE_URL` 指向 `pgm-wz9e7zgczy2wdp7q...`）。
- ✅ **客户端**：`TokenUsageSection.tsx` 重构——团队真实数据、日/周/月/年切换 +
  时间点前后导航、总费用/总 token/请求数卡片、预算占比条、成员排行榜、按模型明细；
  三态(loading/error/未开通)。i18n 中英对称、parity 测试绿。
- 测试：FC 97 绿（含 computeRange 单测 + usage 路由 + 双 repo 契约）；前端
  i18n-parity 绿、typecheck/eslint 净。

## 10. 分期建议

- **P0（不依赖迁移，可先上）**：FC `/v1/.../litellm/usage` 先用现有
  `/team/info` 出**团队 + 成员 spend($)**（无 token、range 退化为 lifetime），
  前端先把页面切到团队真实费用。快速让页面「不再是 0」。
- **P1（本方案核心）**：迁库到 RDS → FC 直连 → 补齐真实 token + 按
  日/周/月/年 + 成员/模型明细。
- **P2**：按模型成本归因、导出、预算告警。

## 11. 影响与风险

- 迁库有短停写窗口；务必先快照、可回滚。
- FC 多一个出站 DB 依赖（只读，故障时端点降级，不影响其它功能）。
- `litellm_ro` 仅 SELECT，无写权限，降低数据风险。
- SpendLogs 体量增长 → 必须建 `(team_id, startTime)` 索引；长期可考虑
  归档/物化视图做按日预聚合。
