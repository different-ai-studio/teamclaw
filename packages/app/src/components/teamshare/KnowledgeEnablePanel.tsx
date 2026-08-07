import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamShareStore, isShareModeLocked } from '@/stores/team-share'
import { useTeamPermissions } from '@/lib/team-permissions'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { humanizeFcError } from '@/lib/fc-error'
import { isTauri } from '@/lib/utils'

/**
 * Onboarding for team knowledge sync, shown in the Knowledge list column when
 * the team has not enabled it.
 *
 * There is no mode to choose any more — sync has exactly one backend — so this
 * is a single button rather than the three-way wizard it replaces. It lives
 * here rather than in Settings because this column IS the thing being enabled:
 * the state it is trying to fix ("no files, and no way to get any") is visible
 * on screen at the moment the user reads it.
 */
export function KnowledgeEnablePanel() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const { isOwner } = useTeamPermissions()
  const enableOss = useTeamShareStore((s) => s.enableOss)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const ready = Boolean(teamId && workspacePath && isTauri())

  async function handleEnable() {
    if (!teamId || !workspacePath || busy) return
    setBusy(true)
    setError(null)
    try {
      await enableOss(teamId, workspacePath)
      // enableOss materializes the shared dir; re-read so this column swaps to
      // the file browser without waiting for a section change.
      await loadSection('knowledge', { force: true })
    } catch (e) {
      setError(humanizeFcError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Bookmark className="h-5 w-5" />
      </span>
      <p className="text-[13px] font-medium text-foreground">
        {t('teamShare.enableTitle', 'Team knowledge sync is not enabled')}
      </p>
      <p className="max-w-[260px] text-[12.5px] leading-relaxed text-muted-foreground">
        {t(
          'teamShare.enableBody',
          'Turn it on to share documents across the team. Files sync encrypted; only members can read them.',
        )}
      </p>

      {!ready ? (
        <p className="text-[12px] text-muted-foreground">
          {t('teamShare.enableNeedsWorkspace', 'Open a team workspace first.')}
        </p>
      ) : isOwner ? (
        <>
          <Button size="sm" onClick={() => void handleEnable()} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('teamShare.enableAction', 'Enable sync')}
          </Button>
          <p className="text-[11.5px] text-muted-foreground">
            {t('teamShare.enableIrreversible', 'This cannot be turned off later.')}
          </p>
        </>
      ) : (
        <p className="text-[12px] text-muted-foreground">
          {t('teamShare.enableOwnerOnly', 'Ask a team owner to enable it.')}
        </p>
      )}

      {error && <p className="max-w-[280px] text-[12px] text-red-500">{error}</p>}
    </div>
  )
}

/** Whether the Knowledge column should offer onboarding instead of files. */
export function useKnowledgeNeedsEnabling(): boolean {
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const status = useTeamShareStore((s) => s.status)
  const refresh = useTeamShareStore((s) => s.refresh)
  const [resolved, setResolved] = React.useState<'pending' | 'ok' | 'failed'>('pending')

  // The zustand snapshot can be left over from another team, so re-read rather
  // than trusting it — showing "enable" to a team that already has it, or the
  // reverse, are both worse than a beat of nothing.
  React.useEffect(() => {
    if (!teamId || !workspacePath || !isTauri()) {
      setResolved('ok')
      return
    }
    let cancelled = false
    setResolved('pending')
    refresh(teamId, workspacePath).then(
      () => {
        if (!cancelled) setResolved('ok')
      },
      () => {
        if (!cancelled) setResolved('failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [teamId, workspacePath, refresh])

  // A refresh that FAILED must not read as "not enabled". `status.mode` is null
  // in both cases, so resolving on `.finally` made a transient FC/token/daemon
  // error hide an enabled team's whole document tree — and invite its owner to
  // "enable" it again, which rotates the team key.
  return resolved === 'ok' && !isShareModeLocked(status.mode)
}
