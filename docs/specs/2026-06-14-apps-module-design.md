# Apps 模块设计 — 第一期（骨架优先）

- **Date**: 2026-06-14
- **Status**: Approved design, ready for implementation planning
- **Branch**: `agent/apps-module`
- **Scope**: Phase 1 only. Phase 2 (real FC + Postgres provisioning + deploy) is
  explicitly out of scope and only stubbed in the data model.

## 1. 背景与目标

TeamClaw 新增 **apps** 模块，让用户在平台内创建并构建自己的全栈应用。每个
app 由 AI session 协助开发，有固定 git 仓库存代码、一个对应的 FC（Function
Compute）作为部署目标，可团队可见或个人私有。

第一期只做"骨架"，让用户能：

1. 创建一个 app（一期类型只支持 **TanStack 前端 + Postgres 后端** 全栈应用）。
2. 系统为它开一个 **专属 git 仓库**，建一个 1:1 绑定的 **workspace**。
3. daemon 把 **TanStack + Postgres 模板** 播种进该仓库（首个 commit）。
4. 用户/agent 在该 app 的 **session** 里继续写代码，完成所有开发工作。
5. app 可设为 **团队可见** 或 **个人私有**。

"每个 app 对应一个 FC" 在第一期 **只在数据模型里占位**（建表字段），真实的 FC
函数 provision、Postgres 库 provision、一键部署、访问 URL 全部留到第二期。

### 既有架构约束（设计依据）

- **session** 是 team 维度实体（`sessions.team_id`），现无 `workspace_id`/`app_id`。
- **workspace** 是 team 维度的本地开发环境（`workspaces.team_id` 非空，可挂
  agent，有 `name`/`path`）；daemon 会把团队 git 仓库本地 checkout 到
  `~/.amuxd/teams/{team_id}/...` 并以 symlink 暴露进 workspace。
- **可见性** 现有成熟模式在 **agents**：`visibility ('personal'|'team')` +
  `agent_member_access` 桥接表，按调用者在 **查询层过滤**（非 RLS）。
- **managed-git**：FC 端 `/managed-git/create-repo` 用 `CODEUP_PAT`/
  `CODEUP_ORG_ID` 在 CodeUp 建私有仓库，返回 `repoHttpUrl` + `pat`；现为
  **per-team**。share-mode（oss|managed_git|custom_git）per-team 一次性锁定。
- **FC** 目前只有一个静态函数 `teamclaw-sync`，无按实体动态 provision FC 的机制。
- **Cloud API 链路**：OpenAPI（`docs/openapi/teamclaw-api.v1.yaml`）→ routes
  （`services/fc/src/lib/routes/*.ts`）→ business-api → pg-repo + supabase-repo
  → repository-contract → 客户端 provider。客户端禁止直连 Supabase。

### 关键关系决策

- **app : workspace : git 仓库 = 1 : 1 : 1**。但 workspace **不一定** 有 app
  （现有纯团队 workspace 照旧，不受影响）。
- app 始终归属一个 team；"个人可见" = 同团队内私有（沿用 agent 可见性模式），
  **不** 引入"无团队的纯个人 app"。
- session 与 app 是 **可空** 关联：有 `app_id` 的归该 app，没有的就是普通团队
  session（现状不变）。

## 2. 数据模型

### 2.1 新表 `amux.apps`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid pk | |
| `team_id` | uuid not null → `teams(id)` cascade | app 始终归属一个 team |
| `created_by_actor_id` | uuid not null → `actors(id)` | |
| `name` | text not null | |
| `slug` | text not null | `(team_id, slug)` 唯一 |
| `type` | text not null | 一期枚举只 `fullstack_tanstack_postgres`，可扩展 |
| `visibility` | text not null default `'personal'` | `'personal' \| 'team'` |
| `workspace_id` | uuid **unique** → `workspaces(id)` | 1:1 绑定（建 app 时创建） |
| `git_remote_url` | text | per-app 仓库 HTTPS URL（provision 后写入） |
| `git_auth_kind` | text | 复用 managed-git 语义（如 `pat`），机密不入库 |
| `provision_status` | text not null default `'pending'` | 见 §3 状态机 |
| `provision_error` | text | 失败原因，给 UI surface |
| `fc_function_name` | text **nullable** | **一期占位** |
| `fc_region` | text **nullable** | **一期占位** |
| `fc_endpoint` | text **nullable** | **一期占位** |
| `fc_status` | text **nullable** | **一期占位** |
| `created_at` / `updated_at` | timestamptz | |

约束：`unique(team_id, slug)`、`unique(workspace_id)`。

### 2.2 新表 `amux.app_member_access`（镜像 `agent_member_access`）

| 列 | 说明 |
|---|---|
| `app_id` uuid → apps cascade | |
| `member_id` uuid → members | |
| `permission_level` text | `'view' \| 'prompt' \| 'admin'` |
| `granted_by_member_id` uuid | |
| `created_at` / `updated_at` | |

唯一约束 `(app_id, member_id)`。用于 personal app 的显式授权可见。

### 2.3 `sessions` 加列

- 新增 **nullable** `app_id uuid references amux.apps(id) on delete set null`。
- 无 `app_id` = 普通团队 session（现状不变，零迁移）。

### 2.4 可见性过滤（查询层，非 RLS）

沿用 agents 模式：

- `visibility = 'team'` → 团队全员可见。
- `visibility = 'personal'` → 仅 `created_by_actor_id` 对应成员 + `app_member_access`
  里被授权的成员可见。
- 过滤逻辑放 pg-repo 的 `listApps`，不写成 RLS 策略。

### 2.5 迁移文件

`services/supabase/migrations/<ts>_apps_module.sql`：

- 建 `amux.apps` / `amux.app_member_access`，给 `sessions` 加 `app_id`。
- **给 amux 三角色 GRANT** + **通知 PostgREST reload schema cache**（参照
  belayo 库三缺口教训：amux 表无 grant 会 PostgREST 不可见；RPC schema 缓存需
  reload）。
- 不改动任何 public 表。

## 3. Provision 流程（骨架）

```
客户端 POST /v1/apps  →  插入 apps 行 (provision_status = pending)
        │
        ├─[FC] 扩展 managed-git create-repo 支持 per-app
        │      仓库名 tc-app-{appId}，建私有 CodeUp 仓
        │      → 写回 git_remote_url / git_auth_kind
        │      → 创建 workspaces 行并 app.workspace_id 绑定（1:1）
        │      → status = repo_created
        │
        └─[daemon] 把该 app 仓库当作本地 workspace checkout
               克隆空仓 → 写入 templates/tanstack-postgres/
               → 首个 commit → push
               → status = seeding → ready
```

状态机：`pending → repo_created → seeding → ready`，任一步失败 → `error`
（写 `provision_error`）。

设计要点：

- **建仓归 FC**：FC 持有 CodeUp 组织级凭证（`CODEUP_PAT`/`CODEUP_ORG_ID`），
  daemon 不应也不持有。仅把命名从 per-team 扩到 per-app（`tc-app-{appId}`）。
- **播种归 daemon**：克隆/写文件/commit/push 本就是 daemon git 引擎日常职责，
  播种模板只是多一步 copy + commit。
- **模板存本仓库** `templates/tanstack-postgres/`，随 daemon 分发，跟代码一起
  review/版本化（不维护独立 starter 仓库，不碰 CodeUp fork API）。
- **失败可重试**：`provision_status` + `provision_error` 让 UI 可见状态，失败
  可重新触发 provision（反应式自愈思路，参照现有 daemon 自愈模式）。失败 **不
  静默吞**（参照 bootstrap-error-surfacing 教训）。

## 4. Cloud API

走标准链路（OpenAPI → routes → business-api → pg-repo + supabase-repo →
repository-contract → 客户端 provider）。

公开端点（`/v1`）：

- `GET  /v1/apps?teamId=` — 列表，按可见性过滤，分页（limit/cursor）。
- `POST /v1/apps` — 创建（body: teamId, name, type, visibility），触发 provision。
- `GET  /v1/apps/{appId}` — 详情（含 provision_status / git_remote_url / fc 占位）。
- `PATCH /v1/apps/{appId}` — 改 name / visibility。
- `GET  /v1/apps/{appId}/sessions` — 该 app 的 session（或复用 listSessions 加
  `appId` 过滤）。

内部端点：

- 扩展 FC `/managed-git/create-repo` 接受 `appId`，按 `tc-app-{appId}` 建仓。

实现要点：

- pg-repo `apps.ts`：`listApps` / `createApp` / `getApp` / `updateApp` /
  `listAppSessions`，actor 从 `ctx.userId` 服务端解析，可见性服务端过滤。
- repository-contract 加 apps 契约（字段名/顺序/形状），防 drift。
- 一期客户端先做 **桌面 desktop provider**；iOS/expo/daemon 的 provider 后续。

## 5. 桌面 UI

- 左侧第一列快捷方式区新增 **"Apps"** 入口（与现有 Skills/MCP/Knowledge 同级
  的可折叠组/快捷方式）。
- 点击 "Apps" → **第二列** 列出当前用户可见的 apps（team 可见 + 本人 personal），
  响应式 store（cache-first + 网络对账 + sync 信号重读，参照 actor-directory
  store）。
- 点某个 app → 进入该 app **关联的最近一个 session 的 detail**（第三栏复用现有
  chat）。若该 app 还没有 session，则新建一个挂 `app_id` 的 session 再进入。
- app 行显示 `provision_status`（创建中 / 就绪 / 失败可重试）。
- 新建 app 入口：名称 + 类型选择（一期只 `fullstack_tanstack_postgres`）+ 可见性
  （团队 / 个人）。

## 6. 错误处理与可观测

- provision 每步落 `provision_status`，失败写 `provision_error` 并在 UI surface，
  不静默吞。
- daemon 播种失败（克隆/推送）要回报状态，桌面可重试。

## 7. 测试

- **FC**：apps route / pg-repo / repository-contract 测试；扩展后的
  create-repo per-app 测试。
- **迁移**：可见性过滤（team/personal/授权）单测；GRANT/PostgREST 可见性核对。
- **daemon**：模板播种用 `cargo test --bin amuxd`（纯 binary crate，集成
  crate 若 pre-existing 破损则绕开）。
- **前端**：apps store + 第二列列表组件 vitest；点击进入最近 session 的导航逻辑。
- **i18n**：新增键过 i18n-parity 守卫（detail 子键不要和分组标签同名）。

## 8. 明确不做（第一期 Out of Scope）

- 真实 FC 函数 provision / 部署 / 访问 URL。
- 真实 Postgres 库 provision。
- iOS / expo / 移动端 UI。
- app 类型扩展（仅 `fullstack_tanstack_postgres`）。
- app 删除 / 归档的完整生命周期（可留最小 archived 标记，按需）。

## 9. 第二期预告（仅记录，不在本 spec 实现）

- 按 app 动态 provision FC 函数（新的 Alibaba FC API 调用机制）。
- 按 app provision Postgres 库。
- 一键部署流水线 + 访问 URL，回填 `fc_*` 字段。
