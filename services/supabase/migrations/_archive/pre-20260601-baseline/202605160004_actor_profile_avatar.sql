-- Actor profile editing: display name + cross-device avatar URL.

alter table public.actors
  add column if not exists avatar_url text;

drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.avatar_url, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_kind as agent_kind,
  ag.status     as agent_status
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team';

grant select on public.actor_directory to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read
on storage.objects for select
to public
using (bucket_id = 'avatars');

drop policy if exists avatars_owner_insert on storage.objects;
create policy avatars_owner_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  and exists (
    select 1
      from public.actors a
     where a.id = split_part(name, '/', 1)::uuid
       and a.actor_type = 'member'
       and a.user_id = auth.uid()
  )
);

drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update
on storage.objects for update
to authenticated
using (
  bucket_id = 'avatars'
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  and exists (
    select 1
      from public.actors a
     where a.id = split_part(name, '/', 1)::uuid
       and a.actor_type = 'member'
       and a.user_id = auth.uid()
  )
)
with check (
  bucket_id = 'avatars'
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  and exists (
    select 1
      from public.actors a
     where a.id = split_part(name, '/', 1)::uuid
       and a.actor_type = 'member'
       and a.user_id = auth.uid()
  )
);

drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete
on storage.objects for delete
to authenticated
using (
  bucket_id = 'avatars'
  and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  and exists (
    select 1
      from public.actors a
     where a.id = split_part(name, '/', 1)::uuid
       and a.actor_type = 'member'
       and a.user_id = auth.uid()
  )
);

create or replace function public.update_current_actor_profile(
  p_actor_id uuid,
  p_display_name text,
  p_avatar_url text default null
)
returns table (
  id uuid,
  team_id uuid,
  actor_type text,
  user_id uuid,
  invited_by_actor_id uuid,
  display_name text,
  avatar_url text,
  last_active_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  member_status text,
  team_role text,
  agent_kind text,
  agent_status text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_avatar_url text := nullif(btrim(coalesce(p_avatar_url, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  update public.actors a
     set display_name = v_display_name,
         avatar_url = v_avatar_url,
         updated_at = now()
   where a.id = p_actor_id
     and a.actor_type = 'member'
     and a.user_id = auth.uid();

  if not found then
    raise exception 'actor profile update is not allowed'
      using errcode = '42501';
  end if;

  return query
  select
    ad.id, ad.team_id, ad.actor_type, ad.user_id, ad.invited_by_actor_id,
    ad.display_name, ad.avatar_url, ad.last_active_at, ad.created_at, ad.updated_at,
    ad.member_status, ad.team_role, ad.agent_kind, ad.agent_status
  from public.actor_directory ad
  where ad.id = p_actor_id;
end;
$$;

revoke all on function public.update_current_actor_profile(uuid, text, text) from public;
grant execute on function public.update_current_actor_profile(uuid, text, text) to authenticated;
