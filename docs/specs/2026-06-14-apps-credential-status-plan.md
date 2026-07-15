# Apps Phase-2a — Credential Delivery + Status Writeback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phase-1 apps skeleton run end-to-end: the daemon fetches a team-scoped managed-git credential just-in-time to push the seeded template into the app's private repo, and the app's `provision_status` is written back (seeding → ready/error) so the UI reflects reality, with a retry action.

**Architecture:** A new team-scoped FC endpoint returns the shared managed-git PAT to authenticated team members; the daemon pulls it during seed via a new `Backend` trait method (PAT never touches the desktop or the DB). `updateApp` gains validated `provisionStatus` transitions; the desktop (holding the creator's bearer, which RLS requires) orchestrates the status writeback around the daemon seed kick and exposes a "reseed" action.

**Tech Stack:** Drizzle + Hono + Supabase-js (FC, Node 20, TS); Rust/tokio + axum + reqwest (amuxd); React 19 + Zustand + i18next (desktop).

**Spec:** `docs/specs/2026-06-14-apps-credential-status-design.md`

**Branch / worktree:** `agent/apps-module` at `.worktrees/apps-module`. All work here. `services/fc/node_modules` installed; FC tests `node --test --import tsx <file>` from `services/fc`. Daemon tests `cargo test --bin amuxd` / `cargo test --test http_apps` from `apps/daemon`. Frontend `npx tsc --noEmit` / `npx vitest run <file>` / `npx eslint <files>` from `packages/app`.

**Commit footer (every task):**
```
Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
```

---

## Phase A — FC: credential endpoint

### Task A1: `managedGitCredential()` helper + repo `getManagedGitCredential(teamId)`

**Files:**
- Modify: `services/fc/src/lib/admin-handlers.ts` (export a helper)
- Modify: `services/fc/src/lib/pg-repo/apps.ts` (add repo method)
- Modify: `services/fc/src/lib/supabase-repo.ts` (add repo method)
- Test: `services/fc/test/pg-repo-apps.test.ts`, `services/fc/test/supabase-repo.test.ts`

- [ ] **Step 1: Add the shared env helper**

In `services/fc/src/lib/admin-handlers.ts`, right after the `CODEUP_BOT_USERNAME` accessor (the env accessors are at lines 33-35), add:

```typescript
/**
 * The shared managed-git credential (the org bot PAT). Returns null when
 * managed-git is not configured. NOT per-repo — one credential for all of an
 * org's managed repos (team repo + every app repo).
 */
export function managedGitCredential(): { username: string; token: string } | null {
  const token = CODEUP_PAT();
  if (!token) return null;
  return { username: CODEUP_BOT_USERNAME(), token };
}
```

- [ ] **Step 2: Write the failing pg-repo test**

Append to `services/fc/test/pg-repo-apps.test.ts`:

```typescript
test("getManagedGitCredential returns creds for a team member, null for non-member", async () => {
  process.env.CODEUP_PAT = "pt-secret";
  process.env.CODEUP_BOT_USERNAME = "teamclaw";
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedActor(db, team.id);
  const otherTeam = await seedTeam(db);
  const outsider = await seedActor(db, otherTeam.id);

  const memberRepo = createPgBusinessRepository({ db, userId: member.userId });
  const outsiderRepo = createPgBusinessRepository({ db, userId: outsider.userId });

  const cred = await memberRepo.getManagedGitCredential(team.id);
  assert.deepEqual(cred, { username: "teamclaw", token: "pt-secret" });

  const denied = await outsiderRepo.getManagedGitCredential(team.id);
  assert.equal(denied, null);
});

test("getManagedGitCredential throws 503 when managed-git unconfigured", async () => {
  delete process.env.CODEUP_PAT;
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: member.userId });
  await assert.rejects(() => repo.getManagedGitCredential(team.id), /managed_git_unavailable|503/);
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `cd services/fc && node --test --import tsx test/pg-repo-apps.test.ts`
Expected: FAIL ("getManagedGitCredential is not a function").

- [ ] **Step 4: Implement in pg-repo**

In `services/fc/src/lib/pg-repo/apps.ts`: add the import at the top (next to the existing `resolveActorForTeam` import from `./authz.js`) — it already imports `resolveActorForTeam`; also import the helper and ApiError:

```typescript
import { ApiError } from "../http-utils.js";
import { managedGitCredential } from "../admin-handlers.js";
```

Add this method inside the `return { ... }` object (e.g. after `getApp`):

```typescript
    async getManagedGitCredential(teamId: string) {
      // Team-scoped: any member of the team may fetch the shared managed-git
      // credential (the org bot PAT). The daemon's agent actor is a team member.
      if (ctx.userId) {
        const callerActorId = await resolveActorForTeam(db, ctx.userId, teamId);
        if (!callerActorId) return null; // route → 404
      }
      const cred = managedGitCredential();
      if (!cred) throw new ApiError(503, "managed_git_unavailable", "managed git is not configured");
      return cred;
    },
```

(Confirm `ApiError`'s constructor signature from `services/fc/src/lib/http-utils.ts` — it is `new ApiError(status, code, message)`, as used in routes.)

- [ ] **Step 5: Write the failing supabase-repo test + implement**

In `services/fc/test/supabase-repo.test.ts`, add a test mirroring the file's existing apps mock style (the stateful supabase double added in F3b). Assert: a team member gets `{username, token}`; a non-member (resolveCurrentMemberActor returns null) gets null; unconfigured → throws 503. Then implement in `services/fc/src/lib/supabase-repo.ts` (next to the other apps methods, e.g. after `getApp`):

```typescript
    async getManagedGitCredential(teamId: string) {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) return null;
      const resolved = await this.resolveCurrentMemberActor(teamId, userId);
      if (!resolved?.id) return null; // not a team member → route 404
      const cred = managedGitCredential();
      if (!cred) throw new ApiError(503, "managed_git_unavailable", "managed git is not configured");
      return cred;
    },
```

Add the imports at the top of supabase-repo.ts if not present: `managedGitCredential` from `./admin-handlers.js` and `ApiError` from `./http-utils.js` (check existing imports — `ApiError` is likely already imported). Match how `resolveCurrentMemberActor` is referenced (`this.` vs a free function) by reading the existing `createApp` in supabase-repo.

- [ ] **Step 6: Run both, expect PASS**

Run: `cd services/fc && node --test --import tsx test/pg-repo-apps.test.ts test/supabase-repo.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Volumes/openbeta/workspace/teamclaw-v2/.worktrees/apps-module add services/fc/src/lib/admin-handlers.ts services/fc/src/lib/pg-repo/apps.ts services/fc/src/lib/supabase-repo.ts services/fc/test/pg-repo-apps.test.ts services/fc/test/supabase-repo.test.ts
git commit -m "feat(apps): getManagedGitCredential (team-scoped, member-gated)"
```

---

### Task A2: Route `GET /v1/teams/:teamId/managed-git-credential`

**Files:**
- Modify: the route file that owns `/v1/teams/...` routes — find it; likely `services/fc/src/lib/routes/team-share.ts` or `routes/teams.ts`
- Test: `services/fc/test/routes-apps.test.ts`

- [ ] **Step 1: Find the team route file + registration**

Run: `grep -rn "/v1/teams/:teamId" services/fc/src/lib/routes`
Pick the file that registers team sub-routes (it has `router.get("/v1/teams/:teamId/...")`). You'll add the new route there, mirroring its handlers (param decode, `ctx.repository`, `ApiError`).

- [ ] **Step 2: Write the failing route test**

Add to `services/fc/test/routes-apps.test.ts` (it already has the fake-router helper from phase-1):

```typescript
test("GET /v1/teams/:teamId/managed-git-credential returns creds", async () => {
  const { router, routes } = makeRouter(); // reuse this file's helper
  // register the team routes — import + call the register fn for the file you edited
  // e.g. registerTeamShare(router) — adjust to the real register fn
  // Then find the route:
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/teams/:teamId/managed-git-credential")[2];
  const res = await handler({
    params: { teamId: "t1" },
    repository: { getManagedGitCredential: async () => ({ username: "teamclaw", token: "pt" }) },
  });
  assert.deepEqual(res.body, { username: "teamclaw", token: "pt" });
});

test("GET managed-git-credential 404s for non-member (repo returns null)", async () => {
  const { router, routes } = makeRouter();
  // register...
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/teams/:teamId/managed-git-credential")[2];
  await assert.rejects(() => handler({ params: { teamId: "t1" }, repository: { getManagedGitCredential: async () => null } }));
});
```

If the team routes live in a file whose register fn isn't yet imported by this test, add the import. If the fake-router helper (`makeRouter`) isn't exported/shared, copy it locally (it's tiny — see phase-1 routes-apps.test.ts).

- [ ] **Step 3: Run, expect FAIL**

Run: `cd services/fc && node --test --import tsx test/routes-apps.test.ts`
Expected: FAIL (route not found).

- [ ] **Step 4: Add the route**

In the team route file from Step 1, add:

```typescript
  router.get("/v1/teams/:teamId/managed-git-credential", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const out = await ctx.repository.getManagedGitCredential(teamId);
    if (!out) throw new ApiError(404, "not_found", "team not found or not a member");
    return { body: out };
  });
```

Ensure `ApiError` is imported in that file (it is, if other handlers throw it). The 503 thrown by the repo propagates as-is.

- [ ] **Step 5: Run, expect PASS**

Run: `cd services/fc && node --test --import tsx test/routes-apps.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C <worktree> add services/fc/src/lib/routes/<team-route-file>.ts services/fc/test/routes-apps.test.ts
git commit -m "feat(apps): GET /v1/teams/:teamId/managed-git-credential route"
```

---

### Task A3: `updateApp` accepts validated `provisionStatus`

**Files:**
- Modify: `services/fc/src/lib/pg-repo/apps.ts`
- Modify: `services/fc/src/lib/supabase-repo.ts`
- Test: `services/fc/test/pg-repo-apps.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `services/fc/test/pg-repo-apps.test.ts`:

```typescript
test("updateApp advances provisionStatus through legal transitions", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({
    db, userId: actor.userId,
    provisionAppRepo: async () => ({ gitRemoteUrl: "https://g/x.git", gitAuthKind: "pat" }),
  });
  const app = await repo.createApp({ teamId: team.id, name: "P", type: "fullstack_tanstack_postgres" });
  assert.equal(app.provisionStatus, "repo_created");

  const seeding = await repo.updateApp(app.id, { provisionStatus: "seeding" });
  assert.equal(seeding.provisionStatus, "seeding");
  const ready = await repo.updateApp(app.id, { provisionStatus: "ready" });
  assert.equal(ready.provisionStatus, "ready");
});

test("updateApp rejects an illegal provisionStatus jump (from pending)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  // No provisionAppRepo dep → createApp leaves the app in `pending`.
  const repo = createPgBusinessRepository({ db, userId: actor.userId });
  const app = await repo.createApp({ teamId: team.id, name: "P2", type: "fullstack_tanstack_postgres" });
  assert.equal(app.provisionStatus, "pending");
  // pending → ready is illegal, and it's the ONLY field → 400.
  await assert.rejects(() => repo.updateApp(app.id, { provisionStatus: "ready" }), /invalid_status_transition|400/);
});

test("updateApp ignores illegal provisionStatus but still applies name", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId }); // pending app
  const app = await repo.createApp({ teamId: team.id, name: "Old", type: "fullstack_tanstack_postgres" });
  // ready is illegal from pending → status ignored, name still applied.
  const updated = await repo.updateApp(app.id, { name: "New", provisionStatus: "ready" });
  assert.equal(updated.name, "New");
  assert.equal(updated.provisionStatus, "pending"); // status unchanged
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd services/fc && node --test --import tsx test/pg-repo-apps.test.ts`
Expected: FAIL (provisionStatus ignored / no validation).

- [ ] **Step 3: Add a shared transition validator**

Create `services/fc/src/lib/pg-repo/app-status.ts`:

```typescript
/** Legal client-driven provision_status transitions. createApp owns
 *  pending→repo_created/error; this governs the seed lifecycle + retry.
 *  Clients may never move a row back TO `pending` or `repo_created` (no list
 *  includes them), and may never move FROM `pending` (empty list). The desktop
 *  writes only the terminal `ready`/`error`; `seeding` is kept reachable for a
 *  future real "in progress" signal. */
const ALLOWED: Record<string, string[]> = {
  pending: [],
  repo_created: ["seeding", "ready", "error"],
  seeding: ["ready", "error"],
  error: ["seeding", "ready", "error"],
  ready: ["seeding", "ready", "error"],
};

export function isLegalStatusTransition(from: string, to: string): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}
```

- [ ] **Step 4: Use it in pg-repo updateApp**

In `services/fc/src/lib/pg-repo/apps.ts`, import it (`import { isLegalStatusTransition } from "./app-status.js";` and ensure `ApiError` imported) and extend `updateApp`'s signature + body. Replace the current `updateApp` body's `set` construction with:

```typescript
    async updateApp(appId: string, patch: { name?: string; visibility?: string; provisionStatus?: string }) {
      const existing = await loadVisibleApp(appId);
      if (!existing) return null;
      if (ctx.userId) {
        const callerActorId = await resolveActorForTeam(db, ctx.userId, existing.teamId);
        if (!callerActorId || existing.createdByActorId !== callerActorId) return null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const set: any = { updatedAt: new Date() };
      if (typeof patch.name === "string" && patch.name.length > 0) set.name = patch.name;
      if (patch.visibility === "team" || patch.visibility === "personal") set.visibility = patch.visibility;
      let statusOk = false;
      if (typeof patch.provisionStatus === "string") {
        if (isLegalStatusTransition(existing.provisionStatus, patch.provisionStatus)) {
          set.provisionStatus = patch.provisionStatus;
          statusOk = true;
        } else if (set.name === undefined && set.visibility === undefined) {
          // Illegal status was the only field → hard error.
          throw new ApiError(400, "invalid_status_transition",
            `cannot move provision_status ${existing.provisionStatus} -> ${patch.provisionStatus}`);
        }
        // else: illegal status alongside other fields → silently ignore status.
      }
      void statusOk;
      const [row] = await db.update(apps).set(set).where(eq(apps.id, appId)).returning();
      if (!row) return null;
      return mapApp(row);
    },
```

- [ ] **Step 5: Mirror in supabase-repo updateApp**

In `services/fc/src/lib/supabase-repo.ts` `updateApp`, the supabase path doesn't pre-load the row (RLS does the gating), so it lacks `existing.provisionStatus`. Fetch it first (the caller can read it — they're the creator passing RLS), then apply the same validation:

```typescript
    async updateApp(appId: string, patch: { name?: string; visibility?: string; provisionStatus?: string }) {
      // Read current status to validate the transition (creator can SELECT it).
      const { data: cur } = await supabase.from("apps").select("provision_status").eq("id", appId).maybeSingle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const set: any = { updated_at: new Date().toISOString() };
      if (typeof patch.name === "string" && patch.name.length > 0) set.name = patch.name;
      if (patch.visibility === "team" || patch.visibility === "personal") set.visibility = patch.visibility;
      if (typeof patch.provisionStatus === "string") {
        const from = cur?.provision_status ?? "";
        if (isLegalStatusTransition(from, patch.provisionStatus)) {
          set.provision_status = patch.provisionStatus;
        } else if (set.name === undefined && set.visibility === undefined) {
          throw new ApiError(400, "invalid_status_transition",
            `cannot move provision_status ${from} -> ${patch.provisionStatus}`);
        }
      }
      const { data, error } = await supabase.from("apps").update(set).eq("id", appId).select(APP_COLUMNS).maybeSingle();
      if (error) throw error;
      return data ? mapApp(data) : null;
    },
```

Import `isLegalStatusTransition` from `./pg-repo/app-status.js` at the top of supabase-repo.ts.

- [ ] **Step 6: Run, expect PASS**

Run: `cd services/fc && node --test --import tsx test/pg-repo-apps.test.ts test/supabase-repo.test.ts`
Expected: PASS. (Add a supabase-repo test mirroring the pg transition test if the file's mock supports update-returning — F3b's stateful double does; otherwise note coverage.)

- [ ] **Step 7: Commit**

```bash
git -C <worktree> add services/fc/src/lib/pg-repo/app-status.ts services/fc/src/lib/pg-repo/apps.ts services/fc/src/lib/supabase-repo.ts services/fc/test/pg-repo-apps.test.ts services/fc/test/supabase-repo.test.ts
git commit -m "feat(apps): updateApp validates provisionStatus transitions"
```

---

### Task A4: OpenAPI for the credential endpoint + PATCH provisionStatus

**Files:**
- Modify: `docs/openapi/teamclaw-api.v1.yaml`

- [ ] **Step 1: Add the credential path + schema**

Add a path `/v1/teams/{teamId}/managed-git-credential` (GET), param `teamId` (uuid), response 200 schema `ManagedGitCredential` (`{ username: string, token: string }`), plus 404 and 503 responses (mirror existing error-response refs). Add `ManagedGitCredential` under `components.schemas`. Match the file's OpenAPI 3.1 style + nullable convention (`type: [..., "null"]`).

- [ ] **Step 2: Add provisionStatus to the PATCH /v1/apps/{appId} requestBody**

Find the `patch` op under `/v1/apps/{appId}` and add an optional `provisionStatus` property (enum `[seeding, ready, error]`) to its requestBody schema, alongside `name`/`visibility`.

- [ ] **Step 3: Validate**

Run: `cd services/fc && npm run openapi:lint` (redocly). Expected: "valid" (pre-existing warnings only).

- [ ] **Step 4: Commit**

```bash
git -C <worktree> add docs/openapi/teamclaw-api.v1.yaml
git commit -m "docs(apps): OpenAPI for managed-git-credential + PATCH provisionStatus"
```

---

## Phase B — daemon: pull credential during seed

### Task B1: `Backend` trait method `managed_git_credential`

**Files:**
- Modify: the `Backend` trait definition (find it) + `apps/daemon/src/backend/cloud_api/mod.rs` (impl) + any other Backend impl / test mock

- [ ] **Step 1: Find the Backend trait + impls**

Run: `grep -rn "trait Backend" apps/daemon/src` and `grep -rln "impl Backend for" apps/daemon/src apps/daemon/tests`
Read the trait (its methods, the `BackendResult` type, async-trait usage) and list every impl (cloud_api + any mock/test/null backend). You'll add one method everywhere.

- [ ] **Step 2: Add a credential type + trait method**

In the backend module (where `BackendResult` and the trait live), add:

```rust
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedGitCredential {
    pub username: String,
    pub token: String,
}
```

Add to the `Backend` trait (match its async-trait style):

```rust
    /// Fetch the team-scoped managed-git credential from the cloud API.
    async fn managed_git_credential(&self, team_id: &str) -> BackendResult<ManagedGitCredential>;
```

- [ ] **Step 3: Implement on the cloud_api backend**

In `apps/daemon/src/backend/cloud_api/mod.rs`, implement it using the existing `get<T>` helper:

```rust
    async fn managed_git_credential(&self, team_id: &str) -> BackendResult<ManagedGitCredential> {
        self.get(&format!("/v1/teams/{team_id}/managed-git-credential")).await
    }
```

(Place it inside the `impl Backend for ...` block. `ManagedGitCredential` must be importable there — define it in the module that the trait and impl share, or re-export.)

- [ ] **Step 4: Implement on every other Backend impl / mock**

For any other impl (e.g. a null/offline backend or a test mock), add a stub. For a real-but-unsupported backend return an error; for test mocks return a fixed credential or an error as the test needs. Example unsupported:

```rust
    async fn managed_git_credential(&self, _team_id: &str) -> BackendResult<ManagedGitCredential> {
        Err(/* the crate's "unsupported"/"not available" BackendError variant */)
    }
```

Use the actual `BackendError` variant the codebase uses for unsupported ops (grep other trait methods in the same impl for the pattern).

- [ ] **Step 5: Build**

Run: `cd apps/daemon && cargo build --bin amuxd`
Expected: compiles. (No behavior test yet — that's B2.)

- [ ] **Step 6: Commit**

```bash
git -C <worktree> add apps/daemon/src/backend/
git commit -m "feat(apps): Backend::managed_git_credential (daemon pulls team git cred)"
```

---

### Task B2: Seed handler fetches the credential

**Files:**
- Modify: `apps/daemon/src/http/apps.rs`
- Test: `apps/daemon/tests/http_apps.rs`

- [ ] **Step 1: Add `teamId` to the seed body + fetch logic**

In `apps/daemon/src/http/apps.rs`:
- Add `#[serde(default)] pub team_id: String,` to `SeedAppBody` (camelCase `teamId`).
- Change the handler signature to use `State(state)` (currently `State(_state)`).
- Before the `spawn_blocking`, resolve the token:

```rust
    // Credential resolution (JIT): an explicit body token wins (tests / legacy);
    // otherwise pull the team-scoped managed-git credential from the cloud API.
    let token: Option<String> = if let Some(t) = body.git_token.clone() {
        Some(t)
    } else {
        let team_id = body.team_id.trim();
        if team_id.is_empty() {
            None
        } else {
            let backend = state
                .backend
                .as_ref()
                .ok_or_else(|| HttpError::internal("cloud backend unavailable for credential fetch"))?;
            let cred = backend
                .managed_git_credential(team_id)
                .await
                .map_err(|e| HttpError::internal(format!("fetch managed-git credential: {e}")))?;
            Some(format!("{}:{}", cred.username, cred.token))
        }
    };
```

Then pass `token.as_deref()` into `seed_app_repo` (replacing the previous `body.git_token` usage). `seed_app_repo`'s `embed` already treats a `user:token` string as verbatim userinfo.

- [ ] **Step 2: Update the existing camelCase deserialize unit test**

In the `body_deserializes_camel_case` test, add `"teamId": "team-1"` to the JSON and assert `body.team_id == "team-1"`. Keep the other unit tests green.

- [ ] **Step 3: Write the integration test (credential pulled from a mock backend)**

In `apps/daemon/tests/http_apps.rs`, add a test that builds `HttpState` with a mock `Backend` whose `managed_git_credential` returns `{ username: "teamclaw", token: "pt-xyz" }`, then POSTs `/v1/apps/seed` with `{ appId, teamId, gitRemoteUrl: <local bare repo>, workdir: <fresh> }` (NO `gitToken`), and asserts 200 + the template landed in the bare repo (clone-and-check, like the existing seed test). Use the existing test harness for spinning the server; you must attach the mock backend via `HttpState::with_backend(Some(Arc::new(MockBackend)))`. Define a minimal `MockBackend` implementing the `Backend` trait (only `managed_git_credential` returns the credential; other methods can `unimplemented!()` or return errors if the test never calls them — check the trait surface and stub the rest minimally). The bare repo accepts the embedded credential regardless (local push), so success proves the fetch+embed path ran.

- [ ] **Step 4: Run the tests**

Run: `cd apps/daemon && cargo test --test http_apps` and `cargo test --bin amuxd app`
Expected: PASS (new credential-fetch integration test + existing explicit-workdir/token tests + unit tests). The C3 explicit-`workdir`+`gitToken` test must stay green (the body-token branch is preserved).

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add apps/daemon/src/http/apps.rs apps/daemon/tests/http_apps.rs
git commit -m "feat(apps): seed handler pulls team managed-git credential JIT"
```

---

## Phase C — desktop: status writeback + retry

### Task C1: `seedDaemonApp` three-state + pass teamId

**Files:**
- Modify: `packages/app/src/lib/daemon-local-client.ts`
- Test: extend an existing daemon-local-client test if present, else covered via store test in C3

- [ ] **Step 1: Change the return type to three-state and accept teamId**

Replace `seedDaemonApp` in `packages/app/src/lib/daemon-local-client.ts` with:

```typescript
export type SeedAppOutcome = "seeded" | "failed" | "unreachable";

export async function seedDaemonApp(
  appId: string,
  gitRemoteUrl: string,
  teamId: string,
): Promise<SeedAppOutcome> {
  try {
    const result = await daemonFetch<{ status: string }>('/v1/apps/seed', {
      method: 'POST',
      body: JSON.stringify({ appId, gitRemoteUrl, teamId }),
    })
    if (result.ok) return "seeded"
    // status 0 = daemon not connected/unreachable; any other non-ok = seed failed.
    if (result.status === 0) {
      console.warn('[daemon-local-client] app seed unreachable (non-fatal):', result.error)
      return "unreachable"
    }
    console.warn('[daemon-local-client] app seed failed (non-fatal):', result.error)
    return "failed"
  } catch (err) {
    console.warn('[daemon-local-client] app seed unavailable (non-fatal):', err)
    return "unreachable"
  }
}
```

(`daemonFetch` returns `{ ok:false, status:0, ... }` when the daemon is not connected — that's the "unreachable" signal.)

- [ ] **Step 2: Typecheck**

Run: `cd packages/app && npx tsc --noEmit`
Expected: FAIL only at the call site in `apps-store.ts` (signature changed) — that's fixed in C3. If other callers of `seedDaemonApp` exist (`grep -rn seedDaemonApp packages/app/src`), note them; only `apps-store.ts` should call it.

- [ ] **Step 3: Commit** (after C3 makes tsc green — or commit C1+C3 together). Proceed to C2/C3; commit the desktop changes together at the end of C3 to keep tsc green per commit.

---

### Task C2: `updateAppProvisionStatus` backend method

**Files:**
- Modify: `packages/app/src/lib/backend/types.ts` (`AppsBackend`)
- Modify: `packages/app/src/lib/backend/cloud-api/apps.ts`
- Test: covered by C3 store test (the store calls it)

- [ ] **Step 1: Extend the interface**

In `packages/app/src/lib/backend/types.ts`, add to `AppsBackend`:

```typescript
  updateAppProvisionStatus(appId: string, provisionStatus: string): Promise<AppRow | null>;
```

- [ ] **Step 2: Implement in the cloud-api module**

In `packages/app/src/lib/backend/cloud-api/apps.ts`, add to the returned object:

```typescript
    async updateAppProvisionStatus(appId, provisionStatus) {
      try {
        return await client.patch<AppRow>(`/v1/apps/${encodeURIComponent(appId)}`, { provisionStatus });
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
```

(`client.patch<T>(path, body)` exists — see `cloud-api/http.ts`. `CloudApiError` is already imported in this file.)

- [ ] **Step 3: Typecheck**

Run: `cd packages/app && npx tsc --noEmit`
Expected: still only the apps-store call-site error from C1 (fixed in C3).

- [ ] **Step 4: Commit** with C3 (keep tsc green per commit).

---

### Task C3: store orchestration (seeding → ready/error/keep) + reseed

**Files:**
- Modify: `packages/app/src/stores/apps-store.ts`
- Test: `packages/app/src/stores/apps-store.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/app/src/stores/apps-store.test.ts`, extend the mock + add tests. Update the `@/lib/backend` mock to include `updateAppProvisionStatus`, and mock `@/lib/daemon-local-client`'s `seedDaemonApp`:

```typescript
const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  createApp: vi.fn(),
  updateAppProvisionStatus: vi.fn(),
  seedDaemonApp: vi.fn(),
}));
vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ apps: {
    listApps: mocks.listApps, createApp: mocks.createApp,
    updateAppProvisionStatus: mocks.updateAppProvisionStatus,
  } }),
}));
vi.mock("@/lib/daemon-local-client", () => ({ seedDaemonApp: mocks.seedDaemonApp }));

// helper appRow(...) already exists in the file; ensure it carries teamId.

it("create: seeded → PATCH seeding then ready", async () => {
  mocks.createApp.mockResolvedValueOnce(appRow({ provisionStatus: "repo_created", gitRemoteUrl: "https://g/x.git", teamId: "team-1" }));
  mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
  mocks.seedDaemonApp.mockResolvedValueOnce("seeded");
  const { useAppsStore } = await import("./apps-store");
  await useAppsStore.getState().create({ teamId: "team-1", name: "N", type: "fullstack_tanstack_postgres", visibility: "team" });
  expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-1", "https://g/x.git", "team-1");
  expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["seeding", "ready"]);
});

it("create: failed → PATCH seeding then error", async () => {
  mocks.createApp.mockResolvedValueOnce(appRow({ provisionStatus: "repo_created", gitRemoteUrl: "https://g/x.git", teamId: "team-1" }));
  mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
  mocks.seedDaemonApp.mockResolvedValueOnce("failed");
  const { useAppsStore } = await import("./apps-store");
  await useAppsStore.getState().create({ teamId: "team-1", name: "N", type: "fullstack_tanstack_postgres", visibility: "team" });
  expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["seeding", "error"]);
});

it("create: unreachable → PATCH seeding only, stays repo_created (no ready/error)", async () => {
  mocks.createApp.mockResolvedValueOnce(appRow({ provisionStatus: "repo_created", gitRemoteUrl: "https://g/x.git", teamId: "team-1" }));
  mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
  mocks.seedDaemonApp.mockResolvedValueOnce("unreachable");
  const { useAppsStore } = await import("./apps-store");
  await useAppsStore.getState().create({ teamId: "team-1", name: "N", type: "fullstack_tanstack_postgres", visibility: "team" });
  const calls = mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1]);
  expect(calls).toContain("seeding");
  expect(calls).not.toContain("ready");
  expect(calls).not.toContain("error");
});

it("reseed: re-runs seed orchestration for an existing app", async () => {
  mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
  mocks.seedDaemonApp.mockResolvedValueOnce("seeded");
  const { useAppsStore } = await import("./apps-store");
  useAppsStore.setState({ items: [appRow({ provisionStatus: "error", gitRemoteUrl: "https://g/x.git", teamId: "team-1" })], loaded: true, loading: false, error: null, teamId: "team-1" });
  await useAppsStore.getState().reseed("app-1");
  expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-1", "https://g/x.git", "team-1");
  expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["seeding", "ready"]);
});

it("create: a thrown PATCH does not reject create", async () => {
  mocks.createApp.mockResolvedValueOnce(appRow({ provisionStatus: "repo_created", gitRemoteUrl: "https://g/x.git", teamId: "team-1" }));
  mocks.updateAppProvisionStatus.mockRejectedValue(new Error("boom"));
  mocks.seedDaemonApp.mockResolvedValueOnce("seeded");
  const { useAppsStore } = await import("./apps-store");
  const row = await useAppsStore.getState().create({ teamId: "team-1", name: "N", type: "fullstack_tanstack_postgres", visibility: "team" });
  expect(row.id).toBe("app-1");
});
```

Add `reseed` to the `AppsState` interface and `beforeEach` reset shape if needed.

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/app && npx vitest run src/stores/apps-store.test.ts`
Expected: FAIL (`reseed` undefined; orchestration not implemented).

- [ ] **Step 3: Implement orchestration + reseed**

In `packages/app/src/stores/apps-store.ts`, add `reseed` to the `AppsState` interface:

```typescript
  reseed: (appId: string) => Promise<void>;
```

Design rule (consistent with A3's `ALLOWED` table): **the desktop writes only the terminal `ready`/`error`** based on the seed outcome. There is NO optimistic `seeding` write, so an `unreachable` kick leaves the row at `repo_created` and `reseed` stays available. (`seeding` remains a legal target in the FC table for a future real "in progress" signal, but this phase doesn't write it.)

Add a shared module-level helper (above `export const useAppsStore`):

```typescript
import { seedDaemonApp } from "@/lib/daemon-local-client";

async function patchStatus(
  set: (fn: (s: AppsState) => Partial<AppsState>) => void,
  appId: string,
  status: string,
): Promise<void> {
  try {
    const updated = await getBackend().apps.updateAppProvisionStatus(appId, status);
    if (updated) set((s) => ({ items: s.items.map((a) => (a.id === appId ? updated : a)) }));
  } catch (e) {
    console.warn("app status writeback failed (non-fatal)", e);
  }
}

async function runSeed(
  set: (fn: (s: AppsState) => Partial<AppsState>) => void,
  appId: string,
  gitRemoteUrl: string,
  teamId: string,
): Promise<void> {
  let outcome: "seeded" | "failed" | "unreachable" = "unreachable";
  try {
    outcome = await seedDaemonApp(appId, gitRemoteUrl, teamId);
  } catch (e) {
    console.warn("app seed kick failed (non-fatal)", e);
  }
  if (outcome === "seeded") await patchStatus(set, appId, "ready");
  else if (outcome === "failed") await patchStatus(set, appId, "error");
  // unreachable → no status change (row stays repo_created); reseed remains available.
}
```

Rewrite `create`'s seed block and add `reseed`:

```typescript
  create: async (input) => {
    const row = await getBackend().apps.createApp(input);
    set((s) => ({ items: [row, ...s.items] }));
    if (row.provisionStatus === "repo_created" && row.gitRemoteUrl) {
      await runSeed(set, row.id, row.gitRemoteUrl, row.teamId);
    }
    return row;
  },
  reseed: async (appId) => {
    const app = get().items.find((a) => a.id === appId);
    if (!app || !app.gitRemoteUrl) return;
    await runSeed(set, app.id, app.gitRemoteUrl, app.teamId);
  },
```

This matches the Step-1 test expectations exactly: `seeded` → status calls `["ready"]`, `failed` → `["error"]`, `unreachable` → `[]`, `reseed` (error row, seeded) → `["ready"]`. All legal under A3's `ALLOWED` (`repo_created→ready`, `repo_created→error`, `error→ready`).

- [ ] **Step 4: Run, expect PASS**

Run: `cd packages/app && npx vitest run src/stores/apps-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `cd packages/app && npx tsc --noEmit && npx eslint src/stores/apps-store.ts src/lib/daemon-local-client.ts src/lib/backend/cloud-api/apps.ts src/lib/backend/types.ts`
Expected: clean.

- [ ] **Step 6: Commit (C1+C2+C3 together — first green tsc point)**

```bash
git -C <worktree> add packages/app/src/lib/daemon-local-client.ts packages/app/src/lib/backend/types.ts packages/app/src/lib/backend/cloud-api/apps.ts packages/app/src/stores/apps-store.ts packages/app/src/stores/apps-store.test.ts
git commit -m "feat(apps): desktop status writeback orchestration + reseed + three-state seed"
```

> NOTE on A3: if you implement C3 before A3 lands, A3's ALLOWED table is the source of truth — make both agree on the reconciled table above. Recommended order: do A3 with the reconciled table first, then C3.

---

### Task C4: "Reseed" action in the apps list

**Files:**
- Modify: `packages/app/src/components/sidebar/AppsListColumn.tsx`
- Modify: `packages/app/src/locales/en.json`, `packages/app/src/locales/zh-CN.json`
- Test: extend `packages/app/src/components/sidebar/__tests__/AppsListColumn.helpers.test.ts` if logic is extractable; else rely on store test + manual

- [ ] **Step 1: Add a reseed control to rows that aren't ready**

In `AppsListColumn.tsx`, for app rows whose `provisionStatus` is `repo_created` or `error`, render a small "Reseed" button (mirror the row/button styling already in the file) that calls `useAppsStore.getState().reseed(app.id)`. Use i18n key `apps.reseed`. Don't show it for `ready`/`seeding`. Keep the existing row click (open session) intact — the button must `stopPropagation` so clicking it doesn't also open the session.

- [ ] **Step 2: Add i18n keys (both locales, identical key set)**

`en.json` (inside the existing `apps` object): `"reseed": "Reseed"`.
`zh-CN.json` (inside `apps`): `"reseed": "重新播种"`.

- [ ] **Step 3: Typecheck + i18n parity + lint**

Run: `cd packages/app && npx tsc --noEmit && npx vitest run src/__tests__/i18n-parity.test.ts && npx eslint src/components/sidebar/AppsListColumn.tsx`
Expected: all green (the new `apps.reseed` key is referenced in the TSX, satisfying the dead-key check).

- [ ] **Step 4: Commit**

```bash
git -C <worktree> add packages/app/src/components/sidebar/AppsListColumn.tsx packages/app/src/locales/en.json packages/app/src/locales/zh-CN.json
git commit -m "feat(apps): reseed action in apps list"
```

---

## Phase D — Verification

### Task D1: Full sweep

- [ ] **Step 1: FC**

Run: `cd services/fc && npm test` (or the package's test script).
Expected: apps-related tests green (pg-repo-apps, supabase-repo, routes-apps, contract). Pre-existing reds unchanged (auth-pg, push-dispatch — env-dependent). `npx tsc -p tsconfig.test.json --noEmit` → only the 5 known pre-existing errors.

- [ ] **Step 2: Daemon**

Run: `cd apps/daemon && cargo test --bin amuxd && cargo test --test http_apps`
Expected: green, including the new credential-fetch integration test; C3 explicit-token/workdir test still green.

- [ ] **Step 3: Frontend**

Run: `cd packages/app && npx tsc --noEmit && npx vitest run && npx eslint src/stores/apps-store.ts src/lib/daemon-local-client.ts src/lib/backend/cloud-api/apps.ts src/components/sidebar/AppsListColumn.tsx`
Expected: apps tests green; i18n parity green; no new tsc/eslint errors.

- [ ] **Step 4: Spec coverage check (self, no commit)**

Confirm each spec section maps to a task:
- §2.1 credential endpoint → A1 (repo) + A2 (route) + A4 (OpenAPI)
- §2.2 daemon JIT pull → B1 (trait) + B2 (seed fetch)
- §3 status writeback → A3 (updateApp) + C1/C2/C3 (desktop orchestration)
- §4 retry → C3 (`reseed`) + C4 (UI)
- §5 error handling → A1 (503/404) + B2 (fetch error → seed error) + C3 (non-fatal, unreachable handling)
- §6 testing → tests in every task + D1
- [ ] Stop. Per `CLAUDE.md`, do NOT push or open a PR until the user explicitly asks. Report completion.

---

## Out of scope (this block)

- Real FC function / Postgres DB provisioning / deploy URL (separate phase-2 block).
- Per-repo scoped deploy tokens (still the shared org PAT).
- Daemon-side credential caching (fetch per seed; app creation is low-frequency).
- iOS / Expo clients.
