import { Pin, Maximize2 } from 'lucide-react'
import { isTauri } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

interface SpotlightTitleBarProps {
  pinned: boolean
  sessionTitle?: string
  onTogglePin: () => void
  onExpandToMain: () => void
}

export function SpotlightTitleBar({ pinned, sessionTitle, onTogglePin, onExpandToMain }: SpotlightTitleBarProps) {
  const { t } = useTranslation()

  return (
    <div
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center gap-2 pl-1 pr-3 pb-1 border-b border-border bg-background/80 backdrop-blur-sm"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={onTogglePin}
          className={`p-2.5 rounded hover:bg-accent transition-colors ${pinned ? 'text-primary' : 'text-muted-foreground'}`}
          title={pinned ? 'Unpin window' : 'Pin window (always on top)'}
        >
          <Pin className="w-4 h-4" fill={pinned ? 'currentColor' : 'none'} />
        </button>
      </div>
      <span
        data-tauri-drag-region
        className="flex-1 text-xs text-foreground font-medium truncate text-center"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {sessionTitle || t("chat.newChat", "New Chat")}
      </span>
      {isTauri() && (
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={onExpandToMain}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
            title="Expand to main window"
          >
            <Maximize2 className="w-4.5 h-4.5" />
          </button>
        </div>
      )}
    </div>
  )
}
