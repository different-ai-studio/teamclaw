# Team-level Default Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a team-level default agent (`amux.teams.default_agent_id`) that acts as a fallback when a member has no per-member default, settable only by team owner/admin, exposed full-stack (DB → FC → desktop → iOS → daemon).

**Architecture:** Mirror the existing per-member default-agent feature. A new column on `amux.teams`, three new `security definer` RPCs (`set_team_default_agent`, `get_team_default_agent`, `get_effective_default_agent`), new FC routes + repository methods (both supabase and pg backends), OpenAPI docs, and client wiring on desktop/iOS/daemon. Resolution (`member ?? team`) happens server-side in `get_effective_default_agent`; the existing `get_member_default_agent` is left untouched so daemon "is-unset?" logic still sees the raw value.

**Tech Stack:** PostgreSQL/plpgsql (Supabase migrations + Drizzle), Node.js 20 FC, React 19/TypeScript/Zustand (desktop), Swift/AMUXCore (iOS), Rust (daemon).

## Global Constraints

- Resolution precedence: `member default > team default > null`. Implemented only in `get_effective_default_agent`. **Do not modify `get_member_default_agent`.**
- Set permission: `amux.current_team_role(p_team_id) in ('owner','admin')` — read is open to any team member.
- Team default agent must be `visibility = 'team'` (stricter than member default, which also allows owner-owned personal agents).
- Storage: `amux.teams.default_agent_id uuid REFERENCES amux.agents(id) ON DELETE SET NULL`.
- All new RPCs: `SECURITY DEFINER`, `SET search_path TO 'amux','public','auth'`, granted to `authenticated`.
- FC error mapping reuses `mapDefaultAgentError` (42501→403, 23514→409, 23503→404) — see `services/fc/src/lib/supabase-repo/shared.ts:43`.
- FC repo casing pitfall: supabase-repo speaks snake_case RPC args / pg-repo speaks camelCase Drizzle columns; keep response shape `{ defaultAgentId }` identical on both paths.
- Backend in production is `BACKEND_KIND=supabase`, but both repo implementations MUST be kept in sync.
- Never push to main; commit per task on the task branch.

---

### Task 1: DB column + RPCs (Supabase migration) with db tests

**Files:**
- Create: `services/supabase/migrations/20260630000000_add_team_default_agent.sql`
- Test: `services/supabase/tests/team_default_agent_test.sql` (pgTAP; follow the existing `services/supabase/tests/` pattern — if member-default has a test file, mirror its harness)

**Interfaces:**
- Produces RPCs:
  - `amux.set_team_default_agent(p_team_id uuid, p_agent_id uuid default null) returns uuid`
  - `amux.get_team_default_agent(p_team_id uuid) returns uuid`
  - `amux.get_effective_default_agent(p_team_id uuid) returns uuid`
- Produces column `amux.teams.default_agent_id uuid`.

- [ ] **Step 1: Write the migration**

```sql
-- 20260630000000_add_team_default_agent.sql
-- Team-level default agent: a single fallback agent for the whole team,
-- settable by owner/admin only. Resolution precedence is member > team.

set search_path = amux, public;

alter table amux.teams
  add column if not exists default_agent_id uuid
  references amux.agents(id) on delete set null;

-- Set the team default. Owner/admin only. Agent must be team-visible & active.
create or replace function amux.set_team_default_agent(
  p_team_id uuid,
  p_agent_id uuid default null
) returns uuid
  language plpgsql security definer
  set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_role       text := amux.current_team_role(p_team_id);
  v_agent_team uuid;
  v_actor_type text;
  v_status     text;
  v_visibility text;
begin
  if v_role is null or v_role not in ('owner','admin') then
    raise exception 'only team owner/admin can set the team default agent'
      using errcode = '42501';
  end if;

  if p_agent_id is not null then
    select a.team_id, a.actor_type, ag.status, ag.visibility
      into v_agent_team, v_actor_type, v_status, v_visibility
      from amux.actors a
      join amux.agents ag on ag.id = a.id
     where a.id = p_agent_id;

    if v_agent_team is null or v_actor_type <> 'agent' or v_agent_team <> p_team_id then
      raise exception 'agent is not in this team' using errcode = '23514';
    end if;
    if v_status <> 'active' then
      raise exception 'agent is not active' using errcode = '23514';
    end if;
    -- Team default must be visible to the whole team (no personal agents).
    if v_visibility <> 'team' then
      raise exception 'team default agent must be team-visible' using errcode = '23514';
    end if;
  end if;

  update amux.teams t
     set default_agent_id = p_agent_id,
         updated_at = now()
   where t.id = p_team_id;

  if not found then
    raise exception 'team not found' using errcode = '23503';
  end if;

  return p_agent_id;
end;
$$;

-- Read the raw team default. Any member may call.
create or replace function amux.get_team_default_agent(p_team_id uuid)
  returns uuid
  language plpgsql stable security definer
  set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_default uuid;
begin
  if v_caller is null then
    raise exception 'caller is not a member of this team' using errcode = '42501';
  end if;
  select t.default_agent_id into v_default from amux.teams t where t.id = p_team_id;
  return v_default;
end;
$$;

-- Resolve the caller's effective default: member default, else team default.
create or replace function amux.get_effective_default_agent(p_team_id uuid)
  returns uuid
  language plpgsql stable security definer
  set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_member uuid;
  v_team   uuid;
begin
  if v_caller is null then
    raise exception 'caller is not a member of this team' using errcode = '42501';
  end if;
  select m.default_agent_id into v_member from amux.members m where m.id = v_caller;
  if v_member is not null then
    return v_member;
  end if;
  select t.default_agent_id into v_team from amux.teams t where t.id = p_team_id;
  return v_team;
end;
$$;

grant execute on function amux.set_team_default_agent(uuid, uuid) to authenticated;
grant execute on function amux.get_team_default_agent(uuid) to authenticated;
grant execute on function amux.get_effective_default_agent(uuid) to authenticated;
```

- [ ] **Step 2: Write the db test**

Mirror the member-default test harness. Cover: (a) owner can set a team-visible active agent; (b) member (non-admin) gets `42501` on set; (c) personal-visibility agent rejected `23514`; (d) inactive agent rejected `23514`; (e) cross-team agent rejected `23514`; (f) `get_effective_default_agent` returns member value when member set, team value when member null, null when both null; (g) deleting the agent row nulls `teams.default_agent_id`.

```sql
-- team_default_agent_test.sql (pgTAP skeleton — fill team/agent fixtures per
-- the existing member_default test file in services/supabase/tests/)
begin;
select plan(7);
-- ... create org/team/owner/member/agents fixtures ...
-- (1) owner sets team-visible active agent
select lives_ok($$ select amux.set_team_default_agent('<team>','<team_agent>') $$,
  'owner can set team-visible active agent');
-- (2) non-admin member cannot set
select throws_ok($$ select amux.set_team_default_agent('<team>','<team_agent>') $$,
  '42501', null, 'non-admin cannot set team default');
-- (3) personal agent rejected
select throws_ok($$ select amux.set_team_default_agent('<team>','<personal_agent>') $$,
  '23514', null, 'personal agent rejected');
-- (4) inactive agent rejected
select throws_ok($$ select amux.set_team_default_agent('<team>','<disabled_agent>') $$,
  '23514', null, 'inactive agent rejected');
-- (5) effective falls back to team when member unset
select is(amux.get_effective_default_agent('<team>'), '<team_agent>'::uuid,
  'effective falls back to team default');
-- (6) effective prefers member when set
-- (after set_member_default_agent ...)
select is(amux.get_effective_default_agent('<team>'), '<member_agent>'::uuid,
  'effective prefers member default');
-- (7) ON DELETE SET NULL
-- (delete the team_agent actor/agent row, expect get_team_default_agent -> null)
select is(amux.get_team_default_agent('<team>'), null::uuid,
  'agent delete nulls team default');
select * from finish();
rollback;
```

- [ ] **Step 3: Run the db test**

Run: `pnpm --filter @teamclaw/supabase test` (or the repo's documented db test command, e.g. `supabase test db`).
Expected: all assertions PASS.

- [ ] **Step 4: Commit**

```bash
git add services/supabase/migrations/20260630000000_add_team_default_agent.sql services/supabase/tests/team_default_agent_test.sql
git commit -m "feat(db): team default agent column + RPCs"
```

---

### Task 2: FC Drizzle migration + schema (pg backend parity)

**Files:**
- Create: `services/fc/src/db/migrations/0009_add_team_default_agent.sql`
- Modify: the Drizzle teams table schema (find with `grep -rn "export const teams" services/fc/src/db/schema*`) — add `defaultAgentId`.

**Interfaces:**
- Produces: `teams.defaultAgentId` Drizzle column for use in `pg-repo`.

- [ ] **Step 1: Write the migration**

```sql
-- 0009_add_team_default_agent.sql
ALTER TABLE "teams" ADD COLUMN "default_agent_id" uuid
  REFERENCES "agents"("id") ON DELETE set null;
```

- [ ] **Step 2: Add the schema column**

In the Drizzle teams table definition, add (matching the `members.defaultAgentId` style used in the same schema file):

```ts
defaultAgentId: uuid("default_agent_id"),
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter ./services/fc typecheck` (or `cd services/fc && pnpm tsc --noEmit`)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/fc/src/db/
git commit -m "feat(fc): team default agent drizzle column"
```

---

### Task 3: FC repository contract + both implementations

**Files:**
- Modify: `services/fc/src/lib/repository-contract.ts` (add the three methods to the Repository interface, next to `getMemberDefaultAgent`/`setMemberDefaultAgent`)
- Modify: `services/fc/src/lib/supabase-repo.ts` (after line 364, `setMemberDefaultAgent`)
- Modify: `services/fc/src/lib/pg-repo/actors.ts` (after the `setMemberDefaultAgent` block ending ~line 300)
- Test: `services/fc/test/` — add cases to the existing default-agent repository test (find with `grep -rln "MemberDefaultAgent" services/fc/test`)

**Interfaces:**
- Consumes: `mapDefaultAgentError` from `services/fc/src/lib/supabase-repo/shared.ts`.
- Produces (all return `{ defaultAgentId: string | null }`):
  - `getTeamDefaultAgent(teamId)`
  - `setTeamDefaultAgent(teamId, agentId)`
  - `getEffectiveDefaultAgent(teamId)`

- [ ] **Step 1: Add to the repository contract**

In `repository-contract.ts`, beside the member default methods, add the signatures (match the file's existing declaration style):

```ts
getTeamDefaultAgent(teamId: string): Promise<{ defaultAgentId: string | null }>;
setTeamDefaultAgent(teamId: string, agentId: string | null): Promise<{ defaultAgentId: string | null }>;
getEffectiveDefaultAgent(teamId: string): Promise<{ defaultAgentId: string | null }>;
```

- [ ] **Step 2: Implement in supabase-repo.ts**

Insert after `setMemberDefaultAgent` (line 364):

```ts
    async getTeamDefaultAgent(teamId) {
      const { data, error } = await supabase.rpc("get_team_default_agent", {
        p_team_id: teamId,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async setTeamDefaultAgent(teamId, agentId) {
      const { data, error } = await supabase.rpc("set_team_default_agent", {
        p_team_id: teamId,
        p_agent_id: agentId ?? null,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async getEffectiveDefaultAgent(teamId) {
      const { data, error } = await supabase.rpc("get_effective_default_agent", {
        p_team_id: teamId,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },
```

- [ ] **Step 3: Implement in pg-repo/actors.ts**

Insert after the `setMemberDefaultAgent` block. Reuse the imports already present in the file (`db`, `teams`, `members`, `actors`, `agents`, `eq`, `requireActorForTeam`, `ApiError`). Add a `teamRole` lookup helper inline (the file already resolves caller actor; mirror the role check via `team_members`).

```ts
    async getTeamDefaultAgent(teamId: string) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      await requireActorForTeam(db, ctx.userId, teamId); // membership gate
      const [r] = await db
        .select({ defaultAgentId: teams.defaultAgentId })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);
      return { defaultAgentId: (r?.defaultAgentId ?? null) as string | null };
    },

    async setTeamDefaultAgent(teamId: string, agentId: string | null) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      const callerActorId = await requireActorForTeam(db, ctx.userId, teamId);
      // owner/admin gate
      const [tm] = await db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.memberId, callerActorId)))
        .limit(1);
      if (!tm || (tm.role !== "owner" && tm.role !== "admin")) {
        throw new ApiError(403, "forbidden", "only team owner/admin can set the team default agent");
      }
      if (agentId != null) {
        const [ag] = await db
          .select({
            teamId: actors.teamId,
            actorType: actors.actorType,
            status: agents.status,
            visibility: agents.visibility,
          })
          .from(actors)
          .innerJoin(agents, eq(agents.id, actors.id))
          .where(eq(actors.id, agentId))
          .limit(1);
        if (!ag || ag.actorType !== "agent" || ag.teamId !== teamId) {
          throw new ApiError(409, "invalid_agent", "agent is not in this team");
        }
        if (ag.status !== "active") {
          throw new ApiError(409, "invalid_agent", "agent is not active");
        }
        if (ag.visibility !== "team") {
          throw new ApiError(409, "invalid_agent", "team default agent must be team-visible");
        }
      }
      const [r] = await (db.update(teams) as any)
        .set({ defaultAgentId: agentId, updatedAt: new Date() })
        .where(eq(teams.id, teamId))
        .returning({ defaultAgentId: teams.defaultAgentId });
      return { defaultAgentId: (r?.defaultAgentId ?? null) as string | null };
    },

    async getEffectiveDefaultAgent(teamId: string) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      const callerActorId = await requireActorForTeam(db, ctx.userId, teamId);
      const [m] = await db
        .select({ defaultAgentId: members.defaultAgentId })
        .from(members)
        .where(eq(members.id, callerActorId))
        .limit(1);
      if (m?.defaultAgentId) return { defaultAgentId: m.defaultAgentId as string };
      const [t] = await db
        .select({ defaultAgentId: teams.defaultAgentId })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);
      return { defaultAgentId: (t?.defaultAgentId ?? null) as string | null };
    },
```

Add imports at the top of the file if missing: `teams`, `teamMembers` (from the Drizzle schema) and `and` (from `drizzle-orm`).

- [ ] **Step 4: Add repository tests**

Mirror the existing member-default repo tests: assert shape `{ defaultAgentId }`, the 403 for non-admin set, the 409 for personal/inactive/cross-team agent, and effective fallback. If a fake/mock repository exists in the test harness, add the three methods there too.

- [ ] **Step 5: Run FC tests**

Run: `pnpm --filter ./services/fc test`
Expected: PASS (new + existing).

- [ ] **Step 6: Commit**

```bash
git add services/fc/src/lib/ services/fc/test/
git commit -m "feat(fc): team default agent repository methods (supabase + pg)"
```

---

### Task 4: FC routes + route tests

**Files:**
- Modify: `services/fc/src/lib/routes/actors.ts` (after the member default routes, ~line 88) OR a team-scoped routes file if one fits better (`grep -rn "workspace-defaults" services/fc/src/lib/routes`). Place the two team routes next to where teams routes live; place the effective route next to the member default route in `actors.ts`.
- Test: `services/fc/test/` route tests (mirror member default route test).

**Interfaces:**
- Consumes: `ctx.repository.{getTeamDefaultAgent,setTeamDefaultAgent,getEffectiveDefaultAgent}`.
- Produces routes:
  - `GET  /v1/teams/:teamId/default-agent` → `{ defaultAgentId }`
  - `PUT  /v1/teams/:teamId/default-agent` body `{ agentId }` → `{ defaultAgentId }`
  - `GET  /v1/teams/:teamId/members/me/effective-default-agent` → `{ defaultAgentId }`

- [ ] **Step 1: Add the routes**

```ts
  // Team-level default agent (fallback when a member has no default). Owner/
  // admin only on PUT — enforced in the RPC/repository layer.
  router.get("/v1/teams/:teamId/default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const result = await ctx.repository.getTeamDefaultAgent(teamId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  router.put("/v1/teams/:teamId/default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const body = ctx.json ?? {};
    const agentId =
      body.agentId === undefined || body.agentId === null ? null : String(body.agentId);
    const result = await ctx.repository.setTeamDefaultAgent(teamId, agentId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  // Effective default for the calling member (member default, else team default).
  router.get("/v1/teams/:teamId/members/me/effective-default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const result = await ctx.repository.getEffectiveDefaultAgent(teamId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });
```

- [ ] **Step 2: Write route tests**

Mirror member-default route tests: GET returns shape, PUT happy path, PUT by non-admin → 403, PUT with bad agent → 409, effective endpoint reflects fallback.

- [ ] **Step 3: Run FC tests**

Run: `pnpm --filter ./services/fc test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/fc/src/lib/routes/ services/fc/test/
git commit -m "feat(fc): team default agent routes"
```

---

### Task 5: OpenAPI documentation

**Files:**
- Modify: `docs/openapi/teamclaw-api.v1.yaml` (add paths near the team workspace endpoints, ~line 1078)

- [ ] **Step 1: Add the three paths**

Document `GET /v1/teams/{teamId}/default-agent`, `PUT /v1/teams/{teamId}/default-agent` (body `{ agentId: string|null }`, responses 200 / 403 / 409), and `GET /v1/teams/{teamId}/members/me/effective-default-agent`. Response schema for all: `{ defaultAgentId: string | null }`. Reuse the existing error response components.

- [ ] **Step 2: Validate the spec**

Run: the repo's OpenAPI lint/validate command if one exists (`grep -rn "openapi" services/fc/package.json package.json`); otherwise YAML-parse check.
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add docs/openapi/teamclaw-api.v1.yaml
git commit -m "docs(openapi): team default agent endpoints"
```

---

### Task 6: Desktop client (provider + store + settings UI)

**Files:**
- Modify: `packages/app/src/lib/backend/types.ts` (after line 584 — the `ActorsBackend` interface)
- Modify: `packages/app/src/lib/backend/cloud-api/actors.ts` (after line 192)
- Modify: `packages/app/src/stores/member-preferences-store.ts` (add team-default + effective state, mirroring the member-default actions at lines 19/43/58)
- Create/Modify: a team settings section component for the owner/admin-only picker (find the team settings file with `grep -rln "TeamShareSection\|团队" packages/app/src/components/settings`)
- Test: `packages/app/src/lib/backend/cloud-api/__tests__/actors.test.ts` (mirror existing default-agent cases)

**Interfaces:**
- Consumes: `client.get`/`client.put` from the cloud-api client.
- Produces on `ActorsBackend`:
  - `getTeamDefaultAgent(teamId): Promise<string | null>`
  - `setTeamDefaultAgent(teamId, agentId): Promise<string | null>`
  - `getEffectiveDefaultAgent(teamId): Promise<string | null>`

- [ ] **Step 1: Add to the backend interface (types.ts, after line 584)**

```ts
  getTeamDefaultAgent(teamId: string): Promise<string | null>;
  setTeamDefaultAgent(teamId: string, agentId: string | null): Promise<string | null>;
  getEffectiveDefaultAgent(teamId: string): Promise<string | null>;
```

- [ ] **Step 2: Implement in cloud-api/actors.ts (after line 192)**

```ts
    async getTeamDefaultAgent(teamId: string): Promise<string | null> {
      const out = await client.get<{ defaultAgentId: string | null }>(
        `/v1/teams/${encodeURIComponent(teamId)}/default-agent`,
      );
      return out.defaultAgentId ?? null;
    },
    async setTeamDefaultAgent(teamId: string, agentId: string | null): Promise<string | null> {
      const out = await client.put<{ defaultAgentId: string | null }>(
        `/v1/teams/${encodeURIComponent(teamId)}/default-agent`,
        { agentId: agentId ?? null },
      );
      return out.defaultAgentId ?? null;
    },
    async getEffectiveDefaultAgent(teamId: string): Promise<string | null> {
      const out = await client.get<{ defaultAgentId: string | null }>(
        `/v1/teams/${encodeURIComponent(teamId)}/members/me/effective-default-agent`,
      );
      return out.defaultAgentId ?? null;
    },
```

- [ ] **Step 3: Write the provider test**

In `__tests__/actors.test.ts`, mirror the member-default test: assert each method calls the right URL and unwraps `defaultAgentId`.

- [ ] **Step 4: Run provider tests**

Run: `pnpm --filter @teamclaw/app test:unit -- actors`
Expected: PASS.

- [ ] **Step 5: Extend member-preferences-store**

Add `teamDefaultAgentId` + `effectiveDefaultAgentId` state and `loadTeamDefaultAgent(teamId)`, `setTeamDefaultAgent(teamId, agentId)`, `loadEffectiveDefaultAgent(teamId)` actions, mirroring lines 19/43/58 (same team-switch race guard). Reuse `getBackend().actors.*`.

- [ ] **Step 6: Add the settings picker**

In the team settings section, add a "团队默认 Agent" picker shown only when the current user's team role is owner/admin (the role is already available via the team store; find with `grep -rn "current_team_role\|teamRole\|role === 'owner'" packages/app/src`). The picker lists team-visible agents (reuse the existing agent list source used by the member-default picker) and calls `setTeamDefaultAgent`. Add i18n keys to the locale files (zh-CN + en) — remember the i18n-parity guard requires both.

- [ ] **Step 7: Typecheck + lint + unit**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: PASS (no new failures; i18n-parity green).

- [ ] **Step 8: Commit**

```bash
git add packages/app/src
git commit -m "feat(desktop): team default agent provider, store, settings picker"
```

---

### Task 7: iOS client (CloudAPIRepositories + settings UI)

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/CloudAPI/CloudAPIRepositories.swift` (methods after line 406; structs after line 974)
- Modify: the iOS team settings view (find with `grep -rln "getMemberDefaultAgent\|My Default\|默认" apps/ios/Sources` or the relevant SwiftUI settings file)
- Test: `apps/ios/Packages/AMUXCore/Tests/` default-agent test (mirror member-default if present)

**Interfaces:**
- Produces on the repository:
  - `getTeamDefaultAgent(teamID:) async throws -> String?`
  - `setTeamDefaultAgent(teamID:agentID:) async throws -> String?`
  - `getEffectiveDefaultAgent(teamID:) async throws -> String?`

- [ ] **Step 1: Add the methods (after line 406)**

```swift
    public func getTeamDefaultAgent(teamID: String) async throws -> String? {
        let row: CloudMemberDefaultAgent = try await client.get(
            "/v1/teams/\(Self.enc(teamID))/default-agent"
        )
        return row.defaultAgentId
    }

    public func setTeamDefaultAgent(teamID: String, agentID: String?) async throws -> String? {
        let body = CloudSetMemberDefaultAgentRequest(agentId: agentID)
        try await client.putVoid("/v1/teams/\(Self.enc(teamID))/default-agent", body: body)
        return agentID
    }

    public func getEffectiveDefaultAgent(teamID: String) async throws -> String? {
        let row: CloudMemberDefaultAgent = try await client.get(
            "/v1/teams/\(Self.enc(teamID))/members/me/effective-default-agent"
        )
        return row.defaultAgentId
    }
```

(Reuse the existing `CloudMemberDefaultAgent` / `CloudSetMemberDefaultAgentRequest` structs — shapes are identical.)

- [ ] **Step 2: Add the settings UI**

In the team settings view, add an owner/admin-only "团队默认 Agent" picker listing team-visible agents, calling `setTeamDefaultAgent`. Gate on the member's team role (available in the team model). Use the effective endpoint wherever the view currently reads the member default for "new session" defaulting.

- [ ] **Step 3: Run AMUXCore tests**

Run: `pnpm ios:test:core`
Expected: PASS.

- [ ] **Step 4: Build the iOS app**

Run: `pnpm ios:build`
Expected: BUILD SUCCEEDED. (Note: `ios:build` does not run xcodegen — run `cd apps/ios && xcodegen` first if project.yml changed.)

- [ ] **Step 5: Commit**

```bash
git add apps/ios
git commit -m "feat(ios): team default agent repository + settings picker"
```

---

### Task 8: daemon cloud_api client method (parity)

**Files:**
- Modify: `apps/daemon/src/backend/mod.rs` (backend trait — add method signature near other cloud calls)
- Modify: `apps/daemon/src/backend/cloud_api/mod.rs` (implement HTTP GET to the effective endpoint)
- Modify: `apps/daemon/src/backend/mock.rs` (mock impl returning a configured value)
- Test: a unit test in `cloud_api/mod.rs` (`#[cfg(test)]`) mirroring the existing `default_agent_type` defaults test (~line 1783)

**Interfaces:**
- Produces: `Backend::get_effective_default_agent(&self, team_id: &str) -> Result<Option<String>>` returning the resolved agent actor id.

**Note:** The daemon currently routes gateway/channel sessions to its own `actor_id` (see `channels.rs:25`), so there is no existing consumer that must change. This task adds the client capability for parity (and for future "daemon picks the team default" use). Do **not** invent a consumer; the per-member auto-set path keeps using `get_member_default_agent` (raw) unchanged.

- [ ] **Step 1: Add the trait method (mod.rs)**

```rust
async fn get_effective_default_agent(&self, team_id: &str) -> anyhow::Result<Option<String>>;
```

- [ ] **Step 2: Implement in cloud_api/mod.rs**

Mirror an existing GET helper in the file. Endpoint: `GET /v1/teams/{team_id}/members/me/effective-default-agent`, response `{ "defaultAgentId": <string|null> }`.

```rust
async fn get_effective_default_agent(&self, team_id: &str) -> anyhow::Result<Option<String>> {
    #[derive(serde::Deserialize)]
    struct Resp { #[serde(rename = "defaultAgentId")] default_agent_id: Option<String> }
    let path = format!("/v1/teams/{}/members/me/effective-default-agent", team_id);
    let resp: Resp = self.get_json(&path).await?; // use the file's existing GET helper name
    Ok(resp.default_agent_id)
}
```

(Replace `self.get_json` with whatever authenticated-GET helper the file already uses.)

- [ ] **Step 3: Implement the mock (mock.rs)**

```rust
async fn get_effective_default_agent(&self, _team_id: &str) -> anyhow::Result<Option<String>> {
    Ok(None)
}
```

- [ ] **Step 4: Add a unit test**

```rust
#[tokio::test]
async fn parses_effective_default_agent() {
    // build a mock HTTP server returning {"defaultAgentId":"agent-123"} for the
    // effective endpoint (mirror the existing defaults-parsing test at ~line 1783),
    // then assert get_effective_default_agent(...) == Some("agent-123".into()).
}
```

- [ ] **Step 5: Build + test the daemon binary**

Run: `cargo test -p amuxd --bin amuxd get_effective_default_agent`
Expected: PASS. (Use `--bin amuxd`; the `tests/` integration crate is pre-existing-broken — do not rely on it.)

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src
git commit -m "feat(daemon): cloud_api effective default agent accessor"
```

---

## Self-Review

- **Spec coverage:** data model (Task 1/2), three RPCs server-side resolution (Task 1), owner/admin gate (Task 1 RPC + Task 3 pg-repo), team-visibility gate (Task 1/3), FC routes (Task 4), OpenAPI (Task 5), desktop (Task 6), iOS (Task 7), daemon (Task 8). `get_member_default_agent` left untouched (Global Constraints + Task 1 note). All spec sections map to a task.
- **Placeholder scan:** db-test fixtures and the daemon mock-HTTP test body are described rather than fully literal because they depend on the repo's existing test harnesses (pgTAP fixture style; daemon mock server helper); every production code change has literal code. Locale/i18n keys and the exact settings-file paths are resolved via the given `grep` commands.
- **Type consistency:** response shape `{ defaultAgentId: string|null }` is identical across DB scalar → FC `{ defaultAgentId }` → desktop `string|null` → iOS `String?` → daemon `Option<String>`. Method names: `getTeamDefaultAgent` / `setTeamDefaultAgent` / `getEffectiveDefaultAgent` used consistently in every layer.
