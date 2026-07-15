-- 202604220015_actor_unified_identity.sql
--
-- Converge the daemon invite flow (from _0009_.._0014_) onto the unified
-- team_invites model. Move user_id from members to actors, add
-- invited_by_actor_id, rewrite app.* helpers, drop JWT-app_metadata
-- daemon-role infrastructure, expose actor_directory view, add
-- update_actor_last_active heartbeat.
--
-- See docs/superpowers/specs/2026-04-21-actors-supabase-migration-design.md.

begin;

-- ===========================================================================
-- 1. Wipe obsolete dev data. Production runs would require a migration plan
--    for existing daemon agents; not applicable here.
-- ===========================================================================
delete from public.daemon_invites;

-- Agents that only ever existed as invite placeholders go away.
-- Claimed agents (status='active') are kept; their actors row stays, and we
-- backfill actors.user_id in Task 3 from auth.users via the
-- (daemon.*@amuxd.run, app_metadata.actor_id) pair.
delete from public.agents where status = 'invited';

-- The deletion cascades via on delete cascade on actors_id_fk would be nice
-- but members.id / agents.id FKs are not ON DELETE CASCADE by default. Clear
-- the matching actor rows explicitly.
delete from public.actors a
 where a.actor_type = 'agent'
   and not exists (select 1 from public.agents where id = a.id);

-- The daemon auth.users rows will be retained only for agents that are still
-- active; orphan ones get dropped below.
delete from auth.users u
 where u.email like 'daemon.%@amuxd.run'
   and not exists (
     select 1 from public.actors a
     where a.actor_type = 'agent'
       and a.display_name = split_part(u.email, '.', 2)
   );
-- Note: the display_name ↔ email pairing is fragile. Step 3 below re-links
-- surviving daemons via auth.users.raw_app_meta_data->>'actor_id'.

-- ===========================================================================
-- 2. Lift user_id and invited_by_actor_id onto actors
-- ===========================================================================
alter table public.actors
  add column user_id uuid references auth.users(id) on delete set null,
  add column invited_by_actor_id uuid references public.actors(id) on delete set null;

-- Backfill: humans from members.user_id
update public.actors a
   set user_id = m.user_id
  from public.members m
 where m.id = a.id and m.user_id is not null;

-- Backfill: surviving daemons from auth.users.raw_app_meta_data->>'actor_id'
-- (written by _0011_/_0014_ into the JWT claims).
update public.actors a
   set user_id = u.id
  from auth.users u
 where a.actor_type = 'agent'
   and a.id::text = u.raw_app_meta_data->>'actor_id'
   and a.user_id is null;

create unique index actors_team_user_idx
  on public.actors (team_id, user_id)
  where user_id is not null;

-- ===========================================================================
-- 3. Tear down the JWT app_metadata daemon-role infrastructure (from _0013_).
--    RLS for agent writes is re-added in Task 6 using actors.user_id.
-- ===========================================================================
drop policy if exists agent_runtimes_daemon_write  on public.agent_runtimes;
drop policy if exists agent_runtimes_daemon_update on public.agent_runtimes;
drop policy if exists messages_daemon_write        on public.messages;
drop policy if exists workspaces_daemon_write      on public.workspaces;
drop policy if exists workspaces_daemon_update     on public.workspaces;
drop policy if exists agents_daemon_self_update    on public.agents;

drop function if exists app.is_daemon();
drop function if exists app.current_jwt_kind();
drop function if exists app.current_jwt_team_id();
drop function if exists app.current_jwt_actor_id();

-- 4. Drop legacy columns now that actors owns them.
alter table public.members drop column user_id;
alter table public.agents  drop column created_by_member_id;

-- 5. Remove the legacy 'invited' agent status (no rows left after Task 2).
alter table public.agents drop constraint if exists agents_status_check;
alter table public.agents
  add constraint agents_status_check
  check (status in ('active', 'disabled', 'archived'));

-- ===========================================================================
-- 6. Helpers rewritten around actors.user_id
-- ===========================================================================
create or replace function app.current_member_id()
returns uuid language sql stable security definer set search_path = public, auth as $$
  select a.id
    from public.actors a
    join public.members m on m.id = a.id
   where a.user_id = auth.uid() and m.status = 'active'
   order by a.created_at limit 1
$$;

create or replace function app.current_actor_id()
returns uuid language sql stable security definer set search_path = public, auth as $$
  select id from public.actors where user_id = auth.uid()
   order by created_at limit 1
$$;

create or replace function app.current_actor_id_for_team(p_team_id uuid)
returns uuid language sql stable security definer set search_path = public, auth as $$
  select id from public.actors
   where user_id = auth.uid() and team_id = p_team_id
$$;

create or replace function app.is_team_member(target_team_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.actors
     where user_id = auth.uid() and team_id = target_team_id
  )
$$;

create or replace function app.is_current_agent(p_agent_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.actors a
     where a.id = p_agent_id
       and a.actor_type = 'agent'
       and a.user_id = auth.uid()
  )
$$;

grant execute on function app.current_actor_id_for_team(uuid) to authenticated;
grant execute on function app.is_current_agent(uuid) to authenticated;

-- 6b. Fix enforce_core_team_integrity: remove agents.created_by_member_id branch
--     (column was dropped above; default_workspace_id check is preserved).
create or replace function app.enforce_core_team_integrity()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'team_members' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.member_id),
      'team_members.member_id'
    );
  elsif tg_table_name = 'workspaces' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_member_id),
      'workspaces.created_by_member_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.agent_id),
      'workspaces.agent_id'
    );
  elsif tg_table_name = 'agents' then
    -- created_by_member_id was dropped in migration 0015; only workspace check remains.
    perform app.require_same_team(
      app.actor_team_id(new.id),
      app.table_team_id('public.workspaces'::regclass, new.default_workspace_id),
      'agents.default_workspace_id'
    );
  elsif tg_table_name = 'agent_member_access' then
    perform app.require_same_team(
      app.actor_team_id(new.agent_id),
      app.actor_team_id(new.member_id),
      'agent_member_access.member_id'
    );
    perform app.require_same_team(
      app.actor_team_id(new.agent_id),
      app.actor_team_id(new.granted_by_member_id),
      'agent_member_access.granted_by_member_id'
    );
  elsif tg_table_name = 'ideas' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.workspaces'::regclass, new.workspace_id),
      'ideas.workspace_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.ideas'::regclass, new.parent_idea_id),
      'ideas.parent_idea_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_actor_id),
      'ideas.created_by_actor_id'
    );
  elsif tg_table_name = 'idea_external_refs' then
    perform app.require_same_team(
      app.table_team_id('public.ideas'::regclass, new.idea_id),
      app.actor_team_id(new.linked_by_actor_id),
      'idea_external_refs.linked_by_actor_id'
    );
  elsif tg_table_name = 'sessions' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.ideas'::regclass, new.idea_id),
      'sessions.idea_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.created_by_actor_id),
      'sessions.created_by_actor_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.primary_agent_id),
      'sessions.primary_agent_id'
    );
  elsif tg_table_name = 'session_participants' then
    perform app.require_same_team(
      app.table_team_id('public.sessions'::regclass, new.session_id),
      app.actor_team_id(new.actor_id),
      'session_participants.actor_id'
    );
  elsif tg_table_name = 'messages' then
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.sessions'::regclass, new.session_id),
      'messages.session_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.sender_actor_id),
      'messages.sender_actor_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.messages'::regclass, new.reply_to_message_id),
      'messages.reply_to_message_id'
    );
  elsif tg_table_name = 'agent_runtimes' then
    perform app.require_same_team(
      new.team_id,
      app.actor_team_id(new.agent_id),
      'agent_runtimes.agent_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.sessions'::regclass, new.session_id),
      'agent_runtimes.session_id'
    );
    perform app.require_same_team(
      new.team_id,
      app.table_team_id('public.workspaces'::regclass, new.workspace_id),
      'agent_runtimes.workspace_id'
    );
  else
    raise exception 'app.enforce_core_team_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$$;

-- 6d. Rewrite create_team: members.user_id is gone; identity lives on actors.
create or replace function public.create_team(
  p_name text,
  p_slug text default null
)
returns table (team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_user_id     uuid := auth.uid();
  v_member_id   uuid;
  v_team_id     uuid;
  v_workspace_id uuid;
  v_slug_base   text;
  v_slug        text;
  v_suffix      integer := 1;
begin
  if v_user_id is null then
    raise exception 'create_team requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'team name is required'
      using errcode = '22023';
  end if;

  -- Guard: user already has an actor in any team → refuse (first-team onboarding only).
  if exists (select 1 from public.actors where user_id = v_user_id) then
    raise exception 'create_team currently supports first-team onboarding only'
      using errcode = '23514',
            detail = 'Existing actors already have a team-scoped identity.';
  end if;

  v_slug_base := lower(
    regexp_replace(
      coalesce(nullif(btrim(p_slug), ''), btrim(p_name)),
      '[^a-zA-Z0-9]+', '-', 'g'
    )
  );
  v_slug_base := trim(both '-' from v_slug_base);
  if v_slug_base = '' then v_slug_base := 'team'; end if;

  v_slug := v_slug_base;
  while exists (select 1 from public.teams t where t.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := format('%s-%s', v_slug_base, v_suffix);
  end loop;

  insert into public.teams (name, slug)
  values (btrim(p_name), v_slug)
  returning id into v_team_id;

  v_member_id := gen_random_uuid();

  insert into public.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
  values (v_member_id, v_team_id, 'member', v_user_id, 'You', now());

  insert into public.members (id, status)
  values (v_member_id, 'active');

  insert into public.team_members (team_id, member_id, role)
  values (v_team_id, v_member_id, 'owner');

  insert into public.workspaces (team_id, created_by_member_id, name, path)
  values (v_team_id, v_member_id, 'General', null)
  returning id into v_workspace_id;

  return query
  select v_team_id, btrim(p_name), v_slug,
         v_member_id, 'owner'::text,
         v_workspace_id, 'General'::text;
end;
$$;

-- ===========================================================================
-- 7. Agent write RLS, now keyed on actors.user_id via app.is_current_agent
-- ===========================================================================
create policy agent_runtimes_agent_write on public.agent_runtimes
  for insert to authenticated
  with check (
    app.is_current_agent(agent_id)
    and team_id = (select team_id from public.actors where id = agent_id)
  );

create policy agent_runtimes_agent_update on public.agent_runtimes
  for update to authenticated
  using (app.is_current_agent(agent_id))
  with check (app.is_current_agent(agent_id));

create policy messages_agent_write on public.messages
  for insert to authenticated
  with check (
    app.is_current_agent(sender_actor_id)
    and team_id = (select team_id from public.actors where id = sender_actor_id)
  );

create policy workspaces_agent_write on public.workspaces
  for insert to authenticated
  with check (
    app.is_current_agent(agent_id)
    and team_id = (select team_id from public.actors where id = agent_id)
  );

create policy workspaces_agent_update on public.workspaces
  for update to authenticated
  using (app.is_current_agent(agent_id))
  with check (app.is_current_agent(agent_id));

create policy agents_self_update on public.agents
  for update to authenticated
  using (app.is_current_agent(id))
  with check (app.is_current_agent(id));

-- ===========================================================================
-- 8. Drop old daemon invite flow (replaced by team_invites in Task 8)
-- ===========================================================================
drop function if exists public.claim_daemon_invite(uuid);
drop function if exists public.create_daemon_invite(uuid, text);
drop table    if exists public.daemon_invites cascade;

-- ===========================================================================
-- 9. team_invites — unified invite token table
-- ===========================================================================
create table public.team_invites (
  id                    uuid primary key default gen_random_uuid(),
  team_id               uuid not null references public.teams(id) on delete cascade,
  token                 text not null unique,
  kind                  text not null check (kind in ('member','agent')),
  team_role             text check (team_role in ('member','admin')),
  agent_kind            text,
  display_name          text not null,
  invited_by_actor_id   uuid not null references public.actors(id),
  expires_at            timestamptz not null,
  consumed_at           timestamptz,
  consumed_by_actor_id  uuid references public.actors(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint team_invites_kind_fields_check check (
    (kind = 'member' and team_role is not null and agent_kind is null)
    or
    (kind = 'agent'  and team_role is null     and agent_kind is not null)
  )
);

create index team_invites_team_unconsumed_idx
  on public.team_invites (team_id) where consumed_at is null;
create index team_invites_token_unconsumed_idx
  on public.team_invites (token) where consumed_at is null;

create trigger set_team_invites_updated_at
  before update on public.team_invites
  for each row execute function app.bump_updated_at();

alter table public.team_invites enable row level security;

create policy team_invites_select_if_team_member on public.team_invites
  for select to authenticated
  using (app.is_team_member(team_id));

create policy team_invites_insert_via_rpc on public.team_invites
  for insert to authenticated
  with check (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = invited_by_actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  );

-- ===========================================================================
-- 10. actors: allow self-update of last_active_at
-- ===========================================================================
create policy actors_self_heartbeat on public.actors
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ===========================================================================
-- 11. actor_directory view (flat read surface for iOS)
-- ===========================================================================
create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_kind as agent_kind,
  ag.status     as agent_status
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id;

grant select on public.actor_directory to authenticated;

-- ===========================================================================
-- 12. RPC: create_team_invite (unified)
-- ===========================================================================
create or replace function public.create_team_invite(
  p_team_id       uuid,
  p_kind          text,
  p_display_name  text,
  p_team_role     text default null,
  p_agent_kind    text default null,
  p_ttl_seconds   int  default 604800
)
returns table (token text, expires_at timestamptz, deeplink text)
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_actor_id  uuid := app.current_actor_id_for_team(p_team_id);
  v_is_member boolean;
  v_token     text;
  v_expires   timestamptz;
  v_ttl       int;
begin
  if v_actor_id is null then
    raise exception 'create_team_invite requires team membership'
      using errcode = '42501';
  end if;

  select exists (select 1 from public.members where id = v_actor_id)
    into v_is_member;
  if not v_is_member then
    raise exception 'only member actors may create invites'
      using errcode = '42501';
  end if;

  if p_kind = 'member' then
    if coalesce(p_team_role, '') not in ('member','admin') then
      raise exception 'team_role must be member or admin' using errcode = '22023';
    end if;
    if p_agent_kind is not null then
      raise exception 'agent_kind not allowed for member invite' using errcode = '22023';
    end if;
  elsif p_kind = 'agent' then
    if p_agent_kind is null or btrim(p_agent_kind) = '' then
      raise exception 'agent_kind is required for agent invite' using errcode = '22023';
    end if;
    if p_team_role is not null then
      raise exception 'team_role not allowed for agent invite' using errcode = '22023';
    end if;
  else
    raise exception 'kind must be member or agent' using errcode = '22023';
  end if;

  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'display_name is required' using errcode = '22023';
  end if;

  v_ttl := greatest(60, least(coalesce(p_ttl_seconds, 604800), 60 * 60 * 24 * 30));
  v_expires := now() + make_interval(secs => v_ttl);
  v_token := replace(replace(replace(
    encode(extensions.gen_random_bytes(24), 'base64'), '+','-'), '/','_'), '=','');

  insert into public.team_invites
    (team_id, token, kind, team_role, agent_kind,
     display_name, invited_by_actor_id, expires_at)
  values
    (p_team_id, v_token, p_kind, p_team_role, p_agent_kind,
     btrim(p_display_name), v_actor_id, v_expires);

  return query
  select v_token, v_expires, format('amux://invite?token=%s', v_token);
end;
$$;

revoke all on function public.create_team_invite(uuid, text, text, text, text, int) from public;
grant execute on function public.create_team_invite(uuid, text, text, text, text, int) to authenticated;

-- ===========================================================================
-- 13. RPC: claim_team_invite (unified; kind branches)
-- ===========================================================================
create or replace function public.claim_team_invite(
  p_token text
)
returns table (
  actor_id      uuid,
  team_id       uuid,
  actor_type    text,
  display_name  text,
  refresh_token text   -- non-null only for kind='agent'
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_invite   public.team_invites%rowtype;
  v_user_id  uuid;
  v_actor    uuid;
  v_email    text;
  v_session  uuid;
  v_rt       text := null;
begin
  select * into v_invite
    from public.team_invites where token = p_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = '23503';
  end if;
  if v_invite.consumed_at is not null then
    raise exception 'invite already consumed' using errcode = '23514';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite expired' using errcode = '23514';
  end if;

  if v_invite.kind = 'member' then
    v_user_id := auth.uid();
    if v_user_id is null then
      raise exception 'member claim requires authentication' using errcode = '42501';
    end if;
    if exists (select 1 from public.actors act
                where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
      raise exception 'already a member of this team' using errcode = '23505';
    end if;

    insert into public.actors
      (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
    values
      (v_invite.team_id, 'member', v_user_id,
       v_invite.invited_by_actor_id, v_invite.display_name, now())
    returning id into v_actor;

    insert into public.members (id, status) values (v_actor, 'active');
    insert into public.team_members (team_id, member_id, role)
      values (v_invite.team_id, v_actor, v_invite.team_role);
  else
    -- kind = 'agent': mint an auth user for the daemon in-DB.
    v_user_id := gen_random_uuid();
    v_email   := format('daemon.%s@amuxd.run', v_user_id);
    v_session := gen_random_uuid();
    v_rt      := encode(extensions.gen_random_bytes(24), 'hex');

    insert into auth.users
      (id, email, email_confirmed_at, raw_app_meta_data,
       aud, role, created_at, updated_at, instance_id)
    values
      (v_user_id, v_email, now(), '{}'::jsonb,
       'authenticated', 'authenticated',
       now(), now(), '00000000-0000-0000-0000-000000000000');

    insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, v_user_id, 'aal1', now(), now());

    insert into auth.refresh_tokens
      (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
    values
      (v_rt, v_user_id::text, v_session, false,
       '00000000-0000-0000-0000-000000000000', now(), now());

    insert into public.actors
      (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
    values
      (v_invite.team_id, 'agent', v_user_id,
       v_invite.invited_by_actor_id, v_invite.display_name, now())
    returning id into v_actor;

    insert into public.agents (id, agent_kind, status)
      values (v_actor, v_invite.agent_kind, 'active');

    insert into public.agent_member_access
      (agent_id, member_id, permission_level, granted_by_member_id)
    values
      (v_actor, v_invite.invited_by_actor_id, 'admin',
       v_invite.invited_by_actor_id);
  end if;

  update public.team_invites
     set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now()
   where id = v_invite.id;

  return query
  select v_actor, v_invite.team_id, v_invite.kind::text,
         v_invite.display_name, v_rt;
end;
$$;

revoke all on function public.claim_team_invite(text) from public;
-- anon allowed so a daemon without a session can claim via the anon key alone.
grant execute on function public.claim_team_invite(text) to anon, authenticated;

-- ===========================================================================
-- 14. RPC: update_actor_last_active (heartbeat)
-- ===========================================================================
create or replace function public.update_actor_last_active()
returns void language sql security definer set search_path = public, auth as $$
  update public.actors
     set last_active_at = now(), updated_at = now()
   where user_id = auth.uid();
$$;

revoke all on function public.update_actor_last_active() from public;
grant execute on function public.update_actor_last_active() to authenticated;

commit;
