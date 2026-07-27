-- ============================================================================
-- gateway_session_switch — 手工应用到 RDS
--
-- 对应仓库文件 services/supabase/migrations/20260728000000_gateway_session_switch.sql
-- 已在自建盒子上应用成功(2026-07-27 05:36 UTC)。
--
-- 跑法(单事务,出错即整体回滚,不留半截状态):
--
--     psql "$RDS_URL" -v ON_ERROR_STOP=1 -1 \
--       -f services/supabase/manual/gateway_session_switch_rds.sql
--
-- 幂等:重复跑安全。
--
-- ─── 跑之前请确认三件事 ─────────────────────────────────────────────────────
--
-- 1) 用哪个角色连。自建盒子上就栽在这:amux.detach_gateway_session 当初是被
--    手工以 supabase_admin 建的,而 migrate 容器以 postgres 连,
--    `create or replace` 一个不属于自己的函数会报
--    "must be owner of function",整个事务回滚。
--    先查 owner,不一致就先归位:
--
--      select proname, pg_get_userbyid(proowner) as owner
--        from pg_proc where pronamespace = 'amux'::regnamespace
--         and proname like '%gateway_session%';
--
--      -- 如有不一致(需以 superuser 或原 owner 执行):
--      alter function amux.detach_gateway_session(text) owner to postgres;
--
-- 2) gen_random_bytes 在哪个 schema。下面 ensure_gateway_session 里写的是
--    extensions.gen_random_bytes(16)(Supabase 的约定)。普通 RDS 上 pgcrypto
--    通常装在 public,那就把那一处改掉。查:
--
--      select extname, nspname from pg_extension e
--        join pg_namespace n on n.oid = e.extnamespace where extname = 'pgcrypto';
--
-- 3) authenticated 角色是否存在。普通 RDS 上多半没有,所以下面的 grant 做了
--    存在性判断,角色不在就跳过,不会报错。
-- ============================================================================


-- ── 1. gateway_key:session 属于哪个 chat,伴随其整个生命周期 ────────────────
--
-- binding 担不了这个职责:它是「当前挂在谁身上」的指针,detach 会置空,于是被
-- 解绑的 session 身上不再留有任何来源痕迹。gateway_key 在创建时从 binding 写入,
-- 此后永不清除 —— 这是 `/sessions` 能列出、`/sessions <n>` 能切回去的前提。

ALTER TABLE amux.sessions
  ADD COLUMN IF NOT EXISTS gateway_key text;

CREATE INDEX IF NOT EXISTS sessions_gateway_key_idx
  ON amux.sessions (team_id, gateway_key)
  WHERE gateway_key IS NOT NULL;

-- 只能为「仍处于挂载状态」的 session 回填:本次改动之前被 /clear 解绑掉的行,
-- 已经没有任何信号能还原它属于哪个 chat 了。
-- (自建盒子上这一步影响 0 行 —— 1710 个 session 的 binding 全是 null。)
UPDATE amux.sessions
   SET gateway_key = binding
 WHERE gateway_key IS NULL
   AND binding IS NOT NULL;


-- ── 2. ensure_gateway_session:插入时打上 gateway_key,并顺带修老行 ──────────
--
-- 与线上现有版本相比只多了 gateway_key 的写入:insert 时打标,已有行在下一条
-- 消息进来时补写,这样改动之前创建的 session 无需单独的数据迁移就能被列出。
--
-- ⚠️ extensions.gen_random_bytes —— 见文件头第 2 条。

create or replace function amux.ensure_gateway_session(
  p_team_id uuid,
  p_binding text,
  p_title text,
  p_primary_agent_actor_id uuid,
  p_owner_member_actor_ids uuid[],
  p_participant_actor_ids uuid[]
)
returns table(session_id uuid, acp_session_id text, created boolean)
language plpgsql
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
declare
  v_session uuid;
  v_acp     text;
  v_created boolean := false;
begin
  select s.id, s.acp_session_id
    into v_session, v_acp
    from amux.sessions as s
   where s.team_id = p_team_id
     and s.binding = p_binding;

  if v_session is null then
    insert into amux.sessions
      (team_id, idea_id, created_by_actor_id, primary_agent_id,
       mode, title, binding, gateway_key, acp_session_id)
    values
      (p_team_id,
       null,
       p_primary_agent_actor_id,
       p_primary_agent_actor_id,
       'collab',
       p_title,
       p_binding,
       p_binding,
       encode(extensions.gen_random_bytes(16), 'hex'))
    returning amux.sessions.id, amux.sessions.acp_session_id
      into v_session, v_acp;
    v_created := true;
  else
    -- 收到消息即取消归档,并为早于本次改动的行补写 gateway_key。source 不动:
    -- 这里创建的 gateway 行一直带着默认的 'user',而 cron 路径也用
    -- `cron/<job>/<run>` 形式的 binding 走同一个函数,没有单一正确值可改写。
    update amux.sessions
       set archived_at = null,
           gateway_key = coalesce(gateway_key, p_binding)
     where id = v_session
       and (archived_at is not null or gateway_key is null);
  end if;

  -- 对已有行同样执行:这是让一个「比创建它的 agent 活得更久」的 session
  -- 重新可达的关键。
  insert into amux.session_participants (session_id, actor_id)
    select v_session, participant_actor_id
      from unnest(
        array[p_primary_agent_actor_id]
          || coalesce(p_owner_member_actor_ids, '{}'::uuid[])
          || coalesce(p_participant_actor_ids,  '{}'::uuid[])
      ) as participant_actor_id
     where participant_actor_id is not null
  on conflict on constraint session_participants_session_id_actor_id_key
  do nothing;

  return query select v_session, v_acp, v_created;
end;
$function$;


-- ── 3. list_gateway_sessions:这个 chat 自己的 session,最新在前 ─────────────
--
-- 按单个 gateway_key 收窄,所以一个会话只看得到自己的血缘 —— 看不到别的 chat 的,
-- 也看不到桌面端的。已归档的行故意包含在内:归档只是把会话从列表里藏起来,
-- 但从会话内部看它仍是自己历史的一部分,而且切回去本身就会取消归档。
--
-- SECURITY DEFINER 的理由同上面两个函数:daemon 以它的 agent actor 身份调用,
-- 而该 actor 的 RLS 授权覆盖不到一个已解绑的行。

create or replace function amux.list_gateway_sessions(
  p_team_id uuid,
  p_gateway_key text,
  p_limit integer default 20
)
returns table(
  session_id uuid,
  acp_session_id text,
  title text,
  is_current boolean,
  last_message_at timestamp with time zone,
  created_at timestamp with time zone
)
language sql
stable
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
  select s.id,
         s.acp_session_id,
         s.title,
         (s.binding is not null and s.binding = p_gateway_key) as is_current,
         s.last_message_at,
         s.created_at
    from amux.sessions as s
   where s.team_id = p_team_id
     and s.gateway_key = p_gateway_key
   order by coalesce(s.last_message_at, s.created_at) desc, s.id desc
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$function$;


-- ── 4. attach_gateway_session:detach 的逆操作 ───────────────────────────────
--
-- 把 chat 的 binding 搬到该 chat 自己的某个已有 session 上,让下一条消息解析到它,
-- 会话就从那里继续。
--
-- 护栏:
--   * 目标必须属于同一个 chat(gateway_key = p_binding)—— 否则一个 chat 就能
--     劫持另一个会话的 session,而 daemon 的 agent actor 没有这个权限;
--   * 当前持有 binding 的那个先被解绑,并附加与 detach_gateway_session 相同的
--     时间戳后缀,使两条路径产生形状一致的历史;
--   * 切入即取消归档,因为这个会话显然正在被使用。
--
-- 目标不存在或不属于本 chat 时返回 attached=false(session 为 null),
-- 好让调用方如实说「没这个 session」,而不是汇报一次没发生的切换。

create or replace function amux.attach_gateway_session(
  p_binding text,
  p_session_id uuid
)
returns table(session_id uuid, acp_session_id text, attached boolean)
language plpgsql
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
declare
  v_team    uuid;
  v_acp     text;
  v_binding text;
  v_holder  uuid;
  v_title   text;
begin
  select s.team_id, s.acp_session_id, s.binding
    into v_team, v_acp, v_binding
    from amux.sessions as s
   where s.id = p_session_id
     and s.gateway_key = p_binding;

  if v_team is null then
    return query select null::uuid, null::text, false;
    return;
  end if;

  -- 已经是这个 chat 的当前 session:没什么可搬的,报成功让命令保持幂等。
  if v_binding is not null and v_binding = p_binding then
    update amux.sessions set archived_at = null where id = p_session_id;
    return query select p_session_id, v_acp, true;
    return;
  end if;

  select s.id, s.title
    into v_holder, v_title
    from amux.sessions as s
   where s.team_id = v_team
     and s.binding = p_binding;

  if v_holder is not null then
    update amux.sessions
       set binding = null,
           title = case
                     when coalesce(v_title, '') = '' then v_title
                     else v_title || ' (' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ')'
                   end
     where id = v_holder;
  end if;

  update amux.sessions
     set binding = p_binding,
         archived_at = null
   where id = p_session_id;

  return query select p_session_id, v_acp, true;
end;
$function$;


-- ── 5. 授权 ────────────────────────────────────────────────────────────────
--
-- authenticated 是 Supabase 的角色。普通 RDS 上多半不存在,所以判断后再授,
-- 免得整个事务因为一个 grant 回滚。

do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function amux.list_gateway_sessions(uuid, text, integer) to authenticated;
    grant execute on function amux.attach_gateway_session(text, uuid) to authenticated;
  else
    raise notice 'role "authenticated" 不存在,跳过 grant —— 请按该库自己的角色模型补授权';
  end if;
end
$grants$;


-- ── 6. 自检(输出结果,不改任何东西) ────────────────────────────────────────

select
  (select count(*) from information_schema.columns
     where table_schema='amux' and table_name='sessions' and column_name='gateway_key') as has_gateway_key,
  (select count(*) from pg_indexes
     where schemaname='amux' and indexname='sessions_gateway_key_idx')                  as has_index,
  (select count(*) from pg_proc
     where pronamespace='amux'::regnamespace
       and proname in ('list_gateway_sessions','attach_gateway_session'))               as new_functions,
  (select count(*) from amux.sessions where gateway_key is not null)                    as rows_with_gateway_key;
-- 期望:has_gateway_key=1, has_index=1, new_functions=2
