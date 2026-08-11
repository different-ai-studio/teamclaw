import { getBackend } from '@/lib/backend'
import { appScheme, deeplinkSchemes } from '@/lib/build-config'

// Which schemes count as an invite link is a build-level decision — see
// `resolveDeeplinkSchemes`. A build on the default scheme also takes the
// pre-rebrand `teamclaw://` and the `amux://` the RPC emits; a build with its
// own scheme (copilot361) takes only that one.
const INVITE_SCHEMES = new Set(deeplinkSchemes.map((s) => `${s}:`))
const INVITE_HOST = 'invite'

/**
 * The invite link to hand out, always on this build's own scheme.
 *
 * Built from the token rather than passed through from the backend: the
 * `create_team_invite` RPC still returns `amux://invite?token=…`, a scheme no
 * build registers with the OS, and the pg-repo backend returns no link at all.
 */
export function buildInviteDeeplink(token: string): string {
  return `${appScheme}://${INVITE_HOST}?token=${encodeURIComponent(token)}`
}

export function parseInviteDeeplink(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!INVITE_SCHEMES.has(url.protocol)) return null
    if (url.hostname !== INVITE_HOST && url.pathname !== `//${INVITE_HOST}`) return null
    const token = url.searchParams.get('token')
    return token && token.length > 0 ? token : null
  } catch {
    return null
  }
}

export function parseInviteTokenInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const fromDeeplink = parseInviteDeeplink(trimmed)
  if (fromDeeplink) return fromDeeplink
  if (trimmed.includes('://')) return null
  return trimmed
}

export interface ClaimResult {
  actorId: string
  teamId: string
  actorType: string
  displayName: string
  refreshToken: string | null
}

export async function claimInviteToken(token: string): Promise<ClaimResult> {
  return getBackend().auth.claimInvite(token)
}
