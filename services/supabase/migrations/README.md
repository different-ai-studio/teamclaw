# Supabase migrations

## Layout

| Path | Purpose |
|------|---------|
| `20260601000000_baseline.sql` | Full TeamClaw schema (squashed from 93 pre-migration files) |
| `_archive/pre-20260601-baseline/` | Historical incremental migrations (reference only, do not apply) |
| `../tests/` | pgTAP behavioral tests |

## Fresh database

Apply the baseline once:

```bash
# via Supabase MCP execute_sql, psql, or Studio SQL editor
\i services/supabase/migrations/20260601000000_baseline.sql
```

Record it in migration history (if your tooling expects `schema_migrations`):

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20260601000000', 'baseline')
ON CONFLICT DO NOTHING;
```

## Existing Aliyun database

The production instance was built by running all archived migrations sequentially.
**Do not re-apply the baseline** — schema already matches.

Optional cleanup (only if you want a single row in `schema_migrations`):

```sql
-- DANGER: only on fresh clones, never on production with mixed history
-- TRUNCATE supabase_migrations.schema_migrations;
-- INSERT INTO supabase_migrations.schema_migrations (version, name)
-- VALUES ('20260601000000', 'baseline');
```

## New changes

Add timestamped SQL files **after** the baseline, e.g. `20260615_add_foo.sql`.
