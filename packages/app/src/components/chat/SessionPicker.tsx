import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSessionStore, getSessionById } from '@/stores/session'
import { SessionList } from './SessionList'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface SessionPickerProps {
  className?: string
}

export function SessionPicker({ className }: SessionPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  const activeSession = activeSessionId ? getSessionById(activeSessionId) : null
  const displayTitle = activeSession?.title || t('chat.newSession', 'New Session')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors max-w-[160px] ${className ?? ''}`}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <span className="truncate">{displayTitle}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end" sideOffset={4}>
        <div className="max-h-[300px] overflow-y-auto">
          <SessionList compact onSessionSelected={() => setOpen(false)} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
