import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace'
import { CONFIG_FILE_NAME, TEAMCLAW_DIR } from '@/lib/build-config'

type View = 'chat' | 'settings'

// Layout mode: 'task' for agent-centric, 'file' for file-centric
export type LayoutMode = 'task' | 'file'
export type MainContentLayout = 'stacked' | 'split'

// Right panel tab in file mode
export type FileModeRightTab = 'shortcuts' | 'changes' | 'files' | 'agent'
export type DefaultPrimaryTab = 'session' | 'knowledge' | 'shortcuts'
export type DefaultMoreDestination = 'automation' | 'rolesSkills' | 'settings'

export type SettingsSection = 'llm' | 'general' | 'voice' | 'prompt' | 'mcp' | 'channels' | 'automation' | 'team' | 'envVars' | 'skills' | 'roles' | 'rolesSkills' | 'knowledge' | 'deps' | 'tokenUsage' | 'privacy' | 'permissions' | 'leaderboard' | 'shortcuts'

/** Sections that can be opened in the main column from the workspace sidebar strip. */
export type EmbeddedSidebarSettingsSection = 'automation' | 'rolesSkills'

interface UIState {
  currentView: View
  layoutMode: LayoutMode
  mainContentLayout: MainContentLayout
  fileModeRightTab: FileModeRightTab
  defaultNavTab: DefaultPrimaryTab
  defaultMoreOpen: boolean
  spotlightMode: boolean
  settingsInitialSection: SettingsSection | null
  /** When set, main column shows this settings section (workspace UI variant only). */
  embeddedSettingsSection: EmbeddedSidebarSettingsSection | null
  setView: (view: View) => void
  setDefaultMoreOpen: (open: boolean) => void
  selectDefaultPrimaryTab: (tab: DefaultPrimaryTab) => void
  openDefaultMoreDestination: (destination: DefaultMoreDestination) => Promise<void> | void
  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  openEmbeddedSettingsSection: (section: EmbeddedSidebarSettingsSection) => void
  closeEmbeddedSettingsSection: () => void
  setLayoutMode: (mode: LayoutMode) => void
  toggleLayoutMode: () => void
  toggleMainContentLayout: () => void
  setFileModeRightTab: (tab: FileModeRightTab) => void
  setSpotlightMode: (mode: boolean) => void
  advancedMode: boolean
  setAdvancedMode: (value: boolean, workspacePath: string | null) => Promise<void>
  loadAdvancedMode: (workspacePath: string) => Promise<void>
  startNewChat: () => void
  switchToSession: (sessionId: string) => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function getWorkspaceConfigPath(workspacePath: string): Promise<{
  dirPath: string
  configPath: string
}> {
  const { join } = await import('@tauri-apps/api/path')
  const dirPath = await join(workspacePath, TEAMCLAW_DIR)
  const configPath = await join(dirPath, CONFIG_FILE_NAME)
  return { dirPath, configPath }
}

async function readWorkspaceConfig(configPath: string): Promise<Record<string, unknown>> {
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  try {
    const parsed = JSON.parse(await readTextFile(configPath))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export const useUIStore = create<UIState>((set, get) => ({
  currentView: 'chat',
  layoutMode: 'task',
  mainContentLayout: 'stacked',
  fileModeRightTab: 'agent',
  defaultNavTab: 'session',
  defaultMoreOpen: false,
  spotlightMode: false,
  settingsInitialSection: null,
  embeddedSettingsSection: null,

  setView: (view) => set({ currentView: view }),

  setDefaultMoreOpen: (open) => set({ defaultMoreOpen: open }),

  selectDefaultPrimaryTab: (tab) => {
    const ws = useWorkspaceStore.getState()

    set({
      defaultNavTab: tab,
      defaultMoreOpen: false,
      currentView: 'chat',
      settingsInitialSection: null,
      embeddedSettingsSection: null,
    })

    if (tab === 'session') {
      ws.clearSelection()
      ws.closePanel()
      return
    }

    ws.clearSelection()
    ws.closePanel()
  },

  openDefaultMoreDestination: (destination) => {
    set({ defaultMoreOpen: false })

    if (destination === 'settings') {
      get().openSettings()
      return
    }

    if (destination === 'automation') {
      get().openSettings('automation')
      return
    }

    if (destination === 'rolesSkills') {
      get().openSettings('rolesSkills')
      return
    }
  },

  openSettings: (section) => set({
    currentView: 'settings',
    settingsInitialSection: section ?? null,
    embeddedSettingsSection: null,
  }),

  closeSettings: () => set({ currentView: 'chat', settingsInitialSection: null, embeddedSettingsSection: null }),

  openEmbeddedSettingsSection: (section) => set({ embeddedSettingsSection: section }),

  closeEmbeddedSettingsSection: () => set({ embeddedSettingsSection: null }),

  startNewChat: () => {
    // Switch to chat view synchronously so settings (full-page or embedded)
    // hides immediately — waiting on the dynamic imports below would leave
    // the settings UI visible until the import chain resolves.
    set({
      currentView: 'chat',
      settingsInitialSection: null,
      embeddedSettingsSection: null,
    })
    const isStacked = get().mainContentLayout === 'stacked'

    // Import session and other stores lazily to avoid circular dependencies
    import('@/stores/session').then(({ useSessionStore }) => {
      import('@/stores/workspace').then(({ useWorkspaceStore }) => {
        import('@/stores/tabs').then(({ useTabsStore }) => {
          import('@/stores/streaming').then(({ useStreamingStore }) => {
            useWorkspaceStore.getState().clearSelection()
            useWorkspaceStore.getState().closePanel()
            // Only deactivate the editor multi-tab pane in stacked layout —
            // in stacked mode chat and tabs share the same slot, so we need
            // to hide tabs to reveal the chat view. In split layout the
            // chat pane is already visible alongside the tabs, so closing
            // them just makes the user's open files vanish for no reason.
            if (isStacked) {
              useTabsStore.getState().hideAll()
            }
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
              pendingQuestions: [],
              pendingPermissions: [],
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

  toggleMainContentLayout: () => set((state) => ({
    mainContentLayout: state.mainContentLayout === 'stacked' ? 'split' : 'stacked'
  })),

  setFileModeRightTab: (tab) => set({ fileModeRightTab: tab }),

  setSpotlightMode: (mode) => set({ spotlightMode: mode }),

  advancedMode: false,

  setAdvancedMode: async (value, workspacePath) => {
    set({ advancedMode: value })
    if (!workspacePath || !isTauri()) return

    try {
      const { exists, mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs')
      const { dirPath, configPath } = await getWorkspaceConfigPath(workspacePath)

      if (!(await exists(dirPath))) {
        await mkdir(dirPath, { recursive: true })
      }

      const config = (await exists(configPath))
        ? await readWorkspaceConfig(configPath)
        : {}
      await writeTextFile(
        configPath,
        `${JSON.stringify({ ...config, advancedMode: value }, null, 2)}\n`,
      )
    } catch (error) {
      console.warn('[UI] Failed to persist advanced mode:', error)
    }
  },

  loadAdvancedMode: async (workspacePath) => {
    if (!workspacePath || !isTauri()) {
      set({ advancedMode: false })
      return
    }

    try {
      const { exists } = await import('@tauri-apps/plugin-fs')
      const { configPath } = await getWorkspaceConfigPath(workspacePath)
      if (!(await exists(configPath))) {
        set({ advancedMode: false })
        return
      }

      const config = await readWorkspaceConfig(configPath)
      set({ advancedMode: config.advancedMode === true })
    } catch (error) {
      console.warn('[UI] Failed to load advanced mode:', error)
      set({ advancedMode: false })
    }
  },
}))

// Listen for Tauri spotlight-mode-changed event at module level
if (typeof window !== 'undefined') {
  const isTauriEnv = isTauri()
  const tauriInternals = (window as unknown as {
    __TAURI_INTERNALS__?: { transformCallback?: unknown }
  }).__TAURI_INTERNALS__
  const canListenForTauriEvents =
    isTauriEnv && typeof tauriInternals?.transformCallback === 'function'

  if (canListenForTauriEvents) {
    void import('@tauri-apps/api/event').then(({ listen }) => {
      return listen<boolean>('spotlight-mode-changed', (event) => {
        useUIStore.setState({ spotlightMode: event.payload })
      })
    }).catch((error) => {
      console.warn('[UI] Failed to listen for spotlight mode changes:', error)
    })
  }
}
