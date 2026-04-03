import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { TEAMCLAW_DIR, CONFIG_FILE_NAME } from '@/lib/build-config'
import { useWorkspaceStore } from '@/stores/workspace'

type View = 'chat' | 'settings'

// Layout mode: 'task' for agent-centric, 'file' for file-centric
export type LayoutMode = 'task' | 'file'

// Right panel tab in file mode
export type FileModeRightTab = 'shortcuts' | 'tasks' | 'changes' | 'files' | 'agent'

export type SettingsSection = 'llm' | 'general' | 'voice' | 'prompt' | 'mcp' | 'channels' | 'automation' | 'team' | 'envVars' | 'skills' | 'roles' | 'knowledge' | 'deps' | 'tokenUsage' | 'privacy' | 'permissions' | 'leaderboard' | 'shortcuts' | 'mobileRelay'

/** Sections that can be opened in the main column from the workspace sidebar strip. */
export type EmbeddedSidebarSettingsSection = 'automation' | 'roles' | 'skills'

interface UIState {
  currentView: View
  layoutMode: LayoutMode
  fileModeRightTab: FileModeRightTab
  spotlightMode: boolean
  settingsInitialSection: SettingsSection | null
  /** When set, main column shows this settings section (workspace UI variant only). */
  embeddedSettingsSection: EmbeddedSidebarSettingsSection | null
  setView: (view: View) => void
  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  openEmbeddedSettingsSection: (section: EmbeddedSidebarSettingsSection) => void
  closeEmbeddedSettingsSection: () => void
  setLayoutMode: (mode: LayoutMode) => void
  toggleLayoutMode: () => void
  setFileModeRightTab: (tab: FileModeRightTab) => void
  setSpotlightMode: (mode: boolean) => void
  advancedMode: boolean
  setAdvancedMode: (value: boolean, workspacePath: string | null) => void
  loadAdvancedMode: (workspacePath: string) => void
  startNewChat: () => void
  switchToSession: (sessionId: string) => Promise<void>
}

export const useUIStore = create<UIState>((set, get) => ({
  currentView: 'chat',
  layoutMode: 'task',
  fileModeRightTab: 'agent',
  spotlightMode: false,
  settingsInitialSection: null,
  embeddedSettingsSection: null,

  setView: (view) => set({ currentView: view }),

  openSettings: (section) => set({
    currentView: 'settings',
    settingsInitialSection: section ?? null,
    embeddedSettingsSection: null,
  }),

  closeSettings: () => set({ currentView: 'chat', settingsInitialSection: null, embeddedSettingsSection: null }),

  openEmbeddedSettingsSection: (section) => set({ embeddedSettingsSection: section }),

  closeEmbeddedSettingsSection: () => set({ embeddedSettingsSection: null }),

  startNewChat: () => {
    // Import session and other stores lazily to avoid circular dependencies
    import('@/stores/session').then(({ useSessionStore }) => {
      import('@/stores/workspace').then(({ useWorkspaceStore }) => {
        import('@/stores/tabs').then(({ useTabsStore }) => {
          import('@/stores/streaming').then(({ useStreamingStore }) => {
            // Close any open UI elements and return to chat view
            set({ 
              currentView: 'chat', 
              settingsInitialSection: null, 
              embeddedSettingsSection: null 
            })
            useWorkspaceStore.getState().clearSelection()
            useWorkspaceStore.getState().closePanel()
            useTabsStore.getState().hideAll()
            useStreamingStore.getState().clearStreaming()
            
            // Clear session state to show "Start a New Chat" UI
            // Actual session will be created when user sends first message
            useSessionStore.setState({
              activeSessionId: null,
              isLoading: false,
              messageQueue: [],
              todos: [],
              sessionDiff: [],
              sessionError: null,
              sessionStatus: null,
              pendingQuestion: null,
              pendingPermission: null,
              pendingPermissionChildSessionId: null,
            })
          })
        })
      })
    })
  },

  switchToSession: async (sessionId: string) => {
    // Import stores lazily to avoid circular dependencies
    const { useSessionStore } = await import('@/stores/session')
    const { useWorkspaceStore } = await import('@/stores/workspace')
    const { useTabsStore } = await import('@/stores/tabs')
    
    // Skip if already on this session (avoid unnecessary reloads)
    const currentActiveId = useSessionStore.getState().activeSessionId
    if (sessionId === currentActiveId) {
      return
    }
    
    // Close any open UI elements and return to chat view
    set({ 
      currentView: 'chat', 
      settingsInitialSection: null, 
      embeddedSettingsSection: null 
    })
    useWorkspaceStore.getState().clearSelection()
    useTabsStore.getState().hideAll()
    
    // Switch to the session (setActiveSession handles its own internal state)
    await useSessionStore.getState().setActiveSession(sessionId)
  },

  setLayoutMode: (mode) => set({ layoutMode: mode }),

  toggleLayoutMode: () => set((state) => ({
    layoutMode: state.layoutMode === 'task' ? 'file' : 'task'
  })),

  setFileModeRightTab: (tab) => set({ fileModeRightTab: tab }),

  setSpotlightMode: (mode) => set({ spotlightMode: mode }),

  advancedMode: false,

  setAdvancedMode: (value, workspacePath) => {
    set({ advancedMode: value })

    // If switching to normal mode, reset layout/tabs
    if (!value) {
      const state = get()
      if (state.layoutMode === 'file') {
        set({ layoutMode: 'task' })
      }
      set({ fileModeRightTab: 'shortcuts' })

      // Reset workspace activeTab if on hidden tabs
      const wsState = useWorkspaceStore.getState()
      if (wsState.activeTab === 'diff' || wsState.activeTab === 'files') {
        wsState.openPanel('shortcuts')
      }
    }

    // Persist to teamclaw.json
    if (workspacePath) {
      import('@tauri-apps/api/path').then(({ join }) =>
        join(workspacePath, TEAMCLAW_DIR, CONFIG_FILE_NAME).then((configPath) =>
          import('@tauri-apps/plugin-fs').then(({ readTextFile, writeTextFile, exists, mkdir }) =>
            join(workspacePath, TEAMCLAW_DIR).then((teamclawDir) =>
              exists(teamclawDir).then((dirExists) => {
                const writeConfig = () =>
                  exists(configPath).then((fileExists) => {
                    if (fileExists) {
                      return readTextFile(configPath).then((content) => {
                        try {
                          const config = JSON.parse(content)
                          config.advancedMode = value
                          return writeTextFile(configPath, JSON.stringify(config, null, 2))
                        } catch {
                          return writeTextFile(configPath, JSON.stringify({ advancedMode: value }, null, 2))
                        }
                      })
                    } else {
                      return writeTextFile(configPath, JSON.stringify({ advancedMode: value }, null, 2))
                    }
                  })

                if (!dirExists) {
                  return mkdir(teamclawDir, { recursive: true }).then(writeConfig)
                }
                return writeConfig()
              })
            )
          )
        )
      ).catch((err) => console.warn('[UI] Failed to persist advancedMode:', err))
    }
  },

  loadAdvancedMode: async (workspacePath) => {
    try {
      const { join } = await import('@tauri-apps/api/path')
      const { readTextFile, exists } = await import('@tauri-apps/plugin-fs')
      const configPath = await join(workspacePath, TEAMCLAW_DIR, CONFIG_FILE_NAME)
      const fileExists = await exists(configPath)
      if (!fileExists) {
        set({ advancedMode: false })
        return
      }
      const content = await readTextFile(configPath)
      try {
        const config = JSON.parse(content)
        const value = config.advancedMode === true

        // Guard against stale workspace switch
        if (useWorkspaceStore.getState().workspacePath !== workspacePath) return

        set({ advancedMode: value })
      } catch {
        console.warn('[UI] Failed to parse teamclaw.json, defaulting advancedMode to false')
        set({ advancedMode: false })
      }
    } catch (err) {
      console.warn('[UI] Failed to load advancedMode:', err)
      set({ advancedMode: false })
    }
  },
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
