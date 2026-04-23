import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const uiVariantState = vi.hoisted(() => ({
  workspace: false,
}))

const uiStoreState = vi.hoisted(() => ({
  currentView: 'chat',
  closeSettings: vi.fn(),
  layoutMode: 'task',
  fileModeRightTab: 'agent',
  setFileModeRightTab: vi.fn(),
  spotlightMode: false,
  toggleLayoutMode: vi.fn(),
  embeddedSettingsSection: null as string | null,
  closeEmbeddedSettingsSection: vi.fn(),
  openEmbeddedSettingsSection: vi.fn(),
  advancedMode: false,
  openSettings: vi.fn(),
}))

const workspaceStoreState = vi.hoisted(() => ({
  workspacePath: null as string | null,
  openCodeBootstrapped: false,
  openCodeReady: false,
  isPanelOpen: false,
  activeTab: 'shortcuts',
  openPanel: vi.fn(),
  closePanel: vi.fn(),
  clearWorkspace: vi.fn(),
  selectedFile: null as string | null,
  fileContent: '',
  isLoadingFile: false,
  clearSelection: vi.fn(),
  selectFile: vi.fn(),
  setOpenCodeBootstrapped: vi.fn(),
  setOpenCodeReady: vi.fn(),
  isNewWorkspace: false,
  setIsNewWorkspace: vi.fn(),
}))

const sidebarState = vi.hoisted(() => ({
  state: 'expanded',
  open: true,
  setOpen: vi.fn(),
}))

// Polyfill browser APIs missing in jsdom
globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn(),
}))

// Mock everything App depends on
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('sonner', () => ({ Toaster: () => null }))
vi.mock('@/lib/utils', () => ({
  cn: (...a: string[]) => a.join(' '),
  isTauri: () => false,
}))
vi.mock('@/components/SSEProvider', () => ({ SSEProvider: () => null }))
vi.mock('@/components/FileEditor', () => ({ FileContentViewer: () => null }))
vi.mock('@/hooks/useTrafficLightSpacer', () => ({ useNeedsTrafficLightSpacer: () => false }))
vi.mock('@/hooks/useAppInit', () => ({
  useOpenCodeInit: () => ({ openCodeError: null, setOpenCodeError: vi.fn(), initialWorkspaceResolved: true }),
  useChannelGatewayInit: vi.fn(),
  useGitReposInit: vi.fn(),
  useCronInit: vi.fn(),
  useP2pAutoReconnect: vi.fn(),
  useOssSyncInit: vi.fn(),
  useExternalLinkHandler: vi.fn(),
  useTauriBodyClass: vi.fn(),
  useSetupGuide: () => ({ showSetupGuide: false, dependencies: [], handleRecheck: vi.fn(), handleSetupContinue: vi.fn() }),
  useTelemetryConsent: () => ({ showConsentDialog: false, setShowConsentDialog: vi.fn() }),
  useOpenCodePreload: vi.fn(),
  useLayoutModeShortcut: vi.fn(),
}))
vi.mock('@/hooks/useMCPFileWatcher', () => ({ useMCPFileWatcher: vi.fn() }))
vi.mock('@/hooks/useFileEditorState', () => ({
  usePanelAutoOpen: vi.fn(),
  useLayoutModePanelSync: vi.fn(),
  useFileTabSync: vi.fn(),
  useResizablePanels: () => ({ rightPanelWidth: 300, handleRightPanelResize: vi.fn() }),
}))
vi.mock('@/components/app-sidebar', () => ({
  AppSidebar: () => <div data-testid="sidebar">sidebar</div>,
  SidebarIconGroup: () => null,
  SidebarCollapseToggle: () => null,
  SidebarSecondarySessionActions: () => null,
}))
vi.mock('@/components/settings/section-registry', () => ({
  SettingsSectionBody: () => <div data-testid="settings-section-body" />,
}))
vi.mock('@/lib/ui-variant', () => ({
  isWorkspaceUIVariant: () => uiVariantState.workspace,
}))
vi.mock('@/components/chat/ChatPanel', () => ({ ChatPanel: () => <div>chat</div> }))
vi.mock('@/components/voice/VoiceInputFloatingButton', () => ({ VoiceInputFloatingButton: () => null }))
vi.mock('@/components/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/components/updater/UpdateDialog', () => ({ UpdateDialogContainer: () => null }))
vi.mock('@/components/panel', () => ({
  RightPanel: () => null,
  ShortcutsPanel: () => null,
}))
vi.mock('@/components/settings', () => ({ Settings: () => <div>settings</div> }))
vi.mock('@/components/SetupGuide', () => ({ SetupGuide: () => null }))
vi.mock('@/components/telemetry/TelemetryConsentDialog', () => ({ TelemetryConsentDialog: () => null }))
vi.mock('@/components/workspace', () => ({ WorkspacePrompt: () => <div>workspace-prompt</div> }))
vi.mock('@/stores/session', () => ({
  useSessionStore: vi.fn((sel: (s: any) => any) => {
    const state = {
      getActiveSession: () => null, todos: [], sessionDiff: [],
      createSession: vi.fn(), sessions: [], setActiveSession: vi.fn(),
      reloadActiveSessionMessages: vi.fn(),
    }
    return sel(state)
  }),
}))
vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    vi.fn((sel: (s: any) => any) => {
      return sel(uiStoreState)
    }),
    { getState: () => ({ spotlightMode: uiStoreState.spotlightMode }) }
  ),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    return sel(workspaceStoreState)
  }),
}))
vi.mock('@/stores/tabs', () => ({
  useTabsStore: Object.assign(
    vi.fn((sel: (s: any) => any) => sel({ tabs: [], activeTabId: null })),
    { getState: () => ({ openTab: vi.fn(), closeTab: vi.fn(), tabs: [], activeTabId: null }) }
  ),
  selectActiveTab: (_s: any) => null,
  selectHasHiddenTabs: (_s: any) => false,
}))
vi.mock('@/components/tab-bar/TabBar', () => ({ TabBar: () => null }))
vi.mock('@/components/tab-bar/TabContentRenderer', () => ({ TabContentRenderer: () => null }))
vi.mock('@/components/tab-bar/WebViewToolbar', () => ({ WebViewToolbar: () => null }))
vi.mock('@/lib/webview-utils', () => ({ urlToLabel: (u: string) => u }))
vi.mock('@/lib/opencode/sdk-client', () => ({ initOpenCodeClient: vi.fn() }))
vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: vi.fn((sel: (s: any) => any) => sel({ devUnlocked: false, teamMode: false })),
}))
vi.mock('@/lib/opencode/preloader', () => ({ startOpenCode: vi.fn(), waitForOpenCodeBootstrapped: vi.fn(), clearPreload: vi.fn() }))
vi.mock('@/components/ui/sidebar', () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useSidebar: () => sidebarState,
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
vi.mock('@/components/ui/separator', () => ({
  Separator: () => <hr />,
}))
vi.mock('@/components/ui/traffic-lights', () => ({ TrafficLights: () => null }))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <>{children}</>,
  DropdownMenuItem: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
}))

import App from '../App'

describe('App', () => {
  beforeEach(() => {
    uiVariantState.workspace = false
    uiStoreState.currentView = 'chat'
    uiStoreState.layoutMode = 'task'
    uiStoreState.fileModeRightTab = 'agent'
    uiStoreState.embeddedSettingsSection = null
    uiStoreState.spotlightMode = false
    workspaceStoreState.workspacePath = null
    workspaceStoreState.isPanelOpen = false
    workspaceStoreState.activeTab = 'shortcuts'
    workspaceStoreState.isNewWorkspace = false
    sidebarState.state = 'expanded'
    sidebarState.open = true
    sidebarState.setOpen.mockReset()
  })

  it('renders without crashing', () => {
    const { container } = render(<App />)
    expect(container).toBeTruthy()
  })

  it('shows workspace prompt when no workspace is selected', () => {
    render(<App />)
    // The WorkspacePrompt mock renders 'workspace-prompt'
    expect(document.body.textContent).toContain('workspace-prompt')
  })

  it('keeps the sidebar open and shows the left dock for default layout knowledge panels', () => {
    workspaceStoreState.workspacePath = '/workspace'
    workspaceStoreState.isPanelOpen = true
    workspaceStoreState.activeTab = 'knowledge'

    render(<App />)

    expect(sidebarState.setOpen).not.toHaveBeenCalledWith(false)
    expect(screen.getByTitle('Back to sidebar')).toBeTruthy()
  })
})
