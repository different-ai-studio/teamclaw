-- Cron sessions created before 2026-06-01 only seeded the primary agent as a
-- participant. Human team members could not SELECT the session row or messages
-- (sessions_select_if_participant_or_creator), so "查看对话" from cron history
-- failed even when the run succeeded. Backfill admin members like gateway
-- sessions (202605170004_gateway_agent_admin_owner_rpc.sql).

insert into public.session_participants (session_id, actor_id)
select s.id, ama.member_id
  from public.sessions as s
  join public.agent_member_access as ama
    on ama.agent_id = s.primary_agent_id
   and ama.permission_level = 'admin'
 where s.title like 'Cron:%'
on conflict on constraint session_participants_session_id_actor_id_key
do nothing;
