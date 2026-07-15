// Betly admin auto-login — share the current TeamClaw session with the Betly
// admin SPA opened in a native webview, so it skips its own login screen.
//
// The Betly admin (testadmin.ucar.cc / admin.mx5.cn) is a supabase-js SPA whose
// Supabase shares TeamClaw's GoTrue (same JWT signing secret + user table), so
// the TeamClaw access/refresh token validates there directly. supabase-js reads
// its session from localStorage under `sb-<ref>-auth-token`, where <ref> is the
// first label of the admin's Supabase host. We hand the storage key + the
// serialized session to the native side, which seeds it before the page bundle
// runs (see webview_create / build_supabase_session_script in webview.rs).
//
// Security: this map is the allowlist. We only ever expose the TeamClaw bearer
// token to these hosts — never to arbitrary third-party webviews. The native
// side re-checks the host against the same allowlist as defense in depth.

import { getSession } from "@/lib/auth/session-store"

// host -> supabase-js localStorage key
//   testadmin.ucar.cc -> Supabase test-supa.mx5.cn -> sb-test-supa-auth-token
//   admin.mx5.cn       -> Supabase supa.mx5.cn      -> sb-supa-auth-token
const BETLY_ADMIN_AUTH_KEYS: Record<string, string> = {
  "testadmin.ucar.cc": "sb-test-supa-auth-token",
  "admin.mx5.cn": "sb-supa-auth-token",
}

export interface BetlyAuthInjection {
  storageKey: string
  sessionJson: string
}

/**
 * If `url` points at an allowlisted Betly admin host and a TeamClaw session is
 * present, return the storage key + serialized supabase-js session to inject.
 * Returns null otherwise (no injection).
 */
export function betlyAuthInjectionFor(url: string): BetlyAuthInjection | null {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }

  const storageKey = BETLY_ADMIN_AUTH_KEYS[host]
  if (!storageKey) return null

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

  return { storageKey, sessionJson: JSON.stringify(supabaseSession) }
}
