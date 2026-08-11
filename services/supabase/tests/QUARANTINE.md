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

Seven files remain. The schema drift that killed the other 21 has been dealt
with; what is left needs a decision, not a rename.

### `001_schema_shape.sql` — needs a rewrite, not a fix

Two problems at once. It asserts `has_table('public', 'agent_runtimes')` for a
table that no longer exists anywhere, and its ~68 assertions all use the
two-argument form described at the bottom of this file — so even the ones naming
surviving tables are asserting the wrong thing. Rewriting it means restating
every assertion against the current schema, which is really "write a new
schema-shape test", not "repair this one".

### `005_agent_role_rls.sql` — tests a table that was dropped

The body inserts into `agent_runtimes` to prove a daemon JWT may write its own
runtime rows. That table is gone, so the scenario no longer exists. Either
delete the section (and keep the surrounding RLS coverage) or delete the file.

### `008_actor_telemetry.sql` — `amux.team_leaderboard` does not exist

Same shape as above: the fixture and assertions are fine until it reaches a
relation that was removed.

### `004_member_reinvite.sql` — behaviour changed

Fails with `member claim requires a non-anonymous user`. The invite-claim path
now refuses anonymous callers; the test predates that. Whether the test or the
rule is right is a product question — read the claim RPC before changing either.

### `007_team_workspace_config.sql` — `new row violates row-level security policy`

The fixture no longer satisfies the workspaces INSERT policy (which now requires
`created_by_member_id` to be the caller's actor in that team). Needs the fixture
to assume an identity before inserting, not a schema rename.

### `012_gateway_message_external_id_upsert.sql` — `actors_external_has_source`

The check constraint requires `(actor_type = 'external') = (source IS NOT NULL
AND source_id IS NOT NULL)`. The fixture builds an actor that violates it.
Straightforward to fix once someone decides what the fixture is meant to model.

### `015_rbac_shortcuts.sql` — temp-table visibility

`permission denied for table fx`. The file builds a fixture temp table and then
`set role`s through several identities. A `grant select on fx` was added and got
it further, but a later step still trips over the same thing — it likely needs
the fixture to live in a regular table, or grants on the `pg_temp` helpers too.

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

## What the repair pass changed

21 files came out of quarantine. Grouped by what was actually wrong:

- **schema rename** — `public.*` and the older `app.*` both became `amux.*`.
  Rewritten by matching against the live object list rather than blanket
  find/replace, because `orgs`, `plans` and `users` really do still live in
  `public`.
- **`members.user_id` moved to `actors.user_id`** — identity is per team now, so
  the link to `auth.users` sits on the per-team row.
- **`agents.agent_kind` is gone**, and `agents.owner_member_id` became NOT NULL
  — several fixtures had no member at all to own their agent.
- **`create_team` is ambiguous**: two overloads with every argument defaulted, so
  `create_team('x')` does not resolve. Calls now name `p_oid` to pick one. Worth
  fixing in the schema rather than in every caller.
- **assertion API misuse** — `like()` is PostgreSQL's operator function, not a
  pgTAP assertion (`alike`/`matches` are), and `ok(lives_ok(...))` never had an
  overload because `lives_ok` returns TAP text, not a boolean. Both had been
  wrong since they were written; nothing ran them, so nobody found out.
- **`perform` at the top level** — valid only inside plpgsql. Note when fixing
  more of these: the same file usually has legitimate `perform` inside `DO`
  blocks, so a blind find/replace breaks it in the other direction.
