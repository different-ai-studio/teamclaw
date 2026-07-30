-- Allow `cursor` in amux.update_agent_defaults().
--
-- 20260729110000_agent_backend_cursor.sql widened the CHECK constraints on
-- amux.agents.default_agent_type and amux.agent_runtimes.backend_type, but
-- update_agent_defaults() carries its own equivalent guard inside a SECURITY
-- DEFINER body, and no migration had refreshed it. So the table would accept
-- 'cursor' while this RPC still raised
--
--   invalid default_agent_type: must be opencode, codex, claude, or pi   (23514)
--
-- which is the path the Cloud API actually uses (supabase-repo passes
-- p_default_agent_type), leaving cursor unsettable as an agent's default type.
--
-- This is a verbatim redefinition of the baseline function with two changes:
--   * 'cursor' added to the accepted list, and the message rewritten to match.
--   * 'claude-code' / 'claude_code' still normalize to 'claude' on the way in,
--     unchanged — amux.agents stores the short form.
-- Everything else (authz, workspace-team check, agent_types membership check,
-- return shape) is preserved exactly.

CREATE OR REPLACE FUNCTION amux.update_agent_defaults(
    p_agent_id uuid,
    p_default_workspace_id uuid DEFAULT NULL::uuid,
    p_agent_kind text DEFAULT NULL::text,
    p_default_agent_type text DEFAULT NULL::text
) RETURNS TABLE(agent_id uuid, default_workspace_id uuid, agent_types jsonb, default_agent_type text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'amux', 'public', 'auth'
    AS $$
declare
  v_team_id          uuid;
  v_caller           uuid := auth.uid();
  v_new_backend      text := nullif(btrim(coalesce(p_default_agent_type, '')), '');
begin
  if v_caller is null then
    raise exception 'update_agent_defaults requires authentication'
      using errcode = '42501';
  end if;

  select a.team_id into v_team_id
    from amux.actors a
   where a.id = p_agent_id and a.actor_type = 'agent';

  if v_team_id is null then
    raise exception 'agent not found' using errcode = '23503';
  end if;

  if not amux.is_team_member(v_team_id) then
    raise exception 'caller is not a member of the agent team'
      using errcode = '42501';
  end if;

  if p_default_workspace_id is not null then
    if not exists (
      select 1 from amux.workspaces w
       where w.id = p_default_workspace_id and w.team_id = v_team_id
    ) then
      raise exception 'workspace is not in the agent team'
        using errcode = '23514';
    end if;
  end if;

  if v_new_backend in ('claude_code', 'claude-code') then
    v_new_backend := 'claude';
  end if;

  if v_new_backend is not null
     and v_new_backend not in ('opencode', 'codex', 'claude', 'pi', 'cursor') then
    raise exception 'invalid default_agent_type: must be opencode, codex, claude, pi, or cursor'
      using errcode = '23514';
  end if;

  if v_new_backend is not null and not exists (
    select 1 from amux.agents ag, jsonb_array_elements_text(ag.agent_types) t(value)
     where ag.id = p_agent_id and t.value = v_new_backend
  ) then
    raise exception 'default_agent_type must be one of agent_types'
      using errcode = '23514';
  end if;

  update amux.agents ag
     set default_workspace_id = coalesce(p_default_workspace_id, ag.default_workspace_id),
         default_agent_type   = coalesce(v_new_backend, ag.default_agent_type),
         updated_at           = now()
   where ag.id = p_agent_id;

  if not found then
    raise exception 'agent row missing' using errcode = '23503';
  end if;

  return query
  select ag.id, ag.default_workspace_id, ag.agent_types, ag.default_agent_type
    from amux.agents ag
   where ag.id = p_agent_id;
end;
$$;
