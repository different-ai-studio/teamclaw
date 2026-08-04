-- Resolve the caller's actor PER TEAM, everywhere.
--
-- amux.current_actor_id() was defined as
--
--     select id from amux.actors where user_id = auth.uid() order by created_at limit 1
--
-- i.e. whichever actor row happened to be created first. But actors are
-- per-team (actors.team_id is NOT NULL, with a unique index on
-- (team_id, user_id)), so a user who belongs to N teams has N actor rows and
-- this function silently picked the one from whichever team they joined first.
--
-- Everything keyed on it was therefore wrong for every team but that one:
--
--   * the session list came back empty (amux.is_session_participant matched
--     against the wrong actor id, so no session in the other team was visible);
--   * has_unread was stuck on true, because the session_read_markers SELECT
--     policy hid the caller's own markers for the same reason;
--   * sending a message was rejected outright -- messages_insert_if_session_participant
--     requires sender_actor_id = <caller's actor>, and clients correctly send
--     their per-team actor;
--   * creating an idea failed on the ideas same-team trigger, since
--     amux.create_idea stamped created_by_actor_id with the wrong team's actor;
--   * amux.remove_team_actor's "cannot remove your own actor" guard compared
--     against the wrong id, so an admin could delete their own actor in any
--     team that was not their first.
--
-- The fix is not to widen visibility -- it is to resolve the right actor. Two
-- invariants already in the schema make the per-team resolution exact:
--
--   1. unique (team_id, user_id) on amux.actors -- one actor per user per team;
--   2. the enforce_*_same_team triggers -- a session's participants, and a
--      message's sender, must belong to that session's team.
--
-- Together they mean at most one of a user's actors can ever participate in a
-- given session, so amux.current_actor_id_for_team(<row's team>) selects
-- exactly the rows the caller is already entitled to. No policy gets looser.
--
-- amux.current_actor_id() is dropped at the end of this file. That DROP is also
-- the check: RLS policies record a dependency on the functions they call, so if
-- any policy still referenced it the DROP would fail instead of leaving a stale
-- caller behind. (plpgsql bodies are not dependency-tracked, so those were
-- audited by hand -- see the function rewrites below.)
--
-- Idempotent: safe for the self-host apply-migrations loop to re-run.

-- ---------------------------------------------------------------------------
-- 1. session_read_markers.team_id
-- ---------------------------------------------------------------------------
-- The read-marker policies are the one place with no team in scope: the row
-- carries session_id and actor_id but no team. Denormalise it so the policies
-- can say current_actor_id_for_team(team_id) instead of falling back to "any of
-- my actors".
--
-- This column is a policy input, so it has to be trustworthy: the trigger added
-- in step 2 pins it to both the session's team and the actor's team. Without
-- that a client could insert (my team-A actor, someone else's session) and read
-- markers it has no business seeing.

ALTER TABLE amux.session_read_markers
  ADD COLUMN IF NOT EXISTS team_id uuid;

UPDATE amux.session_read_markers srm
   SET team_id = s.team_id
  FROM amux.sessions s
 WHERE s.id = srm.session_id
   AND srm.team_id IS NULL;

-- session_id has a FK to sessions, so this cannot legitimately be non-zero.
-- Fail loudly rather than let SET NOT NULL report it as a constraint violation.
DO $$
DECLARE
  v_orphans bigint;
BEGIN
  SELECT count(*) INTO v_orphans
  FROM amux.session_read_markers WHERE team_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'session_read_markers: % rows have no resolvable team_id', v_orphans;
  END IF;
END
$$;

ALTER TABLE amux.session_read_markers
  ALTER COLUMN team_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_read_markers_team_id_fkey'
  ) THEN
    ALTER TABLE amux.session_read_markers
      ADD CONSTRAINT session_read_markers_team_id_fkey
      FOREIGN KEY (team_id) REFERENCES amux.teams(id) ON DELETE CASCADE;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Same-team integrity for the new column
-- ---------------------------------------------------------------------------
-- Copied from 20260804010000 with a session_read_markers branch appended.
-- require_same_team returns early when either side is NULL, which is why
-- team_id had to be NOT NULL above -- otherwise this check would be a no-op.

create or replace function amux.enforce_core_team_integrity()
returns trigger
language plpgsql
as $function$
begin
  if tg_table_name = 'team_members' then
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.member_id),
      'team_members.member_id'
    );
  elsif tg_table_name = 'workspaces' then
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.created_by_member_id),
      'workspaces.created_by_member_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.agent_id),
      'workspaces.agent_id'
    );
  elsif tg_table_name = 'agents' then
    perform amux.require_same_team(
      amux.actor_team_id(new.id),
      amux.table_team_id('amux.workspaces'::regclass, new.default_workspace_id),
      'agents.default_workspace_id'
    );
  elsif tg_table_name = 'agent_member_access' then
    perform amux.require_same_team(
      amux.actor_team_id(new.agent_id),
      amux.actor_team_id(new.member_id),
      'agent_member_access.member_id'
    );
    perform amux.require_same_team(
      amux.actor_team_id(new.agent_id),
      amux.actor_team_id(new.granted_by_member_id),
      'agent_member_access.granted_by_member_id'
    );
  elsif tg_table_name = 'ideas' then
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.workspaces'::regclass, new.workspace_id),
      'ideas.workspace_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.ideas'::regclass, new.parent_idea_id),
      'ideas.parent_idea_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.created_by_actor_id),
      'ideas.created_by_actor_id'
    );
  elsif tg_table_name = 'idea_external_refs' then
    perform amux.require_same_team(
      amux.table_team_id('amux.ideas'::regclass, new.idea_id),
      amux.actor_team_id(new.linked_by_actor_id),
      'idea_external_refs.linked_by_actor_id'
    );
  elsif tg_table_name = 'sessions' then
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.ideas'::regclass, new.idea_id),
      'sessions.idea_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.created_by_actor_id),
      'sessions.created_by_actor_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.primary_agent_id),
      'sessions.primary_agent_id'
    );
  elsif tg_table_name = 'session_participants' then
    perform amux.require_same_team(
      amux.table_team_id('amux.sessions'::regclass, new.session_id),
      amux.actor_team_id(new.actor_id),
      'session_participants.actor_id'
    );
  elsif tg_table_name = 'messages' then
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.sessions'::regclass, new.session_id),
      'messages.session_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.sender_actor_id),
      'messages.sender_actor_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.messages'::regclass, new.reply_to_message_id),
      'messages.reply_to_message_id'
    );
  elsif tg_table_name = 'session_read_markers' then
    perform amux.require_same_team(
      new.team_id,
      amux.table_team_id('amux.sessions'::regclass, new.session_id),
      'session_read_markers.session_id'
    );
    perform amux.require_same_team(
      new.team_id,
      amux.actor_team_id(new.actor_id),
      'session_read_markers.actor_id'
    );
  else
    raise exception 'amux.enforce_core_team_integrity is not defined for table %', tg_table_name;
  end if;

  return new;
end;
$function$;

DROP TRIGGER IF EXISTS enforce_session_read_markers_same_team ON amux.session_read_markers;
CREATE TRIGGER enforce_session_read_markers_same_team
  BEFORE INSERT OR UPDATE ON amux.session_read_markers
  FOR EACH ROW EXECUTE FUNCTION amux.enforce_core_team_integrity();

-- ---------------------------------------------------------------------------
-- 3. Participation, resolved against the session's own team
-- ---------------------------------------------------------------------------
-- The function already joins amux.sessions, so the team is right there. The
-- dropped `current_actor_id() is not null` short-circuit is redundant:
-- current_actor_id_for_team returns NULL for a non-member, and NULL never
-- matches sp.actor_id.

CREATE OR REPLACE FUNCTION amux.is_session_participant(target_session_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select exists (
      select 1
      from amux.sessions s
      where s.id = target_session_id
        and amux.is_team_member(s.team_id)
        and exists (
          select 1
          from amux.session_participants sp
          where sp.session_id = s.id
            and sp.actor_id = amux.current_actor_id_for_team(s.team_id)
        )
    )
$$;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------
-- Every row below carries its own team_id, so each policy resolves the caller
-- in that row's team.

DROP POLICY IF EXISTS sessions_select_if_participant_or_creator ON amux.sessions;
CREATE POLICY sessions_select_if_participant_or_creator ON amux.sessions
  FOR SELECT TO authenticated
  USING (
    amux.is_team_member(team_id)
    AND (
      created_by_actor_id = amux.current_actor_id_for_team(team_id)
      OR primary_agent_id = amux.current_actor_id_for_team(team_id)
      OR amux.is_session_participant(id)
    )
  );

DROP POLICY IF EXISTS messages_insert_if_session_participant ON amux.messages;
CREATE POLICY messages_insert_if_session_participant ON amux.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    amux.is_session_participant(session_id)
    AND sender_actor_id = amux.current_actor_id_for_team(team_id)
  );

-- Read markers. The participant check is dropped from SELECT and UPDATE on
-- purpose: `actor_id = <my actor in this row's team>` already proves the row is
-- mine, so is_session_participant adds no confidentiality there -- it only hid
-- your own marker after you were removed from a session, at the cost of running
-- the heaviest predicate in the schema on every row of the session list's
-- read-marker join. It stays on INSERT, where it does real work: you should not
-- be able to create a marker for a session you never joined.

DROP POLICY IF EXISTS session_read_markers_select_own ON amux.session_read_markers;
CREATE POLICY session_read_markers_select_own ON amux.session_read_markers
  FOR SELECT TO authenticated
  USING (actor_id = amux.current_actor_id_for_team(team_id));

DROP POLICY IF EXISTS session_read_markers_insert_own ON amux.session_read_markers;
CREATE POLICY session_read_markers_insert_own ON amux.session_read_markers
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_id = amux.current_actor_id_for_team(team_id)
    AND amux.is_session_participant(session_id)
  );

DROP POLICY IF EXISTS session_read_markers_update_own ON amux.session_read_markers;
CREATE POLICY session_read_markers_update_own ON amux.session_read_markers
  FOR UPDATE TO authenticated
  USING (actor_id = amux.current_actor_id_for_team(team_id))
  WITH CHECK (actor_id = amux.current_actor_id_for_team(team_id));

DROP POLICY IF EXISTS ideas_insert_if_team_member ON amux.ideas;
CREATE POLICY ideas_insert_if_team_member ON amux.ideas
  FOR INSERT TO authenticated
  WITH CHECK (
    amux.is_team_member(team_id)
    AND created_by_actor_id = amux.current_actor_id_for_team(team_id)
  );

DROP POLICY IF EXISTS idea_activities_insert_if_team_member ON amux.idea_activities;
CREATE POLICY idea_activities_insert_if_team_member ON amux.idea_activities
  FOR INSERT TO authenticated
  WITH CHECK (
    amux.is_team_member(team_id)
    AND actor_id = amux.current_actor_id_for_team(team_id)
    AND EXISTS (
      SELECT 1 FROM amux.ideas i
      WHERE i.id = idea_activities.idea_id
        AND i.team_id = idea_activities.team_id
    )
  );

DROP POLICY IF EXISTS idea_external_refs_insert_if_team_member ON amux.idea_external_refs;
CREATE POLICY idea_external_refs_insert_if_team_member ON amux.idea_external_refs
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM amux.ideas t
      WHERE t.id = idea_external_refs.idea_id
        AND amux.is_team_member(t.team_id)
        AND linked_by_actor_id = amux.current_actor_id_for_team(t.team_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 5. SECURITY DEFINER functions
-- ---------------------------------------------------------------------------
-- plpgsql bodies are opaque to the dependency tracker, so these are the ones
-- the DROP at the end cannot catch. Each either derives the team from its own
-- arguments or already had it.
--
-- Where current_actor_id() was only asking "is anyone signed in", that is now
-- auth.uid() -- which is what the check always meant.


CREATE OR REPLACE FUNCTION amux.archive_idea(p_idea_id uuid, p_archived boolean DEFAULT true) RETURNS TABLE(id uuid, team_id uuid, workspace_id uuid, created_by_actor_id uuid, title text, description text, status text, archived boolean, sort_order integer, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_idea_team_id uuid;
begin
  if auth.uid() is null then
    raise exception 'archive_idea requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_idea_id is null then
    raise exception 'idea id is required'
      using errcode = '22023';
  end if;

  select t.team_id
  into v_idea_team_id
  from amux.ideas t
  where t.id = p_idea_id;

  if v_idea_team_id is null then
    raise exception 'idea not found'
      using errcode = '23503';
  end if;

  if not amux.is_team_member(v_idea_team_id) then
    raise exception 'archive_idea requires team membership'
      using errcode = '42501';
  end if;

  return query
  update amux.ideas
  set archived = coalesce(p_archived, true)
  where ideas.id = p_idea_id
  returning
    ideas.id,
    ideas.team_id,
    ideas.workspace_id,
    ideas.created_by_actor_id,
    ideas.title,
    ideas.description,
    ideas.status,
    ideas.archived,
    ideas.sort_order,
    ideas.created_at,
    ideas.updated_at;
end;
$$;

CREATE OR REPLACE FUNCTION amux.create_idea(p_team_id uuid, p_title text, p_workspace_id uuid DEFAULT NULL::uuid, p_description text DEFAULT ''::text) RETURNS TABLE(id uuid, team_id uuid, workspace_id uuid, created_by_actor_id uuid, title text, description text, status text, archived boolean, sort_order integer, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_actor_id uuid;
  v_workspace_team_id uuid;
  v_sort_order integer;
begin
  if auth.uid() is null then
    raise exception 'create_idea requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_team_id is null or not amux.is_team_member(p_team_id) then
    raise exception 'create_idea requires team membership'
      using errcode = '42501';
  end if;

  -- created_by_actor_id must be the caller's actor IN THIS TEAM: the ideas
  -- same-team trigger rejects any other, which is why creating an idea outside
  -- one's first team used to fail outright.
  v_actor_id := amux.current_actor_id_for_team(p_team_id);

  if p_title is null or btrim(p_title) = '' then
    raise exception 'title is required'
      using errcode = '22023';
  end if;

  if p_workspace_id is not null then
    select w.team_id
    into v_workspace_team_id
    from amux.workspaces w
    where w.id = p_workspace_id
      and w.archived = false;

    if v_workspace_team_id is null then
      raise exception 'workspace not found'
        using errcode = '23503';
    end if;

    if v_workspace_team_id <> p_team_id then
      raise exception 'workspace does not belong to the requested team'
        using errcode = '23514';
    end if;
  end if;

  perform 1
  from amux.teams
  where teams.id = p_team_id
  for update;

  select coalesce(min(i.sort_order), 1000) - 1000
  into v_sort_order
  from amux.ideas i
  where i.team_id = p_team_id
    and i.archived = false;

  return query
  insert into amux.ideas (
    team_id,
    workspace_id,
    created_by_actor_id,
    title,
    description,
    status,
    archived,
    sort_order
  )
  values (
    p_team_id,
    p_workspace_id,
    v_actor_id,
    btrim(p_title),
    coalesce(p_description, ''),
    'open',
    false,
    v_sort_order
  )
  returning
    ideas.id,
    ideas.team_id,
    ideas.workspace_id,
    ideas.created_by_actor_id,
    ideas.title,
    ideas.description,
    ideas.status,
    ideas.archived,
    ideas.sort_order,
    ideas.created_at,
    ideas.updated_at;
end;
$$;

CREATE OR REPLACE FUNCTION amux.update_idea(p_idea_id uuid, p_title text, p_workspace_id uuid DEFAULT NULL::uuid, p_description text DEFAULT ''::text, p_status text DEFAULT 'open'::text) RETURNS TABLE(id uuid, team_id uuid, workspace_id uuid, created_by_actor_id uuid, title text, description text, status text, archived boolean, sort_order integer, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_idea_team_id uuid;
  v_workspace_team_id uuid;
begin
  if auth.uid() is null then
    raise exception 'update_idea requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_idea_id is null then
    raise exception 'idea id is required'
      using errcode = '22023';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'title is required'
      using errcode = '22023';
  end if;

  select t.team_id
  into v_idea_team_id
  from amux.ideas t
  where t.id = p_idea_id;

  if v_idea_team_id is null then
    raise exception 'idea not found'
      using errcode = '23503';
  end if;

  if not amux.is_team_member(v_idea_team_id) then
    raise exception 'update_idea requires team membership'
      using errcode = '42501';
  end if;

  if p_workspace_id is not null then
    select w.team_id
    into v_workspace_team_id
    from amux.workspaces w
    where w.id = p_workspace_id
      and w.archived = false;

    if v_workspace_team_id is null then
      raise exception 'workspace not found'
        using errcode = '23503';
    end if;

    if v_workspace_team_id <> v_idea_team_id then
      raise exception 'workspace does not belong to the idea team'
        using errcode = '23514';
    end if;
  end if;

  return query
  update amux.ideas
  set
    workspace_id = p_workspace_id,
    title = btrim(p_title),
    description = coalesce(p_description, ''),
    status = p_status
  where ideas.id = p_idea_id
  returning
    ideas.id,
    ideas.team_id,
    ideas.workspace_id,
    ideas.created_by_actor_id,
    ideas.title,
    ideas.description,
    ideas.status,
    ideas.archived,
    ideas.sort_order,
    ideas.created_at,
    ideas.updated_at;
end;
$$;

CREATE OR REPLACE FUNCTION amux.create_idea_activity(p_idea_id uuid, p_activity_type text, p_content text DEFAULT ''::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_attachment_urls text[] DEFAULT '{}'::text[]) RETURNS TABLE(id uuid, team_id uuid, idea_id uuid, actor_id uuid, activity_type text, content text, metadata jsonb, attachment_urls text[], created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_actor_id uuid;
  v_team_id uuid;
begin
  if auth.uid() is null then
    raise exception 'create_idea_activity requires an authenticated member'
      using errcode = '42501';
  end if;

  if p_idea_id is null then
    raise exception 'idea id is required'
      using errcode = '22023';
  end if;

  if p_activity_type not in ('progress', 'status_change', 'reorder') then
    raise exception 'invalid idea activity type'
      using errcode = '22023';
  end if;

  select i.team_id
  into v_team_id
  from amux.ideas i
  where i.id = p_idea_id;

  if v_team_id is null then
    raise exception 'idea not found'
      using errcode = '23503';
  end if;

  if not amux.is_team_member(v_team_id) then
    raise exception 'create_idea_activity requires team membership'
      using errcode = '42501';
  end if;

  v_actor_id := amux.current_actor_id_for_team(v_team_id);

  return query
  insert into amux.idea_activities (
    team_id,
    idea_id,
    actor_id,
    activity_type,
    content,
    metadata,
    attachment_urls
  )
  values (
    v_team_id,
    p_idea_id,
    v_actor_id,
    p_activity_type,
    coalesce(p_content, ''),
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_attachment_urls, '{}'::text[])
  )
  returning
    idea_activities.id,
    idea_activities.team_id,
    idea_activities.idea_id,
    idea_activities.actor_id,
    idea_activities.activity_type,
    idea_activities.content,
    idea_activities.metadata,
    idea_activities.attachment_urls,
    idea_activities.created_at,
    idea_activities.updated_at;
end;
$$;

CREATE OR REPLACE FUNCTION amux.list_agent_admin_member_actor_ids(p_agent_actor_id uuid) RETURNS TABLE(member_actor_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'app'
    AS $$
  select ama.member_id
    from amux.agent_member_access as ama
    join amux.agents as ag on ag.id = ama.agent_id
   where ama.agent_id = p_agent_actor_id
     and ama.permission_level = 'admin'
     and (
       p_agent_actor_id = amux.current_actor_for_agent(p_agent_actor_id)
       or ag.owner_member_id = amux.current_actor_for_agent(p_agent_actor_id)
     )
   order by ama.created_at;
$$;

CREATE OR REPLACE FUNCTION amux.mark_current_actor_session_viewed(p_session_id uuid, p_last_read_message_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'amux', 'public', 'app'
    AS $$
declare
  v_team_id uuid;
  v_actor_id uuid;
begin
  select s.team_id into v_team_id
  from amux.sessions s
  where s.id = p_session_id;

  if v_team_id is null then
    raise exception 'session not found' using errcode = '23503';
  end if;

  v_actor_id := amux.current_actor_id_for_team(v_team_id);

  if v_actor_id is null then
    raise exception 'no current actor' using errcode = '42501';
  end if;

  if not amux.is_session_participant(p_session_id) then
    raise exception 'not a session participant' using errcode = '42501';
  end if;

  insert into amux.session_read_markers (
    session_id,
    team_id,
    actor_id,
    last_read_at,
    last_read_message_id
  )
  values (
    p_session_id,
    v_team_id,
    v_actor_id,
    now(),
    p_last_read_message_id
  )
  on conflict (session_id, actor_id)
  do update set
    last_read_at = excluded.last_read_at,
    last_read_message_id = excluded.last_read_message_id;
end;
$$;

create or replace function amux.remove_team_actor(p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_team_id uuid;
  v_actor_type text;
  v_caller_actor uuid;
  v_owned_agent_id uuid;
  v_agent_visibility text;
  v_agent_owner_member_id uuid;
begin
  if auth.uid() is null then
    raise exception 'remove_team_actor requires authentication'
      using errcode = '42501';
  end if;

  select team_id, actor_type
    into v_team_id, v_actor_type
  from amux.actors
  where id = p_actor_id;

  if v_team_id is null then
    raise exception 'actor not found'
      using errcode = '23503';
  end if;

  -- The caller's identity in the TARGET's team. Resolving it globally (the old
  -- amux.current_actor_id()) picked whichever actor row happened to be oldest,
  -- so for a member of several teams the self-removal guard below compared
  -- against the wrong id -- and an admin could delete their own actor in any
  -- team that was not their first.
  v_caller_actor := amux.current_actor_id_for_team(v_team_id);

  if v_caller_actor is null then
    raise exception 'remove_team_actor requires team membership'
      using errcode = '42501';
  end if;

  if v_caller_actor = p_actor_id then
    raise exception 'cannot remove your own actor'
      using errcode = '42501';
  end if;

  if v_actor_type = 'agent' then
    select visibility, owner_member_id
      into v_agent_visibility, v_agent_owner_member_id
    from amux.agents
    where id = p_actor_id;

    if v_agent_visibility = 'personal' then
      if v_caller_actor is distinct from v_agent_owner_member_id then
        raise exception 'remove_team_actor requires agent owner for personal agents'
          using errcode = '42501';
      end if;
    elsif v_agent_visibility = 'team' then
      if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
        raise exception 'remove_team_actor requires owner or admin for team agents'
          using errcode = '42501';
      end if;
    else
      if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
        raise exception 'remove_team_actor requires owner or admin'
          using errcode = '42501';
      end if;
    end if;
  else
    if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
      raise exception 'remove_team_actor requires owner or admin'
        using errcode = '42501';
    end if;
  end if;

  if v_actor_type = 'member' and exists (
    select 1 from amux.team_members
     where team_id = v_team_id and member_id = p_actor_id and role = 'owner'
  ) then
    if (select count(*) from amux.team_members
          where team_id = v_team_id and role = 'owner') <= 1 then
      raise exception 'cannot remove the last owner'
        using errcode = '23514';
    end if;
  end if;

  begin
    -- Member removal: cascade-delete agents they own before dropping the member row.
    if v_actor_type = 'member' then
      for v_owned_agent_id in
        select id from amux.agents where owner_member_id = p_actor_id
      loop
        delete from amux.agent_member_access
         where agent_id = v_owned_agent_id or member_id = v_owned_agent_id;

        delete from amux.team_members
         where member_id = v_owned_agent_id;

        delete from amux.actors where id = v_owned_agent_id;
      end loop;
    end if;

    delete from amux.agent_member_access
     where agent_id = p_actor_id or member_id = p_actor_id;

    delete from amux.team_members where member_id = p_actor_id;

    if v_actor_type = 'member' then
      delete from amux.members where id = p_actor_id;
    else
      delete from amux.agents where id = p_actor_id;
    end if;

    delete from amux.actors where id = p_actor_id;
  exception
    when foreign_key_violation then
      raise exception '%', case
        when sqlerrm ilike '%idea_activities%' then 'agent_delete_blocked_by_idea_activities'
        when sqlerrm ilike '%apps_created_by%' or sqlerrm ilike '%apps_%actor%' then 'agent_delete_blocked_by_apps'
        when sqlerrm ilike '%amuxc_file%' then 'agent_delete_blocked_by_files'
        else 'actor_delete_blocked_by_references'
      end
      using errcode = '23503';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The session list RPC
-- ---------------------------------------------------------------------------
-- p_team_id becomes required, and moves to the front because PostgreSQL will
-- not let a parameter without a default follow ones that have defaults. Every
-- caller passes arguments by name (PostgREST does, and so does supabase-js), so
-- the reorder is invisible to them -- but dropping the old signatures means a
-- caller that omits p_team_id now fails loudly with "function not found"
-- instead of silently listing whatever the old global scope resolved to.
--
-- With the team known up front the caller's actor resolves once for the whole
-- query, instead of per row: this keeps the shape 20260804000000 optimised for.

DROP FUNCTION IF EXISTS amux.list_current_actor_sessions(
  integer, timestamp with time zone, timestamp with time zone, uuid
);
DROP FUNCTION IF EXISTS amux.list_current_actor_sessions(
  integer, timestamp with time zone, timestamp with time zone, uuid, uuid, uuid
);
DROP FUNCTION IF EXISTS amux.list_current_actor_sessions(
  uuid, integer, timestamp with time zone, timestamp with time zone, uuid, uuid
);

CREATE FUNCTION amux.list_current_actor_sessions(
  p_team_id uuid,
  p_limit integer DEFAULT 50,
  p_before_last_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_id uuid DEFAULT NULL::uuid,
  p_idea_id uuid DEFAULT NULL::uuid
) RETURNS TABLE(
  id uuid,
  title text,
  team_id uuid,
  mode text,
  idea_id uuid,
  last_message_at timestamp with time zone,
  last_message_preview text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  has_unread boolean,
  source text,
  cron_job_id text,
  summary text,
  primary_agent_id uuid,
  created_by_actor_id uuid,
  participant_count integer
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'app'
AS $function$
begin
  -- Named-argument resolution ignores parameter order, so a stale caller that
  -- still passes p_team_id => null would bind to this function and get an empty
  -- page: `s.team_id = null` matches nothing. An empty session list is exactly
  -- the symptom this whole migration exists to remove, so refuse instead.
  -- (plpgsql only for that guard -- the query below is unchanged.)
  if p_team_id is null then
    raise exception 'list_current_actor_sessions requires p_team_id'
      using errcode = '22023';
  end if;

  return query
  with current_actor as (
    select amux.current_actor_id_for_team(p_team_id) as actor_id
  )
  select
    s.id,
    s.title,
    s.team_id,
    s.mode,
    s.idea_id,
    s.last_message_at,
    s.last_message_preview,
    s.created_at,
    s.updated_at,
    (
      s.last_message_at is not null
      and s.last_message_at > coalesce(srm.last_read_at, '-infinity'::timestamptz)
    ) as has_unread,
    s.source,
    s.cron_job_id,
    s.summary,
    s.primary_agent_id,
    s.created_by_actor_id,
    (
      select count(*)
      from amux.session_participants participant
      where participant.session_id = s.id
    )::integer as participant_count
  from current_actor ca
  join amux.session_participants membership
    on membership.actor_id = ca.actor_id
  join amux.sessions s
    on s.id = membership.session_id
  left join amux.session_read_markers srm
    on srm.session_id = s.id
   and srm.actor_id = ca.actor_id
  where s.archived_at is null
    and s.team_id = p_team_id
    and (p_idea_id is null or s.idea_id = p_idea_id)
    and (
      p_before_id is null
      or (
        case
          when p_before_last_message_at is null then
            s.last_message_at is not null
            or (
              s.last_message_at is null
              and (
                s.created_at < p_before_created_at
                or (s.created_at = p_before_created_at and s.id < p_before_id)
              )
            )
          when s.last_message_at is null then false
          when s.last_message_at < p_before_last_message_at then true
          when s.last_message_at = p_before_last_message_at then
            s.created_at < p_before_created_at
            or (s.created_at = p_before_created_at and s.id < p_before_id)
          else false
        end
      )
    )
  order by
    s.last_message_at desc nulls first,
    s.created_at desc,
    s.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$function$;

REVOKE ALL ON FUNCTION amux.list_current_actor_sessions(
  p_team_id uuid,
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid,
  p_idea_id uuid
) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(
  p_team_id uuid,
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid,
  p_idea_id uuid
) TO authenticated;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(
  p_team_id uuid,
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid,
  p_idea_id uuid
) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Retire amux.current_actor_id()
-- ---------------------------------------------------------------------------
-- No CASCADE: if anything still depends on it, this fails and the migration
-- rolls back rather than dropping a policy along with the function.

DROP FUNCTION IF EXISTS amux.current_actor_id();
