# Apps Module — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "apps" module where a user creates a full-stack app (TanStack + Postgres) that owns a dedicated git repo, a 1:1 workspace, and multiple sessions; the daemon seeds a starter template into the repo; FC fields are stubbed for a future deploy phase.

**Architecture:** New `amux.apps` + `amux.app_member_access` tables and a nullable `sessions.app_id`. FC Cloud API gains `/v1/apps` CRUD (pg-repo mirroring the sessions pattern) and an extended `managed-git/create-repo` that names per-app repos. The amuxd daemon clones the empty app repo, writes a bundled `templates/tanstack-postgres/` starter, makes the first commit, and pushes. Desktop adds an "Apps" sidebar entry → second-column list → opens the app's most-recent session.

**Tech Stack:** Postgres + RLS (Supabase migrations), Drizzle ORM + Hono (FC, Node 20, TypeScript), Rust/tokio (amuxd daemon, git CLI shell-out), React 19 + Zustand + i18next (desktop).

**Spec:** `docs/specs/2026-06-14-apps-module-design.md`

**Branch / worktree:** `agent/apps-module` at `.worktrees/apps-module`. All work happens here.

**Conventions discovered (mirror these exactly):**
- amux tables use **RLS policies + schema-usage grant** (already granted in `20260608010000_move_teamclaw_to_amux.sql`) + `PGRST_DB_SCHEMAS` (ops-set). Mirror `agents_select_if_visible` (migration `20260612010000_agents_select_self_for_self_update.sql`). Do **not** add per-table GRANT or `NOTIFY pgrst` in the migration.
- FC entity flow: Drizzle schema (`services/fc/src/db/schema/<x>.ts` + re-export in `index.ts`) → pg-repo factory (`services/fc/src/lib/pg-repo/<x>.ts`, wired in `pg-repo/index.ts`) → routes (`services/fc/src/lib/routes/<x>.ts`) → contract test (`services/fc/src/lib/repository-contract.ts`) → client provider.
- Server-side identity only: resolve the actor from `ctx.userId` via `requireActorForTeam` / `resolveActorForTeam` (`services/fc/src/lib/pg-repo/authz.ts`). Never trust a client-supplied actorId.
- Daemon git: shell out via `git_owned_env` / `git`, credentials embedded via `embed_token_in_url` (`apps/daemon/src/sync/git.rs`).
- Desktop: backend module (`packages/app/src/lib/backend/cloud-api/<x>.ts`) + interface in `types.ts` + Zustand store mirroring `stores/team-share-browser.ts` + sidebar entry in `components/sidebar/`.

**Commit discipline:** one commit per task (or per green test where noted). Commit message footer:
```
Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
```

---

## Phase A — Data layer (Drizzle schema + SQL migration)

### Task A1: Drizzle schema for `apps` + `app_member_access`

**Files:**
- Create: `services/fc/src/db/schema/apps.ts`
- Modify: `services/fc/src/db/schema/index.ts` (add re-export)
- Modify: `services/fc/src/db/schema/sessions.ts` (add `appId` column)

- [ ] **Step 1: Create the Drizzle schema file**

Create `services/fc/src/db/schema/apps.ts`:

```typescript
import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { actors, members } from "./teams.js";
import { workspaces } from "./workspaces.js";

export const apps = pgTable("apps", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  createdByActorId: uuid("created_by_actor_id").notNull().references(() => actors.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  type: text("type").notNull(),
  visibility: text("visibility").notNull().default("personal"),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  gitRemoteUrl: text("git_remote_url"),
  gitAuthKind: text("git_auth_kind"),
  provisionStatus: text("provision_status").notNull().default("pending"),
  provisionError: text("provision_error"),
  fcFunctionName: text("fc_function_name"),
  fcRegion: text("fc_region"),
  fcEndpoint: text("fc_endpoint"),
  fcStatus: text("fc_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  teamSlugUniq: unique("apps_team_slug_uniq").on(t.teamId, t.slug),
  workspaceUniq: unique("apps_workspace_uniq").on(t.workspaceId),
}));

export const appMemberAccess = pgTable("app_member_access", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: uuid("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  permissionLevel: text("permission_level").notNull(),
  grantedByMemberId: uuid("granted_by_member_id").references(() => members.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appMemberUniq: unique("app_member_access_app_member_uniq").on(t.appId, t.memberId),
}));
```

- [ ] **Step 2: Re-export from the schema index**

In `services/fc/src/db/schema/index.ts`, add after the `oss-sync.js` line:

```typescript
export * from "./apps.js";
```

- [ ] **Step 3: Add `appId` to the sessions schema**

In `services/fc/src/db/schema/sessions.ts`, inside the `sessions` pgTable definition, add this column right after `primaryAgentId`:

```typescript
  appId: uuid("app_id"),
```

(Leave it a plain nullable column — the FK is enforced by the SQL migration; the Drizzle test DB only needs the column to exist.)

- [ ] **Step 4: Typecheck**

Run: `cd services/fc && npx tsc --noEmit`
Expected: PASS (no new errors referencing apps.ts).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/openbeta/workspace/teamclaw-v2/.worktrees/apps-module
git add services/fc/src/db/schema/apps.ts services/fc/src/db/schema/index.ts services/fc/src/db/schema/sessions.ts
git commit -m "feat(apps): drizzle schema for apps + app_member_access + sessions.app_id"
```

---

### Task A2: SQL migration (production schema + RLS)

**Files:**
- Create: `services/supabase/migrations/20260614000000_apps_module.sql`

- [ ] **Step 1: Write the migration**

Create `services/supabase/migrations/20260614000000_apps_module.sql`:

```sql
-- Apps module (phase 1): apps own a 1:1 workspace + dedicated git repo.
-- Visibility mirrors agents (personal|team), enforced by RLS + app-layer filter.

create table if not exists amux.apps (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references amux.teams(id) on delete cascade,
  created_by_actor_id uuid not null references amux.actors(id) on delete restrict,
  name text not null,
  slug text not null,
  type text not null,
  visibility text not null default 'personal' check (visibility in ('personal', 'team')),
  workspace_id uuid references amux.workspaces(id) on delete set null,
  git_remote_url text,
  git_auth_kind text,
  provision_status text not null default 'pending'
    check (provision_status in ('pending', 'repo_created', 'seeding', 'ready', 'error')),
  provision_error text,
  fc_function_name text,
  fc_region text,
  fc_endpoint text,
  fc_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, slug),
  unique (workspace_id)
);

create table if not exists amux.app_member_access (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references amux.apps(id) on delete cascade,
  member_id uuid not null references amux.members(id) on delete cascade,
  permission_level text not null check (permission_level in ('view', 'prompt', 'admin')),
  granted_by_member_id uuid null references amux.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_id, member_id)
);

alter table amux.sessions
  add column if not exists app_id uuid references amux.apps(id) on delete set null;

alter table amux.apps enable row level security;
alter table amux.app_member_access enable row level security;

-- SELECT: team-visible to all members; personal visible to creator + granted members.
create policy apps_select_if_visible on amux.apps
for select to authenticated using (
  app.is_team_member(apps.team_id)
  and (
    apps.visibility = 'team'
    or apps.created_by_actor_id = app.current_actor_id_for_team(apps.team_id)
    or exists (
      select 1 from amux.app_member_access ama
       where ama.app_id = apps.id
         and ama.member_id = app.current_actor_id_for_team(apps.team_id)
    )
  )
);

-- INSERT: any team member may create an app in their team.
create policy apps_insert_if_team_member on amux.apps
for insert to authenticated with check (
  app.is_team_member(apps.team_id)
  and apps.created_by_actor_id = app.current_actor_id_for_team(apps.team_id)
);

-- UPDATE: creator only (rename / visibility / provision status writeback).
create policy apps_update_if_creator on amux.apps
for update to authenticated using (
  apps.created_by_actor_id = app.current_actor_id_for_team(apps.team_id)
) with check (
  apps.created_by_actor_id = app.current_actor_id_for_team(apps.team_id)
);

-- app_member_access: visible to the member themselves or the app creator; managed by creator.
create policy app_member_access_select on amux.app_member_access
for select to authenticated using (
  member_id = app.current_member_id()
  or exists (
    select 1 from amux.apps a
     where a.id = app_member_access.app_id
       and a.created_by_actor_id = app.current_actor_id_for_team(a.team_id)
  )
);

create policy app_member_access_manage on amux.app_member_access
for all to authenticated using (
  exists (
    select 1 from amux.apps a
     where a.id = app_member_access.app_id
       and a.created_by_actor_id = app.current_actor_id_for_team(a.team_id)
  )
) with check (
  exists (
    select 1 from amux.apps a
     where a.id = app_member_access.app_id
       and a.created_by_actor_id = app.current_actor_id_for_team(a.team_id)
  )
);
```

- [ ] **Step 2: Verify the helper functions referenced exist**

Run: `grep -rn "current_actor_id_for_team\|is_team_member\|current_member_id" services/supabase/migrations/ | grep "create.*function\|create or replace function"`
Expected: each helper (`app.current_actor_id_for_team`, `app.is_team_member`, `app.current_member_id`) appears as a defined function. If `current_actor_id_for_team` is absent, fall back to the form used by `agents_select_if_visible` in `20260612010000_agents_select_self_for_self_update.sql` and match its exact helper names.

- [ ] **Step 3: Commit**

```bash
git add services/supabase/migrations/20260614000000_apps_module.sql
git commit -m "feat(apps): migration for apps + app_member_access + sessions.app_id + RLS"
```

> **Ops note (not in this migration):** production deploy must ensure `amux` is in `PGRST_DB_SCHEMAS` (already true) and reload PostgREST after apply. Capture this in the PR description per the partner RDS schema-cache lesson; do not encode it as migration SQL.

---

## Phase B — FC Cloud API

### Task B1: pg-repo `apps` factory — `createApp` + `getApp`

**Files:**
- Create: `services/fc/src/lib/pg-repo/apps.ts`
- Modify: `services/fc/src/lib/pg-repo/index.ts` (wire factory)
- Test: `services/fc/test/pg-repo-apps.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/fc/test/pg-repo-apps.test.ts` (mirror `pg-repo-sessions.test.ts` seed helpers):

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./helpers/test-db.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers } from "../src/db/schema/index.js";

async function seedTeam(db: any) {
  const [t] = await db.insert(teams).values({ name: "T", slug: `t-${Math.random()}` }).returning();
  return t;
}
async function seedActor(db: any, teamId: string, userId = `user-${Math.random()}`) {
  const [actor] = await db.insert(actors).values({
    teamId, actorType: "member", displayName: "A", userId,
  }).returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

test("createApp inserts a workspace + app and returns canonical fields", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const app = await repo.createApp({
    teamId: team.id, name: "My App", type: "fullstack_tanstack_postgres", visibility: "personal",
  });

  assert.deepEqual(Object.keys(app).sort(), [
    "createdAt", "fcStatus", "gitRemoteUrl", "id", "name", "provisionStatus",
    "slug", "teamId", "type", "updatedAt", "visibility", "workspaceId",
  ].sort());
  assert.equal(app.teamId, team.id);
  assert.equal(app.provisionStatus, "pending");
  assert.ok(app.workspaceId, "app must be linked to a workspace");

  const fetched = await repo.getApp(app.id);
  assert.equal(fetched.id, app.id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/fc && node --test --import tsx test/pg-repo-apps.test.ts`
Expected: FAIL with "createApp is not a function" (or test-db helper import error — if the helper path differs, fix the import to match `pg-repo-sessions.test.ts`'s actual harness before continuing).

- [ ] **Step 3: Write the repo factory**

Create `services/fc/src/lib/pg-repo/apps.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { apps, workspaces } from "../../db/schema/index.js";
import { requireActorForTeam, resolveActorForTeam } from "./authz.js";

type AppsCtx = { userId?: string };
type DbLike = any;

function slugify(name: string): string {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app";
}

const iso = (v: any): string | null => (v ? new Date(v).toISOString() : null);

function mapApp(r: any) {
  return {
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    slug: r.slug,
    type: r.type,
    visibility: r.visibility,
    workspaceId: r.workspaceId ?? null,
    gitRemoteUrl: r.gitRemoteUrl ?? null,
    provisionStatus: r.provisionStatus,
    fcStatus: r.fcStatus ?? null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

export function makeAppsRepo(db: DbLike, ctx: AppsCtx = {}) {
  return {
    async createApp(input: {
      teamId: string;
      name: string;
      type: string;
      visibility?: string;
    }) {
      if (!ctx.userId) throw new Error("unauthenticated");
      const createdByActorId = await requireActorForTeam(db, ctx.userId, input.teamId);
      const slug = slugify(input.name);

      // 1:1 workspace for the app.
      const [ws] = await db.insert(workspaces).values({
        teamId: input.teamId,
        createdByMemberId: createdByActorId,
        name: `app-${slug}-${Math.random().toString(36).slice(2, 8)}`,
      }).returning();

      const [row] = await db.insert(apps).values({
        teamId: input.teamId,
        createdByActorId,
        name: input.name,
        slug,
        type: input.type,
        visibility: input.visibility === "team" ? "team" : "personal",
        workspaceId: ws.id,
        provisionStatus: "pending",
      }).returning();

      return mapApp(row);
    },

    async getApp(appId: string) {
      const [row] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
      if (!row) return null;
      if (ctx.userId) {
        // Visibility gate: caller must be able to see this app's team & visibility.
        const callerActorId = await resolveActorForTeam(db, ctx.userId, row.teamId);
        if (!callerActorId) return null;
        if (row.visibility !== "team" && row.createdByActorId !== callerActorId) {
          // (app_member_access grants are checked in listApps; getApp keeps creator/team gate.)
          return null;
        }
      }
      return mapApp(row);
    },
  };
}
```

- [ ] **Step 4: Wire the factory into the repository**

In `services/fc/src/lib/pg-repo/index.ts`:
- Add import near the other `make*Repo` imports:
  ```typescript
  import { makeAppsRepo } from "./apps.js";
  ```
- Add the repo instance near `const agentsRepo = makeAgentsRepo(db, ctx);`:
  ```typescript
  const appsRepo = makeAppsRepo(db, ctx);
  ```
- Spread it into the returned object near `...agentsRepo,`:
  ```typescript
  ...appsRepo,
  ```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd services/fc && node --test --import tsx test/pg-repo-apps.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/fc/src/lib/pg-repo/apps.ts services/fc/src/lib/pg-repo/index.ts services/fc/test/pg-repo-apps.test.ts
git commit -m "feat(apps): pg-repo createApp + getApp with 1:1 workspace"
```

---

### Task B2: pg-repo `listApps` (visibility-filtered) + `updateApp` + `listAppSessions`

**Files:**
- Modify: `services/fc/src/lib/pg-repo/apps.ts`
- Test: `services/fc/test/pg-repo-apps.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `services/fc/test/pg-repo-apps.test.ts`:

```typescript
test("listApps hides another member's personal app but shows team apps", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedActor(db, team.id);
  const other = await seedActor(db, team.id);

  const ownerRepo = createPgBusinessRepository({ db, userId: owner.userId });
  const otherRepo = createPgBusinessRepository({ db, userId: other.userId });

  await ownerRepo.createApp({ teamId: team.id, name: "Private", type: "fullstack_tanstack_postgres", visibility: "personal" });
  await ownerRepo.createApp({ teamId: team.id, name: "Shared", type: "fullstack_tanstack_postgres", visibility: "team" });

  const ownerList = await ownerRepo.listApps({ teamId: team.id });
  const otherList = await otherRepo.listApps({ teamId: team.id });

  assert.equal(ownerList.length, 2, "owner sees both");
  assert.deepEqual(otherList.map((a: any) => a.name).sort(), ["Shared"], "other sees only the team app");
});

test("updateApp renames and changes visibility", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const app = await repo.createApp({ teamId: team.id, name: "Before", type: "fullstack_tanstack_postgres", visibility: "personal" });
  const updated = await repo.updateApp(app.id, { name: "After", visibility: "team" });

  assert.equal(updated.name, "After");
  assert.equal(updated.visibility, "team");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd services/fc && node --test --import tsx test/pg-repo-apps.test.ts`
Expected: FAIL with "listApps is not a function".

- [ ] **Step 3: Implement the methods**

In `services/fc/src/lib/pg-repo/apps.ts`, add these methods inside the `return { ... }` object (after `getApp`). Add `sql` and `sessions` to imports at the top:

```typescript
import { and, eq, sql } from "drizzle-orm";
import { apps, workspaces, sessions } from "../../db/schema/index.js";
```

Methods:

```typescript
    async listApps({ teamId, limit = 100 }: { teamId: string; limit?: number }) {
      if (!ctx.userId) return [];
      const callerActorId = await resolveActorForTeam(db, ctx.userId, teamId);
      if (!callerActorId) return [];

      const rows = await (db as any).execute(sql`
        SELECT id, team_id AS "teamId", name, slug, type, visibility,
               workspace_id AS "workspaceId", git_remote_url AS "gitRemoteUrl",
               provision_status AS "provisionStatus", fc_status AS "fcStatus",
               created_by_actor_id AS "createdByActorId",
               created_at AS "createdAt", updated_at AS "updatedAt"
          FROM apps
         WHERE team_id = ${teamId}
           AND (
             visibility = 'team'
             OR created_by_actor_id = ${callerActorId}
             OR EXISTS (
               SELECT 1 FROM app_member_access ama
                WHERE ama.app_id = apps.id AND ama.member_id = ${callerActorId}
             )
           )
         ORDER BY created_at DESC
         LIMIT ${limit}
      `);
      const result = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
      return result.map(mapApp);
    },

    async updateApp(appId: string, patch: { name?: string; visibility?: string }) {
      const set: any = { updatedAt: new Date() };
      if (typeof patch.name === "string" && patch.name.length > 0) set.name = patch.name;
      if (patch.visibility === "team" || patch.visibility === "personal") set.visibility = patch.visibility;
      const [row] = await db.update(apps).set(set).where(eq(apps.id, appId)).returning();
      if (!row) return null;
      return mapApp(row);
    },

    async listAppSessions(appId: string) {
      const rows = await db.select({
        id: sessions.id, teamId: sessions.teamId, title: sessions.title,
        mode: sessions.mode, lastMessageAt: sessions.lastMessageAt,
        createdAt: sessions.createdAt, updatedAt: sessions.updatedAt,
      }).from(sessions).where(eq(sessions.appId, appId));
      return rows.map((r: any) => ({
        id: r.id, teamId: r.teamId, title: r.title ?? "", mode: r.mode ?? "collab",
        lastMessageAt: iso(r.lastMessageAt), createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
      }));
    },
```

> Note: `mapApp` ignores the extra `createdByActorId` field from the raw SQL, keeping the returned shape canonical.

- [ ] **Step 4: Run to verify pass**

Run: `cd services/fc && node --test --import tsx test/pg-repo-apps.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/pg-repo/apps.ts services/fc/test/pg-repo-apps.test.ts
git commit -m "feat(apps): listApps (visibility-filtered) + updateApp + listAppSessions"
```

---

### Task B3: Routes `/v1/apps`

**Files:**
- Create: `services/fc/src/lib/routes/apps.ts`
- Modify: the route-registration site that calls `registerSessions(router)` (find with grep below)
- Test: `services/fc/test/routes-apps.test.ts`

- [ ] **Step 1: Locate the registration site**

Run: `grep -rn "registerSessions" services/fc/src/lib`
Expected: a single call site (e.g. in `app.ts` or `business-api.ts`). Note the file — you will add `registerApps(router)` next to it.

- [ ] **Step 2: Write the route file**

Create `services/fc/src/lib/routes/apps.ts` (mirror `routes/sessions.ts`):

```typescript
import { ApiError } from "../http-utils.js";
import { parseLimit, requireString } from "../routing-utils.js";

export function registerApps(router) {
  router.get("/v1/apps", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    requireString(teamId, "teamId");
    const limit = parseLimit(ctx.query.get("limit"));
    const items = await ctx.repository.listApps({ teamId, limit });
    return { body: { items } };
  });

  router.post("/v1/apps", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    requireString(body.name, "name");
    requireString(body.type, "type");
    const out = await ctx.repository.createApp(body);
    return { statusCode: 201, body: out };
  });

  router.get("/v1/apps/:appId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const out = await ctx.repository.getApp(appId);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.patch("/v1/apps/:appId", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const body = ctx.json ?? {};
    const out = await ctx.repository.updateApp(appId, body);
    if (!out) throw new ApiError(404, "not_found", "app not found");
    return { body: out };
  });

  router.get("/v1/apps/:appId/sessions", async (ctx) => {
    const appId = decodeURIComponent(ctx.params.appId);
    const items = await ctx.repository.listAppSessions(appId);
    return { body: { items } };
  });
}
```

- [ ] **Step 3: Register the routes**

In the file found in Step 1, add the import next to the sessions import:

```typescript
import { registerApps } from "./routes/apps.js";
```

and the call next to `registerSessions(router)`:

```typescript
registerApps(router);
```

(Match the relative import path used by the neighbouring `registerSessions` import — it may be `./routes/apps.js` or `../routes/apps.js` depending on the file.)

- [ ] **Step 4: Write the route test**

Create `services/fc/test/routes-apps.test.ts` mirroring an existing route test (find one with `grep -rln "ctx.repository" services/fc/test | head`). Use a stub repository:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerApps } from "../src/lib/routes/apps.js";

function makeRouter() {
  const routes: any[] = [];
  const router = {
    get: (p: string, h: any) => routes.push(["GET", p, h]),
    post: (p: string, h: any) => routes.push(["POST", p, h]),
    patch: (p: string, h: any) => routes.push(["PATCH", p, h]),
  };
  return { router, routes };
}

test("POST /v1/apps creates and returns 201", async () => {
  const { router, routes } = makeRouter();
  registerApps(router as any);
  const post = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps")[2];
  const created = { id: "app-1", name: "X" };
  const res = await post({ json: { teamId: "t1", name: "X", type: "fullstack_tanstack_postgres" }, repository: { createApp: async () => created } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, created);
});

test("GET /v1/apps requires teamId", async () => {
  const { router, routes } = makeRouter();
  registerApps(router as any);
  const get = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps")[2];
  await assert.rejects(() => get({ query: new URLSearchParams(""), repository: {} }));
});
```

- [ ] **Step 5: Run the test**

Run: `cd services/fc && node --test --import tsx test/routes-apps.test.ts`
Expected: PASS. (If `parseLimit`/`requireString` signatures differ, adjust to match `routing-utils.ts`.)

- [ ] **Step 6: Commit**

```bash
git add services/fc/src/lib/routes/apps.ts services/fc/test/routes-apps.test.ts services/fc/src/lib/<registration-file>.ts
git commit -m "feat(apps): /v1/apps routes (list/create/get/patch/sessions)"
```

---

### Task B4: Repository contract entry for apps

**Files:**
- Modify: `services/fc/src/lib/repository-contract.ts`

- [ ] **Step 1: Add the contract test**

In `services/fc/src/lib/repository-contract.ts`, add a test mirroring the sessions/workspaces contract entries:

```typescript
test("repository contract: listApps returns canonical app fields", async () => {
  const repo = createRepository();
  const items = await repo.listApps({ teamId: "team-1", limit: 100 });
  assert.ok(Array.isArray(items));
  if (items.length > 0) {
    assert.deepEqual(Object.keys(items[0]).sort(), [
      "createdAt", "fcStatus", "gitRemoteUrl", "id", "name", "provisionStatus",
      "slug", "teamId", "type", "updatedAt", "visibility", "workspaceId",
    ].sort());
  }
});
```

- [ ] **Step 2: Ensure the contract fixture seeds at least one app**

Run: `grep -n "createRepository\|fixture\|seed" services/fc/src/lib/repository-contract.ts | head`
If `createRepository()` uses a fixed in-memory fixture, add one app row to that fixture so `items.length > 0` exercises the key assertion. If it builds from a live test DB, the `if (items.length > 0)` guard keeps the test green without a fixture.

- [ ] **Step 3: Run the contract test**

Run: `cd services/fc && node --test --import tsx src/lib/repository-contract.ts` (or the project's contract test command — check `services/fc/package.json` `scripts`).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/fc/src/lib/repository-contract.ts
git commit -m "test(apps): repository contract for listApps shape"
```

---

### Task B5: Per-app managed-git repo naming

**Files:**
- Modify: `services/fc/src/lib/admin-handlers.ts` (`handleManagedGitCreateRepo`)
- Test: `services/fc/test/managed-git-create-repo.test.ts`

- [ ] **Step 1: Add the failing test**

In `services/fc/test/managed-git-create-repo.test.ts`, add a case asserting that when `appId` is supplied the repo name is `tc-app-{appId}` (mock `codeupFetch` per the existing test's mocking approach):

```typescript
test("create-repo with appId names the repo tc-app-{appId}", async () => {
  // (mirror the existing test's codeupFetch mock; capture the POST body.name)
  const captured: any = {};
  // ... set up mock so codeupFetch records body ...
  await handleManagedGitCreateRepo({ teamId: "team-1", appId: "11111111-2222-3333-4444-555555555555" });
  assert.equal(captured.name, "tc-app-11111111-2222-3333-4444-555555555555".toLowerCase());
});
```

(Match the existing file's mock mechanism exactly — read the top of `managed-git-create-repo.test.ts` first.)

- [ ] **Step 2: Run to verify failure**

Run: `cd services/fc && node --test --import tsx test/managed-git-create-repo.test.ts`
Expected: FAIL (repo name still `tc-{teamId}`).

- [ ] **Step 3: Extend the handler**

In `services/fc/src/lib/admin-handlers.ts`, in `handleManagedGitCreateRepo`, change the destructure and repoName derivation:

```typescript
  const { teamId, teamName, appId } = body;
  if (!teamId) {
    return json(400, { error: "Missing teamId" });
  }
  // ...
  const sanitize = (s: string) =>
    String(s).toLowerCase().replace(/[^a-z0-9一-鿿-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const repoName = appId ? `tc-app-${sanitize(appId)}` : `tc-${sanitize(teamId)}`;
```

(Leave the existing per-team behaviour intact when `appId` is absent.)

- [ ] **Step 4: Run to verify pass**

Run: `cd services/fc && node --test --import tsx test/managed-git-create-repo.test.ts`
Expected: PASS (existing per-team test + new per-app test).

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/admin-handlers.ts services/fc/test/managed-git-create-repo.test.ts
git commit -m "feat(apps): managed-git create-repo supports per-app naming"
```

---

### Task B6: OpenAPI spec for `/v1/apps`

**Files:**
- Modify: `docs/openapi/teamclaw-api.v1.yaml`

- [ ] **Step 1: Add the `App` schema and paths**

Under `components.schemas`, add an `App` schema:

```yaml
    App:
      type: object
      required: [id, teamId, name, slug, type, visibility, provisionStatus, createdAt, updatedAt]
      properties:
        id: { type: string, format: uuid }
        teamId: { type: string, format: uuid }
        name: { type: string }
        slug: { type: string }
        type: { type: string, enum: [fullstack_tanstack_postgres] }
        visibility: { type: string, enum: [personal, team] }
        workspaceId: { type: string, format: uuid, nullable: true }
        gitRemoteUrl: { type: string, nullable: true }
        provisionStatus: { type: string, enum: [pending, repo_created, seeding, ready, error] }
        fcStatus: { type: string, nullable: true }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
```

Under `paths`, add `/v1/apps` (get list with `teamId` query + post create) and `/v1/apps/{appId}` (get + patch) and `/v1/apps/{appId}/sessions` (get), mirroring the structure of the existing `/v1/sessions` and `/v1/sessions/{sessionId}` blocks (same parameter/response conventions).

- [ ] **Step 2: Validate the spec parses**

Run: `npx @redocly/cli lint docs/openapi/teamclaw-api.v1.yaml` (or the repo's existing OpenAPI lint command — check `package.json`/CI). If no linter is configured, run `node -e "require('yaml').parse(require('fs').readFileSync('docs/openapi/teamclaw-api.v1.yaml','utf8'))"`.
Expected: no parse errors.

- [ ] **Step 3: Commit**

```bash
git add docs/openapi/teamclaw-api.v1.yaml
git commit -m "docs(apps): OpenAPI for /v1/apps endpoints"
```

---

## Phase C — Daemon template seeding

### Task C1: Bundle the TanStack + Postgres starter template

**Files:**
- Create: `templates/tanstack-postgres/` (starter files)

- [ ] **Step 1: Create a minimal, valid starter**

Create the template tree. Keep it small but real (the seed just needs a coherent first commit; the user/agent fills it in via sessions):

`templates/tanstack-postgres/package.json`:

```json
{
  "name": "teamclaw-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build"
  },
  "dependencies": {
    "@tanstack/react-router": "^1.58.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "vite": "^5.4.0"
  }
}
```

`templates/tanstack-postgres/README.md`:

```markdown
# TeamClaw App

A full-stack starter: TanStack (frontend) + Postgres (backend).

Generated by TeamClaw. Edit freely — your AI sessions can build on top of this.

## Structure
- `src/` — TanStack app
- `db/schema.sql` — Postgres schema
```

`templates/tanstack-postgres/db/schema.sql`:

```sql
-- App database schema. Add your tables here.
create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  created_at timestamptz not null default now()
);
```

`templates/tanstack-postgres/src/main.tsx`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <h1>TeamClaw App</h1>;
}

createRoot(document.getElementById("root")!).render(<App />);
```

`templates/tanstack-postgres/.gitignore`:

```
node_modules/
dist/
.env
```

- [ ] **Step 2: Commit**

```bash
git add templates/tanstack-postgres
git commit -m "feat(apps): bundle TanStack + Postgres starter template"
```

---

### Task C2: Daemon seeding function (clone empty → write template → first commit → push)

**Files:**
- Create: `apps/daemon/src/sync/app_seed.rs`
- Modify: `apps/daemon/src/sync/mod.rs` (add `pub mod app_seed;`)

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/sync/app_seed.rs` with the function stub + an inline test that seeds into a local "remote" (a bare repo) and asserts the pushed repo contains the template:

```rust
use std::path::Path;
use std::process::Command;

/// Seed a freshly-created (empty) app repo with a starter template:
/// clone → copy template tree → first commit → push.
pub fn seed_app_repo(
    workdir: &Path,
    remote_url: &str,
    template_dir: &Path,
    token: Option<&str>,
) -> anyhow::Result<()> {
    let url = embed(remote_url, token);
    run_git(&["clone", &url, &workdir.to_string_lossy()], workdir.parent().unwrap())?;
    copy_tree(template_dir, workdir)?;
    run_git(&["-C", &workdir.to_string_lossy(), "add", "-A"], workdir)?;
    run_git(&["-C", &workdir.to_string_lossy(), "config", "user.email", "daemon@teamclaw"], workdir)?;
    run_git(&["-C", &workdir.to_string_lossy(), "config", "user.name", "teamclaw-daemon"], workdir)?;
    run_git(&["-C", &workdir.to_string_lossy(), "commit", "-m", "chore: scaffold app template"], workdir)?;
    run_git(&["-C", &workdir.to_string_lossy(), "push", "origin", "HEAD"], workdir)?;
    Ok(())
}

fn embed(url: &str, token: Option<&str>) -> String {
    match token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(tok) => {
            let userinfo = if tok.contains(':') { tok.to_string() } else { format!("oauth2:{tok}") };
            if let Some(rest) = url.strip_prefix("https://") { format!("https://{userinfo}@{rest}") } else { url.to_string() }
        }
        None => url.to_string(),
    }
}

fn run_git(args: &[&str], cwd: &Path) -> anyhow::Result<()> {
    let out = Command::new("git").args(args).current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0").output()?;
    if !out.status.success() {
        anyhow::bail!("git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

fn copy_tree(src: &Path, dst: &Path) -> anyhow::Result<()> {
    for entry in walkdir_like(src)? {
        let rel = entry.strip_prefix(src)?;
        let target = dst.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() { std::fs::create_dir_all(parent)?; }
            std::fs::copy(&entry, &target)?;
        }
    }
    Ok(())
}

fn walkdir_like(root: &Path) -> anyhow::Result<Vec<std::path::PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(p) = stack.pop() {
        for e in std::fs::read_dir(&p)? {
            let path = e?.path();
            if path.is_dir() { stack.push(path.clone()); }
            out.push(path);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_template_into_empty_remote() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("remote.git");
        run_git(&["init", "--bare", &bare.to_string_lossy()], tmp.path()).unwrap();

        let template = tmp.path().join("template");
        std::fs::create_dir_all(template.join("src")).unwrap();
        std::fs::write(template.join("README.md"), "# app").unwrap();
        std::fs::write(template.join("src/main.tsx"), "x").unwrap();

        let work = tmp.path().join("work");
        seed_app_repo(&work, &bare.to_string_lossy(), &template, None).unwrap();

        // Clone the bare repo afresh and assert the file landed.
        let verify = tmp.path().join("verify");
        run_git(&["clone", &bare.to_string_lossy(), &verify.to_string_lossy()], tmp.path()).unwrap();
        assert!(verify.join("README.md").exists());
        assert!(verify.join("src/main.tsx").exists());
    }
}
```

- [ ] **Step 2: Register the module**

In `apps/daemon/src/sync/mod.rs`, add:

```rust
pub mod app_seed;
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd apps/daemon && cargo test --bin amuxd app_seed`
Expected: PASS (`seeds_template_into_empty_remote`). If `tempfile` is not already a dev-dependency, it is — confirm with `grep tempfile apps/daemon/Cargo.toml` (the daemon tests already use it).

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/sync/app_seed.rs apps/daemon/src/sync/mod.rs
git commit -m "feat(apps): daemon app_seed (clone empty repo, write template, first commit, push)"
```

---

### Task C3: Daemon HTTP endpoint to trigger app seeding

**Files:**
- Modify: `apps/daemon/src/http/workspaces.rs` (or a new `apps/daemon/src/http/apps.rs`)
- Modify: the HTTP router registration (find with grep)
- Test: extend `apps/daemon/tests/http_sessions_runtime.rs` style harness or add `apps/daemon/tests/http_apps.rs`

- [ ] **Step 1: Find where the template dir ships and how routes register**

Run: `grep -rn "register_workspace\|\.route(\"/v1/workspaces" apps/daemon/src/http`
Expected: the axum router build site. Note it — you'll add `POST /v1/apps/seed` beside it.

Run: `grep -rn "amuxd/templates\|templates/" apps/daemon/src` and decide the template location resolution: ship `templates/tanstack-postgres` alongside the daemon (resolved relative to the daemon binary dir, with an env override `TEAMCLAW_APP_TEMPLATE_DIR`).

- [ ] **Step 2: Add the handler**

Create `apps/daemon/src/http/apps.rs`:

```rust
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::http::auth::Principal;
use crate::http::error::HttpError;
use crate::http::state::HttpState;
use crate::http::require_scope;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedAppBody {
    pub app_id: String,
    pub workdir: String,
    pub git_remote_url: String,
    #[serde(default)]
    pub git_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedAppResponse {
    pub status: String,
}

fn template_dir() -> PathBuf {
    if let Ok(p) = std::env::var("TEAMCLAW_APP_TEMPLATE_DIR") {
        return PathBuf::from(p);
    }
    // Resolve relative to the daemon binary directory.
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("templates/tanstack-postgres")))
        .unwrap_or_else(|| PathBuf::from("templates/tanstack-postgres"))
}

pub async fn seed_app(
    principal: Principal,
    State(_state): State<HttpState>,
    Json(body): Json<SeedAppBody>,
) -> Result<Json<SeedAppResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let workdir = PathBuf::from(&body.workdir);
    let tdir = template_dir();
    let token = body.git_token.clone();
    let res = tokio::task::spawn_blocking(move || {
        crate::sync::app_seed::seed_app_repo(&workdir, &body.git_remote_url, &tdir, token.as_deref())
    })
    .await
    .map_err(|_| HttpError::runtime_unavailable("seed task join failed"))?;
    res.map_err(|e| HttpError::runtime_unavailable(&format!("seed failed: {e}")))?;
    Ok(Json(SeedAppResponse { status: "ready".into() }))
}
```

(Adjust the `use` paths to the actual module layout discovered in Step 1 — mirror the imports at the top of `http/workspaces.rs`.)

- [ ] **Step 3: Register the route + module**

- Add `pub mod apps;` to `apps/daemon/src/http/mod.rs`.
- In the router build site (Step 1), add: `.route("/v1/apps/seed", axum::routing::post(crate::http::apps::seed_app))`.

- [ ] **Step 4: Write an integration test**

Create `apps/daemon/tests/http_apps.rs` mirroring `http_sessions_runtime.rs` harness: spin the HTTP server with a token, init a bare repo as the remote, POST `/v1/apps/seed` with `TEAMCLAW_APP_TEMPLATE_DIR` set to a temp template, assert 200 and that the bare repo received a commit. (Reuse the `TestApp`/`cfg_identity` helpers' style.)

- [ ] **Step 5: Run the test**

Run: `cd apps/daemon && cargo test --bin amuxd http_apps` (and `cargo test --test http_apps` if it's an integration crate test).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/http/apps.rs apps/daemon/src/http/mod.rs apps/daemon/tests/http_apps.rs apps/daemon/src/http/<router-file>.rs
git commit -m "feat(apps): daemon POST /v1/apps/seed endpoint"
```

---

## Phase D — Desktop UI

### Task D1: Backend client module for apps

**Files:**
- Create: `packages/app/src/lib/backend/cloud-api/apps.ts`
- Modify: `packages/app/src/lib/backend/types.ts` (add `AppsBackend` + row types)
- Modify: `packages/app/src/lib/backend/cloud-api/index.ts` (wire `apps` module)

- [ ] **Step 1: Add types**

In `packages/app/src/lib/backend/types.ts`, add:

```typescript
export interface AppRow {
  id: string;
  teamId: string;
  name: string;
  slug: string;
  type: string;
  visibility: "personal" | "team";
  workspaceId: string | null;
  gitRemoteUrl: string | null;
  provisionStatus: string;
  fcStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppSessionRow {
  id: string;
  teamId: string;
  title: string;
  mode: string;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppsBackend {
  listApps(teamId: string): Promise<AppRow[]>;
  createApp(input: { teamId: string; name: string; type: string; visibility: "personal" | "team" }): Promise<AppRow>;
  getApp(appId: string): Promise<AppRow | null>;
  listAppSessions(appId: string): Promise<AppSessionRow[]>;
}
```

Add `apps: AppsBackend;` to the `TeamClawBackend` interface (next to `sessions`).

- [ ] **Step 2: Write the module**

Create `packages/app/src/lib/backend/cloud-api/apps.ts` (mirror `cloud-api/workspaces.ts`):

```typescript
import type { CloudApiClient } from "./client.js";
import type { AppsBackend, AppRow, AppSessionRow } from "../types.js";

type Page<T> = { items: T[] };

export function createAppsModule(client: CloudApiClient): AppsBackend {
  return {
    async listApps(teamId) {
      const params = new URLSearchParams({ teamId, limit: "200" });
      const page = await client.get<Page<AppRow>>(`/v1/apps?${params.toString()}`);
      return page.items;
    },
    async createApp(input) {
      return client.post<AppRow>("/v1/apps", input);
    },
    async getApp(appId) {
      try {
        return await client.get<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`);
      } catch {
        return null;
      }
    },
    async listAppSessions(appId) {
      const page = await client.get<Page<AppSessionRow>>(`/v1/apps/${encodeURIComponent(appId)}/sessions`);
      return page.items;
    },
  };
}
```

(Match the actual import path/casing of `CloudApiClient` and the `client.get`/`client.post` signatures used in `cloud-api/workspaces.ts`.)

- [ ] **Step 3: Wire the module**

In `packages/app/src/lib/backend/cloud-api/index.ts`:
- Import: `import { createAppsModule } from "./apps.js";`
- In the returned backend object, add: `apps: createAppsModule(client),` (next to `sessions:`).

- [ ] **Step 4: Typecheck**

Run: `cd packages/app && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/backend/cloud-api/apps.ts packages/app/src/lib/backend/types.ts packages/app/src/lib/backend/cloud-api/index.ts
git commit -m "feat(apps): desktop cloud-api apps backend module"
```

---

### Task D2: Apps Zustand store

**Files:**
- Create: `packages/app/src/stores/apps-store.ts`
- Test: `packages/app/src/stores/apps-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/stores/apps-store.test.ts` (mirror `session-list-store.test.ts` mocking):

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  createApp: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ apps: { listApps: mocks.listApps, createApp: mocks.createApp } }),
}));

const appRow = (over = {}) => ({
  id: "app-1", teamId: "team-1", name: "App", slug: "app", type: "fullstack_tanstack_postgres",
  visibility: "team", workspaceId: "ws-1", gitRemoteUrl: null, provisionStatus: "pending",
  fcStatus: null, createdAt: "2026-06-14T00:00:00.000Z", updatedAt: "2026-06-14T00:00:00.000Z", ...over,
});

describe("apps-store", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({ items: [], loaded: false, loading: false, error: null });
  });

  it("loads apps for a team (cache-first: skips reload when loaded)", async () => {
    mocks.listApps.mockResolvedValueOnce([appRow({ name: "Alpha" })]);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().load("team-1");
    expect(useAppsStore.getState().items[0]).toMatchObject({ id: "app-1", name: "Alpha" });

    await useAppsStore.getState().load("team-1"); // cached → no second call
    expect(mocks.listApps).toHaveBeenCalledTimes(1);
  });

  it("force reload calls the backend again", async () => {
    mocks.listApps.mockResolvedValue([appRow()]);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().load("team-1");
    await useAppsStore.getState().load("team-1", { force: true });
    expect(mocks.listApps).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/app && npx vitest run src/stores/apps-store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the store**

Create `packages/app/src/stores/apps-store.ts` (mirror `team-share-browser.ts` cache-first pattern):

```typescript
import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import type { AppRow } from "@/lib/backend/types";

interface AppsState {
  items: AppRow[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  teamId: string | null;
  load: (teamId: string, opts?: { force?: boolean }) => Promise<void>;
  create: (input: { teamId: string; name: string; type: string; visibility: "personal" | "team" }) => Promise<AppRow>;
}

export const useAppsStore = create<AppsState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  error: null,
  teamId: null,
  load: async (teamId, opts) => {
    const s = get();
    if (s.loaded && s.teamId === teamId && !opts?.force) return;
    set({ loading: true, error: null, teamId });
    try {
      const items = await getBackend().apps.listApps(teamId);
      set({ items, loaded: true, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? "failed to load apps" });
    }
  },
  create: async (input) => {
    const row = await getBackend().apps.createApp(input);
    set((s) => ({ items: [row, ...s.items] }));
    return row;
  },
}));
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/app && npx vitest run src/stores/apps-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/stores/apps-store.ts packages/app/src/stores/apps-store.test.ts
git commit -m "feat(apps): desktop apps store (cache-first load + create)"
```

---

### Task D3: Sidebar "Apps" entry + second-column list + open last session

**Files:**
- Modify: `packages/app/src/components/sidebar/NavRail.tsx` (add Apps entry)
- Modify: the second-column dispatcher (`SidebarSecondColumn` — find via grep) to render an apps list when the filter is `apps`
- Create: `packages/app/src/components/sidebar/AppsListColumn.tsx`
- Modify: `packages/app/src/stores/ui.ts` (support `sidebarFilter.kind === 'apps'` if it's a typed union)
- Modify: `packages/app/src/locales/en.json` and `zh-CN.json`

- [ ] **Step 1: Confirm the filter type + second-column dispatch**

Run: `grep -rn "sidebarFilter\|SidebarFilter\|kind:" packages/app/src/stores/ui.ts | head`
Run: `grep -rln "SidebarSecondColumn\|sidebarFilter.kind" packages/app/src/components`
Note: whether `sidebarFilter.kind` is a string union (extend it with `'apps'`) and which component switches on it.

- [ ] **Step 2: Extend the filter union (if typed)**

In `packages/app/src/stores/ui.ts`, add `'apps'` to the `sidebarFilter.kind` union type (e.g. `{ kind: 'all' | 'pinned' | ... | 'apps' }`). No behavior change beyond the type.

- [ ] **Step 3: Add the NavRail entry**

In `packages/app/src/components/sidebar/NavRail.tsx`, add a `TopEntry` (mirror the neighbouring entries) using a lucide icon (e.g. `AppWindow`), after the existing shortcut entries:

```tsx
<TopEntry
  label={t('sidebar.apps', 'Apps')}
  icon={<AppWindow size={18} />}
  active={filter.kind === 'apps'}
  onClick={() => setFilter({ kind: 'apps' })}
/>
```

Add `import { AppWindow } from 'lucide-react'` (or extend the existing lucide import).

- [ ] **Step 4: Create the list column**

Create `packages/app/src/components/sidebar/AppsListColumn.tsx` (mirror `SessionListColumn.tsx` row + select pattern):

```tsx
import React from "react";
import { useTranslation } from "react-i18next";
import { useAppsStore } from "@/stores/apps-store";
import { useCurrentTeamId } from "@/stores/team-bootstrap"; // adjust to the actual current-team selector
import { getBackend } from "@/lib/backend";
import { useUIStore } from "@/stores/ui";

export function AppsListColumn() {
  const { t } = useTranslation();
  const teamId = useCurrentTeamId();
  const items = useAppsStore((s) => s.items);
  const loading = useAppsStore((s) => s.loading);
  const load = useAppsStore((s) => s.load);

  React.useEffect(() => {
    if (teamId) load(teamId);
  }, [teamId, load]);

  const openApp = React.useCallback(async (appId: string) => {
    // Open the app's most-recent session; create one if none exists.
    const sessions = await getBackend().apps.listAppSessions(appId);
    let sessionId = sessions.sort((a, b) =>
      (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))[0]?.id;
    if (!sessionId) {
      const app = items.find((a) => a.id === appId)!;
      const created = await getBackend().sessions.createSessionShell({
        teamId: app.teamId, title: app.name, mode: "collab", appId,
      } as any);
      sessionId = created.sessionId;
    }
    await useUIStore.getState().switchToSession(sessionId);
  }, [items]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 text-sm font-medium">{t('apps.title', 'Apps')}</div>
      {loading && items.length === 0 ? (
        <div className="px-3 py-2 text-xs text-neutral-500">{t('common.loading', 'Loading…')}</div>
      ) : items.length === 0 ? (
        <div className="px-3 py-2 text-xs text-neutral-500">{t('apps.empty', 'No apps yet')}</div>
      ) : (
        <ul className="flex-1 overflow-auto">
          {items.map((app) => (
            <li key={app.id}>
              <button
                className="w-full text-left px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                onClick={() => openApp(app.id)}
              >
                <div className="text-sm">{app.name}</div>
                <div className="text-xs text-neutral-500">
                  {app.provisionStatus === 'ready'
                    ? t('apps.ready', 'Ready')
                    : app.provisionStatus === 'error'
                    ? t('apps.error', 'Failed')
                    : t('apps.provisioning', 'Provisioning…')}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

(Adjust `useCurrentTeamId`, `createSessionShell`'s actual signature, and styling to match the real codebase — read `SessionListColumn.tsx` first and mirror its imports/classes.)

- [ ] **Step 5: Render it from the second-column dispatcher**

In the component found in Step 1 (e.g. `SidebarSecondColumn`), add a branch:

```tsx
if (sidebarFilter.kind === 'apps') return <AppsListColumn />;
```

with `import { AppsListColumn } from './AppsListColumn';` (match relative path).

- [ ] **Step 6: Add i18n keys**

In `packages/app/src/locales/en.json` add (and the parallel keys in `zh-CN.json`):

```json
"sidebar": { "apps": "Apps" },
"apps": {
  "title": "Apps",
  "empty": "No apps yet",
  "ready": "Ready",
  "error": "Failed",
  "provisioning": "Provisioning…",
  "create": "New App"
}
```

`zh-CN.json`:

```json
"sidebar": { "apps": "应用" },
"apps": {
  "title": "应用",
  "empty": "还没有应用",
  "ready": "就绪",
  "error": "创建失败",
  "provisioning": "创建中…",
  "create": "新建应用"
}
```

(Merge into the existing `sidebar`/top-level objects rather than duplicating them.)

- [ ] **Step 7: Typecheck + i18n parity + unit tests**

Run: `cd packages/app && npx tsc --noEmit && npx vitest run src/stores/apps-store.test.ts`
Run the i18n parity check the repo uses: `grep -rn "i18n-parity\|parity" packages/app/package.json` then run that script.
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/components/sidebar/NavRail.tsx packages/app/src/components/sidebar/AppsListColumn.tsx packages/app/src/components/sidebar/<second-column>.tsx packages/app/src/stores/ui.ts packages/app/src/locales/en.json packages/app/src/locales/zh-CN.json
git commit -m "feat(apps): sidebar Apps entry + list column + open last session"
```

---

### Task D4: "New App" creation entry

**Files:**
- Modify: `packages/app/src/components/sidebar/AppsListColumn.tsx` (add a create button + minimal dialog)
- Create: `packages/app/src/components/apps/CreateAppDialog.tsx`

- [ ] **Step 1: Create the dialog**

Create `packages/app/src/components/apps/CreateAppDialog.tsx` (mirror an existing Radix dialog in the repo — find one with `grep -rln "DialogContent" packages/app/src/components | head`). Fields: name (text), type (single option `fullstack_tanstack_postgres`, disabled select), visibility (personal/team radio). On submit call `useAppsStore.getState().create({ teamId, name, type, visibility })`, then close.

- [ ] **Step 2: Wire the button**

In `AppsListColumn.tsx`, add a "New App" button in the header that opens the dialog:

```tsx
<button className="ml-auto text-xs underline" onClick={() => setCreateOpen(true)}>
  {t('apps.create', 'New App')}
</button>
```

with local `const [createOpen, setCreateOpen] = React.useState(false)` and `<CreateAppDialog open={createOpen} onOpenChange={setCreateOpen} teamId={teamId} />`.

- [ ] **Step 3: Typecheck + test render**

Run: `cd packages/app && npx tsc --noEmit`
Add/confirm a vitest smoke test that mounts `CreateAppDialog` and submits (mirror an existing dialog test; mock `getBackend().apps.createApp`).
Run: `npx vitest run src/components/apps`
Expected: PASS. (Watch for the jsdom Radix-Select-in-Dialog focus loop — if it appears, the repo already has a vitest-setup focus guard; ensure the test file picks up `vitest-setup`.)

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/components/apps/CreateAppDialog.tsx packages/app/src/components/sidebar/AppsListColumn.tsx
git commit -m "feat(apps): create-app dialog"
```

---

## Phase E — Wire provisioning end-to-end (createApp → repo → daemon seed)

### Task E1: createApp triggers managed-git repo creation (server-side)

**Files:**
- Modify: `services/fc/src/lib/pg-repo/apps.ts` (accept an injected `provisionAppRepo` dep)
- Modify: `services/fc/src/lib/pg-repo/index.ts` (pass the dep, mirroring `provisionLiteLlm`)
- Test: `services/fc/test/pg-repo-apps.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `services/fc/test/pg-repo-apps.test.ts`:

```typescript
test("createApp calls provisionAppRepo and records the git remote", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const calls: any[] = [];
  const repo = createPgBusinessRepository({
    db, userId: actor.userId,
    provisionAppRepo: async (args: any) => { calls.push(args); return { gitRemoteUrl: "https://git/x.git", gitAuthKind: "pat" }; },
  } as any);

  const app = await repo.createApp({ teamId: team.id, name: "Z", type: "fullstack_tanstack_postgres" });
  assert.equal(calls.length, 1);
  const fetched = await repo.getApp(app.id);
  assert.equal(fetched.gitRemoteUrl, "https://git/x.git");
  assert.equal(fetched.provisionStatus, "repo_created");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd services/fc && node --test --import tsx test/pg-repo-apps.test.ts`
Expected: FAIL (no provisionAppRepo wired; status stays `pending`).

- [ ] **Step 3: Thread the dependency**

In `makeAppsRepo`, change the signature and `createApp` to call the dep after inserting:

```typescript
export function makeAppsRepo(db: DbLike, ctx: AppsCtx = {}, deps: { provisionAppRepo?: (args: { appId: string; teamId: string }) => Promise<{ gitRemoteUrl: string; gitAuthKind: string } | null> } = {}) {
  // ... inside createApp, after inserting `row`:
      if (deps.provisionAppRepo) {
        try {
          const res = await deps.provisionAppRepo({ appId: row.id, teamId: input.teamId });
          if (res?.gitRemoteUrl) {
            const [updated] = await db.update(apps).set({
              gitRemoteUrl: res.gitRemoteUrl, gitAuthKind: res.gitAuthKind, provisionStatus: "repo_created", updatedAt: new Date(),
            }).where(eq(apps.id, row.id)).returning();
            return mapApp(updated);
          }
        } catch (e: any) {
          const [errd] = await db.update(apps).set({
            provisionStatus: "error", provisionError: String(e?.message ?? e), updatedAt: new Date(),
          }).where(eq(apps.id, row.id)).returning();
          return mapApp(errd);
        }
      }
      return mapApp(row);
```

In `services/fc/src/lib/pg-repo/index.ts`, accept `provisionAppRepo` in the factory args and pass it: `const appsRepo = makeAppsRepo(db, ctx, { provisionAppRepo });`. Wire the real implementation (calling `handleManagedGitCreateRepo({ teamId, appId })` and parsing `repoHttpUrl`) where the FC adapter constructs the repository (mirror how `provisionLiteLlm` is supplied in `business-api.ts`).

- [ ] **Step 4: Run to verify pass**

Run: `cd services/fc && node --test --import tsx test/pg-repo-apps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/fc/src/lib/pg-repo/apps.ts services/fc/src/lib/pg-repo/index.ts services/fc/test/pg-repo-apps.test.ts services/fc/src/lib/business-api.ts
git commit -m "feat(apps): createApp provisions per-app git repo via managed-git"
```

---

### Task E2: Desktop kicks the daemon to seed after create

**Files:**
- Modify: `packages/app/src/stores/apps-store.ts` (`create` → after repo_created, call daemon seed)
- Modify: `packages/app/src/lib/backend/types.ts` if a daemon client method is needed (or call the daemon HTTP directly via the existing daemon client)

- [ ] **Step 1: Find the daemon HTTP client**

Run: `grep -rln "register_workspace\|/v1/workspaces\|daemonFetch\|localhost.*amuxd\|daemon client" packages/app/src/lib | head`
Note the helper used to call the local daemon HTTP API.

- [ ] **Step 2: Add a seed call**

In `apps-store.ts` `create`, after the backend returns an app with `provisionStatus === 'repo_created'` and a `gitRemoteUrl`, call the daemon seed endpoint (mirror the existing daemon-call helper):

```typescript
    if (row.provisionStatus === "repo_created" && row.gitRemoteUrl && row.workspaceId) {
      try {
        await daemonPost("/v1/apps/seed", {
          appId: row.id,
          workdir: /* daemon-resolved workspace path for row.workspaceId */ "",
          gitRemoteUrl: row.gitRemoteUrl,
          // token is delivered to the daemon out-of-band via the existing secret channel; omit here if so
        });
      } catch (e) {
        // Non-fatal: surface status; user can retry. Do not throw from create.
        console.warn("app seed kick failed", e);
      }
    }
```

(If the daemon resolves the workspace path itself from `workspaceId`, change the daemon `SeedAppBody` to take `workspaceId` instead of `workdir` and resolve it server-side. Pick whichever matches how `register_workspace` already maps ids→paths; prefer passing `workspaceId` and resolving in the daemon.)

- [ ] **Step 3: Typecheck + store test**

Run: `cd packages/app && npx tsc --noEmit && npx vitest run src/stores/apps-store.test.ts`
Update the store test to mock `daemonPost` and assert it's called when status is `repo_created`.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/stores/apps-store.ts packages/app/src/stores/apps-store.test.ts
git commit -m "feat(apps): desktop kicks daemon seed after repo creation"
```

---

## Phase F — Verification

### Task F1: Full test sweep

- [ ] **Step 1: FC tests**

Run: `cd services/fc && npm test` (or the repo's FC test command from `package.json`).
Expected: all green, including the new `pg-repo-apps`, `routes-apps`, `managed-git-create-repo`, and contract tests.

- [ ] **Step 2: Daemon tests**

Run: `cd apps/daemon && cargo test --bin amuxd app_seed && cargo test --test http_apps`
Expected: PASS. (Per repo convention, daemon `fmt`/`clippy`/full suite are not CI gates; do not chase unrelated pre-existing failures.)

- [ ] **Step 3: Frontend tests + typecheck + lint**

Run: `cd packages/app && npx tsc --noEmit && npx vitest run && pnpm lint`
Run i18n parity script (from Task D3 Step 7).
Expected: new tests green; no new tsc/eslint errors. (Repo has pre-existing reds — confirm your changes don't add new failures by diffing against a clean `origin/main` run if unsure.)

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test(apps): green sweep fixups"
```

### Task F2: Self-review against the spec

- [ ] Confirm every spec section maps to a task:
  - §2.1 apps table → A1/A2
  - §2.2 app_member_access → A1/A2
  - §2.3 sessions.app_id → A1/A2
  - §2.4 visibility filtering → A2 (RLS) + B2 (`listApps`)
  - §3 provision flow → B5 + C1/C2/C3 + E1/E2
  - §4 cloud API → B1–B4, B6
  - §5 desktop UI → D1–D4
  - §6 error handling → E1 (status/error writeback) + D3 (status surfaced)
  - §7 testing → tests in every phase + F1
- [ ] Stop here. Per `CLAUDE.md`, do **not** push or open a PR until the user explicitly asks. Report completion and wait.

---

## Out of scope (Phase 2 — not in this plan)

- Real FC function provisioning, Postgres DB provisioning, deploy pipeline, access URL (fills `fc_*`).
- iOS / Expo clients.
- Additional app types beyond `fullstack_tanstack_postgres`.
- App archive/delete lifecycle UI.
