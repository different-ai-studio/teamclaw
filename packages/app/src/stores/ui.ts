import { create } from 'zustand'
import { isTauri } from '@/lib/utils'

type View = 'chat' | 'settings'

// Layout mode: 'task' for agent-centric, 'file' for file-centric
export type LayoutMode = 'task' | 'file'

// Right panel tab in file mode
export type FileModeRightTab = 'shortcuts' | 'tasks' | 'changes' | 'files' | 'agent'

interface UIState {
  currentView: View
  layoutMode: LayoutMode
  fileModeRightTab: FileModeRightTab
  spotlightMode: boolean
  setView: (view: View) => void
  openSettings: () => void
  closeSettings: () => void
  setLayoutMode: (mode: LayoutMode) => void
  toggleLayoutMode: () => void
  setFileModeRightTab: (tab: FileModeRightTab) => void
  setSpotlightMode: (mode: boolean) => void
}

export const useUIStore = create<UIState>((set) => ({
  currentView: 'chat',
  layoutMode: 'task',
  fileModeRightTab: 'agent',
  spotlightMode: false,

  setView: (view) => set({ currentView: view }),

  openSettings: () => set({ currentView: 'settings' }),

  closeSettings: () => set({ currentView: 'chat' }),

  setLayoutMode: (mode) => set({ layoutMode: mode }),

  toggleLayoutMode: () => set((state) => ({
    layoutMode: state.layoutMode === 'task' ? 'file' : 'task'
  })),

  setFileModeRightTab: (tab) => set({ fileModeRightTab: tab }),

  setSpotlightMode: (mode) => set({ spotlightMode: mode }),
}))

// Listen for Tauri spotlight-mode-changed event at module level
if (typeof window !== 'undefined') {
  const isTauriEnv = isTauri()
  if (isTauriEnv) {
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<boolean>('spotlight-mode-changed', (event) => {
        useUIStore.setState({ spotlightMode: event.payload })
      })
    })
  }
}
