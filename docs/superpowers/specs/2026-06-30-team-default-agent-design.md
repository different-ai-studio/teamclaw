# Team-level Default Agent — Design

Date: 2026-06-30
Status: Draft (awaiting review)

## Goal

Add a **team-level default agent actor id**: a single agent that acts as the
team's fallback default. When a member has not set their own per-member default
agent, callers resolve to the team default instead.

This is distinct from, and complementary to, the existing **per-member** default
agent (`members.default_agent_id`, `/v1/teams/:id/members/me/default-agent`).

## Decisions (locked)

- **Semantics:** team-level fallback. Resolution precedence is
  `member default > team default > null`.
- **Permission:** only team `owner`/`admin` may set the team default (read is
  open to any member).
- **Resolution:** server-side. Clients fetch an already-resolved "effective"
  value; they do not each re-implement fallback.
- **Storage:** new column on `amux.teams` (alongside `share_mode`), not
  `team_workspace_config`.
- **RPC naming:** add a **new** `get_effective_default_agent`. The existing
  `get_member_default_agent` keeps its current semantics (returns the raw
  `members.default_agent_id`, may be null) so the daemon's "is member default
  unset?" auto-set logic is unaffected.
- **Scope:** full stack — DB + FC API + OpenAPI + desktop + iOS + daemon.

## Data Model

Add to `amux.teams`:

```sql
ALTER TABLE amux.teams
  ADD COLUMN default_agent_id uuid
  REFERENCES amux.agents(id) ON DELETE SET NULL;
```

Two migrations, mirroring the existing per-member migration pattern:

- Supabase: `services/supabase/migrations/<ts>_add_team_default_agent.sql`
  (column + the three RPCs below + grants).
- FC Drizzle: `services/fc/src/db/migrations/0009_add_team_default_agent.sql`
  (column only, to keep the pg path in sync).

## RPCs (Supabase / `amux` schema)

### `set_team_default_agent(p_team_id uuid, p_agent_id uuid default null) → uuid`

- Authorize: `amux.current_team_role(p_team_id) in ('owner','admin')`, else
  raise.
- When `p_agent_id` is not null, validate the agent (reuse the
  `set_member_default_agent` checks):
  - same team,
  - `actor_type = 'agent'`,
  - `status = 'active'`,
  - **`visibility = 'team'`** — a team default must be visible to the whole
    team, so personal agents are rejected (stricter than the member case, which
    also allows owner-owned personal agents).
- Update `teams.default_agent_id`. Returns the value set (or null to clear).

### `get_team_default_agent(p_team_id uuid) → uuid`

- Any team member may call (raise if caller is not a member).
- Returns `teams.default_agent_id` (may be null).

### `get_effective_default_agent(p_team_id uuid) → uuid`

- Any team member may call.
- Returns `coalesce(member.default_agent_id, teams.default_agent_id)` for the
  current caller in that team. May be null.
- `get_member_default_agent` is left untouched.

All three are `security definer`, search_path-pinned, and granted to
`authenticated` (matching the member-default RPCs). FC service-role path goes
through these same RPCs in `supabase-repo.ts`.

## FC API

New routes in `services/fc/src/lib/routes/` (team-scoped, owner/admin enforced
at the RPC layer):

- `GET  /v1/teams/:teamId/default-agent`
  → `{ defaultAgentId: uuid | null }` (the team default; via
  `getTeamDefaultAgent`).
- `PUT  /v1/teams/:teamId/default-agent`
  body `{ agentId: uuid | null }` → `{ defaultAgentId }` (via
  `setTeamDefaultAgent`; 403 from RPC if caller is not owner/admin).
- `GET  /v1/teams/:teamId/members/me/effective-default-agent`
  → `{ defaultAgentId: uuid | null }` (resolved; via
  `getEffectiveDefaultAgent`).

Repository contract additions (`repository-contract.ts`) implemented in both
`supabase-repo.ts` (RPC passthrough) and `pg-repo/` (SQL): `getTeamDefaultAgent`,
`setTeamDefaultAgent`, `getEffectiveDefaultAgent`.

OpenAPI: document the three new endpoints in
`docs/openapi/teamclaw-api.v1.yaml`. (Note: the existing member default-agent
endpoints are currently undocumented; documenting them is out of scope here but
called out.)

## Clients

All clients consume the **effective** endpoint where they currently consume the
member default (so fallback is transparent), and add an owner/admin-only setter
for the team default in team settings UI.

- **Desktop** (`packages/app/`): add `CloudApiProvider` methods + store wiring.
  In team settings, an owner/admin-only "团队默认 Agent" picker (team-visible
  agents only). Where the app currently reads member default for "new session"
  defaulting, switch to the effective endpoint.
- **iOS** (`apps/ios/`): `CloudAPIClient`/`CloudAPIRepositories` methods; team
  settings picker gated on role; effective value used for new-session default.
- **daemon** (`apps/daemon/`): when auto-setting a member default it continues
  to use `get_member_default_agent` (raw) for the "unset?" check — unchanged.
  Where it resolves "which agent to route a new gateway/session to" by default,
  it uses the effective endpoint so the team fallback applies.

## Error Handling

- Setter by non-owner/admin → RPC raises; FC maps to `403`.
- Agent not team-visible / not active / cross-team → RPC raises; FC maps to
  `409`/`422` (match existing member-default error mapping).
- Clearing (agentId null) is always allowed for owner/admin.
- Agent deletion auto-nulls the column (`ON DELETE SET NULL`); effective
  resolution then falls through to null.

## Testing

- **Supabase**: pgTAP/db tests for the three RPCs — role gate, visibility gate,
  fallback precedence (member set vs unset), clear, and `ON DELETE SET NULL`.
- **FC**: route tests (auth, 403 for non-admin, shape), repository-contract
  tests for both backends, casing-drift check (camelCase vs snake_case) per the
  known FC repo-casing pitfall.
- **Desktop**: store/provider unit tests; settings picker role-gating test.
- **iOS**: AMUXCore repository tests.
- **daemon**: bin test for effective-resolution routing (mirrors existing
  default-agent daemon tests).

## Out of Scope

- Migrating/deprecating the per-member default (kept as-is).
- Documenting the pre-existing member default-agent endpoints in OpenAPI.
- Any UI for per-agent visibility changes.
