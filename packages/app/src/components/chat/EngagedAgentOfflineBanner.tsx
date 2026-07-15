import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'
import type { SessionAgentUiState } from '@/lib/session-agent-ui-state'

type Props = {
  entries: EngagedAgentUiEntry[]
  localDaemonAgent: AttachedAgent | null
  onRemoveAgent: (agentId: string) => void
  onSwitchToLocalAgent?: (agent: AttachedAgent) => void
  onRetryOffline?: () => void
}

function filterActionable(entries: EngagedAgentUiEntry[]): EngagedAgentUiEntry[] {
  return entries.filter((e) => e.uiState === 'offline' || e.uiState === 'stale')
}

function bannerMessage(
  actionable: EngagedAgentUiEntry[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const stale = actionable.filter((e) => e.uiState === 'stale')
  const offline = actionable.filter((e) => e.uiState === 'offline')

  if (stale.length > 0 && offline.length > 0) {
    return t('chat.sessionAgent.bannerMixed', {
      staleCount: stale.length,
      offlineCount: offline.length,
    })
  }
  if (actionable.length === 1) {
    const name = actionable[0].agent.displayName
    return actionable[0].uiState === 'stale'
      ? t('chat.sessionAgent.bannerStaleOne', { name })
      : t('chat.sessionAgent.bannerOfflineOne', { name })
  }
  if (stale.length > 0 && offline.length === 0) {
    return t('chat.sessionAgent.bannerStaleMany', { count: stale.length })
  }
  return t('chat.sessionAgent.bannerOfflineMany', { count: actionable.length })
}

export function EngagedAgentOfflineBanner({
  entries,
  localDaemonAgent,
  onRemoveAgent,
  onSwitchToLocalAgent,
  onRetryOffline,
}: Props) {
  const { t } = useTranslation()
  const actionable = filterActionable(entries)
  if (actionable.length === 0) return null

  const hasStale = actionable.some((e) => e.uiState === 'stale')
  const hasOffline = actionable.some((e) => e.uiState === 'offline')
  const showSwitch =
    !!localDaemonAgent &&
    !!onSwitchToLocalAgent &&
    (hasStale || actionable.length > 0)
  const showRetry = hasOffline && !!onRetryOffline

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-soft px-3 py-2 text-[12px] text-muted-foreground"
      data-testid="engaged-agent-offline-banner"
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
      <span className="min-w-0 flex-1">{bannerMessage(actionable, t)}</span>
      <span className="flex shrink-0 items-center gap-2">
        {showRetry ? (
          <button
            type="button"
            className="text-ink-2 hover:text-foreground underline-offset-2 hover:underline"
            onClick={onRetryOffline}
          >
            {t('chat.sessionAgent.retryConnection', 'Retry connection')}
          </button>
        ) : null}
        {showSwitch && localDaemonAgent ? (
          <button
            type="button"
            className="text-ink-2 hover:text-foreground underline-offset-2 hover:underline"
            onClick={() => onSwitchToLocalAgent(localDaemonAgent)}
          >
            {t('chat.sessionAgent.switchToLocal')}
          </button>
        ) : null}
        {actionable.length === 1 ? (
          <button
            type="button"
            className="text-ink-2 hover:text-foreground underline-offset-2 hover:underline"
            onClick={() => onRemoveAgent(actionable[0].agent.id)}
          >
            {t('chat.sessionAgent.removeMention')}
          </button>
        ) : (
          <button
            type="button"
            className="text-ink-2 hover:text-foreground underline-offset-2 hover:underline"
            onClick={() => {
              for (const e of actionable) onRemoveAgent(e.agent.id)
            }}
          >
            {t('chat.sessionAgent.removeAllOffline')}
          </button>
        )}
      </span>
    </div>
  )
}

export function pillSuffixForUiState(
  uiState: SessionAgentUiState,
  t: (key: string, fallback: string) => string,
): string | null {
  switch (uiState) {
    case 'offline':
      return t('chat.sessionAgent.pillOffline', 'Offline')
    case 'stale':
      return t('chat.sessionAgent.pillStale', 'Rebind required')
    case 'connecting':
      return t('chat.sessionAgent.pillConnecting', 'Connecting…')
    default:
      return null
  }
}

export function dotClassesForUiState(uiState: SessionAgentUiState): {
  color: string
  pulse: boolean
} {
  switch (uiState) {
    case 'ready':
      return { color: 'bg-emerald-500', pulse: false }
    case 'connecting':
      return { color: 'bg-amber-400', pulse: false }
    case 'stale':
      return { color: 'bg-red-500', pulse: false }
    case 'offline':
    default:
      return { color: 'bg-muted-foreground/40', pulse: false }
  }
}
