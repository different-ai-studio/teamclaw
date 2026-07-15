import { getBackend } from '@/lib/backend'
import { getLocalDaemonAgent } from '@/lib/daemon-agent-admin'
import { isTauri } from '@/lib/utils'

export type QuickChatSource = 'local' | 'member_default' | 'team_default'

export type QuickChatTarget = {
  agentId: string
  displayName: string
  source: QuickChatSource
}

export async function resolveQuickChatTarget(
  teamId: string,
  opts?: { workspacePath?: string | null },
): Promise<QuickChatTarget | null> {
  const trimmedTeam = teamId.trim()
  if (!trimmedTeam) return null

  const workspacePath = opts?.workspacePath?.trim() || ''

  if (isTauri() && workspacePath) {
    try {
      const local = await getLocalDaemonAgent(trimmedTeam)
      if (local?.id) {
        return {
          agentId: local.id,
          displayName: local.displayName || local.id,
          source: 'local',
        }
      }
    } catch {
      // Fall through to effective default.
    }
  }

  const backend = getBackend()

  let effectiveId: string
  try {
    effectiveId = (await backend.actors.getEffectiveDefaultAgent(trimmedTeam))?.trim() || ''
  } catch {
    return null
  }
  if (!effectiveId) return null

  let memberId: string
  try {
    memberId = (await backend.actors.getMemberDefaultAgent(trimmedTeam))?.trim() || ''
  } catch {
    memberId = ''
  }

  const source: QuickChatSource =
    memberId && memberId === effectiveId ? 'member_default' : 'team_default'

  let displayName = effectiveId
  try {
    const actor = await backend.actors.getActorDirectoryEntry(effectiveId)
    const name = actor?.display_name?.trim()
    if (name) displayName = name
  } catch {
    // keep id fallback
  }

  return { agentId: effectiveId, displayName, source }
}
