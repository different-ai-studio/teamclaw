import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Plus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { getBackend } from '@/lib/backend'
import { formatActorRemoveError } from '@/lib/actor-remove-error'
import { useActorsForTeam, type ActorRow as ActorRowData } from '@/components/panel/ActorsView'
import { InviteActorDialog } from '@/components/sidebar/InviteActorDialog'
import { ActorRow } from '@/components/sidebar/ActorRow'
import { getLocalDaemonAgent } from '@/lib/daemon-agent-admin'
import { ActorDetailDialog } from '@/components/sidebar/ActorDetailDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useUIStore } from '@/stores/ui'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { cn } from '@/lib/utils'
import { getRecentContactActors } from '@/components/sidebar/sidebar-list-helpers'

export function ActorsSection() {
  const { t } = useTranslation()
  const collapsed = useUIStore((s) => s.actorsSectionCollapsed)
  const toggle = useUIStore((s) => s.toggleActorsSection)
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const { actors, loading, refetch, teamId } = useActorsForTeam()
  const defaultAgentId = useMemberPreferencesStore((s) => s.defaultAgentId)
  const ensureDefaultAgentLoaded = useMemberPreferencesStore((s) => s.ensureLoaded)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [detailFor, setDetailFor] = React.useState<ActorRowData | null>(null)
  const [removeFor, setRemoveFor] = React.useState<ActorRowData | null>(null)
  const [removing, setRemoving] = React.useState(false)

  React.useEffect(() => {
    if (teamId) void ensureDefaultAgentLoaded(teamId)
  }, [teamId, ensureDefaultAgentLoaded])

  const [localDaemonAgentId, setLocalDaemonAgentId] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!teamId) { setLocalDaemonAgentId(null); return }
    let cancelled = false
    void getLocalDaemonAgent(teamId).then((a) => { if (!cancelled) setLocalDaemonAgentId(a?.id ?? null) })
    return () => { cancelled = true }
  }, [teamId])

  // Live agent presence (online/offline) overlays the server's last_active_at so
  // an agent appears/reorders in RECENTS the instant it connects.
  const presence = useActorPresenceStore((s) => s.byActorId)
  const recentActors = React.useMemo(
    () => getRecentContactActors(actors, defaultAgentId, presence).filter((a) => a.id !== localDaemonAgentId),
    [actors, defaultAgentId, presence, localDaemonAgentId],
  )

  const handleSelect = (actor: ActorRowData) => {
    setFilter({
      kind: 'actor',
      actorId: actor.id,
      displayName: actor.display_name,
      actorType: actor.actor_type,
    })
  }

  const handleCopyName = async (actor: ActorRowData) => {
    try {
      await navigator.clipboard.writeText(actor.display_name)
      toast.success(t('actors.copiedName', 'Copied name'))
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const handleCopyId = async (actor: ActorRowData) => {
    try {
      await navigator.clipboard.writeText(actor.id)
      toast.success(t('actors.copiedId', 'Copied actor ID'))
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const confirmRemove = async () => {
    if (!removeFor || !teamId) return
    setRemoving(true)
    try {
      await getBackend().teams.removeTeamActor(teamId, removeFor.id)
      toast.success(t('actors.removed', 'Removed from team'))
      setRemoveFor(null)
      refetch()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      toast.error(formatActorRemoveError(msg, t))
    } finally {
      setRemoving(false)
    }
  }

  const removeIsAgent = removeFor?.actor_type === 'agent'

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={toggle}
          className="group flex flex-1 items-center gap-1.5 rounded-md px-[9px] py-1 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="h-[10px] w-[10px]" /> : <ChevronDown className="h-[10px] w-[10px]" />}
          <span>{t('sidebar.actorsSection', 'Recents')}</span>
          {recentActors.length > 0 && (
            <span className="font-mono font-normal normal-case tracking-normal text-faint/80">
              · {recentActors.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setFilter({ kind: 'actors' }) }}
          className={cn(
            'rounded-md p-0.5 text-faint hover:bg-selected/60 hover:text-foreground',
            filter.kind === 'actors' && 'bg-selected text-foreground',
          )}
          title={t('actors.viewAll', 'View all actors')}
          aria-label={t('actors.viewAll', 'View all actors')}
        >
          <Users className="h-[11px] w-[11px]" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setInviteOpen(true) }}
          className="rounded-md p-0.5 text-faint hover:bg-selected/60 hover:text-foreground"
          title={t('invite.title', 'Invite to team')}
          aria-label={t('invite.title', 'Invite to team')}
        >
          <Plus className="h-[11px] w-[11px]" />
        </button>
      </div>
      <InviteActorDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <ActorDetailDialog
        actor={detailFor}
        teamId={teamId}
        onOpenChange={(open) => { if (!open) setDetailFor(null) }}
        onRemoved={refetch}
      />
      <AlertDialog open={!!removeFor} onOpenChange={(open) => { if (!open) setRemoveFor(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removeIsAgent
                ? t('actors.removeConfirm.titleAgent', 'Remove agent?')
                : t('actors.removeConfirm.titleMember', 'Remove member?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('actors.removeConfirm.body', 'Remove {{name}} from the team. This cannot be undone.', { name: removeFor?.display_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove} disabled={removing}>
              {t('actors.removeConfirm.cta', 'Remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {!collapsed && (
        <div className="flex flex-col">
          {loading && (
            <div className="px-[9px] py-1 text-[12px] text-faint">{t('actors.loading', 'Loading actors...')}</div>
          )}
          {!loading && recentActors.length === 0 && (
            <div className="px-[9px] py-1 text-[12px] text-faint">{t('actors.noRecentContacts', 'No recent contacts')}</div>
          )}
          {recentActors.map((actor) => (
            <ActorRow
              key={actor.id}
              actor={actor}
              active={filter.kind === 'actor' && filter.actorId === actor.id}
              isDefault={actor.id === defaultAgentId}
              onSelect={handleSelect}
              onViewDetail={setDetailFor}
              onCopyName={handleCopyName}
              onCopyId={handleCopyId}
              onRequestRemove={setRemoveFor}
            />
          ))}
        </div>
      )}
    </div>
  )
}
