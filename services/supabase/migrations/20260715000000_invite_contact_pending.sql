-- Pending-invite contact matching.
--
-- Before this migration an invite captured no way to reach the invitee: only
-- `display_name` plus a `token` the inviter had to deliver out-of-band. The
-- server therefore could not answer "is there an invite waiting for *this*
-- person?" at login, and the only join path was the pre-auth
-- `pendingInviteToken` stash on the client.
--
-- This adds optional `invite_email` / `invite_phone` to amux.team_invites and a
-- `status` lifecycle, so a freshly-authenticated user can be shown the invites
-- addressed to their VERIFIED contact and accept or decline them in-app. The
-- token path is untouched and remains the fallback for invitees whose contact
-- the inviter does not know.
--
-- The table keeps a soft lifecycle (pending/accepted/declined/expired) rather
-- than deleting rows, so "who declined" survives for audit.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table amux.team_invites
  add column if not exists invite_email text,
  add column if not exists invite_phone text,
  add column if not exists status       text not null default 'pending',
  add column if not exists declined_at  timestamptz;

-- Existing rows predate `status`; derive it from the consumption marker that
-- was previously the only signal.
update amux.team_invites
   set status = 'accepted'
 where consumed_at is not null
   and status = 'pending';

alter table amux.team_invites
  drop constraint if exists team_invites_status_check;
alter table amux.team_invites
  add constraint team_invites_status_check
  check (status = any (array['pending', 'accepted', 'declined', 'expired']));

-- Contact is only meaningful for member invites. Agent invites are claimed by a
-- daemon that self-provisions its own auth user, so there is nobody to match.
alter table amux.team_invites
  drop constraint if exists team_invites_contact_member_only_check;
alter table amux.team_invites
  add constraint team_invites_contact_member_only_check
  check (kind = 'member' or (invite_email is null and invite_phone is null));

comment on column amux.team_invites.invite_email is
  'Optional invitee email captured at invite time. Matched against the verified auth.users.email of a logging-in user by amux.list_pending_invites_for_me().';
comment on column amux.team_invites.invite_phone is
  'Optional invitee phone captured at invite time. Compared digit-normalized against auth.users.phone.';
comment on column amux.team_invites.status is
  'pending | accepted | declined | expired. Soft lifecycle — rows are retained after acceptance/decline for audit.';

-- ---------------------------------------------------------------------------
-- 2. Phone normalization
-- ---------------------------------------------------------------------------

-- Phones reach us in inconsistent shapes: `bind_phone_to_account` writes what
-- the client sent, and an inviter may type spaces, dashes or a leading '+'.
-- Comparing raw text would miss obvious matches, so both sides are reduced to
-- digits. IMMUTABLE so it can back an index.
create or replace function amux.normalize_invite_phone(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '')
$$;

comment on function amux.normalize_invite_phone(text) is
  'Reduces a phone to its digits (dropping +, spaces, dashes) so invite_phone and auth.users.phone compare equal regardless of formatting. Returns NULL for empty input.';

revoke all on function amux.normalize_invite_phone(text) from public;
grant execute on function amux.normalize_invite_phone(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------

-- One live invite per (team, contact): re-inviting the same person should
-- update or replace, not stack up rows the invitee then has to decline twice.
create unique index if not exists team_invites_pending_email_uniq
  on amux.team_invites (team_id, lower(btrim(invite_email)))
  where status = 'pending' and invite_email is not null;

create unique index if not exists team_invites_pending_phone_uniq
  on amux.team_invites (team_id, amux.normalize_invite_phone(invite_phone))
  where status = 'pending' and invite_phone is not null;

-- The unique indexes above lead with team_id, so they cannot serve the
-- login-time lookup, which knows only the contact. These can.
create index if not exists team_invites_pending_email_lookup
  on amux.team_invites (lower(btrim(invite_email)))
  where status = 'pending' and invite_email is not null;

create index if not exists team_invites_pending_phone_lookup
  on amux.team_invites (amux.normalize_invite_phone(invite_phone))
  where status = 'pending' and invite_phone is not null;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------

-- The baseline policy (20260601000000_baseline.sql:7248) was inert: its WITH
-- CHECK compared `a.id = a.invited_by_actor_id` and `a.team_id = a.team_id` —
-- both self-comparisons on the same alias, the latter a tautology — so it never
-- constrained the row being inserted. Rewritten to reference the target row via
-- the table name. Inserts in practice go through the SECURITY DEFINER
-- create_team_invite RPC, which bypasses RLS, so this only tightens the
-- unused direct-insert path.
drop policy if exists team_invites_insert_via_rpc on amux.team_invites;
create policy team_invites_insert_via_rpc on amux.team_invites
  for insert to authenticated
  with check (
    amux.is_team_member(team_invites.team_id)
    and exists (
      select 1 from amux.actors a
       where a.id = team_invites.invited_by_actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_invites.team_id
    )
  );

-- ---------------------------------------------------------------------------
-- 5. create_team_invite — accept optional contact
-- ---------------------------------------------------------------------------

-- The old 7-arg signature is DROPPED, not replaced: appending defaulted params
-- creates an overload, and a 7-positional-arg call would then be ambiguous
-- between the two. The new 9-arg form uses CREATE OR REPLACE so re-running this
-- migration is a no-op rather than a "function already exists" error.
drop function if exists amux.create_team_invite(uuid, text, text, text, text, integer, uuid);

create or replace function amux.create_team_invite(
  p_team_id         uuid,
  p_kind            text,
  p_display_name    text,
  p_team_role       text    default null,
  p_agent_kind      text    default null,
  p_ttl_seconds     integer default 604800,
  p_target_actor_id uuid    default null,
  p_invite_email    text    default null,
  p_invite_phone    text    default null
) RETURNS TABLE(token text, expires_at timestamp with time zone, deeplink text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'app'
    AS $$
declare
  v_caller uuid := amux.current_actor_id_for_team(p_team_id);
  v_token  text := translate(
                     encode(extensions.gen_random_bytes(24), 'base64'),
                     '+/=', '-_0'
                   );
  v_expires timestamptz := now() + make_interval(secs => greatest(60, p_ttl_seconds));
  v_kind    text;
  v_role    text;
  v_target  amux.actors%rowtype;
  v_target_anon boolean;
  v_email   text;
  v_phone   text;
begin
  if v_caller is null then
    raise exception 'create_team_invite requires team membership'
      using errcode = '42501';
  end if;

  v_kind := lower(coalesce(p_kind, ''));
  if v_kind not in ('member','agent') then
    raise exception 'p_kind must be member or agent' using errcode = '22023';
  end if;

  v_email := nullif(lower(btrim(coalesce(p_invite_email, ''))), '');
  v_phone := nullif(btrim(coalesce(p_invite_phone, '')), '');

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invite_email is not a valid email address' using errcode = '22023';
  end if;
  if v_phone is not null and amux.normalize_invite_phone(v_phone) is null then
    raise exception 'invite_phone contains no digits' using errcode = '22023';
  end if;

  if v_kind = 'member' then
    if p_team_role is null or btrim(p_team_role) = '' then
      raise exception 'member invites require p_team_role' using errcode = '22023';
    end if;
    v_role := lower(p_team_role);
    if v_role not in ('owner','admin','member') then
      raise exception 'team_role must be owner/admin/member' using errcode = '22023';
    end if;

    if p_target_actor_id is not null then
      select * into v_target from amux.actors where id = p_target_actor_id;
      if not found then
        raise exception 'target actor not found' using errcode = '23503';
      end if;
      if v_target.team_id <> p_team_id then
        raise exception 'target actor belongs to a different team'
          using errcode = '23514';
      end if;
      if v_target.actor_type <> 'member' then
        raise exception 'target actor must be a member' using errcode = '22023';
      end if;
      if v_target.user_id is null then
        raise exception 'target member has no auth user'
          using errcode = '23503';
      end if;
      select coalesce(is_anonymous, false) into v_target_anon
        from auth.users where id = v_target.user_id;
      if not v_target_anon then
        raise exception 'cannot re-invite member with bound auth identity'
          using errcode = '22023';
      end if;
    end if;

    -- Supersede an existing live invite to the same contact instead of letting
    -- the partial unique index reject the call: an inviter re-sending an invite
    -- means "this one is now current", and the old token stops working.
    if v_email is not null then
      update amux.team_invites
         set status = 'expired', updated_at = now()
       where team_id = p_team_id
         and status = 'pending'
         and lower(btrim(invite_email)) = v_email;
    end if;
    if v_phone is not null then
      update amux.team_invites
         set status = 'expired', updated_at = now()
       where team_id = p_team_id
         and status = 'pending'
         and amux.normalize_invite_phone(invite_phone) = amux.normalize_invite_phone(v_phone);
    end if;
  else
    if v_email is not null or v_phone is not null then
      raise exception 'agent invites cannot carry invite_email/invite_phone'
        using errcode = '22023';
    end if;
    if p_agent_kind is null or btrim(p_agent_kind) = '' then
      raise exception 'agent invites require p_agent_kind' using errcode = '22023';
    end if;
    if p_target_actor_id is not null then
      select * into v_target from amux.actors where id = p_target_actor_id;
      if not found then
        raise exception 'target actor not found' using errcode = '23503';
      end if;
      if v_target.team_id <> p_team_id then
        raise exception 'target actor belongs to a different team'
          using errcode = '23514';
      end if;
      if v_target.actor_type <> 'agent' then
        raise exception 'target actor must be an agent' using errcode = '22023';
      end if;
      if not exists (
        select 1 from amux.agents
        where id = p_target_actor_id
          and owner_member_id = v_caller
      ) then
        raise exception 'only the agent owner can re-invite this agent'
          using errcode = '42501';
      end if;
    end if;
  end if;

  insert into amux.team_invites (
    team_id, kind, display_name, team_role, agent_kind,
    invited_by_actor_id, token, expires_at, target_actor_id,
    invite_email, invite_phone, status
  )
  values (
    p_team_id, v_kind, btrim(p_display_name), v_role, p_agent_kind,
    v_caller, v_token, v_expires, p_target_actor_id,
    v_email, v_phone, 'pending'
  );

  return query
  select v_token,
         v_expires,
         format('amux://invite?token=%s', v_token);
end;
$$;

comment on function amux.create_team_invite(uuid, text, text, text, text, integer, uuid, text, text) is
  'Creates a team invite. p_invite_email / p_invite_phone are optional and member-only; when supplied the invitee can discover and accept the invite at login via amux.list_pending_invites_for_me() instead of needing the token out-of-band. Re-inviting the same contact expires the previous pending invite.';

revoke all on function amux.create_team_invite(uuid, text, text, text, text, integer, uuid, text, text) from public;
grant all on function amux.create_team_invite(uuid, text, text, text, text, integer, uuid, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. list_pending_invites_for_me
-- ---------------------------------------------------------------------------

-- Matching only ever reads the CALLER's own verified contact from auth.users —
-- it never takes a contact as an argument — so this cannot be used to probe
-- which addresses have invites waiting.
--
-- Email requires email_confirmed_at. Phone deliberately does NOT require
-- phone_confirmed_at: `amux.bind_phone_to_account` (20260618020000) verifies
-- via our own auth_verify_code table and then sets auth.users.phone directly
-- without touching GoTrue's phone_confirmed_at, so requiring it would match
-- nothing. Presence of auth.users.phone is the verification signal on this
-- deployment.
create or replace function amux.list_pending_invites_for_me()
returns table (
  invite_id               uuid,
  team_id                 uuid,
  team_name               text,
  team_role               text,
  display_name            text,
  invited_by_display_name text,
  invite_email            text,
  invite_phone            text,
  expires_at              timestamptz,
  matched_via             text
)
language sql
stable
security definer
set search_path to 'amux', 'public', 'auth'
as $$
  with me as (
    select u.id as user_id,
           case when u.email_confirmed_at is not null
                then nullif(lower(btrim(u.email)), '') end as email,
           amux.normalize_invite_phone(u.phone)            as phone
      from auth.users u
     where u.id = auth.uid()
       and coalesce(u.is_anonymous, false) = false
  )
  select ti.id,
         ti.team_id,
         t.name,
         ti.team_role,
         ti.display_name,
         inviter.display_name,
         ti.invite_email,
         ti.invite_phone,
         ti.expires_at,
         case
           when me.email is not null
            and lower(btrim(ti.invite_email)) = me.email then 'email'
           else 'phone'
         end
    from amux.team_invites ti
    cross join me
    join amux.teams t on t.id = ti.team_id
    left join amux.actors inviter on inviter.id = ti.invited_by_actor_id
   where ti.kind = 'member'
     and ti.status = 'pending'
     and ti.consumed_at is null
     and ti.expires_at > now()
     and (
       (me.email is not null and ti.invite_email is not null
        and lower(btrim(ti.invite_email)) = me.email)
       or
       (me.phone is not null and ti.invite_phone is not null
        and amux.normalize_invite_phone(ti.invite_phone) = me.phone)
     )
     -- Already in the team (joined via token, or invited twice) — nothing to accept.
     and not exists (
       select 1 from amux.actors a
        where a.team_id = ti.team_id
          and a.user_id = me.user_id
     )
   order by ti.created_at desc
$$;

comment on function amux.list_pending_invites_for_me() is
  'Invites addressed to the calling user''s verified email/phone that are still pending, unexpired, and for a team they have not already joined. Takes no contact argument by design — it reads auth.uid()''s own contact, so it cannot be used to probe other addresses.';

revoke all on function amux.list_pending_invites_for_me() from public;
grant execute on function amux.list_pending_invites_for_me() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. accept / decline
-- ---------------------------------------------------------------------------

-- Accepting resolves the invite's token and delegates to claim_team_invite, so
-- the contact path and the token path converge on one implementation. The
-- membership guard is `list_pending_invites_for_me()` itself: an invite the
-- caller cannot see is one they cannot accept.
create or replace function amux.accept_pending_invite(p_invite_id uuid)
returns table (actor_id uuid, team_id uuid, actor_type text, display_name text, refresh_token text)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $$
declare
  v_token text;
begin
  select ti.token into v_token
    from amux.team_invites ti
   where ti.id = p_invite_id
     and ti.id in (select p.invite_id from amux.list_pending_invites_for_me() p);

  if v_token is null then
    raise exception 'no pending invite % for this account', p_invite_id using errcode = '23503';
  end if;

  return query select * from amux.claim_team_invite(v_token);
end;
$$;

comment on function amux.accept_pending_invite(uuid) is
  'Accepts an invite matched to the caller''s verified contact by resolving its token and delegating to claim_team_invite. Visibility via list_pending_invites_for_me() IS the authorization check.';

revoke all on function amux.accept_pending_invite(uuid) from public;
grant execute on function amux.accept_pending_invite(uuid) to authenticated, service_role;

create or replace function amux.decline_pending_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth'
as $$
begin
  update amux.team_invites
     set status = 'declined', declined_at = now(), updated_at = now()
   where id = p_invite_id
     and id in (select p.invite_id from amux.list_pending_invites_for_me() p);

  if not found then
    raise exception 'no pending invite % for this account', p_invite_id using errcode = '23503';
  end if;
end;
$$;

comment on function amux.decline_pending_invite(uuid) is
  'Marks an invite addressed to the caller as declined. The row is kept so the inviter can see the outcome.';

revoke all on function amux.decline_pending_invite(uuid) from public;
grant execute on function amux.decline_pending_invite(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. claim_team_invite — keep `status` in step with `consumed_at`
-- ---------------------------------------------------------------------------

-- Redefines 20260708000000_claim_invite_public_users_for_daemon.sql:19. The
-- only change is the final UPDATE, which now also sets status='accepted' so the
-- token path and the contact path leave the same lifecycle state. Every other
-- line is carried over verbatim.
CREATE OR REPLACE FUNCTION amux.claim_team_invite(p_token text) RETURNS TABLE(actor_id uuid, team_id uuid, actor_type text, display_name text, refresh_token text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth', 'extensions'
    AS $$
declare
  v_invite      amux.team_invites%rowtype;
  v_user_id     uuid;
  v_actor       uuid;
  v_email       text;
  v_session     uuid;
  v_rt          text := null;
  v_old_user    uuid;
  v_target_anon boolean;
  v_team_org    uuid;   -- invite team's org (S3-FC.3)
  v_old_org     uuid;   -- claimer's previous org (member path)
begin
  select * into v_invite from amux.team_invites where token = p_token for update;
  if not found then raise exception 'invite not found' using errcode = '23503'; end if;
  if v_invite.consumed_at is not null then raise exception 'invite already consumed' using errcode = '23514'; end if;
  if v_invite.status = 'declined' then raise exception 'invite was declined' using errcode = '23514'; end if;
  if v_invite.status = 'expired' then raise exception 'invite superseded' using errcode = '23514'; end if;
  if v_invite.expires_at < now() then raise exception 'invite expired' using errcode = '23514'; end if;

  -- Resolved once for both branches: members get public.users.org_id switched,
  -- agents get the claim baked into raw_app_meta_data.
  select oid into v_team_org from amux.teams where id = v_invite.team_id;

  if v_invite.kind = 'member' then
    if v_invite.target_actor_id is not null then
      select user_id into v_user_id from amux.actors where id = v_invite.target_actor_id;
      if v_user_id is null then raise exception 'target member has no auth user' using errcode = '23503'; end if;
      select coalesce(is_anonymous, false) into v_target_anon from auth.users where id = v_user_id;
      if not v_target_anon then raise exception 'target member is no longer anonymous' using errcode = '23514'; end if;

      v_session := gen_random_uuid();
      v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);
      insert into auth.sessions (id, user_id, aal, created_at, updated_at) values (v_session, v_user_id, 'aal1', now(), now());
      insert into auth.refresh_tokens (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
        values (v_rt, v_user_id::text, v_session, false, '00000000-0000-0000-0000-000000000000', now(), now());

      v_actor := v_invite.target_actor_id;
      update amux.actors set last_active_at = now(), updated_at = now() where id = v_actor;
    else
      v_user_id := auth.uid();
      if v_user_id is null then raise exception 'member claim requires authentication' using errcode = '42501'; end if;
      if exists (select 1 from amux.actors act where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
        raise exception 'already a member of this team' using errcode = '23505';
      end if;

      insert into amux.actors (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values (v_invite.team_id, 'member', v_user_id, v_invite.invited_by_actor_id, v_invite.display_name, now())
      returning id into v_actor;
      insert into amux.members (id, status) values (v_actor, 'active');
      insert into amux.team_members (team_id, member_id, role) values (v_invite.team_id, v_actor, v_invite.team_role);
    end if;

    -- S3-FC.3: strict single-org — claimer's org becomes the invite team's org.
    if v_team_org is not null and v_user_id is not null then
      select org_id into v_old_org from public.users where id = v_user_id;
      if v_old_org is null then
        insert into public.users (id, org_id, mobile) values (v_user_id, v_team_org, '');
      else
        update public.users set org_id = v_team_org, updated_at = now() where id = v_user_id;
      end if;
      -- best-effort GC of an abandoned one-person (personal) old org; never fail the claim
      begin
        if v_old_org is not null and v_old_org <> v_team_org
           and not exists (select 1 from public.users where org_id = v_old_org) then
          delete from amux.teams where oid = v_old_org;   -- cascades actors/members/sessions/...
          delete from public.orgs where id = v_old_org;
        end if;
      exception when others then
        null;  -- leave the orphan; reassignment already succeeded
      end;
    end if;
  else
    v_user_id := gen_random_uuid();
    v_email   := format('daemon.%s@amuxd.run', v_user_id);
    v_session := gen_random_uuid();
    v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);
    -- Stamp the team's org into app_metadata so daemon access tokens pass
    -- teams_org_guard (current_org_id() reads the JWT claim first; daemon
    -- users have no public.users fallback row).
    insert into auth.users (id, email, email_confirmed_at, encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change, raw_app_meta_data, aud, role, created_at, updated_at, instance_id)
    values (v_user_id, v_email, now(), '', '', '', '', '',
      case when v_team_org is not null then jsonb_build_object('org_id', v_team_org) else '{}'::jsonb end,
      'authenticated', 'authenticated', now(), now(), '00000000-0000-0000-0000-000000000000');
    insert into auth.sessions (id, user_id, aal, created_at, updated_at) values (v_session, v_user_id, 'aal1', now(), now());
    insert into auth.refresh_tokens (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
      values (v_rt, v_user_id::text, v_session, false, '00000000-0000-0000-0000-000000000000', now(), now());

    -- Also give the daemon account a public.users fallback row with the team's
    -- org, so org resolvers that query public.users by id directly (without the
    -- JWT app_metadata.org_id claim) can resolve org_id instead of erroring.
    if v_team_org is not null then
      insert into public.users (id, org_id, mobile) values (v_user_id, v_team_org, '')
      on conflict (id) do update set org_id = excluded.org_id, updated_at = now();
    end if;

    if v_invite.target_actor_id is not null then
      select user_id into v_old_user from amux.actors where id = v_invite.target_actor_id;
      update amux.actors set user_id = v_user_id, invited_by_actor_id = v_invite.invited_by_actor_id,
             last_active_at = null, updated_at = now() where id = v_invite.target_actor_id;
      v_actor := v_invite.target_actor_id;
      update amux.agents set owner_member_id = v_invite.invited_by_actor_id, visibility = 'team', updated_at = now() where id = v_actor;
      if v_old_user is not null then delete from auth.users where id = v_old_user; end if;
    else
      insert into amux.actors (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values (v_invite.team_id, 'agent', v_user_id, v_invite.invited_by_actor_id, v_invite.display_name, null)
      returning id into v_actor;
      insert into amux.agents (id, owner_member_id, visibility, status) values (v_actor, v_invite.invited_by_actor_id, 'team', 'active');
    end if;

    insert into amux.agent_member_access (agent_id, member_id, permission_level, granted_by_member_id)
    values (v_actor, v_invite.invited_by_actor_id, 'admin', v_invite.invited_by_actor_id)
    on conflict (agent_id, member_id) do update
      set permission_level = 'admin', granted_by_member_id = excluded.granted_by_member_id, updated_at = now();
  end if;

  update amux.team_invites set consumed_at = now(), consumed_by_actor_id = v_actor,
         status = 'accepted', updated_at = now() where id = v_invite.id;

  return query select v_actor, v_invite.team_id, v_invite.kind::text, v_invite.display_name, v_rt;
end;
$$;
