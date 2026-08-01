-- When a picker row belongs to another tenant identity with the same phone,
-- switch to that actor's user before minting the replacement auth session.

create or replace function amux.switch_active_team(p_team_id uuid)
returns table(actor_id uuid, team_id uuid, refresh_token text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth', 'app'
as $function$
declare
  v_caller_id uuid := auth.uid();
  v_mobile text;
  v_actor uuid;
  v_member_user_id uuid;
  v_team_org uuid;
  v_rt text;
begin
  if v_caller_id is null then
    raise exception 'switch requires authentication' using errcode = '42501';
  end if;

  select nullif(btrim(u.mobile), '') into v_mobile
    from public.users u
   where u.id = v_caller_id
   limit 1;

  select a.id, a.user_id into v_actor, v_member_user_id
    from amux.actors a
   where a.team_id = p_team_id
     and (
       a.user_id = v_caller_id
       or (
         v_mobile is not null
         and exists (
           select 1
             from public.users u
            where u.id = a.user_id
              and u.mobile = v_mobile
         )
       )
     )
   order by case when a.user_id = v_caller_id then 0 else 1 end, a.created_at asc
   limit 1;
  if v_actor is null then
    raise exception 'not a member of this team' using errcode = '42501';
  end if;

  select oid into v_team_org from amux.teams where id = p_team_id;
  if v_team_org is not null then
    insert into public.users (auth_user_id, org_id)
    values (v_member_user_id, v_team_org)
    on conflict (auth_user_id) where auth_user_id is not null do update
      set org_id = excluded.org_id, updated_at = now();
  end if;

  v_rt := auth._mint_session(v_member_user_id);
  update amux.actors set last_active_at = now(), updated_at = now() where id = v_actor;

  return query select v_actor, p_team_id, v_rt;
end;
$function$;

grant execute on function amux.switch_active_team(uuid) to authenticated, service_role;
