import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTeamShareStore, type ShareMode } from '@/stores/team-share'
import { useAuthStore } from '@/stores/auth-store'
import { isNotLoggedInError } from '@/lib/fc-error'
import { EnableShareWizard } from './EnableShareWizard'

interface Props {
  teamId: string
  workspacePath: string
  isOwner: boolean
  /** Parent already fetched share-mode (e.g. TeamSection) — skip duplicate refresh. */
  skipInitialRefresh?: boolean
  /** Called after the enable wizard succeeds so the parent can route to the detail view. */
  onConfigured?: () => void | Promise<void>
}

// OSS is a brand token; the git modes resolve through i18n at render time.
const MODE_LABEL_KEY: Record<Exclude<ShareMode, null>, string | null> = {
  oss: null,
  managed_git: 'settings.teamShare.modeManagedGitLabel',
  custom_git: 'settings.teamShare.modeCustomGitLabel',
}

/**
 * Team-share onboarding panel.
 *
 * States:
 *   - loading: spinner
 *   - mode === null: "团队共享未开通" + (owner) "开通" button → opens wizard
 *   - mode !== null: "已开通：{label}" — locked, no toggle
 */
export function TeamShareSection({
  teamId,
  workspacePath,
  isOwner,
  skipInitialRefresh = false,
  onConfigured,
}: Props) {
  const { t } = useTranslation()
  const status = useTeamShareStore((s) => s.status)
  const loading = useTeamShareStore((s) => s.loading)
  const lastError = useTeamShareStore((s) => s.lastError)
  const refresh = useTeamShareStore((s) => s.refresh)
  const isLoggedIn = useAuthStore((s) => s.session !== null)

  const [wizardOpen, setWizardOpen] = useState(false)

  useEffect(() => {
    if (skipInitialRefresh || !teamId || !workspacePath || !isLoggedIn) return
    void refresh(teamId, workspacePath)
  }, [teamId, workspacePath, isLoggedIn, refresh, skipInitialRefresh])

  // Don't echo the backend's not-logged-in error in red — it's an expected
  // signed-out state, handled with a friendly message instead.
  const visibleError =
    lastError && !isNotLoggedInError(lastError) ? lastError : null

  return (
    <section className="rounded-xl border border-border-soft bg-panel p-4 space-y-3">
      <div>
        <h4 className="text-[13.5px] font-semibold">
          {t('settings.teamShare.title')}
        </h4>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {t('settings.teamShare.lockSubtitle')}
        </p>
      </div>

      {!isLoggedIn ? (
        <p className="text-[12.5px] text-muted-foreground">
          {t('settings.teamShare.signInRequired')}
        </p>
      ) : loading ? (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('common.loading')}
        </div>
      ) : status.mode === null ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-foreground">
            {t('settings.teamShare.notEnabled')}
          </p>
          {isOwner && (
            <Button size="sm" onClick={() => setWizardOpen(true)}>
              {t('settings.teamShare.enable')}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-[12.5px]">
            {t('settings.teamShare.enabledPrefix')}
            <span className="ml-1 font-medium">
              {MODE_LABEL_KEY[status.mode]
                ? t(MODE_LABEL_KEY[status.mode]!)
                : 'OSS'}
            </span>
          </p>
          {status.gitRemoteUrl && (
            <p className="text-[12px] text-muted-foreground break-all">
              {t('settings.teamShare.repositoryPrefix')}
              {status.gitRemoteUrl}
            </p>
          )}
          {status.globalPath && (
            <p className="text-[12px] text-muted-foreground break-all">
              {t('settings.teamShare.globalSyncDirPrefix')}
              <code className="font-mono">{status.globalPath}</code>
            </p>
          )}
          <p className="text-[12px] text-muted-foreground">
            {t('settings.teamShare.workspaceLinkPrefix')}
            <span className="ml-1">
              {status.linkStatus === 'symlink'
                ? `${t('settings.teamShare.linkStatus.linked')} ✓`
                : status.linkStatus === 'real_dir'
                  ? t('settings.teamShare.linkStatus.pendingMigration')
                  : t('settings.teamShare.linkStatus.unlinked')}
            </span>
          </p>
        </div>
      )}

      {visibleError && (
        <p className="text-[12px] text-red-500">{visibleError}</p>
      )}

      {isOwner && (
        <EnableShareWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          teamId={teamId}
          workspacePath={workspacePath}
          onSuccess={() => void onConfigured?.()}
        />
      )}
    </section>
  )
}
