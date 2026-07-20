# 删除旧 Agent 失败：`public.actors` schema drift

日期：2026-07-17

## 现象

切换到新的 team 后，左侧 `RECENTS` 仍显示旧的 agent，例如 `MACPRO`。用户尝试从侧边栏删除该 agent 时，UI toast 报错：

```text
Remove failed: relation "public.actors" does not exist
```

截图中同时可以看到：

- `RECENTS` 中仍有 `MACPRO`，右侧标记为 `Agent`。
- 左下角本机 daemon 卡片显示另一个 agent：`J60GP07WVG`。
- 删除 `MACPRO` 失败后，它仍然留在 actor 列表中。

## 复现路径

1. 登录 TeamClaw Desktop。
2. 切换到一个新的 team。
3. 让本机 daemon 重新绑定或进入新 team，使左下角显示当前本机 agent。
4. 观察左侧 `RECENTS`。
5. 如果旧 agent（如 `MACPRO`）仍显示，右键或打开详情尝试 `Remove from team`。
6. 删除失败，toast 显示 `relation "public.actors" does not exist`。
7. 刷新 actor 列表后旧 agent 仍显示。

## 当前显示逻辑

`RECENTS` 不是本机 daemon 的专用显示位。它来自当前 team 的 actor directory：

- `ActorsSection` 通过 `useActorsForTeam()` 读取当前 team 的 actor directory。
  - `packages/app/src/components/sidebar/ActorsSection.tsx`
- `useActorsForTeam()` 来自 `actor-directory-store`，加载顺序是本地 cache first，然后用 Cloud API `listActorDirectory(teamId)` 覆盖。
  - `packages/app/src/stores/actor-directory-store.ts`
- `getRecentContactActors()` 只保留有 `last_active_at` 或 presence 在线的 actor，并会把当前用户的 `defaultAgentId` 置顶。
  - `packages/app/src/components/sidebar/sidebar-list-helpers.ts`
- 本机 daemon agent 会被 `ActorsSection` 排除出 `RECENTS`，改由左下角 `LocalDaemonCard` 独立显示。
  - `packages/app/src/components/sidebar/LocalDaemonCard.tsx`

因此：

- 左下角 `J60GP07WVG` 是当前本机 daemon agent。
- `RECENTS` 中的 `MACPRO` 是当前 team actor directory 返回的 actor，或当前用户默认 agent 置顶结果。
- 如果 `MACPRO` 被服务端 directory 返回，前端不会认为它“不存在”。

## 问题根因判断

这不太像单纯前端脏缓存，原因是删除动作本身返回了数据库错误：

```text
relation "public.actors" does not exist
```

当前项目已迁到 `amux.*` schema。baseline 中 `amux.remove_team_actor` 仍包含旧表引用：

```sql
from public.actors
delete from public.team_members
delete from public.agents
delete from public.members
delete from public.agent_member_access
delete from public.daemon_invites
```

位置：

- `services/supabase/migrations/20260601000000_baseline.sql`

FC Supabase repository 的删除路径调用的是：

```ts
supabase.rpc("remove_team_actor", { p_actor_id: actorId })
```

位置：

- `services/fc/src/lib/supabase-repo.ts`

因为 live DB 上 `public.actors` 不存在，删除 RPC 执行失败。actor 没有被删除，后续 actor directory 仍然返回这条旧 agent，所以侧边栏继续显示。

## 为什么切 team 后旧 agent 还在

切换 team 的代码只会：

1. 调用 Cloud API 激活新 team。
2. 更新本地 auth session。
3. 重载当前 team。
4. 调用 daemon onboarding refresh 检查本机 daemon 和当前 team 的绑定状态。

它不会自动删除旧 team 或旧 actor，也不会在切 team 时清理服务端残留 agent。

相关位置：

- `packages/app/src/stores/current-team.ts`
- `packages/app/src/stores/daemon-onboarding.ts`

如果旧 agent 已经错误地存在于当前 team 的 actor directory，切 team 不会自动修复它。

## 临时处理方案

不改代码也可以临时处理（在 DB 手工删）。**先查再删**，把下面 `<team_id>` / `<actor_id>` 换成实际值。

### 1) 查出要删的 agent

```sql
select a.id, a.display_name, a.actor_type, a.last_active_at, ag.status, ag.visibility
from amux.actors a
left join amux.agents ag on ag.id = a.id
where a.team_id = '<team_id>'
  and a.actor_type = 'agent'
order by a.display_name;
```

### 2) 删单个 agent（与 RPC 同序，避开 RESTRICT）

```sql
begin;

-- optional: 看有没有 RESTRICT 引用会挡删除
select 'apps' as src, id from amux.apps where created_by_actor_id = '<actor_id>'
union all
select 'idea_activities', id::text from amux.idea_activities where actor_id = '<actor_id>'
union all
select 'amuxc_files', id from amux.amuxc_files where updated_by = '<actor_id>'
union all
select 'amuxc_file_versions', id::text from amux.amuxc_file_versions where created_by = '<actor_id>';

delete from amux.agent_member_access
 where agent_id = '<actor_id>' or member_id = '<actor_id>';

delete from amux.team_members where member_id = '<actor_id>';

delete from amux.agents where id = '<actor_id>';
delete from amux.actors where id = '<actor_id>';

commit;
```

若第 2 步因 FK RESTRICT 失败，先处理那些引用行，或等正式 migration 上线后走 UI 删除。

### 3) 更快的临时方案：只修函数，然后走 UI

直接在 live DB 执行 migration 文件内容：

`services/supabase/migrations/20260718000000_fix_remove_team_actor_amux.sql`

然后在桌面端再点 Remove。合并进 `main` 后 `self-host-deploy` 也会自动 apply。

## 正式修复方向

已落地（2026-07-18）：

1. Migration：`services/supabase/migrations/20260718000000_fix_remove_team_actor_amux.sql`
2. 函数体全部改为 `amux.*`，并去掉已删除的 `daemon_invites` 引用
3. FC：`supabase.schema("amux").rpc("remove_team_actor", ...)`
4. pgTAP：`024_remove_team_actor_owned_agents.sql` 改用 `amux.*`
5. FC 单测断言 RPC 带 `schema: "amux"`

应用 migration 到 live DB 后，在 UI 重新删除旧 agent 即可。

## 验证建议

修复完成后至少验证：

1. UI 删除旧 agent 不再报 `public.actors`。
2. 删除后 `GET /v1/teams/:teamId/actors` 不再返回该 actor。
3. `RECENTS` 不再显示该 actor。
4. 删除 member 时，其拥有的 agent 仍按预期级联删除。
5. 删除最后一个 owner / 删除自己 / 非 owner-admin 删除仍保持原有保护逻辑。
