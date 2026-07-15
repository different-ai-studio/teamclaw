# Apps 模块第二期(第一块):per-app 凭证投递 + 状态回写

- **Date**: 2026-06-14
- **Status**: Approved design, ready for implementation planning
- **Branch**: `agent/apps-module`(承接第一期同分支)
- **依赖**: 第一期 apps 骨架(`docs/specs/2026-06-14-apps-module-design.md` + `-phase1-plan.md`)

## 1. 背景与目标

第一期建好 app 后,链路卡在最后一步:建 app → FC 建**私有** CodeUp 仓 → 桌面踢
daemon `POST /v1/apps/seed` → daemon 克隆+推**但没有 git 凭证 → 私有仓推送失败**。
同时 `apps.provision_status` 的 `seeding`/`ready` 是死状态(无人写回)。

本块目标:让第一期骨架**真正端到端跑通** ——

1. **凭证投递**:daemon 播种时拿到能推送托管仓的 git 凭证。
2. **状态回写**:app 的 `provision_status` 在播种过程中如实流转到 `ready`/`error`,
   UI 可见。
3. **重试**:失败/未播种的 app 能再次触发播种。

### 关键事实(设计依据)

- managed-git 的"凭证"是 FC 环境里的**静态组织级 bot PAT**(`CODEUP_PAT`,配合
  `CODEUP_BOT_USERNAME`,形如 `teamclaw:<pat>`),所有 team/app 的托管仓**共用一个**
  ——不是每仓一个 token。`handleManagedGitCreateRepo` 已经返回它(`{repoHttpUrl, pat,
  botUsername}`),第一期 `provisionAppRepo` 拿到后**丢弃**(只写 `git_remote_url`)。
- daemon 已能反向调用 FC `/v1/...`(`apps/daemon/src/backend/cloud_api/mod.rs` 的
  `post`/`patch_no_content`,带 daemon actor 的 bearer)。
- daemon git 引擎 `seed_app_repo(workdir, remote_url, template_dir, token)`(第一期
  C2)已接受可选 token,内部 `embed_token_in_url` 把 `username:token` 嵌进 https URL。
- RLS `apps_update_if_creator` 只放行 app 创建者更新;daemon 的 actor ≠ 创建者,
  故 daemon **不能**直接写 `provision_status`(会被 RLS 挡)→ 状态回写必须由持有创建者
  bearer 的桌面来做。
- 现有 `seedDaemonApp`(`packages/app/src/lib/daemon-local-client.ts`)返回 `boolean`
  (true=成功/false=不可达或失败),conflate 了"不可达"与"推送失败"。

### 设计决策

- **凭证 = daemon 实时拉取**(非桌面中转):PAT 全程只在 FC↔daemon,不经桌面、不入
  app 行、不落客户端。比把组织级 PAT 下发到每个客户端更安全,且 daemon 已具备调
  FC 的能力。
- **状态 = 桌面中转**:用创建者 bearer 走 RLS,天然合规;daemon 直写会被 RLS 挡。

## 2. 凭证投递(daemon 实时拉取)

### 2.1 新增 FC 端点 `GET /v1/teams/{teamId}/managed-git-credential`

- 返回 `{ username: string, token: string }` —— 即 `CODEUP_BOT_USERNAME()` +
  `CODEUP_PAT()`。
- **团队维度(非 per-app)**:managed-git 的 PAT 是组织级共享凭证,对一个 team 的所有
  托管仓(团队仓 + 其下所有 app 仓)都是同一个。所以端点按 **team** 维度授权,语义更
  诚实,也避免了 per-app RLS 难题——daemon 以自己的 **agent** actor 认证,而 RLS 会对
  非创建者隐藏 **personal** app(daemon agent ≠ 创建者),若按 app 可见性授权则 daemon
  取不到 personal app 的凭证。改按"是否该 team 成员"授权后,daemon agent 作为 team
  成员可正常取用,无需 security-definer 绕过 RLS。
- **授权**:调用者(`ctx.userId` → actor)必须是 `teamId` 的成员;否则 403/404。
  managed-git 未配置(无 `CODEUP_ORG_ID`/`CODEUP_PAT`)→ 503 `managed_git_unavailable`。
- 仓库层:pg-repo + supabase-repo 各加 `getManagedGitCredential(teamId)`:校验调用者是
  该 team 成员(pg 用 `resolveActorForTeam`;supabase 用 `resolveCurrentMemberActor`),
  通过则返回共享 helper `managedGitCredential()`(读 `CODEUP_BOT_USERNAME`/`CODEUP_PAT`,
  未配置返回 null→路由 503)。非成员 → null → 路由 404。**`mapApp` 不变**,凭证不进
  app 序列化。
- daemon 需要 `teamId` 才能调该端点:`POST /v1/apps/seed` 的请求体增加 `teamId`(桌面
  踢 seed 时带上 `app.teamId`)。

### 2.2 daemon 播种时取用

- `POST /v1/apps/seed`(`apps/daemon/src/http/apps.rs`)处理器在调用 `seed_app_repo`
  前:若请求体带显式 `git_token`(测试/显式路径),直接用;否则若带 `teamId`,经
  `state.backend`(`Arc<dyn Backend>`)调 `GET /v1/teams/{teamId}/managed-git-credential`
  → 得 `{username, token}` → 拼 `username:token` 作为 https token 传入
  `seed_app_repo(workdir, gitRemoteUrl, template_dir, Some("username:token"))`。
- 取凭证失败(非 200)→ seed 返回错误(daemon 端记录,HTTP 返回失败状态),**不**用
  无凭证硬推。
- 凭证**用完即弃**:不写 `secret_store`、不落盘。
- daemon 的 cloud_api 客户端已有 `get<T>` + base URL + bearer。需在 `Backend` trait 上
  加一个方法 `managed_git_credential(team_id)`(cloud_api impl 调 `self.get`;其它
  Backend impl/测试 mock 返回固定值或 unsupported),让 axum handler 经 `state.backend`
  调用。

### 2.3 seed 响应细化

- `SeedAppResponse` 从 `{status:"ready"}` 改为携带成功/失败语义:成功 →
  `{status:"ready"}`;失败 → 走 `HttpError`(已是如此)。关键是桌面能区分
  **HTTP 成功(已播种)** vs **HTTP 失败(播种失败)** vs **不可达(连不上 daemon)**。
- `seedDaemonApp` 返回值从 `boolean` 改为三态:`'seeded' | 'failed' | 'unreachable'`
  (或 `{ ok: boolean; reachable: boolean }`),让桌面据此决定回写哪个状态。

## 3. 状态回写(桌面中转)

### 3.1 扩展 `updateApp` 接受 `provisionStatus`

- pg-repo + supabase-repo 的 `updateApp(appId, patch)` 的 `patch` 增加可选
  `provisionStatus`。
- **合法流转校验**(仓库层):只允许
  `repo_created → seeding`、`seeding → ready`、`seeding → error`、
  以及重试场景 `error → seeding`、`repo_created → seeding`。非法目标值或非法跃迁 →
  忽略该字段或返回 400(实现取**忽略非法 provisionStatus 并按其余 patch 处理**,
  避免一次 PATCH 因状态字段失败而丢掉 name/visibility;若 patch 仅含非法 status 则
  返回 400 `invalid_status_transition`)。
- 创建者限制由 RLS `apps_update_if_creator` 保证(postgres 后端用同款 app 层校验
  `loadVisibleApp` + creator 检查,已在第一期 `updateApp` 中)。

### 3.2 路由

- 复用 `PATCH /v1/apps/{appId}`(已存在);body 增加可选 `provisionStatus`。
- OpenAPI 更新 PATCH 的 requestBody 与 `App.provisionStatus` 描述。

### 3.3 桌面编排(`apps-store.create` 及重试路径)

播种编排(仅当 `createApp` 返回 `repo_created` 且有 `gitRemoteUrl`):

```
PATCH provisionStatus=seeding        // 落地"创建中"
const r = await seedDaemonApp(appId, gitRemoteUrl)   // 三态
if r === 'seeded'       → PATCH provisionStatus=ready
else if r === 'failed'  → PATCH provisionStatus=error
else /* unreachable */  → 不回写(保持 repo_created,留待重试)
```

- 所有 PATCH best-effort 包 try/catch,失败只 `console.warn`,**不**让建 app 抛错。
- store 在 PATCH 后用返回的 app 行更新本地 `items`,让第二列状态实时刷新。

## 4. 重试

- `AppsListColumn` 给 `repo_created` / `error` 状态的 app 行加一个"重新播种"动作
  (按钮或右键项,i18n)。点击 → 调一个 store action `reseed(app)`:走 §3.3 同一编排
  (seeding → seed → ready/error)。
- 不引入新机制,纯复用现有 seed + status 回写路径。

## 5. 错误处理

- 凭证端点:未认证/非同队 403;app 不存在/不可见 404;managed-git 未配置 503。
- daemon 取凭证失败 → seed 失败 → 桌面置 `error`,UI 显示失败 + 可重试。
- daemon 不可达 → 保持 `repo_created`,UI 显示"创建中/待播种" + 可重试(不误报 error)。
- 所有桌面侧 FC PATCH 与 daemon 调用都是 best-effort,绝不阻断建 app 主流程。

## 6. 测试

- **FC**:
  - `GET /v1/apps/{id}/git-credential`:同队成员 200 返回 `{username, token}`;
    非同队/未认证 403;managed-git 未配置 503;app 不存在 404。(route + repo 测试)
  - `updateApp` 状态流转:合法跃迁成功;非法跃迁被忽略/拒绝;非创建者被挡(已有
    loadVisibleApp 守卫)。pg-repo + supabase-repo 各一套。
- **daemon**:扩展 `tests/http_apps.rs` —— seed 时从一个**桩 FC 凭证端点**取凭证后
  推到本地 bare repo 成功;凭证端点 500/403 时 seed 失败。复用第一期 bare-repo 验证。
- **桌面**:`apps-store` 编排单测 —— `seeded→ready`、`failed→error`、
  `unreachable→保持 repo_created` 三路径都断言对应 PATCH 被调用/不被调用;`reseed`
  动作走同编排。`seedDaemonApp` 三态返回的单测。
- 全量回归:FC / daemon / 前端 套件不新增红;i18n parity(新增重试键)。

## 7. 明确不做(本块 Out of Scope)

- 真实 FC 函数 / Postgres 库 provision / 部署 URL(第二期另一块)。
- 每仓独立 deploy token(CodeUp 仍用共享组织 PAT;per-repo scoped token 留作后续
  安全增强)。
- daemon 侧凭证缓存(每次 seed 实时拉取即可,建 app 是低频操作)。
- iOS / expo 端。

## 8. 受影响文件(概览)

- FC:`services/fc/src/lib/routes/apps.ts`(GET git-credential + PATCH 加 status)、
  `services/fc/src/lib/pg-repo/apps.ts` + `supabase-repo.ts`(`getAppGitCredential` +
  `updateApp` status)、`docs/openapi/teamclaw-api.v1.yaml`。
- daemon:`apps/daemon/src/http/apps.rs`(seed 前取凭证)、cloud_api 客户端加 `get`
  辅助(如缺)。
- 桌面:`packages/app/src/lib/daemon-local-client.ts`(`seedDaemonApp` 三态)、
  `packages/app/src/lib/backend/cloud-api/apps.ts` +
  `packages/app/src/lib/backend/types.ts`(`updateAppProvisionStatus`)、
  `packages/app/src/stores/apps-store.ts`(编排 + `reseed`)、
  `packages/app/src/components/sidebar/AppsListColumn.tsx`(重试动作)、locale 文件。
