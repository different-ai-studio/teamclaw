import {
  useEffect,
  useState,
  useRef,
  lazy,
  Suspense,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { cn, isTauri } from "@/lib/utils";
import { buildConfig } from "@/lib/build-config";
import {
  AlertTriangle,
  Terminal,
  ListTodo,
  FolderGit,
  FolderTree,
  ChevronLeft,
  X,
  Loader2,
  Code,
  Bot,
  ChevronDown,
  Plus,
  Bookmark,
  RotateCw,
  MessageSquarePlus,
} from "lucide-react";
// Spotlight window - lazy loaded for spotlight window label
const SpotlightWindow = lazy(() =>
  import("@/components/spotlight/SpotlightWindow").then((m) => ({
    default: m.SpotlightWindow,
  }))
)

// SSE connection provider — must render outside spotlight/main conditional
import { SSEProvider } from "@/components/SSEProvider"

import { FileContentViewer } from "@/components/FileEditor";
import { useNeedsTrafficLightSpacer } from "@/hooks/useTrafficLightSpacer";
import {
  useOpenCodeInit,
  useChannelGatewayInit,
  useGitReposInit,
  useCronInit,
  useExternalLinkHandler,
  useTauriBodyClass,
  useSetupGuide,
  useTelemetryConsent,
  useOpenCodePreload,
  useLayoutModeShortcut,
} from "@/hooks/useAppInit";
import { loadPlugins } from '@/plugins'
import { getPlugins } from '@/plugins/registry'

loadPlugins()
import {
  usePanelAutoOpen,
  useLayoutModePanelSync,
  useFileTabSync,
  useResizablePanels,
} from "@/hooks/useFileEditorState";
import { useMCPFileWatcher } from "@/hooks/useMCPFileWatcher";

import {
  AppSidebar,
  SidebarIconGroup,
  SidebarCollapseToggle,
  SidebarSecondarySessionActions,
} from "@/components/app-sidebar";
import { SettingsSectionBody } from "@/components/settings/section-registry";
import { isWorkspaceUIVariant } from "@/lib/ui-variant";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { UpdateDialogContainer } from "@/components/updater/UpdateDialog";
import { RightPanel, ShortcutsPanel } from "@/components/panel";
import { Settings } from "@/components/settings";
import { FeedbackDialog } from "@/components/settings/FeedbackDialog";
import { SetupGuide } from "@/components/SetupGuide";
import { TelemetryConsentDialog } from "@/components/telemetry/TelemetryConsentDialog";
import { WorkspacePrompt } from "@/components/workspace";
import { WorkspaceTypeDialog } from "@/components/workspace/WorkspaceTypeDialog";
import { OnboardingTour, type OnboardingStep } from "@/components/onboarding";
import { useSessionStore } from "@/stores/session";
import { useUIStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTabsStore, selectActiveTab } from "@/stores/tabs";
import { TabBar } from "@/components/tab-bar/TabBar";
import { TabContentRenderer } from "@/components/tab-bar/TabContentRenderer";
import { WebViewToolbar } from "@/components/tab-bar/WebViewToolbar";
import { urlToLabel } from "@/lib/webview-utils";
import { initOpenCodeClient } from "@/lib/opencode/client";
import {
  startOpenCode,
  clearPreload,
} from "@/lib/opencode/preloader";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TrafficLights } from "@/components/ui/traffic-lights";
import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Main content component - shows chat with tab overlay
// ChatPanel is always mounted to preserve state, hidden when a tab is active
function MainContent() {
  const activeTab = useTabsStore(selectActiveTab);
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const fileContent = useWorkspaceStore((s) => s.fileContent);
  const isLoadingFile = useWorkspaceStore((s) => s.isLoadingFile);
  const clearSelection = useWorkspaceStore((s) => s.clearSelection);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const hasActiveTab = !!activeTab;

  // Track previous active tab to detect tab switches (user clicking a different tab)
  const prevActiveTabId = useRef<string | null>(activeTab?.id ?? null);

  // Sync workspace store when user switches tabs (tab click → load file)
  useEffect(() => {
    const tabChanged = activeTab?.id !== prevActiveTabId.current;
    const hadTab = prevActiveTabId.current !== null;
    prevActiveTabId.current = activeTab?.id ?? null;
    if (tabChanged && activeTab?.type === "file") {
      selectFile(activeTab.target);
    }
    // When active file tab is closed (had a tab → now null), clear selectedFile
    // to prevent stale file re-opening on mode switch
    if (tabChanged && hadTab && !activeTab) {
      clearSelection();
    }
  }, [activeTab?.id, activeTab?.type, activeTab?.target, selectFile, clearSelection]);

  // Sync file selections to tab store (file opened from chat links, file tree, etc.)
  useEffect(() => {
    if (selectedFile) {
      const filename = selectedFile.split("/").pop() || selectedFile;
      useTabsStore.getState().openTab({
        type: "file",
        target: selectedFile,
        label: filename,
      });
    }
  }, [selectedFile]);

  return (
    <div className="relative h-full flex flex-col">
      {/* Tab bar — shown when tabs exist */}
      <TabBar />

      {/* WebView toolbar — shown only when active tab is a webview */}
      {hasActiveTab && activeTab.type === "webview" && (
        <WebViewToolbar
          url={activeTab.target}
          label={urlToLabel(activeTab.target)}
        />
      )}

      <div className="relative flex-1">
        {/* ChatPanel - always mounted, hidden when a tab is active */}
        <div
          className={`absolute inset-0 ${hasActiveTab ? "invisible" : "visible"}`}
        >
          <ErrorBoundary scope="Chat" inline>
            <ChatPanel />
          </ErrorBoundary>
        </div>

        {/* Tab content overlay - shown when a tab is active */}
        {hasActiveTab && (
          <div className={cn(
            "absolute inset-0 z-10",
            activeTab.type === "webview" ? "bg-transparent pointer-events-none" : "bg-background"
          )}>
            {activeTab.type === "file" ? (
              <FileContentViewer
                selectedFile={selectedFile}
                fileContent={fileContent}
                isLoadingFile={isLoadingFile}
                onClose={() => {
                  clearSelection();
                  useTabsStore.getState().closeTab(activeTab.id);
                }}
              />
            ) : (
              <TabContentRenderer />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Header panel tab button component
function HeaderPanelTab({
  icon: Icon,
  label,
  count,
  isActive,
  onClick,
}: {
  icon: typeof ListTodo;
  label: string;
  count: number;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 px-2 py-1 text-xs transition-colors rounded ${
        isActive
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
      {isActive && <span>{label}</span>}
      {count > 0 && (
        <span
          className={`min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-medium flex items-center justify-center ${
            isActive ? "bg-primary/20 text-primary" : "bg-muted-foreground/20"
          }`}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

// WebView toolbar for file mode — only renders when active tab is a webview
function FileModeWebViewToolbar() {
  const activeTab = useTabsStore(selectActiveTab);
  if (!activeTab || activeTab.type !== "webview") return null;
  return <WebViewToolbar url={activeTab.target} label={urlToLabel(activeTab.target)} />;
}

// File mode tab content — renders file viewer for file tabs, delegates to TabContentRenderer for others
function FileModeTabContent() {
  const activeTab = useTabsStore(selectActiveTab);
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const fileContent = useWorkspaceStore((s) => s.fileContent);
  const isLoadingFile = useWorkspaceStore((s) => s.isLoadingFile);
  const clearSelection = useWorkspaceStore((s) => s.clearSelection);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const { t } = useTranslation();

  // Track previous active tab to detect tab switches
  const prevActiveTabId = useRef<string | null>(activeTab?.id ?? null);

  // Sync workspace store when user switches tabs (tab click → load file)
  useEffect(() => {
    const tabChanged = activeTab?.id !== prevActiveTabId.current;
    const hadTab = prevActiveTabId.current !== null;
    prevActiveTabId.current = activeTab?.id ?? null;
    if (tabChanged && activeTab?.type === "file") {
      selectFile(activeTab.target);
    }
    // When active file tab is closed, clear selectedFile
    if (tabChanged && hadTab && !activeTab) {
      clearSelection();
    }
  }, [activeTab?.id, activeTab?.type, activeTab?.target, selectFile, clearSelection]);

  if (!activeTab) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Bookmark className="h-16 w-16 mb-4 opacity-30" />
        <p className="text-sm">
          {t("app.selectFile", "Select a file from the explorer")}
        </p>
      </div>
    );
  }

  if (activeTab.type === "file") {
    return (
      <FileContentViewer
        selectedFile={selectedFile}
        fileContent={fileContent}
        isLoadingFile={isLoadingFile}
        onClose={() => {
          clearSelection();
          useTabsStore.getState().closeTab(activeTab.id);
        }}
      />
    );
  }

  // Webview or native tab
  return <TabContentRenderer />;
}

// Resize handle component for resizable panels
function ResizeHandle({
  onResize,
  direction = "horizontal",
  className = "",
}: {
  onResize: (delta: number) => void;
  direction?: "horizontal" | "vertical";
  className?: string;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef(0);

  const handleMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startPosRef.current = direction === "horizontal" ? e.clientX : e.clientY;

    const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
      const currentPos =
        direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
      const delta = currentPos - startPosRef.current;
      startPosRef.current = currentPos;
      onResize(delta);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor =
      direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className={`
        ${direction === "horizontal" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}
        ${isDragging ? "bg-primary" : "bg-transparent hover:bg-primary/50"}
        transition-colors duration-150 flex-shrink-0 z-20
        ${className}
      `}
      onMouseDown={handleMouseDown}
    >
      {/* Larger hit area */}
      <div
        className={`
          ${direction === "horizontal" ? "w-3 h-full -ml-1" : "h-3 w-full -mt-1"}
        `}
      />
    </div>
  );
}

// Layout toggle button component
function LayoutToggleButton() {
  const { t } = useTranslation();
  const { layoutMode, toggleLayoutMode } = useUIStore();
  const isFileMode = layoutMode === "file";

  // Detect OS for keyboard shortcut display
  const isMac =
    typeof navigator !== "undefined" &&
    navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const shortcutKey = isMac ? "⌘\\" : "Ctrl+\\";

  return (
    <button
      className={`p-1.5 transition-colors rounded ${
        isFileMode
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
      onClick={toggleLayoutMode}
      title={`${isFileMode ? t("app.switchTaskMode", "Switch to Task Mode") : t("app.switchCodeSpace", "Switch to Code Space")} (${shortcutKey})`}
    >
      <Code className="h-4 w-4" />
    </button>
  );
}

/** Full-screen overlay shown when OpenCode server is starting/restarting.
 *  Uses `fixed` positioning to cover the entire viewport (sidebar + content),
 *  blocking all user interaction until the server is ready. */
function ConnectingOverlay() {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <div className="text-center">
          <p className="text-lg font-medium">
            {t("app.connecting", "Connecting to Core Agent...")}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            {t("app.startingServer", "Starting server for workspace")}
          </p>
        </div>
      </div>
    </div>
  );
}

function usePluginInit() {
  getPlugins().forEach(p => p.useInit?.())
}

// Inner component to access sidebar context
function AppContent() {
  const { t } = useTranslation();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Session store - individual selectors
  const getActiveSession = useSessionStore((s) => s.getActiveSession);
  const todos = useSessionStore((s) => s.todos);
  const sessionDiff = useSessionStore((s) => s.sessionDiff);
  const createSession = useSessionStore((s) => s.createSession);
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const reloadActiveSessionMessages = useSessionStore(
    (s) => s.reloadActiveSessionMessages,
  );
  const activeSession = getActiveSession();

  // Workspace store - individual selectors
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openCodeReady = useWorkspaceStore((s) => s.openCodeReady);
  const isPanelOpen = useWorkspaceStore((s) => s.isPanelOpen);
  const activeTab = useWorkspaceStore((s) => s.activeTab);
  const openPanel = useWorkspaceStore((s) => s.openPanel);
  const closePanel = useWorkspaceStore((s) => s.closePanel);
  const clearWorkspace = useWorkspaceStore((s) => s.clearWorkspace);
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const setOpenCodeReady = useWorkspaceStore((s) => s.setOpenCodeReady);

  // UI store - individual selectors
  const currentView = useUIStore((s) => s.currentView);
  const closeSettings = useUIStore((s) => s.closeSettings);
  const layoutMode = useUIStore((s) => s.layoutMode);
  const fileModeRightTab = useUIStore((s) => s.fileModeRightTab);
  const setFileModeRightTab = useUIStore((s) => s.setFileModeRightTab);
  const advancedMode = useUIStore((s) => s.advancedMode);
  const openSettings = useUIStore((s) => s.openSettings);
  const embeddedSettingsSection = useUIStore((s) => s.embeddedSettingsSection);
  const closeEmbeddedSettingsSection = useUIStore(
    (s) => s.closeEmbeddedSettingsSection,
  );
  const isNewWorkspace = useWorkspaceStore((s) => s.isNewWorkspace);
  const setIsNewWorkspace = useWorkspaceStore((s) => s.setIsNewWorkspace);
  const { state, open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
  /** Workspace UI: Shortcuts docks left of chat; other panel tabs use the right column. */
  const shortcutsLeftDock =
    isWorkspaceUIVariant() && isPanelOpen && activeTab === "shortcuts";
  const showRightWorkspacePanel = isPanelOpen && !shortcutsLeftDock;
  const isCollapsed = state === "collapsed";
  /** Native traffic lights sit over the left column; spare inset header when Shortcuts owns that strip. */
  const hideInsetChromeForShortcutsDock =
    shortcutsLeftDock && isWorkspaceUIVariant() && currentView !== "settings";
  const collapsedInsetLeading = isCollapsed ? (
    hideInsetChromeForShortcutsDock ? null : (
      <>
        {(!shortcutsLeftDock || currentView === "settings") && <TrafficLights />}
        {isWorkspaceUIVariant() ? (
          <>
            <SidebarCollapseToggle className="mr-0.5" />
            <SidebarSecondarySessionActions className="mr-2" newChatOnly />
          </>
        ) : (
          <SidebarIconGroup className="mr-2" />
        )}
        <Separator
          orientation="vertical"
          className="data-[orientation=vertical]:h-4 mr-2"
        />
      </>
    )
  ) : null;
  const needsTrafficLightSpacer = useNeedsTrafficLightSpacer();
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false);
  const mainWorkspaceOnboardingSteps: OnboardingStep[] = [
    {
      target: '[data-onboarding-id="main-sidebar"]',
      title: t("onboarding.main.sidebarTitle", "Session sidebar"),
      description: t(
        "onboarding.main.sidebarBody",
        "Use the left sidebar to create a new chat, switch tasks, and find earlier conversations.",
      ),
    },
    {
      target: '[data-onboarding-id="main-chat-area"]',
      title: t("onboarding.main.chatTitle", "Work from the chat center"),
      description: t(
        "onboarding.main.chatBody",
        "Describe what you want in plain language here. Most tasks can start with a sentence instead of a command.",
      ),
    },
    {
      target: '[data-onboarding-id="workspace-panel-tabs"]',
      title: t("onboarding.main.panelTitle", "Open the helper panels"),
      description: t(
        "onboarding.main.panelBody",
        "This area opens tasks and helper panels. If advanced mode is enabled, file and change views will also appear here.",
      ),
    },
    {
      target: '[data-onboarding-id="chat-input-root"]',
      title: t("onboarding.chatInput.inputTitle", "Describe the task here"),
      description: t(
        "onboarding.chatInput.inputBody",
        "You can start with a plain sentence like asking for analysis, code changes, or a summary of the current project.",
      ),
    },
    {
      target: '[data-onboarding-id="chat-input-files"]',
      title: t("onboarding.chatInput.filesTitle", "Attach files when useful"),
      description: t(
        "onboarding.chatInput.filesBody",
        "Use this button to add files or screenshots so the assistant can work with concrete context.",
      ),
    },
    {
      target: '[data-onboarding-id="chat-input-submit"]',
      title: t("onboarding.chatInput.submitTitle", "Send or stop here"),
      description: t(
        "onboarding.chatInput.submitBody",
        "Send your request from here. If the assistant is already working, the same area lets you stop and retry.",
      ),
    },
  ];

  // Extracted hooks — initialization, panel state, keyboard shortcuts
  const { openCodeError, setOpenCodeError, initialWorkspaceResolved } = useOpenCodeInit();
  useChannelGatewayInit();
  useGitReposInit();
  useCronInit();
  usePluginInit();
  useMCPFileWatcher(workspacePath);
  useExternalLinkHandler();
  useLayoutModeShortcut();
  usePanelAutoOpen();
  useLayoutModePanelSync();
  useFileTabSync();
  const { rightPanelWidth, handleRightPanelResize } = useResizablePanels();

  /** When Shortcuts opens in workspace UI, hide the main sidebar first; restore prior expansion when it closes. */
  const restoreSidebarAfterShortcutsRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!isWorkspaceUIVariant()) {
      restoreSidebarAfterShortcutsRef.current = null;
      return;
    }
    if (shortcutsLeftDock) {
      if (restoreSidebarAfterShortcutsRef.current === null) {
        // Remember whether to re-expand when Shortcuts closes; collapse only if needed.
        restoreSidebarAfterShortcutsRef.current = sidebarOpen;
        if (sidebarOpen) {
          setSidebarOpen(false);
        }
      } else if (sidebarOpen) {
        // User expanded the session sidebar while Shortcuts is open — exit Shortcuts.
        closePanel();
      }
    } else {
      const shouldExpand = restoreSidebarAfterShortcutsRef.current === true;
      restoreSidebarAfterShortcutsRef.current = null;
      if (shouldExpand) {
        setSidebarOpen(true);
      }
    }
  }, [shortcutsLeftDock, sidebarOpen, setSidebarOpen, closePanel]);

  // Full-screen loading overlay when OpenCode server is starting/restarting
  const showConnectingOverlay =
    workspacePath && !openCodeReady && !openCodeError && isTauri();

  // If settings is open, show settings page (check first so it works regardless of workspace state)
  if (currentView === "settings") {
    return (
      <>
        {/* Global connecting overlay — fixed to viewport, covers sidebar + content */}
        {showConnectingOverlay && <ConnectingOverlay />}
        <AppSidebar />
        <SidebarInset className="flex h-svh flex-col overflow-hidden">
          {/* Header for settings - with traffic light space when collapsed */}
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg"
              onClick={closeSettings}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="font-medium">
              {t("common.settings", "Settings")}
            </span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
              onClick={() => setFeedbackOpen(true)}
            >
              <MessageSquarePlus className="h-4 w-4" />
              {t('settings.feedback.title', 'Send Feedback')}
            </Button>
          </header>
          <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
          <div className="flex-1 overflow-hidden">
            <Settings />
          </div>
        </SidebarInset>
      </>
    );
  }

  if (!initialWorkspaceResolved) {
    return (
      <>
        <AppSidebar />
        <SidebarInset className="flex h-svh flex-col overflow-hidden">
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}
            <span className="font-medium">{buildConfig.app.name}</span>
          </header>
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SidebarInset>
      </>
    );
  }

  // If no workspace selected, show workspace prompt
  if (!workspacePath) {
    return (
      <>
        <AppSidebar />
        <SidebarInset className="flex h-svh flex-col overflow-hidden">
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}
            <span className="font-medium">{buildConfig.app.name}</span>
          </header>
          <div className="flex-1 overflow-hidden">
            <WorkspacePrompt />
          </div>
        </SidebarInset>
      </>
    );
  }

  // If there's an OpenCode error (e.g., workspace mismatch in dev mode)
  if (openCodeError) {
    return (
      <>
        <AppSidebar />
        <SidebarInset className="flex h-svh flex-col overflow-hidden">
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}
            <span className="font-medium">{buildConfig.app.name}</span>
          </header>
          <div className="flex-1 overflow-hidden flex flex-col items-center justify-center gap-6 p-8">
            <div className="flex flex-col items-center gap-4 text-center max-w-lg">
              <div className="rounded-full bg-amber-100 p-4">
                <AlertTriangle className="h-12 w-12 text-amber-600" />
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold">
                  OpenCode Server Configuration Error
                </h2>
                <div className="text-sm text-muted-foreground whitespace-pre-wrap text-left bg-muted p-4 rounded-lg font-mono">
                  {openCodeError}
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => clearWorkspace()}>
                {t("app.chooseDirectory", "Choose Another Directory")}
              </Button>
              <Button
                onClick={async () => {
                  setOpenCodeError(null);
                  if (!isTauri()) {
                    console.log(
                      "[Web Mode] Cannot start OpenCode from browser",
                    );
                    return;
                  }
                  try {
                    // Clear stale preload so we get a fresh invocation
                    clearPreload();
                    const status = await startOpenCode(workspacePath!);
                    console.log("[OpenCode] Server started:", status);
                    initOpenCodeClient({ baseUrl: status.url });
                    setOpenCodeReady(true, status.url);
                  } catch (error) {
                    setOpenCodeError(String(error));
                  }
                }}
              >
                {t("app.retryConnection", "Retry Connection")}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Terminal className="h-3 w-3" />
              {t(
                "app.retryConnectionTip",
                'Tip: Restart OpenCode server with the command above, then click "Retry Connection"',
              )}
            </p>
          </div>
        </SidebarInset>
      </>
    );
  }

  // File Mode: Completely different layout without sidebar
  if (layoutMode === "file") {
    return (
      <div className="flex h-svh w-full flex-col overflow-hidden bg-background">
        {/* Global connecting overlay — fixed to viewport, covers everything */}
        {showConnectingOverlay && <ConnectingOverlay />}
        {/* Header for file mode */}
        <header
          className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background border-b px-4"
          data-tauri-drag-region
        >
          {needsTrafficLightSpacer && <TrafficLights />}

          {/* Layout toggle - before TeamClaw */}
          {advancedMode && <LayoutToggleButton />}

          <span className="text-sm font-medium">{buildConfig.app.name}</span>
          <Separator
            orientation="vertical"
            className="data-[orientation=vertical]:h-4 mx-2"
          />

          {/* Current file path */}
          <span className="text-sm text-muted-foreground truncate flex-1">
            {selectedFile
              ? selectedFile.split("/").slice(-2).join("/")
              : t("app.noFileSelected", "No file selected")}
          </span>

          {/* Right panel tabs */}
          <div className="ml-auto flex items-center gap-1">
            <HeaderPanelTab
              icon={Bookmark}
              label={t("navigation.shortcuts", "Shortcuts")}
              count={0}
              isActive={fileModeRightTab === "shortcuts"}
              onClick={() => setFileModeRightTab("shortcuts")}
            />
            <HeaderPanelTab
              icon={ListTodo}
              label={t("navigation.tasks", "Tasks")}
              count={
                todos.filter(
                  (t) => t.status !== "completed" && t.status !== "cancelled",
                ).length
              }
              isActive={fileModeRightTab === "tasks"}
              onClick={() => setFileModeRightTab("tasks")}
            />
            <HeaderPanelTab
              icon={FolderGit}
              label={t("navigation.changes", "Changes")}
              count={sessionDiff.length}
              isActive={fileModeRightTab === "changes"}
              onClick={() => setFileModeRightTab("changes")}
            />
            <HeaderPanelTab
              icon={FolderTree}
              label={t("navigation.files", "Files")}
              count={0}
              isActive={fileModeRightTab === "files"}
              onClick={() => setFileModeRightTab("files")}
            />
            <HeaderPanelTab
              icon={Bot}
              label={t("navigation.agent", "Agent")}
              count={0}
              isActive={fileModeRightTab === "agent"}
              onClick={() => setFileModeRightTab("agent")}
            />
          </div>
        </header>

        {/* File Mode: 2-panel layout with resizable panels */}
        <div className="relative flex flex-1 w-full overflow-hidden">
          {/* Center - TabBar + Content */}
          <div className="relative overflow-hidden flex-1 min-w-[200px] flex flex-col">
            <TabBar />
            <FileModeWebViewToolbar />
            <div className="flex-1 relative overflow-hidden">
              <FileModeTabContent />
            </div>
          </div>

          {/* Right resize handle */}
          <ResizeHandle
            direction="horizontal"
            onResize={handleRightPanelResize}
            className="border-l border-border"
          />

          {/* Right Panel (resizable) */}
          <div
            className="bg-background overflow-hidden flex flex-col shrink-0"
            style={{ width: rightPanelWidth }}
          >
            {/* Panel header — Agent tab has session dropdown + new session button */}
            <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
              {fileModeRightTab === "agent" ? (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="flex items-center gap-1 text-xs font-medium text-foreground hover:bg-muted px-1.5 py-0.5 rounded transition-colors truncate max-w-[200px]">
                        <span className="truncate">
                          {activeSession?.title || t("chat.newChat", "New Chat")}
                        </span>
                        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56 max-h-64 overflow-y-auto">
                      {sessions.slice(0, 20).map((s) => (
                        <DropdownMenuItem
                          key={s.id}
                          className={cn(
                            "text-xs truncate",
                            s.id === activeSession?.id && "bg-accent"
                          )}
                          onClick={() => setActiveSession(s.id)}
                        >
                          {s.title || t("chat.newChat", "New Chat")}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    onClick={() => createSession()}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    title={t("app.newSession", "New Session")}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <span className="text-xs font-medium text-foreground">
                  {(() => {
                    switch (fileModeRightTab) {
                      case "shortcuts": return t("navigation.shortcuts", "Shortcuts");
                      case "tasks": return t("navigation.tasks", "Tasks");
                      case "changes": return t("navigation.changes", "Changes");
                      default: return t("navigation.files", "Files");
                    }
                  })()}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-hidden relative">
              {fileModeRightTab === "shortcuts" && (
                <ShortcutsPanel />
              )}
              {fileModeRightTab === "agent" && (
                <ErrorBoundary scope="Chat" inline>
                  <ChatPanel compact />
                </ErrorBoundary>
              )}
              {fileModeRightTab === "changes" && (
                <RightPanel defaultTab="diff" compact />
              )}
              {fileModeRightTab === "tasks" && (
                <RightPanel defaultTab="tasks" compact />
              )}
              {fileModeRightTab === "files" && (
                <RightPanel defaultTab="files" compact />
              )}
            </div>
          </div>
        </div>
        <WorkspaceTypeDialog
          open={isNewWorkspace}
          onSelectPersonal={() => setIsNewWorkspace(false)}
          onSelectTeam={() => {
            setIsNewWorkspace(false);
            openSettings('team');
          }}
        />
      </div>
    );
  }

  // Task Mode: Standard layout with sidebar
  return (
    <>
      {/* Global connecting overlay — fixed to viewport, covers sidebar + content */}
      {showConnectingOverlay && <ConnectingOverlay />}
      <AppSidebar />
      <SidebarInset className="flex flex-row h-svh overflow-hidden relative">
        {isWorkspaceUIVariant() && (
          <div
            className={cn(
              "shrink-0 overflow-hidden border-border bg-background transition-[width,opacity,transform] duration-500 ease-out",
              shortcutsLeftDock
                ? "w-(--sidebar-width) translate-x-0 border-r opacity-100"
                : "pointer-events-none w-0 -translate-x-4 border-r-0 opacity-0",
            )}
          >
            <div className="flex h-full w-(--sidebar-width) flex-col overflow-hidden bg-background">
              {shortcutsLeftDock && (
                <>
                  <div
                    className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-2"
                    data-tauri-drag-region
                  >
                    <TrafficLights />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 rounded-lg"
                      onClick={() => closePanel()}
                      title={t("shortcuts.backToSidebar", "Back to sidebar")}
                      aria-label={t(
                        "shortcuts.backToSidebar",
                        "Back to sidebar",
                      )}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="min-w-0 truncate text-sm font-medium">
                      {t("navigation.shortcuts", "Shortcuts")}
                    </span>
                    <div className="min-w-0 flex-1" data-tauri-drag-region />
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <RightPanel todos={todos} diff={sessionDiff} />
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {/* Main column: header + main content */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
          {/* Header with breadcrumb - sticky */}
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}

            {embeddedSettingsSection ? (
              <>
                {advancedMode && <LayoutToggleButton />}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 rounded-lg"
                  onClick={closeEmbeddedSettingsSection}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="min-w-0 truncate text-sm font-medium">
                  {embeddedSettingsSection === "automation"
                    ? t("settings.nav.automation", "Automation")
                    : t("settings.nav.skills", "Skills")}
                </span>
                <div className="min-w-0 flex-1" />
              </>
            ) : (
              <>
                {advancedMode && <LayoutToggleButton />}
                <span className="min-w-0 truncate text-sm">
                  {activeSession?.title || t("chat.newChat", "New Chat")}
                </span>
                {activeSession && (
                  <button
                    onClick={async () => {
                      setIsRefreshingMessages(true);
                      await reloadActiveSessionMessages();
                      setIsRefreshingMessages(false);
                    }}
                    className="ml-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title={t("chat.refreshMessages", "Refresh messages")}
                  >
                    <RotateCw
                      className={cn(
                        "h-3.5 w-3.5",
                        isRefreshingMessages && "animate-spin",
                      )}
                    />
                  </button>
                )}
              </>
            )}

            {/* Panel tabs - right side of header (Shortcuts lives in sidebar when workspace UI variant) */}
            <div className="ml-auto flex shrink-0 items-center gap-0.5" data-onboarding-id="workspace-panel-tabs">
              {!isWorkspaceUIVariant() && (
                <HeaderPanelTab
                  icon={Bookmark}
                  label={t("navigation.shortcuts", "Shortcuts")}
                  count={0}
                  isActive={isPanelOpen && activeTab === "shortcuts"}
                  onClick={() => isPanelOpen && activeTab === "shortcuts" ? closePanel() : openPanel("shortcuts")}
                />
              )}
              <HeaderPanelTab
                icon={ListTodo}
                label={t("navigation.tasks", "Tasks")}
                count={
                  todos.filter(
                    (t) => t.status !== "completed" && t.status !== "cancelled",
                  ).length
                }
                isActive={isPanelOpen && activeTab === "tasks"}
                onClick={() => isPanelOpen && activeTab === "tasks" ? closePanel() : openPanel("tasks")}
              />
              {advancedMode && (
                <HeaderPanelTab
                  icon={FolderGit}
                  label={t("navigation.changes", "Changes")}
                  count={sessionDiff.length}
                  isActive={isPanelOpen && activeTab === "diff"}
                  onClick={() => isPanelOpen && activeTab === "diff" ? closePanel() : openPanel("diff")}
                />
              )}
              {advancedMode && (
                <HeaderPanelTab
                  icon={FolderTree}
                  label={t("navigation.files", "Files")}
                  count={0}
                  isActive={isPanelOpen && activeTab === "files"}
                  onClick={() => isPanelOpen && activeTab === "files" ? closePanel() : openPanel("files")}
                />
              )}
              {isPanelOpen && (
                <button
                  className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={closePanel}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </header>

          {/* Main content - Chat, file preview, or embedded settings section */}
          <div
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
            data-onboarding-id="main-chat-area"
          >
            {embeddedSettingsSection ? (
              <SettingsSectionBody section={embeddedSettingsSection} />
            ) : (
              <MainContent />
            )}
          </div>
        </div>

        {/* Right Panel - full height (Shortcuts use left dock in workspace UI) */}
        <div
          className={cn(
            "shrink-0 overflow-hidden border-l border-border bg-background transition-[width,opacity,transform] duration-500 ease-out",
            showRightWorkspacePanel
              ? "w-72 translate-x-0 opacity-100"
              : "pointer-events-none w-0 translate-x-4 border-l-0 opacity-0",
          )}
        >
          <div className="h-full w-72">
            {showRightWorkspacePanel && (
              <RightPanel todos={todos} diff={sessionDiff} />
            )}
          </div>
        </div>
      </SidebarInset>
      <OnboardingTour
        id="main-workspace"
        enabled={
          !!workspacePath &&
          !embeddedSettingsSection
        }
        steps={mainWorkspaceOnboardingSteps}
      />
      <WorkspaceTypeDialog
        open={isNewWorkspace}
        onSelectPersonal={() => setIsNewWorkspace(false)}
        onSelectTeam={() => {
          setIsNewWorkspace(false);
          openSettings('team');
        }}
      />
    </>
  );
}

function App() {
  // ── Spotlight mode from UI store ──────────────────────────────────────
  const spotlightMode = useUIStore((s) => s.spotlightMode)

  // ── Initialize tauri-plugin-mcp event listeners (dev only) ──
  useEffect(() => {
    if (!isTauri() || import.meta.env.PROD) return;
    // Dynamic import — module only exists in Tauri dev; externalized in prod builds
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    import(/* @vite-ignore */ 'tauri-plugin-mcp').then((mod: { setupPluginListeners?: () => void }) => {
      mod.setupPluginListeners?.();
      console.log('[App] tauri-plugin-mcp listeners initialized');
    }).catch(() => {});
  }, []);

  // Extracted hooks — initialization, setup guide, telemetry consent, preload
  useTauriBodyClass();
  useOpenCodePreload();
  const openCodeReady = useWorkspaceStore((s) => s.openCodeReady);
  const { showSetupGuide, dependencies, handleRecheck, handleSetupContinue } = useSetupGuide(openCodeReady);
  const { showConsentDialog, setShowConsentDialog } = useTelemetryConsent(showSetupGuide);
  const devUnlocked = useUIStore(s => s.devUnlocked)

  if (spotlightMode) {
    return (
      <>
        <SSEProvider />
        <Suspense fallback={<div className="h-screen w-screen rounded-2xl overflow-hidden" />}>
          <div className="h-screen w-screen rounded-2xl overflow-hidden">
            <SpotlightWindow />
          </div>
        </Suspense>
      </>
    )
  }

  const mainContent = (
    <>
      {showSetupGuide && (
        <SetupGuide
          dependencies={dependencies}
          onRecheck={handleRecheck}
          onContinue={handleSetupContinue}
        />
      )}
      {!showSetupGuide && (
        <>
          <SidebarProvider
            style={
              {
                "--sidebar-width": "320px",
              } as React.CSSProperties
            }
          >
            <AppContent />
          </SidebarProvider>
          <Toaster position="bottom-right" richColors />
          <UpdateDialogContainer />
          <TelemetryConsentDialog
            open={showConsentDialog}
            onComplete={() => setShowConsentDialog(false)}
          />
        </>
      )}
    </>
  )

  return isTauri() ? (
    <div className="h-screen w-screen rounded-2xl overflow-hidden bg-background">
      <SSEProvider />
      {mainContent}
      {devUnlocked && (
        <div className="fixed bottom-2 right-2 z-50 text-[10px] font-mono font-bold text-orange-500 bg-orange-500/10 border border-orange-500/30 px-1.5 py-0.5 rounded pointer-events-none">
          DEV
        </div>
      )}
    </div>
  ) : (
    <>
      <SSEProvider />
      {mainContent}
    </>
  )
}

export default App;
