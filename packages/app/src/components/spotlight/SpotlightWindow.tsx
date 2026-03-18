import { useEffect } from 'react'
import { useSessionStore, getSessionById } from '@/stores/session'
import { useSpotlight } from '@/hooks/useSpotlight'
import { isTauri } from '@/lib/utils'
import { SpotlightTitleBar } from './SpotlightTitleBar'
import { ChatPanel } from '@/components/chat/ChatPanel'

export function SpotlightWindow() {
  const { pinned, togglePin, expandToMain } = useSpotlight()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeSession = activeSessionId ? getSessionById(activeSessionId) : undefined

  // Auto-paste clipboard content into input when spotlight opens
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('spotlight-clipboard', (event) => {
        if (event.payload) {
          useSessionStore.getState().setDraftInput(event.payload)
        }
      }).then((fn) => { unlisten = fn })
    })
    return () => { unlisten?.() }
  }, [])

  return (
    <div className="relative flex flex-col h-screen w-full rounded-2xl border border-border bg-background overflow-hidden">
      <SpotlightTitleBar
        pinned={pinned}
        sessionTitle={activeSession?.title}
        onTogglePin={togglePin}
        onExpandToMain={expandToMain}
      />
      <div className="flex-1 min-h-0 relative">
        <ChatPanel compact />
      </div>
    </div>
  )
}
