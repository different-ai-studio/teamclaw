-- One-time cleanup: daemon cloud sync was inserting orphan workspace rows
-- (agent_id IS NULL) on every register, while agents.default_workspace_id
-- pointed at those orphans. Repoint defaults to agent-bound rows first,
-- then archive unreferenced duplicates.

-- 1) Archive junk orphan rows (not General, not referenced).
update amux.workspaces w
set archived = true,
    updated_at = now()
where w.archived = false
  and w.agent_id is null
  and w.name <> 'General'
  and not exists (
    select 1 from amux.agents a where a.default_workspace_id = w.id
  )
  and not exists (
    select 1 from amux.agent_runtimes ar where ar.workspace_id = w.id
  );

-- 2) Known cross-agent contamination: meng.wang agent bound to wuxing path.
update amux.workspaces
set archived = true,
    updated_at = now()
where id = '88567d25-f7f5-4545-ba28-ad1dcebdbb4a'
  and path = '/Users/wuxing.liu/TeamClaw';

-- 3) Prefer agent-bound rows for defaults when both orphan + bound exist.
update amux.agents a
set default_workspace_id = wb.id
from amux.actors act
join lateral (
  select id
  from amux.workspaces
  where team_id = act.team_id
    and agent_id = act.id
    and archived = false
    and path is not null
  order by updated_at desc
  limit 1
) wb on true
where a.id = act.id
  and act.actor_type = 'agent'
  and wb.id is not null
  and a.default_workspace_id is distinct from wb.id;

-- 4) Archive orphan duplicates left behind after default repoint.
update amux.workspaces w
set archived = true,
    updated_at = now()
where w.archived = false
  and w.agent_id is null
  and w.name <> 'General'
  and not exists (
    select 1 from amux.agents a where a.default_workspace_id = w.id
  )
  and not exists (
    select 1 from amux.agent_runtimes ar where ar.workspace_id = w.id
  );

-- 5) Backfill agent_id on remaining canonical default rows when no bound
--    duplicate exists (avoids workspaces_team_id_agent_id_name_key clash).
update amux.workspaces w
set agent_id = a.id,
    updated_at = now()
from amux.agents a
where a.default_workspace_id = w.id
  and w.agent_id is null
  and not exists (
    select 1
    from amux.workspaces w2
    where w2.team_id = w.team_id
      and w2.agent_id = a.id
      and w2.name = w.name
      and w2.archived = false
      and w2.id <> w.id
  );
