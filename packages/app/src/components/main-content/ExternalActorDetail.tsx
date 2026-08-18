import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronRight, Copy, MessageSquare, User as UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getBackend } from '@/lib/backend'
import { actorAvatarColor } from '@/lib/actor-color'
import { formatDate, formatRelativeTime } from '@/lib/date-format'
import { externalSourceLabel } from '@/lib/external-actor-source'
import { loadSessionIdsForActor } from '@/lib/session-by-actor'
import { useActorDirectory, type ActorRow } from '@/stores/actor-directory-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useUIStore } from '@/stores/ui'
import { useCurrentTeamStore } from '@/stores/current-team'

interface Props {
  actorId: string
}

/**
 * The main-column detail pane for an EXTERNAL actor — a gateway contact.
 *
 * Members and agents keep their dialog (`ActorDetailDialog`): those rows are
 * things you act on (start a session, re-invite, remove). An external contact is
 * something you read about, and the one useful action is opening a conversation
 * they took part in — which is a list, not a dialog's worth of buttons.
 */
export function ExternalActorDetail({ actorId }: Props) {
  const { t } = useTranslation()
  const { actors, teamId } = useActorDirectory()
  const sessionRows = useSessionListStore((s) => s.rows)
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)

  const fromDirectory = React.useMemo(
    () => actors.find((a) => a.id === actorId) ?? null,
    [actors, actorId],
  )
  // The directory row is enough to paint immediately, but `source` is
  // network-only (the libsql cache has no column for it), so a cold start has
  // the row without it. The single-actor fetch fills that in.
  const [fetched, setFetched] = React.useState<ActorRow | null>(null)
  React.useEffect(() => {
    setFetched(null)
    let cancelled = false
    void (async () => {
      try {
        const entry = await getBackend().actors.getActorDirectoryEntry(actorId)
        if (cancelled || !entry) return
        setFetched({
          id: entry.id,
          actor_type: 'external',
          display_name: entry.display_name || entry.id,
          avatar_url: entry.avatar_url ?? null,
          member_status: entry.member_status ?? null,
          agent_status: entry.agent_status ?? null,
          last_active_at: entry.last_active_at ?? null,
          created_at: entry.created_at ?? null,
          source: entry.source ?? null,
          source_id: entry.source_id ?? null,
        })
      } catch {
        // Best-effort enrichment; the directory row still renders.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [actorId])

  const actor: ActorRow | null = fetched ?? fromDirectory
  const source = fetched?.source ?? fromDirectory?.source ?? null
  const sourceId = fetched?.source_id ?? fromDirectory?.source_id ?? null

  // Sessions this contact took part in, intersected with the loaded session
  // list — the same approach as SessionContinueBanner, and the same limitation:
  // a session older than the loaded pages is not listed.
  const [participatingIds, setParticipatingIds] = React.useState<Set<string> | null>(null)
  React.useEffect(() => {
    setParticipatingIds(null)
    if (!teamId) return
    let cancelled = false
    void (async () => {
      const ids = await loadSessionIdsForActor(actorId, teamId)
      if (!cancelled) setParticipatingIds(ids)
    })()
    return () => {
      cancelled = true
    }
  }, [actorId, teamId])

  const sessions = React.useMemo(() => {
    if (!participatingIds) return []
    return sessionRows
      .filter((row) => participatingIds.has(row.id))
      .slice(0, 20)
  }, [participatingIds, sessionRows])

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(actorId)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  if (!actor) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t('actors.detail.notFound', 'This contact is no longer in the team directory.')}
      </div>
    )
  }

  const c = actorAvatarColor(actor.id)
  const lastActive = actor.last_active_at ? formatRelativeTime(new Date(actor.last_active_at)) : null

  const rows: Array<{ label: string; value: React.ReactNode; mono?: boolean }> = [
    { label: t('actors.detail.type', 'Type'), value: t('actors.type.external', 'External contact') },
    { label: t('actors.detail.source', 'Source'), value: externalSourceLabel(source, t) },
  ]
  if (sourceId) {
    rows.push({ label: t('actors.detail.sourceId', 'Source ID'), value: sourceId, mono: true })
  }
  if (actor.created_at) {
    rows.push({ label: t('actors.detail.firstSeen', 'First seen'), value: formatDate(actor.created_at) })
  }
  rows.push({
    label: t('actors.detail.lastActiveLabel', 'Last active'),
    value: lastActive ?? t('actors.detail.never', 'Never'),
    mono: true,
  })
  rows.push({ label: t('actors.detail.actorId', 'Actor ID'), value: actor.id, mono: true })
  if (currentTeamId) {
    rows.push({ label: t('actors.detail.teamId', 'Team ID'), value: currentTeamId, mono: true })
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-[640px] flex-col px-8 pb-10 pt-12">
        <div className="flex flex-col items-center text-center">
          <div
            className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full text-[38px] font-semibold shadow-[0_8px_22px_-18px_rgba(26,26,20,0.45)]"
            style={{ background: c.bg, color: c.fg }}
          >
            {actor.display_name?.slice(0, 1).toUpperCase() || <UserIcon className="h-9 w-9" />}
          </div>
          <div className="mt-5 max-w-full break-all text-[24px] font-bold leading-tight text-foreground">
            {actor.display_name}
          </div>
          <div className="mt-2 text-[14px] leading-5 text-muted-foreground">
            {t('actors.type.external', 'External contact')}
            {' · '}
            {externalSourceLabel(source, t)}
          </div>
          <p className="mt-4 max-w-[420px] text-[12px] leading-5 text-faint">
            {t(
              'actors.detail.externalNoSession',
              'Reachable only through the channel they wrote from.',
            )}
          </p>
        </div>

        <div className="mt-8 border-t border-border-soft pt-5">
          <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
            {t('actors.detail.details', 'Details')}
          </div>
          <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-5 gap-y-4 text-[13px] leading-5">
            {rows.map((row) => (
              <React.Fragment key={row.label}>
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd
                  className={
                    row.mono
                      ? 'min-w-0 break-all font-mono text-[12px] text-foreground'
                      : 'min-w-0 break-words text-foreground'
                  }
                >
                  {row.value}
                </dd>
              </React.Fragment>
            ))}
          </dl>
          <Button
            variant="outline"
            onClick={() => void copyId()}
            className="mt-5 h-9 rounded-[9px] border-border-soft bg-background text-[13px]"
          >
            <Copy className="h-4 w-4" />
            {t('actors.detail.copyId', 'Copy ID')}
          </Button>
        </div>

        <div className="mt-8 border-t border-border-soft pt-5">
          <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
            {t('actors.detail.sessions', 'Sessions')}
          </div>
          {sessions.length === 0 ? (
            <p className="text-[12.5px] leading-5 text-muted-foreground">
              {participatingIds === null
                ? t('common.loading', 'Loading…')
                : t('actors.detail.noSessions', 'No sessions from this contact yet.')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => void useUIStore.getState().switchToSession(session.id)}
                    className="flex w-full items-center gap-2.5 rounded-[10px] border border-border-soft bg-paper px-3 py-2.5 text-left transition-colors hover:bg-selected"
                  >
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {session.title || t('chat.untitledSession', '(untitled)')}
                      </span>
                      {session.last_message_preview && (
                        <span className="mt-0.5 block truncate text-[11.5px] leading-4 text-muted-foreground">
                          {session.last_message_preview}
                        </span>
                      )}
                    </span>
                    {session.last_message_at && (
                      <span className="shrink-0 font-mono text-[11px] text-faint">
                        {formatRelativeTime(new Date(session.last_message_at))}
                      </span>
                    )}
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
