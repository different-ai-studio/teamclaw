import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Filter, Loader2, Plus, Search, Sparkles, Star, User as UserIcon, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { InviteActorDialog } from '@/components/sidebar/InviteActorDialog'
import { ActorDetailDialog } from '@/components/sidebar/ActorDetailDialog'
import { ActorContextMenu } from '@/components/sidebar/ActorContextMenu'
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
import { getBackend } from '@/lib/backend'
import { formatActorRemoveError } from '@/lib/actor-remove-error'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { actorAvatarColor } from '@/lib/actor-color'
import { formatRelativeTimeShort } from '@/lib/date-format'
import { externalSourceLabel } from '@/lib/external-actor-source'
import { encodeActorTarget } from '@/lib/tabs/actor-target'
import { useTabsStore } from '@/stores/tabs'
import { useUIStore } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import {
  useActorDirectory,
  isActorOnline,
  resolveActorOnlineStatus,
  type ActorRow,
} from '@/stores/actor-directory-store'
import { useCurrentTeamStore } from '@/stores/current-team'

// The actor directory now lives in a single reactive store
// (`@/stores/actor-directory-store`). These re-exports keep the historical
// import sites (`@/components/panel/ActorsView`) working unchanged.
export { isActorOnline }
export type { ActorRow }
export type { UseActorDirectoryResult as UseActorsForTeamResult } from '@/stores/actor-directory-store'
export const useActorsForTeam = useActorDirectory

/**
 * `all` deliberately means "everyone on the team" — members and agents — and NOT
 * external gateway contacts. A team that talks to customers over WeCom
 * accumulates one external actor per person who ever wrote in, which buried the
 * actual teammates. They are one filter click away instead.
 */
export type ActorTypeFilter = 'all' | 'agent' | 'member' | 'external'

/** Whether a row survives the type filter. Exported so the rule is unit-testable
 *  without driving the filter popover. */
export function matchesActorTypeFilter(
  actorType: ActorRow['actor_type'],
  filter: ActorTypeFilter,
): boolean {
  if (filter === 'all') return actorType !== 'external'
  return actorType === filter
}

const actorNameCollator = new Intl.Collator(['zh-Hans-CN', 'en'], {
  sensitivity: 'base',
  numeric: true,
})

function ActorRowView({
  actor,
  onOpen,
  onViewProfile,
  onRequestRemove,
}: {
  actor: ActorRow
  onOpen: (actor: ActorRow) => void
  onViewProfile: (actor: ActorRow) => void
  onRequestRemove: (actor: ActorRow) => void
}) {
  const { t } = useTranslation()
  const isAgent = actor.actor_type === 'agent'
  const isExternal = actor.actor_type === 'external'
  const isDefaultAgent = useMemberPreferencesStore((s) => isAgent && s.defaultAgentId === actor.id)
  // Members: heartbeat-based — last_active_at within 5min.
  // Agents: authoritative MQTT presence from actor-presence-store
  // (daemon LWT flips this to offline within seconds of disconnect).
  // For an agent with no presence entry at all (daemon never connected
  // since the app launched), fall back to last_active_at so freshly-loaded
  // sessions don't show every agent as gray during the first second.
  // Subscribe so agent rows re-render when MQTT presence / local cache changes.
  useActorPresenceStore((s) => (isAgent ? s.byActorId[actor.id]?.online : undefined))
  const currentMemberActorId = useCurrentTeamStore((s) => s.currentMember?.id ?? null)
  // External contacts resolve to offline inside resolveActorOnlineStatus — they
  // publish no presence of their own.
  const online = resolveActorOnlineStatus(actor, { currentMemberActorId })
  const status = actor.actor_type === 'member' ? actor.member_status : actor.agent_status
  const initial = actor.display_name?.trim().slice(0, 1).toUpperCase() || ''
  const colors = actorAvatarColor(actor.id)
  const lastActive = actor.last_active_at ? formatRelativeTimeShort(new Date(actor.last_active_at)) : ''
  // Subtitle: an agent shows "Team Agent" / "Personal Agent" (the standalone
  // "Agent" pill was dropped — it ate width that long display names need — so
  // this line is now the only place the agent/role distinction is visible).
  // A member shows their team role. An agent with unknown visibility
  // (offline-cache first paint, which doesn't carry it) falls back to "Agent".
  const subtitle = isAgent
    ? actor.visibility === 'personal'
      ? t('actors.visibility.personalAgent', 'Personal Agent')
      : actor.visibility === 'team'
        ? t('actors.visibility.teamAgent', 'Team Agent')
        : t('actors.type.agent', 'Agent')
    : isExternal
      // Name the channel when we know it: for a WeCom contact whose nickname
      // never resolved, the raw `wo…` id above says nothing and this line is
      // the only thing that explains what the row is.
      ? (actor.source
        ? `${t('actors.type.external', 'External')} · ${externalSourceLabel(actor.source, t)}`
        : t('actors.type.external', 'External'))
      : actor.team_role
        ? t(`actors.role.${actor.team_role}`, actor.team_role)
        : t('actors.type.member', 'Team')

  const handleCopyName = async () => {
    try {
      await navigator.clipboard.writeText(actor.display_name)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(actor.id)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  return (
    <ActorContextMenu
      actor={actor}
      isDefault={isDefaultAgent}
      onViewDetail={onViewProfile}
      onCopyName={handleCopyName}
      onCopyId={handleCopyId}
      onRequestRemove={onRequestRemove}
    >
      <button
        type="button"
        onClick={() => onOpen(actor)}
        className="flex w-full items-center gap-2.5 border-b border-border-soft px-4 py-2.5 text-left hover:bg-selected focus:outline-none focus-visible:bg-selected"
      >
          <div className={cn(
            'relative flex h-10 w-10 shrink-0 items-center justify-center text-[16px] font-semibold text-white',
            isAgent ? 'rounded-[11px] ring-[1.5px] ring-coral' : 'rounded-full',
          )} style={{ backgroundColor: colors.bg, color: colors.fg }}>
            {initial || (isAgent ? <Sparkles className="h-4 w-4" /> : <UserIcon className="h-4 w-4" />)}
            <span className={cn(
              'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-background',
              isAgent ? 'bg-coral' : online ? 'bg-emerald-500' : 'bg-faint',
            )} aria-label={status ?? (online ? 'online' : 'offline')} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] font-semibold leading-[19px] text-foreground">{actor.display_name}</span>
              {isDefaultAgent && (
                <Star
                  className="h-3 w-3 shrink-0 fill-coral text-coral"
                  aria-label={t('actors.defaultAgent', 'Default agent')}
                />
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11.5px] leading-[18px] text-muted-foreground">
              {subtitle && <span className="truncate">{subtitle}</span>}
              {subtitle && status && <span className="text-faint">·</span>}
              {status && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-faint" aria-label={status} />}
            </div>
          </div>
          {lastActive && <span className="ml-2 shrink-0 font-mono text-[11.5px] text-faint">{lastActive}</span>}
      </button>
    </ActorContextMenu>
  )
}

function FilterRow({
  active,
  count,
  dotClassName,
  label,
  onSelect,
}: {
  active: boolean
  count: number
  dotClassName?: string
  label: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[8px] px-3 py-1.5 text-left text-[12.5px] font-semibold text-foreground',
        active && 'bg-coral-soft/35',
      )}
    >
      {dotClassName ? <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClassName)} /> : <span className="w-2" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-mono text-[11.5px] font-normal text-faint">{count}</span>
      {active && <Check className="h-3.5 w-3.5 text-coral" />}
    </button>
  )
}

export function ActorsView() {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'
  const { actors, loading, error, teamId, refetch } = useActorsForTeam()
  const ensureDefaultAgentLoaded = useMemberPreferencesStore((s) => s.ensureLoaded)

  React.useEffect(() => {
    if (teamId) void ensureDefaultAgentLoaded(teamId)
  }, [teamId, ensureDefaultAgentLoaded])

  // Opening the "All actors" panel kicks one background reconcile so a teammate's
  // recent change (e.g. an agent flipped team→personal, which the server already
  // filters out for other viewers) shows up immediately instead of lingering until
  // the next 60s periodic poll. The panel only mounts while the sidebar filter is
  // `actors` (SidebarSecondColumn), so this fires each time it's shown. refetch()
  // keeps the current list visible — no spinner — and swaps in the fresh result
  // when it lands. The very first mount is already covered by the store's initial
  // load (this extra call coalesces via the in-flight guard); reopens are where it
  // does real work.
  React.useEffect(() => {
    if (teamId) refetch()
  }, [teamId, refetch])
  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [filter, setFilter] = React.useState<ActorTypeFilter>('all')
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [detailFor, setDetailFor] = React.useState<ActorRow | null>(null)
  const [removeFor, setRemoveFor] = React.useState<ActorRow | null>(null)
  const [removing, setRemoving] = React.useState(false)

  const counts = React.useMemo(() => {
    const agent = actors.filter((actor) => actor.actor_type === 'agent').length
    const member = actors.filter((actor) => actor.actor_type === 'member').length
    const external = actors.filter((actor) => actor.actor_type === 'external').length
    // `all` is members + agents, matching what the unfiltered list renders.
    return { all: agent + member, agent, member, external }
  }, [actors])

  const visibleActors = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return actors
      .filter((actor) => {
        // Unfiltered means the team, not the address book: external gateway
        // contacts appear only under their own filter.
        if (!matchesActorTypeFilter(actor.actor_type, filter)) return false
        if (!normalizedQuery) return true
        return actor.display_name.toLowerCase().includes(normalizedQuery)
      })
      .sort((a, b) => actorNameCollator.compare(a.display_name, b.display_name))
  }, [actors, filter, query])

  const openTab = useTabsStore((s) => s.openTab)
  const enterActorDraft = useUIStore((s) => s.enterActorDraft)

  /**
   * Clicking a row. A teammate or an agent is someone you write to, so the click
   * opens a draft session addressed to them. An external contact is not
   * addressable from here — there is no session to start, only a profile to
   * read — so it opens its detail pane in the main column instead. This is what
   * used to drop the user into an empty draft aimed at a WeCom contact that
   * could never receive it.
   */
  const openActor = React.useCallback((actor: ActorRow) => {
    if (actor.actor_type === 'external') {
      openTab({ type: 'native', target: encodeActorTarget(actor.id), label: actor.display_name })
      return
    }
    enterActorDraft({ id: actor.id, displayName: actor.display_name, kind: actor.actor_type })
  }, [enterActorDraft, openTab])

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

  const renderBody = () => {
    if (loading) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="mb-2 h-5 w-5 animate-spin" />
          <span>{t('actors.loading', 'Loading actors...')}</span>
        </div>
      )
    }

    if (error) {
      return (
        <div className="px-4 py-3 text-sm text-destructive">{t('actors.error', 'Failed to load actors')}</div>
      )
    }

    if (actors.length === 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
          <Users className="mb-2 h-8 w-8 text-muted-foreground" />
          <span>{t('actors.empty', 'No actors in this team yet')}</span>
        </div>
      )
    }

    if (visibleActors.length === 0) {
      return (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('actors.noMatches', 'No matching actors')}
        </div>
      )
    }

    return (
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {visibleActors.map((a) => (
          <ActorRowView
            key={a.id}
            actor={a}
            onOpen={openActor}
            // An external contact's profile IS the pane the row opens; sending
            // the context-menu entry to the dialog too would be two different
            // answers to "show me this contact".
            onViewProfile={a.actor_type === 'external' ? openActor : setDetailFor}
            onRequestRemove={setRemoveFor}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="border-b border-border px-4 py-3" data-tauri-drag-region>
        <div className="flex items-center gap-2">
          {sidebarCollapsed && (
            <div className="flex items-center gap-1 shrink-0">
              <TrafficLights />
              <SidebarCollapseToggle />
            </div>
          )}
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold leading-7 text-foreground">
            {t('actors.allTitle', 'All actors')}
            <span className="ml-2 font-mono text-[12.5px] font-normal text-faint">· {visibleActors.length}</span>
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn('h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground', searchOpen && 'bg-selected text-foreground')}
            aria-label={t('common.search', 'Search')}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search className="h-4 w-4" />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
                aria-label={t('actors.filterType', 'Filter by type')}
              >
                <Filter className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[260px] rounded-[14px] border-border bg-paper p-2 shadow-[0_18px_45px_-28px_rgba(26,26,20,0.45)]">
              <div className="px-3 pb-1 pt-1 text-[11.5px] font-semibold text-faint">{t('actors.typeFilterLabel', 'Type')}</div>
              <FilterRow active={filter === 'all'} count={counts.all} label={t('common.all', 'All')} onSelect={() => setFilter('all')} />
              <FilterRow active={filter === 'agent'} count={counts.agent} dotClassName="bg-coral" label={t('actors.type.agent', 'Agent')} onSelect={() => setFilter('agent')} />
              <FilterRow active={filter === 'member'} count={counts.member} dotClassName="bg-emerald-500" label={t('actors.type.member', 'Team')} onSelect={() => setFilter('member')} />
              {/* Only offered when the team actually has gateway contacts —
                  otherwise it is a row that can only ever say 0. */}
              {counts.external > 0 && (
                <FilterRow active={filter === 'external'} count={counts.external} dotClassName="bg-sky-500" label={t('actors.type.external', 'External')} onSelect={() => setFilter('external')} />
              )}
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
            aria-label={t('actors.invite', 'Invite actor')}
            onClick={() => setInviteOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {searchOpen && (
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('actors.searchPlaceholder', 'Search actors')}
            className="mt-2 h-8 w-full rounded-[8px] border border-border bg-paper px-3 text-[12.5px] outline-none placeholder:text-faint focus:border-border"
          />
        )}
      </div>
      {renderBody()}
      <InviteActorDialog open={inviteOpen} onOpenChange={setInviteOpen} />
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
            <AlertDialogAction onClick={() => void confirmRemove()} disabled={removing}>
              {t('actors.removeConfirm.cta', 'Remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ActorDetailDialog
        actor={detailFor}
        teamId={teamId}
        onOpenChange={(open) => { if (!open) setDetailFor(null) }}
        onRemoved={refetch}
      />
    </div>
  )
}
