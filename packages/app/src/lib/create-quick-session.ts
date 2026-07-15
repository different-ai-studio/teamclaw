import { createQuickEmptySession } from '@/lib/quick-empty-session'
import { resolveQuickChatTarget, type QuickChatTarget } from '@/lib/resolve-quick-chat-target'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * Why a quick session could not be created. Callers branch on this to show the
 * RIGHT message instead of a blanket "agent offline" toast:
 * - `no_team`      — no team selected/joined yet.
 * - `no_agent`     — no target agent resolvable (no local daemon agent, and
 *                    both the member default and team default are unset). This
 *                    is NOT a connectivity problem — guide the user to set a
 *                    default agent.
 * - `no_actor`     — the caller's own member actor id could not be resolved.
 *                    An identity/session problem, surfaced as a real failure.
 * - `server_error` — session creation threw (backend/transport error).
 */
export type QuickSessionFailureReason = 'no_team' | 'no_agent' | 'no_actor' | 'server_error'

export type QuickSessionOutcome =
  | { ok: true; sessionId: string; agentDisplayName: string }
  | { ok: false; reason: QuickSessionFailureReason; error?: unknown }

export async function createQuickSession(
  targetOverride?: QuickChatTarget | null,
): Promise<QuickSessionOutcome> {
  const teamId = useCurrentTeamStore.getState().team?.id ?? null
  if (!teamId) return { ok: false, reason: 'no_team' }

  const target =
    targetOverride ??
    (await resolveQuickChatTarget(teamId, {
      workspacePath: useWorkspaceStore.getState().workspacePath,
    }))
  if (!target) return { ok: false, reason: 'no_agent' }

  let created: { sessionId: string } | null
  try {
    created = await createQuickEmptySession({
      additionalActorIds: [target.agentId],
      titleName: target.displayName,
      engagedAgent: { id: target.agentId, displayName: target.displayName },
      agentActorIdsForRuntime: [target.agentId],
      runtimeReason: `quick_session_${target.source}`,
    })
  } catch (error) {
    // createSessionShell throws on backend/transport failures. This is a real
    // "creation failed" — do NOT mislabel it as "agent offline".
    return { ok: false, reason: 'server_error', error }
  }

  // createQuickEmptySession returns null only when the creator's member actor
  // id can't be resolved (or team/auth is missing) — a distinct identity issue.
  if (!created) return { ok: false, reason: 'no_actor' }

  return { ok: true, sessionId: created.sessionId, agentDisplayName: target.displayName }
}

/**
 * Map a failure reason to a user-facing toast. `no_agent` is guidance (set a
 * default agent), not an error; `no_actor`/`server_error` are genuine failures;
 * none of them claim the agent is "offline" unless that's actually true.
 */
export function describeQuickSessionFailure(
  reason: QuickSessionFailureReason,
  t: (key: string, fallback: string) => string,
): { title: string; description: string } {
  switch (reason) {
    case 'no_agent':
      return {
        title: t('chat.quickSessionNoAgentTitle', '尚未设置默认 Agent'),
        description: t(
          'chat.quickSessionNoAgentHint',
          '请设置个人默认 Agent，或联系管理员设置团队默认 Agent。',
        ),
      }
    case 'no_team':
      return {
        title: t('chat.quickSessionCreateError', '无法创建会话'),
        description: t('chat.quickSessionNoTeamHint', '请先选择或加入一个团队后再试。'),
      }
    case 'no_actor':
    case 'server_error':
    default:
      return {
        title: t('chat.quickSessionServerError', '创建会话失败'),
        description: t(
          'chat.quickSessionServerErrorDesc',
          '服务器暂时无法创建会话，请稍后重试。',
        ),
      }
  }
}
