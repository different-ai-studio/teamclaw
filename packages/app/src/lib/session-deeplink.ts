import { appScheme } from '@/lib/build-config'

// The desktop app accepts the build's configured scheme as well as
// `teamclaw://` and `amux://` for back-compat (shared with iOS).
const SESSION_SCHEMES = new Set([`${appScheme}:`, 'teamclaw:', 'amux:'])
const SESSION_HOST = 'session'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseSessionDeeplink(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!SESSION_SCHEMES.has(url.protocol)) return null
    if (url.hostname !== SESSION_HOST) return null
    // teamclaw://session/<uuid> → pathname is "/<uuid>"; take the first segment.
    const id = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
    return UUID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

export function buildSessionDeeplink(sessionId: string): string {
  return `${appScheme}://${SESSION_HOST}/${sessionId}`
}
