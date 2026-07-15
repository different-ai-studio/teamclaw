\set ON_ERROR_STOP on
begin;

-- move-set of teamclaw public function names (defined in migrations)
create temp table _tc_pub(name text);
insert into _tc_pub(name) values ('actor_id_for_user_in_team'),('add_gateway_session_participant'),('amux_access_token_hook'),('amux_acl_rules_for'),('amuxc_complete_delete'),('amuxc_complete_upload'),('archive_idea'),('check_agent_permission'),('claim_daemon_invite'),('claim_team_invite'),('create_daemon_invite'),('create_idea'),('create_idea_activity'),('create_session'),('create_team'),('create_team_invite'),('disable_team_share'),('enable_team_share'),('ensure_gateway_session'),('ensure_personal_org'),('get_member_default_agent'),('get_team_sync_mode'),('list_agent_admin_member_actor_ids'),('list_connected_agents'),('list_current_actor_sessions'),('list_session_push_targets'),('make_agent_personal'),('mark_current_actor_session_viewed'),('notify_push_dispatch'),('push_idempotency_claim'),('remove_team_actor'),('rename_team'),('reorder_ideas'),('report_client_version'),('set_member_default_agent'),('set_team_sync_mode'),('share_agent_to_team'),('shortcut_batch_move'),('shortcut_create'),('shortcut_set_visible_roles'),('team_leaderboard'),('team_member_set_roles'),('update_actor_last_active'),('update_agent_defaults'),('update_audit_columns'),('update_current_actor_profile'),('update_idea'),('update_owned_agent_profile'),('update_team_litellm'),('upsert_external_actor');

-- 1. capture recreate-DDL for policies that depend (by OID) on functions we will DROP
--    = 4 amux shims + app.current_org_id. Rewrite app.current_org_id -> amux.current_org_id.
create temp table _recreate_pol(tbl text, polname text, stmt text);
insert into _recreate_pol
select pol.polrelid::regclass::text, pol.polname,
  format('create policy %I on %s for %s to %s%s%s;',
    pol.polname, pol.polrelid::regclass,
    case pol.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'all' end,
    coalesce((select string_agg(quote_ident(rolname),',') from pg_roles where oid=any(pol.polroles)),'public'),
    case when pol.polqual is not null then ' using ('||replace(pg_get_expr(pol.polqual,pol.polrelid),'app.current_org_id','amux.current_org_id')||')' else '' end,
    case when pol.polwithcheck is not null then ' with check ('||replace(pg_get_expr(pol.polwithcheck,pol.polrelid),'app.current_org_id','amux.current_org_id')||')' else '' end)
from pg_policy pol
where pol.oid in (
  select d.objid from pg_depend d
  join pg_proc pr on pr.oid=d.refobjid
  join pg_namespace n on n.oid=pr.pronamespace
  where d.classid='pg_policy'::regclass
    and ( (n.nspname='amux' and pr.proname in ('is_current_agent','is_team_member','current_actor_id_for_team','current_member_id'))
       or (n.nspname='app'  and pr.proname='current_org_id') )
);

-- 2. drop those policies
do $$ declare r record; begin
  for r in select tbl, polname from _recreate_pol loop
    execute format('drop policy if exists %I on %s', r.polname, r.tbl);
  end loop;
end $$;

-- 3. drop Group A public duplicates (amux canonical kept), Group B amux shims, and app.current_org_id
drop function if exists public.amux_access_token_hook(jsonb);
drop function if exists public.amux_acl_rules_for(uuid,uuid,text);
drop function if exists public.claim_team_invite(text);
drop function if exists public.create_team(text,text,text,text,text);
drop function if exists public.create_team(text,text,text,text,text,uuid);
drop function if exists public.ensure_personal_org();
drop function if exists amux.is_current_agent(uuid);
drop function if exists amux.is_team_member(uuid);
drop function if exists amux.current_actor_id_for_team(uuid);
drop function if exists amux.current_member_id();
drop function if exists app.current_org_id();

-- 3b. move teamclaw custom types (enums) to amux so function signatures resolve
alter type app.team_share_mode set schema amux;

-- 4. move every remaining app function -> amux
do $$ declare r record; begin
  for r in select p.proname, pg_get_function_identity_arguments(p.oid) args
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.prokind='f'
  loop execute format('alter function app.%I(%s) set schema amux', r.proname, r.args); end loop;
end $$;

-- 5. move teamclaw public functions -> amux (those in move-set with no amux twin of same signature)
do $$ declare r record; begin
  for r in select p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_function_identity_arguments(p.oid) sig
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.prokind='f' and p.proname in (select name from _tc_pub)
             and not exists (select 1 from pg_proc a join pg_namespace an on an.oid=a.pronamespace
                             where an.nspname='amux' and a.proname=p.proname
                               and pg_get_function_identity_arguments(a.oid)=pg_get_function_identity_arguments(p.oid))
  loop execute format('alter function public.%I(%s) set schema amux', r.proname, r.args); end loop;
end $$;

-- 6. rewrite body qualifiers in all amux functions: app. -> amux. ; public.<movedfn> -> amux.<movedfn>
do $$ declare r record; v_new text; begin
  for r in select p.oid, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='amux' and p.prokind='f'
  loop
    v_new := regexp_replace(r.def, '\mapp\.', 'amux.', 'g');
    v_new := regexp_replace(v_new, '\mpublic\.(actor_id_for_user_in_team|add_gateway_session_participant|amux_access_token_hook|amux_acl_rules_for|amuxc_complete_delete|amuxc_complete_upload|archive_idea|check_agent_permission|claim_daemon_invite|claim_team_invite|create_daemon_invite|create_idea|create_idea_activity|create_session|create_team|create_team_invite|disable_team_share|enable_team_share|ensure_gateway_session|ensure_personal_org|get_member_default_agent|get_team_sync_mode|list_agent_admin_member_actor_ids|list_connected_agents|list_current_actor_sessions|list_session_push_targets|make_agent_personal|mark_current_actor_session_viewed|notify_push_dispatch|push_idempotency_claim|remove_team_actor|rename_team|reorder_ideas|report_client_version|set_member_default_agent|set_team_sync_mode|share_agent_to_team|shortcut_batch_move|shortcut_create|shortcut_set_visible_roles|team_leaderboard|team_member_set_roles|update_actor_last_active|update_agent_defaults|update_audit_columns|update_current_actor_profile|update_idea|update_owned_agent_profile|update_team_litellm|upsert_external_actor)\M', 'amux.\1', 'g');
    if v_new <> r.def then execute v_new; end if;
  end loop;
end $$;

-- 7. recreate captured policies (now resolving to amux)
do $$ declare r record; begin
  for r in select stmt from _recreate_pol loop execute r.stmt; end loop;
end $$;

commit;
