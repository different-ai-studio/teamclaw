-- Telemetry leaderboard fix:
--  * actor_skill_usage table (skill dimension storage)
--  * unique (actor_id, message_id) index so feedback upsert is valid
--  * replace the cartesian-product team_leaderboard view with a
--    period-aware aggregate function that also returns skill_usage + score

-- 1) Per-skill usage -------------------------------------------------------
create table public.actor_skill_usage (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references public.actors(id)  on delete cascade,
  team_id     uuid not null references public.teams(id)   on delete cascade,
  session_id  uuid references public.sessions(id)         on delete set null,
  skill       text not null,
  count       integer not null default 1 check (count > 0),
  created_at  timestamptz not null default now()
);

create index actor_skill_usage_team_idx
  on public.actor_skill_usage (team_id, created_at desc);
create index actor_skill_usage_actor_idx
  on public.actor_skill_usage (actor_id, created_at desc);

alter table public.actor_skill_usage enable row level security;

create policy actor_skill_usage_select_if_team_member
  on public.actor_skill_usage
  for select to authenticated
  using (app.is_team_member(team_id));

create policy actor_skill_usage_insert_self
  on public.actor_skill_usage
  for insert to authenticated
  with check (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  );

grant select, insert on public.actor_skill_usage to authenticated;

-- 2) Make the feedback upsert key valid -----------------------------------
-- supabase-repo upserts on (actor_id, message_id); the table had no matching
-- unique constraint, so the upsert would error.
-- Non-partial unique index: required so supabase-js .upsert({ onConflict:
-- "actor_id,message_id" }) (which emits ON CONFLICT with no WHERE) can match it.
-- NULL message_id rows (session-level feedback) remain unconstrained because
-- Postgres treats NULLs as distinct in a unique index.
create unique index actor_message_feedback_actor_message_uidx
  on public.actor_message_feedback (actor_id, message_id);

-- The feedback upsert (INSERT ... ON CONFLICT DO UPDATE) needs UPDATE rights
-- for the re-rate path. Mirror the existing insert-self policy.
create policy actor_message_feedback_update_self
  on public.actor_message_feedback
  for update to authenticated
  using (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  )
  with check (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  );

grant update on public.actor_message_feedback to authenticated;

-- 3) Period-aware leaderboard ---------------------------------------------
drop view if exists public.team_leaderboard;

create or replace function public.team_leaderboard(p_team_id uuid, p_period text default 'week')
returns table (
  team_id           uuid,
  actor_id          uuid,
  display_name      text,
  period            text,
  tokens_used       bigint,
  cost_usd          numeric,
  positive_feedback bigint,
  negative_feedback bigint,
  session_count     bigint,
  skill_usage       jsonb,
  score             numeric
)
language sql
stable
security invoker
as $$
  with bounds as (
    select case p_period
      when 'day'   then now() - interval '1 day'
      when 'week'  then now() - interval '7 days'
      when 'month' then now() - interval '30 days'
      else              now() - interval '7 days'
    end as since
  ),
  reports as (
    select r.actor_id,
           sum(r.tokens_used)::bigint   as tokens_used,
           sum(r.cost_usd)::numeric     as cost_usd,
           count(*)::bigint             as session_count
    from public.actor_session_report r, bounds b
    where r.team_id = p_team_id and r.created_at >= b.since
    group by r.actor_id
  ),
  fb as (
    select f.actor_id,
           sum((f.kind = 'positive')::int)::bigint as positive_feedback,
           sum((f.kind = 'negative')::int)::bigint as negative_feedback
    from public.actor_message_feedback f, bounds b
    where f.team_id = p_team_id and f.created_at >= b.since
    group by f.actor_id
  ),
  skills as (
    select s.actor_id,
           jsonb_object_agg(s.skill, s.cnt) as skill_usage
    from (
      select su.actor_id, su.skill, sum(su.count)::bigint as cnt
      from public.actor_skill_usage su, bounds b
      where su.team_id = p_team_id and su.created_at >= b.since
      group by su.actor_id, su.skill
    ) s
    group by s.actor_id
  )
  select
    a.team_id,
    a.id                                          as actor_id,
    a.display_name,
    p_period                                      as period,
    coalesce(reports.tokens_used, 0)              as tokens_used,
    coalesce(reports.cost_usd, 0)                 as cost_usd,
    coalesce(fb.positive_feedback, 0)             as positive_feedback,
    coalesce(fb.negative_feedback, 0)             as negative_feedback,
    coalesce(reports.session_count, 0)            as session_count,
    coalesce(skills.skill_usage, '{}'::jsonb)     as skill_usage,
    -- score = tokens_used (placeholder ranking key; cost-weighted formula TBD)
    coalesce(reports.tokens_used, 0)::numeric     as score
  from public.actors a
  left join reports on reports.actor_id = a.id
  left join fb      on fb.actor_id      = a.id
  left join skills  on skills.actor_id  = a.id
  where a.team_id = p_team_id;
$$;

grant execute on function public.team_leaderboard(uuid, text) to authenticated;
