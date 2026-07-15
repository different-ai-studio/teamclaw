-- team_leaderboard: 30-day rolling per-actor aggregate of feedback + reports.
-- security_invoker = on so RLS on the underlying tables is enforced.

create view public.team_leaderboard
  with (security_invoker = on)
as
select
  a.team_id,
  a.id                                              as actor_id,
  a.display_name,
  coalesce(sum(r.tokens_used), 0)                   as tokens_used_30d,
  coalesce(sum(r.cost_usd),    0)                   as cost_usd_30d,
  coalesce(sum((f.kind = 'positive')::int), 0)      as positive_feedback_30d,
  coalesce(sum((f.kind = 'negative')::int), 0)      as negative_feedback_30d
from public.actors a
left join public.actor_session_report   r
  on r.actor_id = a.id
  and r.created_at >= now() - interval '30 days'
left join public.actor_message_feedback f
  on f.actor_id = a.id
  and f.created_at >= now() - interval '30 days'
group by a.team_id, a.id, a.display_name;

grant select on public.team_leaderboard to authenticated;
