import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Bot } from 'lucide-react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { useTeamPermissions } from '@/lib/team-permissions'
import { useActorDirectory } from '@/stores/actor-directory-store'

const NONE_VALUE = '__none__'

/**
 * Team-wide default agent picker (shown in team settings).
 *
 * Only owner/admin can edit the value; other roles see a read-only notice.
 * The agent list is filtered to team-visible agents only (the backend enforces
 * this constraint as well).
 */
export function TeamDefaultAgentConfig() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const { canManageTeam } = useTeamPermissions()

  const teamDefaultAgentId = useMemberPreferencesStore((s) => s.teamDefaultAgentId)
  const teamDefaultLoading = useMemberPreferencesStore((s) => s.teamDefaultLoading)
  const loadTeamDefaultAgent = useMemberPreferencesStore((s) => s.loadTeamDefaultAgent)
  const setTeamDefaultAgent = useMemberPreferencesStore((s) => s.setTeamDefaultAgent)

  const { actors } = useActorDirectory()

  // Load team default on mount / team change
  React.useEffect(() => {
    if (teamId) void loadTeamDefaultAgent(teamId)
  }, [teamId, loadTeamDefaultAgent])

  // Filter to team-visible agents only
  const teamAgents = React.useMemo(
    () => actors.filter((a) => a.actor_type === 'agent' && a.visibility === 'team'),
    [actors],
  )

  const handleChange = React.useCallback(
    async (value: string) => {
      if (!teamId) return
      const agentId = value === NONE_VALUE ? null : value
      await setTeamDefaultAgent(teamId, agentId)
    },
    [teamId, setTeamDefaultAgent],
  )

  return (
    <section className="rounded-xl border border-border-soft bg-panel p-4">
      <div className="mb-3 flex items-start gap-3">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="space-y-0.5">
          <h4 className="text-[13.5px] font-semibold">
            {t('settings.team.defaultAgent', '团队默认 Agent')}
          </h4>
          <p className="text-[12px] leading-5 text-muted-foreground">
            {t(
              'settings.team.defaultAgentDesc',
              '团队成员未设置个人默认 Agent 时，将使用此 Agent。',
            )}
          </p>
        </div>
      </div>

      {canManageTeam ? (
        <Select
          disabled={teamDefaultLoading || !teamId}
          value={teamDefaultAgentId ?? NONE_VALUE}
          onValueChange={(v) => void handleChange(v)}
        >
          <SelectTrigger className="h-9 text-[13px]">
            <SelectValue
              placeholder={t('settings.team.defaultAgentPlaceholder', '选择团队默认 Agent（可选）')}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>
              <span className="text-muted-foreground">
                {t('settings.team.defaultAgentPlaceholder', '选择团队默认 Agent（可选）')}
              </span>
            </SelectItem>
            {teamAgents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="text-[12px] text-muted-foreground">
          {t('settings.team.defaultAgentReadOnly', '仅团队 owner/admin 可编辑')}
        </p>
      )}
    </section>
  )
}
