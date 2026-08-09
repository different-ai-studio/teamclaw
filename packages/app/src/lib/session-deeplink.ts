import { appScheme } from '@/lib/build-config'

// The desktop app accepts the build's configured scheme as well as `teamclu://`,
// the pre-rebrand `teamclaw://`, and `amux://` for back-compat (shared with iOS).
//
// `teamclaw:` is a historical fact, not a brand string: session links already
// shared with teammates carry it, and a white-label build (whose appScheme is
// its own) has no other way to accept an official link.
const SESSION_SCHEMES = new Set([`${appScheme}:`, 'teamclu:', 'teamclaw:', 'amux:'])
const SESSION_HOST = 'session'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseSessionDeeplink(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!SESSION_SCHEMES.has(url.protocol)) return null
    if (url.hostname !== SESSION_HOST) return null
    // teamclu://session/<uuid> → pathname is "/<uuid>"; take the first segment.
    const id = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
    return UUID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

export function buildSessionDeeplink(sessionId: string): string {
  return `${appScheme}://${SESSION_HOST}/${sessionId}`
}
