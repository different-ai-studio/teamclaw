-- Enable pg_net for async HTTP calls from triggers
create extension if not exists pg_net with schema net;

-- Trigger function: fires on messages INSERT, calls FC /push/dispatch
-- Reads webhook secret from vault so no plaintext secret in migration.
create or replace function public.notify_push_dispatch()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'push_webhook_secret'
   limit 1;

  -- Silently skip if secret not configured yet
  if v_secret is null then
    return new;
  end if;

  perform net.http_post(
    url     := 'https://cloud.ucar.cc/push/dispatch',
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-webhook-secret', v_secret
    ),
    body    := jsonb_build_object(
      'type',   'INSERT',
      'table',  'messages',
      'record', row_to_json(new)
    )
  );

  return new;
end;
$$;

revoke all on function public.notify_push_dispatch() from public, anon, authenticated;

create trigger messages_push_dispatch
  after insert on public.messages
  for each row execute function public.notify_push_dispatch();
