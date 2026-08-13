import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Users, Loader2, AlertCircle } from 'lucide-react'

import { TeamOssSyncStatus } from './team/TeamOssSyncStatus'
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

function NotEnabledNotice() {
  const { t } = useTranslation()
  return (
    <div
      data-testid="not-enabled"
      className="flex items-start gap-2.5 rounded-[10px] border border-border-soft bg-panel px-3.5 py-3"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        {t(
          'settings.teamShare.enableMovedToKnowledge',
          'Team knowledge sync is not enabled. Turn it on from the Knowledge panel in the sidebar.',
        )}
      </p>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamSection() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const refreshShare = useTeamShareStore((s) => s.refresh)

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
          setResolvedShare({ mode: null, enabledAt: null })
        }
      })
    return () => {
      cancelled = true
    }
  }, [teamId, workspacePath, refreshShare])

  const shareResolved = resolvedShare !== 'pending' && resolvedShare !== 'idle'
  const shareMode: ShareMode =
    resolvedShare !== 'pending' && resolvedShare !== 'idle'
      ? resolvedShare.mode
      : null

  // The FC-locked share mode ('oss' | null) is the single source of truth for
  // which sync surface to show. The daemon reads share_mode from the Cloud API;
  // when it is unset the team is not configured.
  const isConfigured = isShareModeLocked(shareMode)

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Users}
        title={t('settings.team.title', 'Team Shared')}
        description={t(
          'settings.team.description',
          'Configure the team shared directory and sync status',
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
        // Onboarding moved to the Knowledge list column, which is where the
        // problem it solves is visible. Settings only reports state now — it
        // never had the context to explain what enabling would do.
        teamId && workspacePath ? (
          <NotEnabledNotice />
        ) : (
          <MissingPrereqNotice teamId={teamId} workspacePath={workspacePath} />
        )
      ) : (
        <TeamOssSyncStatus />
      )}
    </div>
  )
}
