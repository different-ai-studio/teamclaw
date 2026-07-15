# Agent Invite 后端缺口修复 (Block ③) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让现有 `POST /v1/teams/:teamId/invites`(kind=agent,含 targetActorId)在 **两个后端**都能安全、正确地支撑桌面 daemon onboarding 的"新建 agent / 绑定已有 agent"——补上一个越权漏洞和三个 postgres 后端 bug,无需新增端点。

**Architecture:** 复用现有 invites 端点(决策已定)。supabase 后端走 SQL RPC `create_team_invite`/`claim_team_invite`;postgres 后端走 Drizzle + `pg-repo/*.ts`。两者独立,各自实现各自测。本计划修四处:① pg `listConnectedAgents` 的 caller actor 未解析(isOwner 恒 false、personal 不可见);② pg `createTeamInvite` 字段映射 bug(kind/agentKind 丢失);③ supabase `create_team_invite` 给 targetActorId 重发 invite 时**缺 owner 鉴权(越权漏洞)**;③b pg `claimInvite` 未实现 targetActorId rebind(绑定已有 agent 在 pg 后端会另造新 agent)。

**Tech Stack:** SQL(supabase 顺序迁移)、TypeScript(Hono FC、Drizzle、pg-repo)、node:test + tsx + pglite(FC 测试)。

**依赖/前提:** FC 在本分支已是 TS+Hono+Drizzle 双后端(`BACKEND_KIND`,默认 supabase)。本计划不新增 Cloud API 端点。客户端 UI 接线属 Block ④。

---

## File Structure

新增:
- `services/supabase/migrations/20260602000000_create_team_invite_owner_check.sql` — 覆盖 `create_team_invite`,对 targetActorId 重发加 owner 校验。

修改:
- `services/fc/src/lib/pg-repo/teams.ts` — `createTeamInvite` 字段映射(kind/teamRole/agentKind)+ targetActorId 的 owner 校验。
- `services/fc/src/lib/pg-repo/auth.ts` — `claimInvite` agent 分支加 targetActorId rebind。
- `services/fc/src/lib/pg-repo/agents.ts` — `listConnectedAgents` 用 `resolveActorForTeam` 解析 caller actor(修 isOwner / personal 可见性)。
- `services/fc/src/lib/pg-repo/actors.ts` — `listTeamActors` / `getTeamDirectory` 同样解析 caller actor。
- `services/fc/src/lib/repository-contract.ts` — `createTeamInvite` 契约测试改用生产 key(`kind`),断言收敛到两后端公共字段。
- `services/fc/test/pg-repo-agents.test.ts` / `pg-repo-teams.test.ts`(若无则新建后者)— 加 pglite 实测。

不动:`supabase-repo.ts` 的 `createTeamInvite`(已正确映射 kind/agentKind)、route handlers(已正确透传)、`src/index.ts` 工厂(callerActorId 改为方法内解析,不在工厂注入)。

> **测试命令(全计划通用)**:在 `services/fc/` 目录下 —— 测试 `npm run test`(= `node --import tsx --test "test/**/*.test.ts"`),类型 `npm run typecheck`。可用过滤:`node --import tsx --test test/pg-repo-agents.test.ts`。pglite 测试用真 Drizzle schema,故 pg-repo 行为可真实 TDD;**supabase SQL RPC 改动无本地单测,靠精确复刻 + 评审**(见 Task 1)。

---

## Part S — supabase 越权修复

### Task 1: create_team_invite 加 owner 鉴权(targetActorId)

**Files:**
- Create: `services/supabase/migrations/20260602000000_create_team_invite_owner_check.sql`

> 安全修复:当前 `create_team_invite` 给已存在 agent(p_target_actor_id)重发 invite 时只校验 target 同 team + 是 agent,不校验 caller 是该 agent 的 owner → 任意成员可劫持他人 agent。本任务覆盖该函数,在 target 分支加 owner 校验。supabase RPC 无本地单测,务必逐字复刻原函数,仅加这一处校验。

- [ ] **Step 1: 读取 winning 定义原文**

Run: `sed -n '3889,3995p' services/supabase/migrations/20260601000000_baseline.sql`
记录:函数完整签名是
`public.create_team_invite(p_team_id uuid, p_kind text, p_display_name text, p_team_role text default null, p_agent_kind text default null, p_ttl_seconds int default 604800, p_target_actor_id uuid default null)`
返回 `table (token text, expires_at timestamptz, deeplink text)`,`language plpgsql security definer set search_path = public, auth, app`。注意末尾的 `revoke ... ` / `grant execute ...` 两行(3994-3995)。

- [ ] **Step 2: 写迁移(逐字复刻 + 加一处校验)**

创建 `services/supabase/migrations/20260602000000_create_team_invite_owner_check.sql`。内容 = `create or replace function public.create_team_invite(<完全相同的签名>) returns table (...) language plpgsql security definer set search_path = public, auth, app as $$ ... $$;` 把 Step 1 读到的函数体**逐字照抄**,然后在 **agent 分支里 `if p_target_actor_id is not null then` 块内、在现有"target 存在 / 同 team / actor_type=agent"三个校验之后**,插入:

```sql
      if not exists (
        select 1 from public.agents
        where id = p_target_actor_id
          and owner_member_id = v_caller
      ) then
        raise exception 'only the agent owner can re-invite this agent'
          using errcode = '42501';
      end if;
```

(`v_caller` 即函数顶部 `v_caller uuid := app.current_actor_id_for_team(p_team_id);` —— team-scoped 的 caller actor,正确。)
迁移文件结尾照抄 baseline 3994-3995 的 `revoke`/`grant execute` 两行,确保权限不变。

- [ ] **Step 3: 静态校验 SQL 语法 + 检查是否有 supabase DB 测试**

Run: `ls services/supabase/tests 2>/dev/null; sed -n '1,60p' services/supabase/migrations/README.md`
- 若存在 pgTAP/SQL 测试目录(如 `services/supabase/tests/*.sql`)且有跑测脚本,新增一个最小测试:owner 重发成功、非 owner 重发抛 42501。否则跳过(无 harness),在 commit message 注明"verified by review, no local SQL test harness"。
Run(语法粗检,若本机有 psql 否则跳过): `which psql && psql --version || echo "no psql; rely on review"`

- [ ] **Step 4: 自检签名一致**

Run: `grep -n "create or replace function public.create_team_invite" services/supabase/migrations/20260602000000_create_team_invite_owner_check.sql`
确认签名参数顺序/类型/默认值与 baseline 3889 完全一致(否则会创建重载而非覆盖)。逐字符比对 Step 1 的签名行。

- [ ] **Step 5: 提交**

```bash
cd /Volumes/openbeta/workspace/teamclaw-v2/.worktrees/unified-install-onboarding
git branch --show-current   # must be agent/unified-install-onboarding
git add services/supabase/migrations/20260602000000_create_team_invite_owner_check.sql
git commit -m "fix(db): require agent owner to re-invite via create_team_invite (authz)"
```

---

## Part P — postgres 后端修复

### Task 2: pg createTeamInvite 字段映射 + owner 校验

**Files:**
- Modify: `services/fc/src/lib/pg-repo/teams.ts`(`createTeamInvite`,约 216-254)
- Test: `services/fc/test/pg-repo-teams.test.ts`(若不存在则新建)

- [ ] **Step 1: 确认 teamInvites schema 列名**

Run: `grep -rn "agentKind\|teamRole\|targetActorId\|kind:" services/fc/src/db/schema/*.ts | grep -i invite`
确认 `teamInvites` 表有 `kind` / `teamRole` / `agentKind` / `targetActorId` 列(Drizzle 字段名)。若 `agentKind` 列名不同(如 `agent_kind`→`agentKind`),以 schema 实际驼峰名为准,后续代码用该名。

- [ ] **Step 2: 写失败测试**

`services/fc/test/pg-repo-teams.test.ts`(若已存在则追加 test;import 沿用 pg-repo-agents.test.ts 风格):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers, teamInvites } from "../src/db/schema/index.js";

async function seedOwner(db: any) {
  const [t] = await db.insert(teams).values({ name: "T", slug: `t-${Date.now()}-${Math.random()}` }).returning();
  const userId = crypto.randomUUID();
  const [actor] = await db.insert(actors).values({ teamId: t.id, actorType: "member", displayName: "Owner", userId }).returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: t.id, memberId: actor.id, role: "owner" });
  return { teamId: t.id, userId, actorId: actor.id };
}

test("pg createTeamInvite persists kind and agentKind for agent invites", async () => {
  const db = await makeTestDb();
  const { teamId, userId } = await seedOwner(db);
  const repo = createPgBusinessRepository({ db, userId });
  const result = await repo.createTeamInvite(teamId, {
    kind: "agent",
    displayName: "Build Bot",
    agentKind: "claude",
    teamRole: null,
    targetActorId: null,
  } as any);
  assert.ok(result.token, "token present");
  const [row] = await db.select().from(teamInvites).where(eqToken(teamInvites, result.token));
  assert.equal(row.kind, "agent");
  assert.equal(row.agentKind, "claude");
});
```

加一个 helper（文件顶部 import `eq` from drizzle-orm）：
```ts
import { eq } from "drizzle-orm";
function eqToken(tbl: any, token: string) { return eq(tbl.token, token); }
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd services/fc && node --import tsx --test test/pg-repo-teams.test.ts 2>&1 | tail -20`
Expected: 失败 —— `row.kind` 为 `undefined`/null、`row.agentKind` 为 null(当前读 `input.actorType`、丢 `agentKind`)。

- [ ] **Step 4: 修字段映射 + 加 owner 校验**

在 `services/fc/src/lib/pg-repo/teams.ts` 的 `createTeamInvite`:
1. 入参类型改为接受生产 key(并保留旧 key 兼容契约,以防其它调用方):
```ts
  async createTeamInvite(
    teamId: string,
    input: {
      kind?: string;
      actorType?: string;
      displayName: string;
      teamRole?: string | null;
      role?: string;
      agentKind?: string | null;
      expiresAt?: string | null;
      ttlSeconds?: number | null;
      targetActorId?: string | null;
    },
    ctx?: { userId?: string },
  ) {
    const userId = ctx?.userId;
    const kind = input.kind ?? input.actorType ?? "member";
    const teamRole = input.teamRole ?? input.role ?? null;
    let invitedByActorId: string | null = null;
    if (userId) {
      invitedByActorId = await requireActorForTeam(db, userId, teamId);
    }
```
2. 在解析出 `invitedByActorId` 后、insert 之前,加 targetActorId 的 owner 校验:
```ts
    if (input.targetActorId) {
      if (!userId) {
        throw new ApiError(401, "missing_identity", "re-inviting an agent requires authentication");
      }
      const owns = await checkAgentOwnership(db, userId, input.targetActorId);
      if (!owns) {
        throw new ApiError(403, "forbidden", "only the agent owner can re-invite this agent");
      }
    }
```
3. insert 用修正后的字段(加 agentKind):
```ts
    const [invite] = await (db as any)
      .insert(teamInvites)
      .values({
        teamId,
        token,
        kind,
        teamRole,
        agentKind: input.agentKind ?? null,
        displayName: input.displayName,
        invitedByActorId: invitedByActorId ?? "00000000-0000-0000-0000-000000000000",
        expiresAt,
        targetActorId: input.targetActorId ?? null,
      })
      .returning();
```
确保文件顶部 import 了 `checkAgentOwnership`(from `./authz.js`)和 `ApiError`(from `../http-utils.js`);`requireActorForTeam` 已在用。

- [ ] **Step 5: 加 owner 校验的测试**

追加到 `pg-repo-teams.test.ts`:
```ts
test("pg createTeamInvite rejects re-invite by non-owner", async () => {
  const db = await makeTestDb();
  const { teamId, userId: ownerUser, actorId: ownerActor } = await seedOwner(db);
  // create an agent owned by ownerActor
  const [agentActor] = await db.insert(actors).values({ teamId, actorType: "agent", displayName: "A1" }).returning();
  await db.insert(agents).values({ id: agentActor.id, agentKind: "claude", status: "active", visibility: "team", ownerMemberId: ownerActor });
  // a different member in the same team
  const otherUser = crypto.randomUUID();
  const [otherActor] = await db.insert(actors).values({ teamId, actorType: "member", displayName: "Other", userId: otherUser }).returning();
  await db.insert(members).values({ id: otherActor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: otherActor.id, role: "member" });

  const repo = createPgBusinessRepository({ db, userId: otherUser });
  await assert.rejects(
    () => repo.createTeamInvite(teamId, { kind: "agent", displayName: "x", agentKind: "claude", targetActorId: agentActor.id } as any),
    /forbidden|owner/i,
  );

  // owner can re-invite
  const ownerRepo = createPgBusinessRepository({ db, userId: ownerUser });
  const ok = await ownerRepo.createTeamInvite(teamId, { kind: "agent", displayName: "x", agentKind: "claude", targetActorId: agentActor.id } as any);
  assert.ok(ok.token);
});
```
加 import：`import { agents } from "../src/db/schema/index.js";`(并入现有 schema import)。

- [ ] **Step 6: 运行测试确认通过**

Run: `cd services/fc && node --import tsx --test test/pg-repo-teams.test.ts 2>&1 | tail -20`
Expected: 3 tests pass(persists kind/agentKind、reject non-owner、owner ok)。

- [ ] **Step 7: 提交**

```bash
git add services/fc/src/lib/pg-repo/teams.ts services/fc/test/pg-repo-teams.test.ts
git commit -m "fix(fc-pg): createTeamInvite field mapping + owner check on re-invite"
```

---

### Task 3: pg claimInvite 实现 targetActorId rebind

**Files:**
- Modify: `services/fc/src/lib/pg-repo/auth.ts`(`claimInvite` agent 分支,约 332-405)
- Test: `services/fc/test/pg-repo-claim.test.ts`(新建)

> 绑定已有 agent:claim 一个带 targetActorId 的 agent invite 时,应**复用该 actor**(改 owner/visibility/userId),而不是新造 agent。对齐 supabase `claim_team_invite`(baseline 7471-7500)。

- [ ] **Step 1: 读现状**

Run: `sed -n '266,408p' services/fc/src/lib/pg-repo/auth.ts`
定位 agent 分支的 `db.transaction(async (tx) => { ... })`,确认现在无条件 `tx.insert(actors)` + `tx.insert(agents)`(NEW-only),且 invite 对象上有 `targetActorId`(若该字段未从 invite 查询里 select 出来,需在读取 invite 的 select 里补上 `targetActorId`)。

- [ ] **Step 2: 写失败测试**

`services/fc/test/pg-repo-claim.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers, teamInvites, agents } from "../src/db/schema/index.js";

test("pg claimInvite with targetActorId rebinds the existing agent (no new agent)", async () => {
  const db = await makeTestDb();
  const [t] = await db.insert(teams).values({ name: "T", slug: `t-${Date.now()}-${Math.random()}` }).returning();
  const ownerUser = crypto.randomUUID();
  const [owner] = await db.insert(actors).values({ teamId: t.id, actorType: "member", displayName: "Owner", userId: ownerUser }).returning();
  await db.insert(members).values({ id: owner.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: t.id, memberId: owner.id, role: "owner" });
  // existing personal agent owned by owner
  const [ag] = await db.insert(actors).values({ teamId: t.id, actorType: "agent", displayName: "Existing" }).returning();
  await db.insert(agents).values({ id: ag.id, agentKind: "claude", status: "active", visibility: "personal", ownerMemberId: owner.id });
  // invite targeting that agent
  const token = `tok-${Date.now()}`;
  await db.insert(teamInvites).values({ teamId: t.id, token, kind: "agent", agentKind: "claude", displayName: "Existing", invitedByActorId: owner.id, expiresAt: new Date(Date.now() + 3600_000), targetActorId: ag.id });

  const repo = createPgBusinessRepository({ db, userId: ownerUser });
  const result = await repo.claimInvite(token, {});

  assert.equal(result.actorId, ag.id, "claim returns the existing agent's actor id, not a new one");
  const allAgents = await db.select().from(agents);
  assert.equal(allAgents.length, 1, "no extra agent row created");
  const [after] = await db.select().from(agents).where(eq(agents.id, ag.id));
  assert.equal(after.visibility, "team", "rebind sets visibility=team");
  assert.equal(after.ownerMemberId, owner.id);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd services/fc && node --import tsx --test test/pg-repo-claim.test.ts 2>&1 | tail -25`
Expected: 失败 —— `allAgents.length` = 2(造了新 agent),或 `result.actorId` ≠ ag.id。

- [ ] **Step 4: 实现 rebind 分支**

在 `auth.ts` 的 agent 分支 transaction 里,把现有 NEW-only 逻辑包进 `if (invite.targetActorId) { …rebind… } else { …existing new-create… }`。rebind 分支(复用既有 actor,不建新 actor/agent):
```ts
    return await (db as any).transaction(async (tx: any) => {
      let actorId: string;
      if (invite.targetActorId) {
        // Rebind an existing agent to the claiming daemon user.
        const [old] = await tx.select({ userId: actors.userId }).from(actors).where(eq(actors.id, invite.targetActorId)).limit(1);
        await (tx.update(actors) as any)
          .set({ userId: daemonUser.id, invitedByActorId: invite.invitedByActorId, lastActiveAt: null, updatedAt: new Date() })
          .where(eq(actors.id, invite.targetActorId));
        await (tx.update(agents) as any)
          .set({ ownerMemberId: invite.invitedByActorId, visibility: "team", updatedAt: new Date() })
          .where(eq(agents.id, invite.targetActorId));
        await (tx.insert(agentMemberAccess) as any)
          .values({ agentId: invite.targetActorId, memberId: invite.invitedByActorId, permissionLevel: "admin", grantedByMemberId: invite.invitedByActorId })
          .onConflictDoUpdate({ target: [agentMemberAccess.agentId, agentMemberAccess.memberId], set: { permissionLevel: "admin" } });
        actorId = invite.targetActorId;
        // best-effort: delete the previous daemon user the agent was bound to
        if (old?.userId && old.userId !== daemonUser.id) {
          try { await ctx2.internalAdapter.deleteSessions(old.userId); await ctx2.internalAdapter.deleteUser(old.userId); } catch { /* ignore */ }
        }
      } else {
        const [actor] = await tx.insert(actors).values({
          teamId: invite.teamId, actorType: "agent",
          displayName: invite.displayName, userId: daemonUser.id,
          invitedByActorId: invite.invitedByActorId,
        }).returning();
        await tx.insert(agents).values({ id: actor.id, agentKind: invite.agentKind ?? "daemon", status: "active", visibility: "team" });
        await tx.insert(agentMemberAccess).values({ agentId: actor.id, memberId: invite.invitedByActorId, permissionLevel: "admin", grantedByMemberId: invite.invitedByActorId });
        actorId = actor.id;
      }
      await (tx.update(teamInvites) as any).set({ consumedAt: new Date(), consumedByActorId: actorId }).where(eq(teamInvites.token, token));
      return { actorId, teamId: invite.teamId, actorType: "agent" as const, displayName: invite.displayName, refreshToken: minted.refreshToken };
    });
```
注意:
- `ctx2`/`internalAdapter`/`daemonUser`/`minted`/`invite` 等变量名必须与现有 agent 分支一致(Step 1 里确认实际命名,按实际改)。若现有删旧 user 的 API 用法不同,照现有 compensate 段(auth.ts:348-357)的写法。
- 若 invite 查询未 select `targetActorId`,在该查询补上。
- `onConflictDoUpdate` 的 target 列写法以 Drizzle schema 的复合唯一约束为准(agentMemberAccess (agentId, memberId))。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd services/fc && node --import tsx --test test/pg-repo-claim.test.ts 2>&1 | tail -20`
Expected: rebind 测试通过。再跑一遍既有 claim 测试确认无回归:`node --import tsx --test test/pg-repo-agents.test.ts test/business-api.test.ts 2>&1 | tail -10`。

- [ ] **Step 6: 提交**

```bash
git add services/fc/src/lib/pg-repo/auth.ts services/fc/test/pg-repo-claim.test.ts
git commit -m "fix(fc-pg): claimInvite rebinds existing agent when targetActorId set"
```

---

### Task 4: pg listConnectedAgents / listTeamActors 解析 caller actor

**Files:**
- Modify: `services/fc/src/lib/pg-repo/agents.ts`(`listConnectedAgents`,约 43-96)
- Modify: `services/fc/src/lib/pg-repo/actors.ts`(`listTeamActors` 56-71/128-147、`getTeamDirectory` 153-166)
- Test: `services/fc/test/pg-repo-agents.test.ts`(追加)

> 生产工厂不注入 callerActorId → isOwner 恒 false、personal agent 不可见。因为 callerActorId 是 per-team 的,正确做法是在方法内用 `ctx.userId + teamId` 现解析,而非工厂构造时注入。

- [ ] **Step 1: 写失败测试**

追加到 `services/fc/test/pg-repo-agents.test.ts`(复用其 `seedTeam`/`seedMemberActor`/`seedAgentActor` helpers;若签名不同按实际调整):

```ts
test("pg listConnectedAgents marks owner and shows owner's personal agent", async () => {
  const db = await makeTestDb();
  const team = await seedTeam(db);
  const ownerUser = crypto.randomUUID();
  const owner = await seedMemberActor(db, team.id, { userId: ownerUser, role: "owner" });
  // a personal agent owned by `owner`
  const personal = await seedAgentActor(db, team.id, owner.id, "personal");

  const repo = createPgBusinessRepository({ db, userId: ownerUser });
  const list = await repo.listConnectedAgents(team.id);
  const found = list.find((a: any) => a.id === personal.id);
  assert.ok(found, "owner can see their own personal agent");
  assert.equal(found.isOwner, true, "isOwner true for the owner");
});
```
(若 `seedMemberActor`/`seedAgentActor` 现有签名不接受 userId/role 或 ownerId,按 Task 2 Step 2 的内联 seed 方式写。)

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/fc && node --import tsx --test test/pg-repo-agents.test.ts 2>&1 | tail -20`
Expected: 失败 —— `found` 为 undefined(personal 被过滤)或 `isOwner` false。

- [ ] **Step 3: 在 listConnectedAgents 内解析 caller actor**

`services/fc/src/lib/pg-repo/agents.ts` 的 `listConnectedAgents(teamId)`:把第 67 行
```ts
    const callerActorId = ctx.callerActorId;
```
改为(优先用现解析,回退到构造注入值):
```ts
    const callerActorId =
      ctx.callerActorId ??
      (ctx.userId ? await resolveActorForTeam(db, ctx.userId, teamId) : undefined);
```
确保 `agents.ts` 顶部 import 了 `resolveActorForTeam`(from `./authz.js`),且 `makeAgentsRepo(db, ctx)` 的 `db` 在该函数闭包可见(现有代码已是 `db`/`ctx` 闭包)。其余 isOwner / visibility 过滤逻辑不变(它们已正确使用 callerActorId,只是之前恒 undefined)。

- [ ] **Step 4: 同样修 actors.ts 的 listTeamActors / getTeamDirectory**

`services/fc/src/lib/pg-repo/actors.ts`:`listTeamActors(teamId, …)` 与 `getTeamDirectory(teamId)` 里,凡是 `visibilityFilter(ctx.callerActorId)` 处,改为先解析:
```ts
    const callerActorId =
      ctx.callerActorId ??
      (ctx.userId ? await resolveActorForTeam(db, ctx.userId, teamId) : undefined);
    // ...then use callerActorId in visibilityFilter(callerActorId)
```
import `resolveActorForTeam` from `./authz.js`。`visibilityFilter` 签名不变。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd services/fc && node --import tsx --test test/pg-repo-agents.test.ts 2>&1 | tail -20`
Expected: 新测试通过,既有测试无回归。

- [ ] **Step 6: 提交**

```bash
git add services/fc/src/lib/pg-repo/agents.ts services/fc/src/lib/pg-repo/actors.ts services/fc/test/pg-repo-agents.test.ts
git commit -m "fix(fc-pg): resolve caller actor per-team for isOwner + personal visibility"
```

---

## Part T — 契约测试对齐

### Task 5: repository-contract createTeamInvite 改用生产 key

**Files:**
- Modify: `services/fc/src/lib/repository-contract.ts`(约 397-408)

> 契约测试当前用旧 key `actorType`/`role` 调 createTeamInvite,并断言 `inviteId`。Task 2 把 pg 改为读 `kind`/`teamRole`(兼容旧 key),但契约应反映**生产路由实际传的 key**。同时 supabase 与 pg 的返回形状不完全一致(supabase 无 `inviteId`),契约断言收敛到两后端公共字段。

- [ ] **Step 1: 读现状**

Run: `sed -n '395,410p' services/fc/src/lib/repository-contract.ts`

- [ ] **Step 2: 改契约用例**

把该 test 改为:
```ts
  test("repository contract: createTeamInvite returns invite details", async () => {
    const repo = createRepository();
    const result = await repo.createTeamInvite("team-1", {
      kind: "member",
      displayName: "New User",
      teamRole: "member",
      expiresAt: null,
    });
    assert.ok(result.token, "token must be present");
    assert.equal(result.expiresAt, null);
  });
```
(去掉 `inviteId` 断言 —— supabase 返回 `{token, expiresAt, deeplink}` 不含 inviteId;两后端公共字段是 token/expiresAt。)

- [ ] **Step 3: 跑两个契约后端 + 路由测试**

Run: `cd services/fc && node --import tsx --test test/repository-contract.test.ts test/pg-repo-contract.test.ts test/business-api.test.ts 2>&1 | tail -15`
Expected: 全绿。若 `business-api.test.ts` 的 fakeRepo createTeamInvite 桩(test 文件内)因 input 断言旧 key 而失败,把那处断言改为生产 key(`kind`/`teamRole`/`agentKind`/`targetActorId`)以匹配路由实际传参。

- [ ] **Step 4: 全量 typecheck + test**

Run: `cd services/fc && npm run typecheck 2>&1 | tail -5 && npm run test 2>&1 | tail -15`
Expected: typecheck 干净;FC 测试全绿(或仅剩与本计划无关的 pre-existing 失败,需在报告里点名)。

- [ ] **Step 5: 提交**

```bash
git add services/fc/src/lib/repository-contract.ts services/fc/test/business-api.test.ts
git commit -m "test(fc): align createTeamInvite contract to production keys"
```

---

## Self-Review

**Spec coverage(对照核实报告的 4 个缺口):**
- #3 supabase create_team_invite 缺 owner 鉴权(越权) → Task 1 ✅
- #2 pg createTeamInvite 字段映射(kind/agentKind 丢失)+ targetActorId owner 校验 → Task 2 ✅
- #3b pg claimInvite 未实现 targetActorId rebind → Task 3 ✅
- #1 pg listConnectedAgents/listTeamActors callerActorId 未解析(isOwner/personal 可见性) → Task 4 ✅
- 契约/路由测试对齐 → Task 5 ✅
- 新增 Cloud API 端点 / 客户端 UI → **不在本计划**(决策=复用现有端点;UI 属 Block ④)。

**Placeholder 扫描:** Task 1 的"逐字复刻 baseline 3889-3995"不是占位 —— 源是确定行号、改动是单处具体校验,且给了 sed 命令读取;SQL 无本地 harness 时靠签名比对 + 评审,已说明。其余步骤含完整代码/命令。`ctx2`/`daemonUser`/`minted` 等变量名以 Task 3 Step 1 读到的实际命名为准(已显式要求按实际改)。

**类型/命名一致性:** `createTeamInvite` 入参生产 key 统一为 `kind`/`teamRole`/`agentKind`/`targetActorId`(Task 2 实现、Task 5 契约、business-api 路由三处一致);`resolveActorForTeam`/`checkAgentOwnership`/`ApiError` 来源 `./authz.js`/`../http-utils.js` 一致;rebind 设 `visibility="team"`、`ownerMemberId=invitedByActorId` 与 supabase claim_team_invite 7471-7500 对齐。

**风险/前置:**
- supabase 迁移无本地单测,正确性靠精确复刻 + 代码评审 + 上线迁移时验证(若 services/supabase 有 SQL 测试 harness 则补一条)。
- pglite 测试用 Drizzle schema;若某列(如 agentKind)在 schema 缺失,Task 2 Step 1 会发现并需先确认列名。
- 默认 `BACKEND_KIND=supabase`:Task 1 修的是 live 路径;Task 2-4 修的是 postgres 路径,为 fc-drop-supabase 切换做准备。两路独立、互不影响。
