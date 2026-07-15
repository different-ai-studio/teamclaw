/**
 * Shared disconnect affordance for OSS / Git team-share status panels.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Unlink } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTeamShareStore } from '@/stores/team-share'
import { useTeamPermissions } from '@/lib/team-permissions'
import { TEAMCLAW_DIR, TEAM_REPO_DIR } from '@/lib/build-config'
import { humanizeFcError } from '@/lib/fc-error'
import { cn, isTauri } from '@/lib/utils'

function SettingCard({
  children,
  className,
  ...rest
}: React.ComponentProps<'div'>) {
  return (
    <div className={cn('rounded-xl border bg-card p-5 transition-all', className)} {...rest}>
      {children}
    </div>
  )
}

export function TeamShareDisconnect({
  onDisconnected,
  className,
  variant = 'standalone',
  leading,
  trailingActions,
}: {
  onDisconnected?: () => void
  className?: string
  /** `footer` places Disconnect beside `trailingActions` (e.g. Sync Now). */
  variant?: 'standalone' | 'footer'
  leading?: React.ReactNode
  trailingActions?: React.ReactNode
}) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const disconnectShare = useTeamShareStore((s) => s.disconnect)
  const { isOwner } = useTeamPermissions()

  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const handleDisconnect = async () => {
    if (!isOwner) {
      toast.error(t('settings.teamShare.ownerOnlyDisconnect'))
      return
    }
    if (!teamId || !workspacePath) {
      toast.error(t('settings.team.noWorkspace', 'No workspace selected'))
      return
    }
    if (!isTauri()) {
      toast.error(t('settings.team.desktopOnly'))
      return
    }

    setBusy(true)
    try {
      await disconnectShare(teamId, workspacePath)
      setConfirmOpen(false)
      toast.success(t('settings.team.disconnectSuccess'), {
        description: t('settings.team.disconnectSuccessHint'),
      })
      onDisconnected?.()
    } catch (err) {
      toast.error(humanizeFcError(err))
    } finally {
      setBusy(false)
    }
  }

  const disconnectButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy || !workspacePath || !isOwner}
      onClick={() => setConfirmOpen((o) => !o)}
      className="shrink-0 gap-2 text-muted-foreground hover:text-destructive"
      aria-expanded={confirmOpen}
    >
      <Unlink className="h-3 w-3 shrink-0" />
      {t('settings.team.disconnect', 'Disconnect')}
    </Button>
  )

  const confirmPanel =
    confirmOpen &&
    (
      <SettingCard
        className="border-destructive/40 bg-destructive/5"
        data-testid="disconnect-confirm-panel"
      >
        <h4 className="text-[13px] font-semibold text-foreground">
          {t('settings.team.disconnectTitle')}
        </h4>
        <p className="mt-2 text-[13px] text-muted-foreground">
          {t('settings.team.disconnectConfirm', { teamRepoDir: TEAM_REPO_DIR })}
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {t('settings.team.disconnectDesc', {
            teamclawDir: TEAMCLAW_DIR,
            teamRepoDir: TEAM_REPO_DIR,
          })}
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmOpen(false)}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => void handleDisconnect()}
          >
            {busy
              ? t('settings.llm.disconnecting', 'Disconnecting...')
              : t('settings.team.confirmDisconnect', 'Disconnect')}
          </Button>
        </div>
      </SettingCard>
    )

  if (variant === 'footer') {
    return (
      <div className={className}>
        <div className="space-y-3 pt-2 border-t">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {leading}
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {disconnectButton}
              {trailingActions}
            </div>
          </div>
          {confirmPanel}
        </div>
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="flex justify-end">{disconnectButton}</div>
      {confirmPanel}
    </div>
  )
}
