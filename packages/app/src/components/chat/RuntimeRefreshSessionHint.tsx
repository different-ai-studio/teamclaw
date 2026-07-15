import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { formatRuntimeRefreshChangeKinds } from '@/lib/workspace-runtime-refresh-labels'
import { useWorkspaceRuntimeRefreshStore } from '@/stores/workspace-runtime-refresh'

export function RuntimeRefreshSessionHint() {
  const { t } = useTranslation()
  const refresh = useWorkspaceRuntimeRefreshStore((s) => s.refresh)
  const isApplying = useWorkspaceRuntimeRefreshStore((s) => s.isApplying)
  const applyChanges = useWorkspaceRuntimeRefreshStore((s) => s.applyChanges)

  if (
    refresh?.status !== 'pending' &&
    refresh?.status !== 'failed'
  ) {
    return null
  }
  if (refresh.recommended_action !== 'apply_changes') {
    return null
  }

  const kindsLabel = formatRuntimeRefreshChangeKinds(refresh.change_kinds)

  return (
    <div
      className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-border/60 bg-paper px-3 py-2 text-[12.5px] text-ink-2 shadow-sm"
      data-testid="runtime-refresh-session-hint"
    >
      <p className="min-w-0 flex-1">
        {kindsLabel
          ? t('chat.runtimeRefresh.sessionHintKinds', 'Reload the agent to pick up {{kinds}}.', {
              kinds: kindsLabel,
            })
          : t(
              'chat.runtimeRefresh.sessionHint',
              'Reload the agent runtime to pick up workspace changes.',
            )}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 gap-1 text-[12px]"
        disabled={isApplying}
        onClick={() => void applyChanges()}
      >
        <RefreshCw className="h-3 w-3" />
        {t('workspace.runtimeRefresh.apply', 'Apply changes')}
      </Button>
    </div>
  )
}
