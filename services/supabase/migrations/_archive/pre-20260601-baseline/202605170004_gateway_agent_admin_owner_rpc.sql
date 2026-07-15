-- 2026-05-17: let daemon-owned gateway sessions include human agent admins.
--
-- Daemon channel startup runs as the agent actor. RLS on agent_member_access
-- intentionally hides access rows from the agent, so direct REST SELECT can
-- return an empty owner list. This RPC allows the current agent to resolve its
-- own admin member actors for gateway session participant bootstrap.

create or replace function public.list_agent_admin_member_actor_ids(
  p_agent_actor_id uuid
)
returns table (member_actor_id uuid)
language sql
stable
security definer
set search_path = public, app
as $$
  select ama.member_id
    from public.agent_member_access as ama
    join public.agents as ag on ag.id = ama.agent_id
   where ama.agent_id = p_agent_actor_id
     and ama.permission_level = 'admin'
     and (
       p_agent_actor_id = app.current_actor_id()
       or ag.owner_member_id = app.current_member_id()
     )
   order by ama.created_at;
$$;

revoke all on function public.list_agent_admin_member_actor_ids(uuid) from public, anon, authenticated;
grant execute on function public.list_agent_admin_member_actor_ids(uuid) to authenticated;

-- Backfill existing gateway sessions so the current desktop session list can
-- see them without waiting for a fresh gateway session to be created.
insert into public.session_participants (session_id, actor_id)
select s.id, ama.member_id
  from public.sessions as s
  join public.agent_member_access as ama
    on ama.agent_id = s.primary_agent_id
   and ama.permission_level = 'admin'
 where s.binding is not null
   and split_part(s.binding, '://', 1) in ('discord', 'wecom', 'feishu', 'kook', 'wechat', 'email')
on conflict on constraint session_participants_session_id_actor_id_key
do nothing;
