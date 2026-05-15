import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox, AtSign, Keyboard, Pin } from 'lucide-react'
import { useUIStore } from '@/stores/ui'
import { useSessionStore } from '@/stores/session'
import { useCronStore } from '@/stores/cron'
import { IdeasSection } from '@/components/sidebar/IdeasSection'
import { ActorsSection } from '@/components/sidebar/ActorsSection'
import { cn } from '@/lib/utils'

interface TopEntryProps {
  label: string
  icon: React.ComponentType<{ className?: string }>
  active?: boolean
  badge?: number | null
  onClick: () => void
}

function TopEntry({ label, icon: Icon, active, badge, onClick }: TopEntryProps) {
  // Direction B quick-link row: tight 7×9 padding, selected (#e7e2d6) fill on
  // active, no left bar. The coral left bar is reserved for session cards in
  // the middle column. See AGENTS.md §2 "Sidebar".
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-[9px] py-[7px] text-left text-[13px] transition-colors',
        active
          ? 'bg-selected font-semibold text-foreground'
          : 'text-ink-2 hover:bg-selected/60',
      )}
    >
      <Icon
        className={cn('h-[15px] w-[15px] shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
          {badge}
        </span>
      )}
    </button>
  )
}

export function NavRail() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const sessions = useSessionStore((s) => s.sessions)
  const cronSessionIds = useCronStore((s) => s.cronSessionIds)

  const sessionsCount = React.useMemo(
    () => sessions.filter((s) => !s.parentID && !cronSessionIds.has(s.id)).length,
    [sessions, cronSessionIds],
  )

  const handleComingSoon = () => {
    void import('sonner').then((m) => m.toast(t('common.comingSoon', 'Coming soon')))
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-2 overflow-y-auto px-3 pt-0 pb-3">
      <div className="flex flex-col">
        <TopEntry
          label={t('sidebar.sessions', 'Sessions')}
          icon={Inbox}
          active={filter.kind === 'all'}
          badge={sessionsCount}
          onClick={() => setFilter({ kind: 'all' })}
        />
        <TopEntry
          label={t('sidebar.mentions', '@Mentions')}
          icon={AtSign}
          onClick={handleComingSoon}
        />
        <TopEntry
          label={t('sidebar.pinned', 'Pinned')}
          icon={Pin}
          active={filter.kind === 'pinned'}
          onClick={() => setFilter({ kind: 'pinned' })}
        />
        <TopEntry
          label={t('common.shortcuts', 'Shortcuts')}
          icon={Keyboard}
          active={filter.kind === 'shortcuts'}
          onClick={() => setFilter({ kind: 'shortcuts' })}
        />
      </div>

      <IdeasSection />
      <ActorsSection />
    </div>
  )
}
