import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatRuntimeRefreshChangeKinds, runtimeRefreshNeedsBanner } from '@/lib/workspace-runtime-refresh-labels'
import { useWorkspaceRuntimeRefreshStore } from '@/stores/workspace-runtime-refresh'

export function RuntimeRefreshWorkspaceBanner() {
  const { t } = useTranslation()
  const refresh = useWorkspaceRuntimeRefreshStore((s) => s.refresh)
  const isApplying = useWorkspaceRuntimeRefreshStore((s) => s.isApplying)
  const applyError = useWorkspaceRuntimeRefreshStore((s) => s.applyError)
  const applyChanges = useWorkspaceRuntimeRefreshStore((s) => s.applyChanges)

  if (!runtimeRefreshNeedsBanner(refresh?.status)) {
    return null
  }

  const kindsLabel = formatRuntimeRefreshChangeKinds(refresh?.change_kinds ?? [])
  const showApply =
    refresh?.recommended_action === 'apply_changes' &&
    refresh.status !== 'applying' &&
    !isApplying
  const failed = refresh?.status === 'failed'
  const applying = refresh?.status === 'applying' || isApplying

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-3 border-b px-4 py-2.5 text-[13px]',
        failed
          ? 'border-destructive/30 bg-destructive/5 text-destructive'
          : 'border-border/60 bg-paper text-ink-2',
      )}
      data-testid="runtime-refresh-workspace-banner"
    >
      <AlertCircle
        className={cn('h-4 w-4 shrink-0', failed ? 'text-destructive' : 'text-muted-foreground')}
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {failed
            ? t('workspace.runtimeRefresh.failedTitle', 'Runtime refresh failed')
            : applying
              ? t('workspace.runtimeRefresh.applyingTitle', 'Applying workspace changes…')
              : t('workspace.runtimeRefresh.pendingTitle', 'Workspace changes need a reload')}
        </p>
        <p className="text-[12px] text-muted-foreground">
          {kindsLabel
            ? t('workspace.runtimeRefresh.pendingKinds', 'Pending: {{kinds}}', { kinds: kindsLabel })
            : t(
                'workspace.runtimeRefresh.pendingGeneric',
                'Configuration or skills changed outside the running agent.',
              )}
          {refresh?.auto_apply_blocked_by_active_runtime
            ? ` ${t(
                'workspace.runtimeRefresh.blockedByActive',
                'An agent runtime is active — apply reloads when you confirm.',
              )}`
            : null}
        </p>
        {(applyError || refresh?.last_error) && (
          <p className="mt-1 text-[12px] text-destructive">
            {applyError ?? refresh?.last_error}
          </p>
        )}
      </div>
      {showApply && (
        <Button
          size="sm"
          variant={failed ? 'destructive' : 'default'}
          className="gap-1.5 shrink-0"
          onClick={() => void applyChanges()}
          data-testid="runtime-refresh-apply"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t('workspace.runtimeRefresh.apply', 'Apply changes')}
        </Button>
      )}
      {applying && (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      )}
    </div>
  )
}
