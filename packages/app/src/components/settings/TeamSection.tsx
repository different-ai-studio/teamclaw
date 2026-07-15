import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Users, Loader2, AlertCircle } from 'lucide-react'

import { TeamGitConfig } from './team/TeamGitConfig'
import { TeamOssSyncStatus } from './team/TeamOssSyncStatus'
import { TeamShareSection } from './team/TeamShareSection'
import { TeamDefaultAgentConfig } from './team/TeamDefaultAgentConfig'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  useTeamShareStore,
  isShareModeLocked,
  type ShareStatus,
  type ShareMode,
} from '@/stores/team-share'
import { isTauri } from '@/lib/utils'
import { useTeamPermissions } from '@/lib/team-permissions'

// ─── Section Header ──────────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType
  title: string
  description: string
  iconColor?: string
}) {
  return (
    <div className="mb-6 flex items-start gap-4">
      <div className="rounded-[14px] border border-border-soft bg-panel p-3">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-[15px] font-semibold tracking-normal">{title}</h3>
        <p className="mt-1 text-[12.5px] text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

// ─── Missing prerequisite notice ─────────────────────────────────────────────
// Shown when team-share is not yet configured but we lack a team and/or workspace
// to target. Previously this case fell through to the legacy Git config form,
// which was misleading — surface the actual missing prerequisite instead.

function MissingPrereqNotice({
  teamId,
  workspacePath,
}: {
  teamId: string | null
  workspacePath: string | null
}) {
  const { t } = useTranslation()

  return (
    <section className="rounded-xl border border-border-soft bg-panel p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1.5">
          <h4 className="text-[13.5px] font-semibold">
            {t('settings.team.prereqTitle', '暂无法配置团队共享')}
          </h4>
          {!teamId && (
            <p className="text-[12px] leading-5 text-muted-foreground">
              {t(
                'settings.team.prereqNoTeam',
                '尚未创建或选择团队，请先创建/选择一个团队后再配置团队共享。',
              )}
            </p>
          )}
          {!workspacePath && (
            <p className="text-[12px] leading-5 text-muted-foreground">
              {t(
                'settings.team.prereqNoWorkspace',
                'workspacePath 为空，请先打开一个工作区。',
              )}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamSection() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const refreshShare = useTeamShareStore((s) => s.refresh)
  const { isOwner } = useTeamPermissions()

  // Route from the FC refresh result — never from a stale zustand snapshot left
  // over from another team or a prior session (that was showing Git "Connected"
  // while share_mode was unset on the server).
  const [resolvedShare, setResolvedShare] = React.useState<
    ShareStatus | 'pending' | 'idle'
  >('idle')
  React.useEffect(() => {
    if (!teamId || !workspacePath || !isTauri()) {
      setResolvedShare('idle')
      return
    }
    let cancelled = false
    setResolvedShare('pending')
    void refreshShare(teamId, workspacePath)
      .then((status) => {
        if (!cancelled) setResolvedShare(status)
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedShare({
            mode: null,
            gitRemoteUrl: null,
            gitAuthKind: null,
            enabledAt: null,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [teamId, workspacePath, refreshShare])

  const reResolveShareMode = React.useCallback(async () => {
    if (!teamId || !workspacePath || !isTauri()) return
    setResolvedShare('pending')
    try {
      const status = await refreshShare(teamId, workspacePath)
      setResolvedShare(status)
    } catch {
      setResolvedShare({
        mode: null,
        gitRemoteUrl: null,
        gitAuthKind: null,
        enabledAt: null,
      })
    }
  }, [teamId, workspacePath, refreshShare])

  const shareResolved = resolvedShare !== 'pending' && resolvedShare !== 'idle'
  const shareMode: ShareMode =
    resolvedShare !== 'pending' && resolvedShare !== 'idle'
      ? resolvedShare.mode
      : null

  // The FC-locked share mode ('oss' | 'managed_git' | 'custom_git' | null) is the
  // single source of truth for which sync surface to show. The daemon reads
  // share_mode from the Cloud API; when it is unset the team is not configured.
  const isOss = shareMode === 'oss'
  const isConfigured = isShareModeLocked(shareMode)

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Users}
        title={t('settings.team.title', 'Team Shared')}
        description={t(
          'settings.team.description',
          'Configure the team shared Git repository, local shared directory, and sync status',
        )}
      />

      {teamId && <TeamDefaultAgentConfig />}

      {teamId && workspacePath && !shareResolved ? (
        // Prereqs present but the FC share mode is still loading — show a spinner
        // rather than briefly flashing the wizard / git form before we know it.
        <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('settings.team.loadingShareMode', 'Loading team share status…')}
        </div>
      ) : !isConfigured ? (
        // New team (PR #213 no longer auto-creates team-share): show the onboarding
        // wizard so the owner can lock in oss / managed_git / custom_git. This needs a
        // team + workspace to target; without them, surface the missing prerequisite
        // instead of falling through to the (misleading) legacy Git config form.
        teamId && workspacePath ? (
          <TeamShareSection
            teamId={teamId}
            workspacePath={workspacePath}
            isOwner={isOwner}
            skipInitialRefresh
            onConfigured={reResolveShareMode}
          />
        ) : (
          <MissingPrereqNotice teamId={teamId} workspacePath={workspacePath} />
        )
      ) : isOss ? (
        <TeamOssSyncStatus />
      ) : (
        <TeamGitConfig />
      )}
    </div>
  )
}
