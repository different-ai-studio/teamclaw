-- Make the push-dispatch webhook target configurable per environment.
--
-- amux.notify_push_dispatch() posted to a URL baked into the function body:
-- https://cloud.ucar.cc/push/dispatch. That host is the retired hosted
-- deployment — it still resolves, but to an Alibaba Function Compute endpoint,
-- not to the ECS box that runs FC today. Every message insert therefore fired a
-- webhook at a service that no longer serves this environment, so iOS push has
-- been dead by construction regardless of how APNS_* was configured.
--
-- A hostname does not belong in a migration: the same file runs against every
-- environment, and each one answers on a different host. Read it from the vault
-- instead, alongside the secret this function already reads from there.
--
-- Falls back to the previous literal when push_webhook_url is absent, so an
-- environment that is working today keeps working until someone sets its vault
-- entry. Set it with:
--
--   select vault.create_secret(
--     'https://api.example.com/push/dispatch', 'push_webhook_url', 'FC push webhook target');
--
-- Behaviour is otherwise unchanged, including the silent skip when the shared
-- secret is unset — a message insert must never fail because push is not
-- configured.

CREATE OR REPLACE FUNCTION amux.notify_push_dispatch() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_secret text;
  v_url    text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'push_webhook_secret'
   limit 1;

  -- Silently skip if secret not configured yet
  if v_secret is null then
    return new;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name = 'push_webhook_url'
   limit 1;

  -- Legacy default: what this function hardcoded before this migration. Kept so
  -- an environment that has not set push_webhook_url is not silently switched
  -- off by deploying this.
  v_url := coalesce(v_url, 'https://cloud.ucar.cc/push/dispatch');

  perform net.http_post(
    url     := v_url,
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
