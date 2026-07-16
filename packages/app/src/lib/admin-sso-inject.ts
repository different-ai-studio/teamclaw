// Partner admin console auto-login — share the current TeamClaw session with
// the partner admin SPA opened in a native webview, so it skips its own login
// screen.
//
// The admin console is a supabase-js SPA whose Supabase shares TeamClaw's
// GoTrue (same JWT signing secret + user table), so the TeamClaw access/refresh
// token validates there directly. supabase-js reads its session from
// localStorage under `sb-<ref>-auth-token`. We hand the storage key + the
// serialized session to the native side, which seeds it before the page bundle
// runs (see webview_create / build_supabase_session_script in webview.rs).
//
// The target host and storage key are NOT hardcoded: they come from the Cloud
// API via `/v1/config/{public,bootstrap}` (cached in server-config), the same
// source `web-sso.ts` reads. This is the reverse direction of that flow — it
// injects a session instead of harvesting one.
//
// Security: the resolved host is the allowlist. We only ever expose the
// TeamClaw bearer token to the host the Cloud API declares — never to arbitrary
// third-party webviews. The native side re-checks the host against its own
// build-time allowlist (WEBSSO_ADMIN_HOSTS) as defense in depth.

import { getSession } from "@/lib/auth/session-store"
import { adminConsoleTarget } from "@/lib/auth/web-sso"

export interface AdminSsoInjection {
  storageKey: string
  sessionJson: string
}

/**
 * If `url` points at the Cloud-API-declared partner admin host and a TeamClaw
 * session is present, return the storage key + serialized supabase-js session
 * to inject. Returns null otherwise (no injection).
 */
export function adminSsoInjectionFor(url: string): AdminSsoInjection | null {
  const target = adminConsoleTarget()
  if (!target) return null

  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  if (host !== target.host) return null

  const session = getSession()
  if (!session?.access_token || !session.refresh_token) return null

  // supabase-js v2 persists a flat session object under its storage key.
  const supabaseSession = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? null,
    expires_in: session.expires_in ?? 3600,
    token_type: session.token_type ?? "bearer",
    user: session.user,
  }

  return { storageKey: target.storageKey, sessionJson: JSON.stringify(supabaseSession) }
}
