import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { Loader2 } from 'lucide-react'

import { TeamSecretEntry } from '@/components/settings/team/TeamSecretEntry'
import { linkDaemonTeamWorkspace } from '@/lib/daemon-local-client'
import { getFreshAccessToken } from '@/lib/auth/session-store'

type Phase = 'loading' | 'not_opened' | 'initializing' | 'secret_prompt' | 'error'

interface StatusResponse {
  mode: 'oss' | 'managed_git' | 'custom_git' | null
}

interface JoinResult {
  initialized: boolean
  shareMode: string | null
}

interface Props {
  teamId: string
  workspacePath: string
  onDone?: () => void
}

/**
 * Task 12 — JoinTeamFlow.
 *
 * After a user claims an invite, this component:
 *   1. Fetches `team_share_get_status` to learn if the owner has enabled a
 *      share mode.
 *   2. If `mode === null`, displays an "owner hasn't enabled share yet" notice.
 *   3. Otherwise auto-invokes `team_share_join_existing` which writes
 *      `oss_team_id`, `share_mode`, `git_remote_url`, `litellm_team_id` into
 *      the local `teamclaw.json` and creates `teamclaw-team/`.
 *   4. Prompts the user to paste their team secret via `TeamSecretEntry`.
 *
 * Per spec: the team secret must be entered manually. We do not auto-import.
 */
export function JoinTeamFlow({ teamId, workspacePath, onDone }: Props) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('loading')
  const [mode, setMode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const accessToken = await getFreshAccessToken()
        const status = await invoke<StatusResponse>('team_share_get_status', {
          teamId,
          workspacePath,
          accessToken,
        })
        if (cancelled) return
        if (status?.mode == null) {
          setPhase('not_opened')
          return
        }
        setPhase('initializing')
        const res = await invoke<JoinResult>('team_share_join_existing', {
          teamId,
          workspacePath,
          accessToken,
        })
        if (cancelled) return
        if (!res.initialized) {
          setPhase('not_opened')
          return
        }
        // Materialize the daemon's global dir + workspace symlink now
        // (best-effort) so the synced directory exists immediately rather than
        // waiting for the daemon's next start or the first runtime.
        await linkDaemonTeamWorkspace(workspacePath)
        if (cancelled) return
        setMode(res.shareMode)
        setPhase('secret_prompt')
      } catch (e) {
        if (cancelled) return
        setError(String(e))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [teamId, workspacePath])

  if (phase === 'loading' || phase === 'initializing') {
    return (
      <div className="flex items-center gap-2 text-sm text-neutral-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{phase === 'loading' ? t('onboarding.joinTeam.checkingStatus') : t('onboarding.joinTeam.initializing')}</span>
      </div>
    )
  }

  if (phase === 'not_opened') {
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('onboarding.joinTeam.joined')}</p>
        <p className="text-[12px] text-neutral-600">
          {t('onboarding.joinTeam.shareNotOpened')}
        </p>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <p className="text-[12px] text-red-500">{t('onboarding.joinTeam.failed', { error })}</p>
    )
  }

  // secret_prompt
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('onboarding.joinTeam.joinedWithMode', { mode: mode ?? t('onboarding.joinTeam.unknownMode') })}</p>
        <p className="text-[12px] text-neutral-600">
          {t('onboarding.joinTeam.enterSecret')}
        </p>
      </div>
      <TeamSecretEntry teamId={teamId} workspacePath={workspacePath} onSaved={onDone} />
    </div>
  )
}
