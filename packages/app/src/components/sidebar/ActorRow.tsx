import { useTranslation } from 'react-i18next'
import { Sparkles, Star, User as UserIcon } from 'lucide-react'
import type { ActorRow as ActorRowData } from '@/components/panel/ActorsView'
import { resolveActorOnlineStatus } from '@/lib/actor-online'
import { ActorContextMenu } from '@/components/sidebar/ActorContextMenu'
import { actorAvatarColor } from '@/lib/actor-color'
import { cn } from '@/lib/utils'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { useCurrentTeamStore } from '@/stores/current-team'

interface Props {
  actor: ActorRowData
  active: boolean
  /** True when this actor is the current user's default agent (pinned + starred). */
  isDefault?: boolean
  onSelect: (actor: ActorRowData) => void
  onViewDetail: (actor: ActorRowData) => void
  onCopyName: (actor: ActorRowData) => void
  onCopyId: (actor: ActorRowData) => void
  onRequestRemove: (actor: ActorRowData) => void
}

export function ActorRow({
  actor,
  active,
  isDefault = false,
  onSelect,
  onViewDetail,
  onCopyName,
  onCopyId,
  onRequestRemove,
}: Props) {
  const { t } = useTranslation()
  const isAgent = actor.actor_type === 'agent'
  const agentPresence = useActorPresenceStore((s) => isAgent ? s.byActorId[actor.id] : undefined)
  const currentMemberActorId = useCurrentTeamStore((s) => s.currentMember?.id ?? null)
  const online = resolveActorOnlineStatus(actor, { currentMemberActorId, agentPresence })
  const c = actorAvatarColor(actor.id)

  return (
    <ActorContextMenu
      actor={actor}
      isDefault={isDefault}
      onViewDetail={onViewDetail}
      onCopyName={onCopyName}
      onCopyId={onCopyId}
      onRequestRemove={onRequestRemove}
    >
      <button
        type="button"
        onClick={() => onSelect(actor)}
        className={cn(
          'flex w-full items-center gap-[9px] rounded-md px-[9px] py-[5px] text-left text-[12.5px] transition-colors',
          active ? 'bg-selected font-semibold text-foreground' : 'text-ink-2 hover:bg-selected/60',
        )}
      >
        <div
          className={cn(
            'relative flex h-5 w-5 shrink-0 items-center justify-center text-[10px] font-semibold',
            isAgent ? 'rounded' : 'rounded-full',
          )}
          style={{ background: c.bg, color: c.fg }}
        >
          {actor.display_name?.slice(0, 1).toUpperCase()
            || (isAgent ? <Sparkles className="h-3 w-3" /> : <UserIcon className="h-3 w-3" />)}
          {online && (
            <span className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-paper" />
          )}
        </div>
        <span className="min-w-0 flex-1 truncate">{actor.display_name}</span>
        {isDefault && (
          <Star
            className="h-3 w-3 shrink-0 fill-coral text-coral"
            aria-label={t('actors.defaultAgent', 'Default agent')}
          />
        )}
        {isAgent && (
          <span className="shrink-0 font-mono text-[9px] font-semibold tracking-wider text-coral">{t('actors.type.agent', 'Agent')}</span>
        )}
      </button>
    </ActorContextMenu>
  )
}
