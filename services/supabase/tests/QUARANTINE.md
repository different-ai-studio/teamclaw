# Quarantined pgTAP tests

`run.sh` skips the files listed in its `QUARANTINE` block. They are not skipped
because they are unimportant — they are skipped because they assert against a
schema that no longer exists, and a suite that is always red is a suite everyone
learns to ignore. That is exactly how this directory got here: nothing ran it,
so nothing noticed when the schema moved out from under it.

**Fixing one = delete its line from `QUARANTINE` in `run.sh` and make it pass.**
CI runs everything not on that list, so a fixed test is protected from then on.

## How to run

```sh
cd services/supabase/tests

# against a local stack
PGHOST=… PGUSER=postgres PGDATABASE=postgres ./run.sh

# against a compose deployment
PSQL="docker exec -i supabase-db psql -U postgres -d postgres" ./run.sh

./run.sh 016_session_list_v2_rpc.sql   # one file
ALL=1 ./run.sh                          # include the quarantined ones
```

Every file wraps itself in `begin … rollback`, so running the suite leaves
nothing behind and is safe against a live database.

## Why they fail

The schema moved twice since these were written. Grouped by what each one needs:

### 1. `public.*` → `amux.*` (all of them)

Every business table and function moved to the `amux` schema. Note `orgs` is the
exception — it is still in `public`, so a blanket find/replace breaks it.

### 2. Identity moved from `members` to `actors`

`members.user_id` no longer exists. A user's link to `auth.users` is on
`amux.actors.user_id`, because identity is per team (one actor row per user per
team, `unique (team_id, user_id)`). Fixtures must insert `user_id` on the actor
and omit it on the member.

Affected: `002_rls`, `004_member_reinvite`, `005_agent_role_rls`,
`015_rbac_shortcuts`, `021_agent_reinvite_owner_check`.

### 3. `agents.agent_kind` is gone

Replaced by `default_agent_type` + `agent_types`. Fixtures inserting
`agent_kind` need it dropped.

Affected: `001_schema_shape`, `006_access_token_hook`, `009_agent_visibility`,
`011_gateway_session_rpc`, `013_gateway_agent_admin_owner_rpc`,
`014_gateway_external_message_rls`, `016_push_notifications`.

### 4. `create_team` is ambiguous

There are now two overloads, both with every argument defaulted, so
`create_team('x')` fails with *function is not unique*. Calls need enough
arguments (or explicit casts) to pick one. Worth fixing in the schema rather
than the tests.

Affected: `003_team_invites`, `004_member_reinvite`, `007_team_workspace_config`,
`008_actor_telemetry`, `020_oss_sync_schema`, `team_share_mode.test`.

### 5. `permission denied for table <fixture>`

These create a fixture table and then `set role`, leaving the new role without a
grant on it. They need a `grant` after the fixture, or should build the fixture
as a temp table owned by the test role.

Affected: `027_org_default_team_selection`, `028_phone_linked_org_picker`,
`029_empty_org_public_bootstrap`, `claim_team_invite_agent_org.test`.

### 6. Genuine behaviour differences — read before "fixing"

These fail on an assertion, not on schema drift, so the assertion may be
describing behaviour that was deliberately changed. Check the intent before
touching them.

- `025_agent_delete_authz` — *expected personal-agent delete denial for
  non-owner*. Either the authz rule changed or the test is right and there is a
  real hole. Worth a look on its own.
- `team_default_agent.test` — inserts an agent without `owner_member_id`, which
  is NOT NULL now.

## A trap worth knowing

pgTAP overloads its assertions on both `(schema, object)` and
`(object, description)`. Two untyped string literals resolve to the **latter**,
so

```sql
select has_table('amux', 'session_read_markers');   -- asserts a table NAMED "amux"
```

silently checks the wrong thing and fails. Always pass a description, which
picks the schema-qualified overload and makes the output readable:

```sql
select has_table('amux', 'session_read_markers', 'session_read_markers exists');
```

Several of the quarantined files carry this bug on top of the schema drift.

## Deleted

- `003_daemon_invites.sql` — the `daemon_invites` table no longer exists
  anywhere in the schema. The test covered a feature that was removed, so it was
  deleted rather than quarantined.
