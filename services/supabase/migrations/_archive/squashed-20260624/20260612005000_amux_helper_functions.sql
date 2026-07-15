-- Create the amux.* helper functions that later migrations reference but that
-- no migration ever defines in the `amux` schema.
--
-- Root cause: move_teamclaw_to_amux (20260608010000) relocates business *tables*
-- from public -> amux and rewrites *function bodies* in place (functions stay in
-- their original `app`/`public` schema). But several post-move migrations qualify
-- helper calls with `amux.` — assuming the helpers were also moved — e.g.:
--   - 20260612010000 (agents SELECT policy): amux.is_current_agent / is_team_member
--                                            / current_actor_id_for_team
--   - 20260614000000 (app_member_access policy): amux.current_member_id
--   - 20260617000000 / 20260618000000 (ACL view): amux.amux_acl_rules_for
-- On the live belayo-test/dev databases these functions were created out of band,
-- so the sequence applied there; on a clean sequential apply (a fresh self-host
-- or a fresh production deploy) those migrations fail with
-- "function amux.<name>(...) does not exist". This migration closes that gap.
--
-- The simple lookups are defined directly against the post-move amux tables; the
-- security-sensitive, overloaded ACL function delegates to its existing public
-- definition so its semantics and grants stay the single source of truth.
-- All idempotent (create or replace). Placed before the first consumer.

create or replace function amux.is_current_agent(p_agent_id uuid)
returns boolean language sql stable security definer set search_path = amux, public, auth as $$
  select exists (
    select 1 from amux.actors a
     where a.id = p_agent_id
       and a.actor_type = 'agent'
       and a.user_id = auth.uid()
  )
$$;

create or replace function amux.is_team_member(target_team_id uuid)
returns boolean language sql stable security definer set search_path = amux, public, auth as $$
  select exists (
    select 1 from amux.actors
     where user_id = auth.uid() and team_id = target_team_id
  )
$$;

create or replace function amux.current_actor_id_for_team(p_team_id uuid)
returns uuid language sql stable security definer set search_path = amux, public, auth as $$
  select id from amux.actors
   where user_id = auth.uid() and team_id = p_team_id
$$;

create or replace function amux.current_member_id()
returns uuid language sql stable security definer set search_path = amux, public, auth as $$
  select a.id
    from amux.actors a
    join amux.members m on m.id = a.id
   where a.user_id = auth.uid() and m.status = 'active'
   order by a.created_at limit 1
$$;

-- current_org_id is created in amux only at 20260617, but a create-time consumer
-- (20260615 list_my_teams view) needs it earlier. Provide an early shim delegating
-- to app.current_org_id() (present since 20260608020000); 20260617 later replaces
-- it with its richer users-linkage-aware body via create-or-replace.
create or replace function amux.current_org_id()
returns uuid language sql stable security definer set search_path = amux, public, auth as $$
  select app.current_org_id()
$$;

-- ACL rules are EMQX/MQTT authorization data — keep the public definition (with
-- its overloads) as the single source of truth and expose an amux-qualified shim.
create or replace function amux.amux_acl_rules_for(p_team uuid, p_actor uuid, p_type text)
returns table (action text, topic text) language sql immutable set search_path = amux, public as $$
  select action, topic from public.amux_acl_rules_for(p_team, p_actor, p_type)
$$;

grant execute on function amux.is_current_agent(uuid)            to authenticated;
grant execute on function amux.is_team_member(uuid)              to authenticated;
grant execute on function amux.current_actor_id_for_team(uuid)   to authenticated;
grant execute on function amux.current_member_id()               to authenticated;
grant execute on function amux.current_org_id()                  to anon, authenticated, service_role;
revoke execute on function amux.amux_acl_rules_for(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function amux.amux_acl_rules_for(uuid, uuid, text) to supabase_auth_admin;
