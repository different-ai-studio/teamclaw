-- The initial access-token-hook migration revoked execute from `public` only.
-- The spec required revoking from `public, anon, authenticated` — the two
-- direct grants made by Supabase at role creation were not stripped, leaving
-- `amux_acl_rules_for` callable via PostgREST by any authenticated iOS user
-- (and anonymous callers with the anon key).
--
-- The function does not grant MQTT access (EMQX validates JWT, not PostgREST),
-- but leaking the rule structure is both a spec violation and unnecessary
-- attack surface.
--
-- The hook itself (`amux_access_token_hook`) already has no anon/authenticated
-- grant — only `supabase_auth_admin` can call it — so no fix needed there.

revoke execute on function public.amux_acl_rules_for(uuid, uuid, text)
  from anon, authenticated;
