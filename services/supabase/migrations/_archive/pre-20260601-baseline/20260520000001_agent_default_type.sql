-- Add dedicated default_agent_type column to agents.
--
-- agent_kind  = runner/host type ('daemon' | 'cli')
-- default_agent_type = preferred LLM backend ('opencode' | 'codex' | 'claude_code')
--
-- Previously agent_kind was overloaded with both meanings.  This migration
-- splits them: adds the new column, backfills from the old mixed values, and
-- resets any agent_kind that was used as a backend preference back to 'daemon'.

begin;

-- ===========================================================================
-- 1. Add column
-- ===========================================================================
alter table public.agents
  add column if not exists default_agent_type text
    check (default_agent_type in ('opencode', 'codex', 'claude_code'));

comment on column public.agents.agent_kind is
  'Runner/host type for this agent. Canonical values: ''daemon'' (amuxd-hosted), ''cli'' (server CLI). Does not indicate which LLM backend is preferred — see default_agent_type.';

comment on column public.agents.default_agent_type is
  'Preferred LLM backend when no explicit agent type is requested. Canonical values: ''opencode'', ''codex'', ''claude_code''. Null means use the daemon''s compiled-in default (currently opencode). Stored separately from agent_kind so agent_kind can remain a stable runner descriptor.';

comment on column public.agents.capabilities is
  'Reserved for future use: extensible JSONB config, e.g. a list of supported_backends the agent advertises, feature flags, or per-backend overrides. Not used for backend selection today — use default_agent_type instead.';

-- ===========================================================================
-- 2. Backfill: move backend-preference values out of agent_kind
--    'claude'   → default_agent_type = 'claude_code', agent_kind = 'daemon'
--    'opencode' → default_agent_type = 'opencode',    agent_kind = 'daemon'
-- ===========================================================================
update public.agents
   set default_agent_type = case agent_kind
                              when 'claude'    then 'claude_code'
                              when 'opencode'  then 'opencode'
                            end,
       agent_kind         = 'daemon',
       updated_at         = now()
 where agent_kind in ('claude', 'opencode');

-- ===========================================================================
-- 3. Re-create actor_directory view to expose default_agent_type
-- ===========================================================================
drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.avatar_url, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_kind,
  ag.default_agent_type,
  ag.status     as agent_status,
  ag.default_workspace_id
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team';

grant select on public.actor_directory to authenticated;

-- ===========================================================================
-- 4. Update update_agent_defaults RPC: add p_default_agent_type parameter
-- ===========================================================================
create or replace function public.update_agent_defaults(
  p_agent_id             uuid,
  p_default_workspace_id uuid    default null,
  p_agent_kind           text    default null,
  p_default_agent_type   text    default null
)
returns table (
  agent_id             uuid,
  default_workspace_id uuid,
  agent_kind           text,
  default_agent_type   text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team_id          uuid;
  v_caller           uuid := auth.uid();
  v_new_kind         text := nullif(btrim(coalesce(p_agent_kind, '')), '');
  v_new_backend      text := nullif(btrim(coalesce(p_default_agent_type, '')), '');
begin
  if v_caller is null then
    raise exception 'update_agent_defaults requires authentication'
      using errcode = '42501';
  end if;

  select a.team_id into v_team_id
    from public.actors a
   where a.id = p_agent_id and a.actor_type = 'agent';

  if v_team_id is null then
    raise exception 'agent not found' using errcode = '23503';
  end if;

  if not app.is_team_member(v_team_id) then
    raise exception 'caller is not a member of the agent team'
      using errcode = '42501';
  end if;

  if p_default_workspace_id is not null then
    if not exists (
      select 1 from public.workspaces w
       where w.id = p_default_workspace_id and w.team_id = v_team_id
    ) then
      raise exception 'workspace is not in the agent team'
        using errcode = '23514';
    end if;
  end if;

  if v_new_backend is not null
     and v_new_backend not in ('opencode', 'codex', 'claude_code') then
    raise exception 'invalid default_agent_type: must be opencode, codex, or claude_code'
      using errcode = '23514';
  end if;

  update public.agents ag
     set default_workspace_id = coalesce(p_default_workspace_id, ag.default_workspace_id),
         agent_kind           = coalesce(v_new_kind, ag.agent_kind),
         default_agent_type   = coalesce(v_new_backend, ag.default_agent_type),
         updated_at           = now()
   where ag.id = p_agent_id;

  if not found then
    raise exception 'agent row missing' using errcode = '23503';
  end if;

  return query
  select ag.id, ag.default_workspace_id, ag.agent_kind, ag.default_agent_type
    from public.agents ag
   where ag.id = p_agent_id;
end;
$$;

revoke all on function public.update_agent_defaults(uuid, uuid, text, text) from public;
grant execute on function public.update_agent_defaults(uuid, uuid, text, text) to authenticated;

commit;
