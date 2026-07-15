# belayo_live — clone TeamClaw from belayo_test

Production and test are separate Alibaba RDS instances. Both use database
**`supabase_db`** (the empty `postgres` database is not Supabase).

## Verified schema layout (belayo_test, 2026-06)

| Object | Location |
|---|---|
| Business tables (37), views, RLS, triggers | **`amux`** |
| Helpers + RPCs (`is_team_member`, `create_team`, `ensure_personal_org`, …) | **`amux`** (not `app`) |
| FC auth invite RPC | **`public.claim_team_invite`** only |
| saas-mono tables (`orgs`, `users`, …) | **`public`** — unchanged |
| `storage.*`, `auth.*` | unchanged |

There is **no `app` schema** on belayo.

## RDS hosts (connectivity)

| Env | Host | Notes |
|---|---|---|
| **test** | `pgm-wz9e7zgczy2wdp7qgo.pg.rds.aliyuncs.com` | Public IP `47.113.29.0` — use this |
| test (broken from laptop) | `pgm-wz9e7zgczy2wdp7q.pg.rds.aliyuncs.com` | Resolves to VPC private IP — do not use off-VPC |
| **live** | `pgm-wz9269brt4zi9k91bo.pg.rds.aliyuncs.com` | Public IP `47.112.66.50` |

Use `sslmode=disable` for both.

## Migrate test → live

```sh
export BELAYO_TEST_RDS_PASSWORD='...'
export BELAYO_LIVE_RDS_PASSWORD='...'

cd services/supabase/s4
chmod +x belayo-live.sh belayo-compare.sh
./belayo-live.sh preflight
./belayo-live.sh dump-only    # review ./_dump/
./belayo-live.sh apply        # schema-only (no amux row data)

# optional: copy test row data into live amux
# WITH_DATA=1 ./belayo-live.sh apply
```

The script:

1. `pg_dump --schema=amux --schema-only` from test
2. `CREATE OR REPLACE public.claim_team_invite` from test (single public function)
3. Verifies **public base table count unchanged** on live before/after
4. Does **not** dump or modify `public` tables, `storage`, or other `public` functions
5. Grants `amux` to `anon` / `authenticated` / `service_role` and runs PostgREST reload SQL

Re-run grants + `NOTIFY` on an already-migrated live DB:

```sh
./belayo-live.sh postgrest-reload
```

## Compare test vs live

```sh
export BELAYO_TEST_RDS_PASSWORD='...'
export BELAYO_LIVE_RDS_PASSWORD='...'
./belayo-compare.sh
```

## After apply (ops)

PostgREST needs **both** RDS and the live Supabase **rest container**:

1. **RDS** (`supabase_db`) — done by `./belayo-live.sh apply` or `postgrest-reload`:
   - `GRANT` on `amux` tables/routines/sequences to `anon`, `authenticated`, `service_role`
   - `ALTER ROLE authenticator SET pgrst.db_schemas TO 'public, amux, storage, graphql_public'`
   - `NOTIFY pgrst, 'reload schema'`
2. **rest container** on live Supabase host — set and recreate if needed:
   - `PGRST_DB_SCHEMAS=public, amux, storage, graphql_public`
   - `PGRST_DB_URI` must point at **`supabase_db`** (not empty `postgres`)
   - Use the live RDS `authenticator` password from the Supabase stack env (auth/meta containers — not a stale typo in `/opt/supabase/.env`)
3. **FC**: `SUPABASE_URL` → live Supabase API (`https://supa.mx5.cn` public / Kong internal)
4. **Smoke** (REST):

```sh
curl -sS "https://supa.mx5.cn/rest/v1/teams?select=id&limit=1" \
  -H "apikey: $SUPABASE_LIVE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_LIVE_ANON_KEY" \
  -H "Accept-Profile: amux"
# expect HTTP 200 and [] when schema-only (RLS) or rows with service_role
```

## Acceptance

```sql
select count(*) from information_schema.tables
 where table_schema='amux' and table_type='BASE TABLE';  -- 37

select count(*) from information_schema.views
 where table_schema='amux' and table_name='actor_directory';  -- 1

select n.nspname, p.proname from pg_proc p
 join pg_namespace n on n.oid = p.pronamespace
 where p.proname = 'is_team_member';  -- amux only

select count(*) from pg_policies
 where schemaname='amux' and policyname='teams_org_guard';  -- 1
```

## Rollback

```sh
./belayo-live.sh rollback   # drops amux + public.claim_team_invite only
```
