import { create } from 'zustand'
import { useWorkspaceStore } from '@/stores/workspace'
import { resolveEmbedMode } from '@/lib/embed-mode'
import type { PageContext } from '@/lib/embed-page-context'
import type { TeamShareSection } from '@/stores/team-share-browser'

type View = 'chat' | 'settings'

export type LayoutMode = 'task'
export type MainContentLayout = 'stacked' | 'split'

// Right panel tab in file mode
export type FileModeRightTab = 'shortcuts' | 'changes' | 'files' | 'agent'
export type DefaultPrimaryTab = 'session' | 'actors' | 'ideas' | 'shortcuts'
export type DefaultMoreDestination = 'settings'

/** Preselected actor for the draft chat state: when the user taps an actor
 * row in the Actors tab, we record it here, switch nav back to Session, and
 * clear activeSessionId. ChatPanel's "no active session" branch then renders
 * a draft view that uses this actor's name as the title and creates a solo
 * session directly on send, bypassing the new-session dialog. */
export type DraftActor = { id: string; displayName: string; kind: 'member' | 'agent' }

/** Selector for what the workspace sidebar's column 2 displays. */
export type SidebarFilter =
  | { kind: 'all' }
  | { kind: 'pinned' }
  | { kind: 'shortcuts' }
  | { kind: 'ideas' }
  | { kind: 'apps' }
  | { kind: 'actors' }
  | { kind: 'actor'; actorId: string; displayName: string; actorType: 'member' | 'agent' }
  | { kind: 'idea'; ideaId: string; title: string }
  | { kind: 'workspace'; workspaceId: string | null; path: string; name: string }
  | { kind: 'teamShare'; section: TeamShareSection }

export type SettingsSection = 'llm' | 'general' | 'voice' | 'prompt' | 'mcp' | 'channels' | 'automation' | 'daemonGeneral' | 'daemonWorkspaces' | 'daemonRuntimes' | 'team' | 'envVars' | 'skills' | 'roles' | 'rolesSkills' | 'knowledge' | 'deps' | 'tokenUsage' | 'privacy' | 'permissions' | 'leaderboard' | 'shortcuts' | 'cache'

/** Context passed when opening Agent settings from a blocked quick-new-chat action. */
export type DaemonGeneralPrompt = 'quick_chat'

interface UIState {
  /** True when the page was loaded with ?embed=chat — renders minimal layout. Read-only; no setter. */
  embedMode: boolean
  currentView: View
  layoutMode: LayoutMode
  mainContentLayout: MainContentLayout
  fileModeRightTab: FileModeRightTab
  defaultNavTab: DefaultPrimaryTab
  defaultMoreOpen: boolean
  /** Toggle for the session-scoped Actors sheet (the right-side slideover
   * that lists members + agents for the current session). Lives in ui-store
   * so the header trigger (App.tsx) and the sheet mount (ChatPanel) can
   * share state. */
  actorSheetOpen: boolean
  settingsInitialSection: SettingsSection | null
  /** Shown as a banner in DaemonGeneralSection when the user was redirected here. */
  daemonGeneralPrompt: DaemonGeneralPrompt | null
  draftPreselectedActor: DraftActor | null
  sidebarFilter: SidebarFilter
  ideasSectionCollapsed: boolean
  actorsSectionCollapsed: boolean
  /** Collapsed state of the team-share nav group (Skills/MCP/Env/Knowledge). */
  teamShareCollapsed: boolean
  /** Workspace list expanded (「管理 Workspace 列表」). */
  localDaemonExpanded: boolean
  /** Action sheet open (⋯ menu). */
  localDaemonSheetOpen: boolean
  /** True when LocalDaemonCard already shows the inline MQTT disconnect strip. */
  localDaemonMqttNoticeSuppressed: boolean
  setLocalDaemonMqttNoticeSuppressed: (suppressed: boolean) => void
  draftIdeaId: string | null
  /** Modal "新会话" dialog (NavRail ▾ menu + intercepted send-with-no-session). */
  newSessionDialogOpen: boolean
  /** Message text the dialog opens with — used when the user typed in the
   * empty-session input then hit send (we redirect into the dialog so the
   * draft isn't lost). */
  newSessionDialogInitialMessage: string | null
  openNewSessionDialog: (initialMessage?: string | null) => void
  closeNewSessionDialog: () => void
  setSidebarFilter: (filter: SidebarFilter) => void
  toggleIdeasSection: () => void
  toggleActorsSection: () => void
  toggleTeamShareSection: () => void
  toggleLocalDaemon: () => void
  toggleLocalDaemonSheet: () => void
  setLocalDaemonSheetOpen: (open: boolean) => void
  setDraftIdeaId: (ideaId: string) => void
  clearDraftIdeaId: () => void
  setView: (view: View) => void
  setDefaultMoreOpen: (open: boolean) => void
  setActorSheetOpen: (open: boolean) => void
  toggleActorSheet: () => void
  selectDefaultPrimaryTab: (tab: DefaultPrimaryTab) => void
  openDefaultMoreDestination: (destination: DefaultMoreDestination) => Promise<void> | void
  openSettings: (section?: SettingsSection) => void
  openDaemonAgentSettings: (prompt?: DaemonGeneralPrompt) => void
  clearDaemonGeneralPrompt: () => void
  closeSettings: () => void
  setLayoutMode: (mode: LayoutMode) => void
  toggleLayoutMode: () => void
  toggleMainContentLayout: () => void
  setFileModeRightTab: (tab: FileModeRightTab) => void
  startNewChat: () => void
  /** Incremented to request focus on the chat composer (e.g. after quick new session). */
  composerFocusRequestId: number
  requestComposerFocus: () => void
  /** Pending page-link chip insert — survives composer mount race after session switch. */
  pendingPageLinkInsert: PageContext | null
  pageLinkInsertRequestId: number
  requestPageLinkInsert: (ctx: PageContext) => void
  switchToSession: (sessionId: string) => Promise<void>
  enterActorDraft: (actor: DraftActor) => void
  clearActorDraft: () => void
}

export const useUIStore = create<UIState>((set, get) => ({
  embedMode:
    typeof window !== 'undefined'
      ? resolveEmbedMode(window.location.search, import.meta.env.VITE_FORCE_EMBED) === 'chat'
      : import.meta.env.VITE_FORCE_EMBED === 'chat',
  currentView: 'chat',
  layoutMode: 'task',
  mainContentLayout: 'stacked',
  fileModeRightTab: 'agent',
  defaultNavTab: 'session',
  defaultMoreOpen: false,
  actorSheetOpen: false,
  settingsInitialSection: null,
  daemonGeneralPrompt: null,
  draftPreselectedActor: null,
  sidebarFilter: { kind: 'all' },
  ideasSectionCollapsed: false,
  actorsSectionCollapsed: false,
  teamShareCollapsed: true,
  localDaemonExpanded: false,
  localDaemonSheetOpen: false,
  localDaemonMqttNoticeSuppressed: false,
  draftIdeaId: null,
  newSessionDialogOpen: false,
  newSessionDialogInitialMessage: null,
  composerFocusRequestId: 0,

  requestComposerFocus: () => set((s) => ({
    composerFocusRequestId: s.composerFocusRequestId + 1,
  })),

  pendingPageLinkInsert: null,
  pageLinkInsertRequestId: 0,

  requestPageLinkInsert: (ctx) => set((s) => ({
    pendingPageLinkInsert: ctx,
    pageLinkInsertRequestId: s.pageLinkInsertRequestId + 1,
  })),

  openNewSessionDialog: (initialMessage) => set({
    newSessionDialogOpen: true,
    newSessionDialogInitialMessage: initialMessage ?? null,
  }),
  closeNewSessionDialog: () => set({
    newSessionDialogOpen: false,
    newSessionDialogInitialMessage: null,
  }),

  setView: (view) => set({ currentView: view }),

  setDefaultMoreOpen: (open) => set({ defaultMoreOpen: open }),

  setActorSheetOpen: (open) => set({ actorSheetOpen: open }),
  toggleActorSheet: () => set((s) => ({ actorSheetOpen: !s.actorSheetOpen })),

  selectDefaultPrimaryTab: (tab) => {
    const ws = useWorkspaceStore.getState()

    set({
      defaultNavTab: tab,
      defaultMoreOpen: false,
      currentView: 'chat',
      settingsInitialSection: null,
      daemonGeneralPrompt: null,
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
  },

  openSettings: (section) => set({
    currentView: 'settings',
    settingsInitialSection: section ?? null,
    daemonGeneralPrompt: null,
  }),

  openDaemonAgentSettings: (prompt) => set({
    currentView: 'settings',
    settingsInitialSection: 'daemonGeneral',
    daemonGeneralPrompt: prompt ?? null,
  }),

  clearDaemonGeneralPrompt: () => set({ daemonGeneralPrompt: null }),

  closeSettings: () => set({
    currentView: 'chat',
    settingsInitialSection: null,
    daemonGeneralPrompt: null,
  }),

  startNewChat: () => {
    // Switch to chat view synchronously so settings hides immediately —
    // waiting on the dynamic imports below would leave the settings UI
    // visible until the import chain resolves.
    set({
      currentView: 'chat',
      settingsInitialSection: null,
      daemonGeneralPrompt: null,
      // Starting a fresh chat overrides any pending actor-draft selection.
      draftPreselectedActor: null,
      sidebarFilter: { kind: 'all' },
      draftIdeaId: null,
    })
    const isStacked = get().mainContentLayout === 'stacked'

    // Import session and other stores lazily to avoid circular dependencies
    import('@/stores/cron').then(({ useCronStore }) => {
      useCronStore.getState().setShowCronSessions(false)
    })
    import('@/stores/session-selection-store').then(({ useSessionSelectionStore }) => {
      import('@/stores/workspace').then(({ useWorkspaceStore }) => {
        import('@/stores/tabs').then(({ useTabsStore }) => {
          import('@/stores/streaming').then(({ useStreamingStore }) => {
            import('@/stores/session').then(({ useSessionStore }) => {
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
            useSessionSelectionStore.getState().clearActiveSession()

            // Clear session state to show "Start a New Chat" UI
            // Actual session will be created when user sends first message
            useSessionStore.setState({
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
    })
  },

  switchToSession: async (sessionId: string) => {
    // Import stores lazily to avoid circular dependencies
    const { useSessionSelectionStore } = await import('@/stores/session-selection-store')
    const { useWorkspaceStore } = await import('@/stores/workspace')
    const { useTabsStore } = await import('@/stores/tabs')
    const { useCurrentTeamStore } = await import('@/stores/current-team')
    const { switchToSessionWorkspaceIfNeeded } = await import('@/lib/session-by-workspace')
    
    const teamId = useCurrentTeamStore.getState().team?.id

    // If already on this session just navigate back to chat view (e.g. user
    // opened the apps panel and clicked the same app again). Still switch the
    // workspace so daemon runtimes started from this session use the right
    // worktree (e.g. app sessions whose workspace wasn't set yet).
    const currentActiveId = useSessionSelectionStore.getState().activeSessionId
    if (sessionId === currentActiveId) {
      set({ currentView: 'chat', settingsInitialSection: null, daemonGeneralPrompt: null, sidebarFilter: { kind: 'all' } })
      if (teamId) await switchToSessionWorkspaceIfNeeded(teamId, sessionId)
      return
    }

    if (teamId) {
      await switchToSessionWorkspaceIfNeeded(teamId, sessionId)
    }
    
    // Close any open UI elements and return to chat view
    set({
      currentView: 'chat',
      settingsInitialSection: null,
      daemonGeneralPrompt: null,
    })
    useWorkspaceStore.getState().clearSelection()
    useTabsStore.getState().hideAll()
    
    // Switch to the session (selection store also updates the read marker).
    await useSessionSelectionStore.getState().setActiveSession(sessionId)
    // If the user was in actor-draft mode, drop that since they jumped into
    // an existing session.
    set({ draftPreselectedActor: null, sidebarFilter: { kind: 'all' }, draftIdeaId: null })
  },

  enterActorDraft: (actor) => {
    set({
      draftPreselectedActor: actor,
      draftIdeaId: null,
      defaultNavTab: 'session',
      defaultMoreOpen: false,
      currentView: 'chat',
      settingsInitialSection: null,
      daemonGeneralPrompt: null,
    })
    // Mirror startNewChat's clear-out so the chat view shows an empty
    // canvas with the preselected actor as the implicit recipient. We
    // dynamic-import to avoid a top-level cycle with session/workspace stores.
    void (async () => {
      const { useSessionSelectionStore } = await import('@/stores/session-selection-store')
      const { useSessionStore } = await import('@/stores/session')
      const { useWorkspaceStore } = await import('@/stores/workspace')
      useWorkspaceStore.getState().clearSelection()
      useWorkspaceStore.getState().closePanel()
      useSessionSelectionStore.getState().clearActiveSession()
      useSessionStore.setState({
        isLoading: false,
        messageQueue: [],
        todos: [],
        sessionDiff: [],
        sessionError: null,
        sessionStatus: null,
        pendingQuestions: [],
        pendingPermissions: [],
      })
    })()
  },

  clearActorDraft: () => set({ draftPreselectedActor: null }),

  setSidebarFilter: (filter) => set({ sidebarFilter: filter }),
  toggleIdeasSection: () => set((s) => ({ ideasSectionCollapsed: !s.ideasSectionCollapsed })),
  toggleActorsSection: () => set((s) => ({ actorsSectionCollapsed: !s.actorsSectionCollapsed })),
  toggleTeamShareSection: () => set((s) => ({ teamShareCollapsed: !s.teamShareCollapsed })),
  toggleLocalDaemon: () => set((s) => ({ localDaemonExpanded: !s.localDaemonExpanded })),
  toggleLocalDaemonSheet: () => set((s) => ({ localDaemonSheetOpen: !s.localDaemonSheetOpen })),
  setLocalDaemonSheetOpen: (open) => set({ localDaemonSheetOpen: open }),
  setLocalDaemonMqttNoticeSuppressed: (suppressed) =>
    set({ localDaemonMqttNoticeSuppressed: suppressed }),
  setDraftIdeaId: (ideaId) => set({ draftIdeaId: ideaId }),
  clearDraftIdeaId: () => set({ draftIdeaId: null }),

  setLayoutMode: () => set({ layoutMode: 'task' }),

  toggleLayoutMode: () => set({ layoutMode: 'task' }),

  toggleMainContentLayout: () => set((state) => ({
    mainContentLayout: state.mainContentLayout === 'stacked' ? 'split' : 'stacked'
  })),

  setFileModeRightTab: (tab) => set({ fileModeRightTab: tab }),
}))
