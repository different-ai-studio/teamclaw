import { getBackend } from '@/lib/backend'
import { appScheme } from '@/lib/build-config'

// `create_team_invite` RPC returns deeplinks with the `amux://` scheme (shared
// with iOS). The desktop app accepts the build's configured scheme as well as
// `teamclu://`, the pre-rebrand `teamclaw://`, and `amux://` for back-compat.
//
// `teamclaw:` is a historical fact, not a brand string: invite links already
// handed out carry it, and a white-label build (whose appScheme is its own) has
// no other way to accept an official link.
const INVITE_SCHEMES = new Set([`${appScheme}:`, 'teamclu:', 'teamclaw:', 'amux:'])
const INVITE_HOST = 'invite'

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
