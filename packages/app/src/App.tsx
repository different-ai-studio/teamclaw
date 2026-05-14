import {
  useEffect,
  useState,
  useRef,
  lazy,
  Suspense,
  MouseEvent as ReactMouseEvent,
  type ComponentType,
} from "react";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { cn, isTauri } from "@/lib/utils";
import { buildConfig } from "@/lib/build-config";
import {
  AlertTriangle,
  Terminal,
  BookOpen,
  FolderGit,
  FolderTree,
  ChevronLeft,
  X,
  Loader2,
  Bot,
  ChevronDown,
  Plus,
  Bookmark,
  RotateCw,
  MessageSquarePlus,
  AppWindow,
  Users,
  TerminalSquare,
} from "lucide-react";
// Spotlight window - lazy loaded for spotlight window label
const SpotlightWindow = lazy(() =>
  import("@/components/spotlight/SpotlightWindow").then((m) => ({
    default: m.SpotlightWindow,
  }))
)

import { FileContentViewer } from "@/components/FileEditor";
import { useNeedsTrafficLightSpacer } from "@/hooks/useTrafficLightSpacer";
import {
  useWorkspaceInit,
  useChannelGatewayInit,
  useGitReposInit,
  useCronInit,
  useOssSyncInit,
  useP2pAutoReconnect,

  useExternalLinkHandler,
  useTauriBodyClass,
  useSetupGuide,
  useTelemetryConsent,
  useLayoutModeShortcut,
} from "@/hooks/useAppInit";
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
import { SessionListColumn } from "@/components/sidebar/SessionListColumn";
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
import { useSessionListStore } from "@/stores/session-list-store";
import { useAuthStore } from "@/stores/auth-store";
import { mqttConnect, mqttSubscribe, listenForEnvelopes } from "@/lib/mqtt-bridge";
import { initTeamclawRpc, disposeTeamclawRpc } from "@/lib/teamclaw-rpc";
import { decodeLiveEvent, sessionIdFromTopic } from "@/lib/teamclaw-events";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { initRuntimeStateStore, disposeRuntimeStateStore } from "@/stores/runtime-state-store";
import { supabase } from "@/lib/supabase-client";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageSchema, MessageKind } from "@/lib/proto/teamclaw_pb";
import { useUIStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTabsStore, selectActiveTab, selectHasHiddenTabs } from "@/stores/tabs";
import { useTerminalStore } from "@/stores/terminal-store";
import { TabBar } from "@/components/tab-bar/TabBar";
import { TabContentRenderer } from "@/components/tab-bar/TabContentRenderer";
import { WebViewToolbar } from "@/components/tab-bar/WebViewToolbar";
import { FindInPageBar } from "@/components/tab-bar/FindInPageBar";
import { urlToLabel } from "@/lib/webview-utils";
import { create } from "zustand";
import {
  insertAgentRuntimeEvent,
  loadAgentRuntimeEvents,
  upsertMessagesBatch,
  type MessageRow,
} from "@/lib/local-cache";
import { syncActorsForTeam } from "@/lib/sync/actor-sync";
import { syncMessagesForSession } from "@/lib/sync/message-sync";
import { syncParticipantsForSession } from "@/lib/sync/session-participant-sync";
import { syncSessionsForTeam } from "@/lib/sync/session-sync";
import { Button } from "@/components/ui/button";

// Module-level set of session/live topics we've already MQTT-subscribed to.
// Lives outside the React tree so that the App.tsx mount effect + the
// per-row sync effect + ChatPanel.handlePickerConfirm can share a single
// dedup gate. mqttSubscribe is idempotent broker-side but we avoid sending
// duplicate SUBSCRIBE packets here.
export const subscribedSessionTopics = new Set<string>();

/** How many most-recent sessions get auto-subscribed on boot / list reload.
 * Older sessions subscribe lazily when the user opens them (see the
 * activeSessionId effect in AppContent). */
const RECENT_SESSION_SUBSCRIBE_CAP = 10;

/** Subscribe to a session's live topic, idempotently. */
export async function ensureSessionLiveSubscribed(teamId: string, sessionId: string): Promise<void> {
  const topic = `amux/${teamId}/session/${sessionId}/live`;
  if (subscribedSessionTopics.has(topic)) return;
  subscribedSessionTopics.add(topic);
  try {
    await mqttSubscribe(topic);
  } catch (e) {
    subscribedSessionTopics.delete(topic);
    console.warn('[MQTT] subscribe failed', topic, e);
    throw e;
  }
}
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

// ── Webview UI micro-store (find bar + zoom levels) ────────────────────────
const useWebviewUIStore = create<{
  showFind: boolean
  zoomLevels: Record<string, number>
  setShowFind: (v: boolean) => void
  setZoomLevel: (label: string, level: number) => void
}>((set, get) => ({
  showFind: false,
  zoomLevels: {},
  setShowFind: (v) => set({ showFind: v }),
  setZoomLevel: (label, level) =>
    set({ zoomLevels: { ...get().zoomLevels, [label]: level } }),
}))

/**
 * Global keyboard shortcuts (Cmd+F, Cmd+/-/0) and context menu listener
 * for webview tabs. Registered once, reads active tab from tabs store.
 */
function useWebviewShortcuts() {
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const activeTab = useTabsStore.getState().getActiveTab()
      if (!activeTab || activeTab.type !== "webview") return
      if (!isTauri()) return

      const mod = e.metaKey || e.ctrlKey
      const webviewLabel = urlToLabel(activeTab.target)
      const { setShowFind, setZoomLevel, zoomLevels } =
        useWebviewUIStore.getState()

      if (mod && e.key === "f") {
        e.preventDefault()
        setShowFind(true)
        return
      }

      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault()
        const cur = zoomLevels[webviewLabel] ?? 1.0
        const next = Math.min(Math.round((cur + 0.1) * 10) / 10, 2.0)
        setZoomLevel(webviewLabel, next)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", { label: webviewLabel, level: next }).catch(
            () => {}
          )
        })
        return
      }

      if (mod && e.key === "-") {
        e.preventDefault()
        const cur = zoomLevels[webviewLabel] ?? 1.0
        const next = Math.max(Math.round((cur - 0.1) * 10) / 10, 0.5)
        setZoomLevel(webviewLabel, next)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", { label: webviewLabel, level: next }).catch(
            () => {}
          )
        })
        return
      }

      if (mod && e.key === "0") {
        e.preventDefault()
        setZoomLevel(webviewLabel, 1.0)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", {
            label: webviewLabel,
            level: 1.0,
          }).catch(() => {})
        })
        return
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])
}

function useTerminalShortcuts() {
  const togglePanel = useTerminalStore(s => s.togglePanel);
  const openTerminal = useTerminalStore(s => s.openTerminal);
  const closeTerminal = useTerminalStore(s => s.closeTerminal);
  const workspacePath = useWorkspaceStore(s => s.workspacePath);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!workspacePath) return;
      const mod = e.metaKey || e.ctrlKey;

      // Ctrl + ` (backtick) — toggle terminal panel
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        togglePanel(workspacePath);
        return;
      }

      // Only act on Cmd+T / Cmd+W when focus is inside a terminal viewport.
      const focused = document.activeElement;
      const inTerminal = focused?.closest?.(".xterm") != null;
      if (!inTerminal) return;

      if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        void openTerminal(workspacePath, {
          cwd: workspacePath,
          allowedRoots: [workspacePath],
        });
        return;
      }

      if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const state = useTerminalStore.getState();
        const activeId = state.activeTabByWorkspace[workspacePath];
        if (activeId) void closeTerminal(activeId);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspacePath, togglePanel, openTerminal, closeTerminal]);
}

// Main content component - shows chat with tab overlay
// ChatPanel is always mounted to preserve state, hidden when a tab is active
function MainContent() {
  const activeTab = useTabsStore(selectActiveTab);
  const mainContentLayout = useUIStore((s) => s.mainContentLayout);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [splitContainerWidth, setSplitContainerWidth] = useState(0);
  const mainSplitLeftMaxWidth =
    splitContainerWidth > 0 ? Math.max(360, splitContainerWidth - 280) : undefined;
  const { mainSplitLeftWidth, handleMainSplitResize } = useResizablePanels({
    mainSplitLeftMaxWidth,
  });
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const fileContent = useWorkspaceStore((s) => s.fileContent);
  const isLoadingFile = useWorkspaceStore((s) => s.isLoadingFile);
  const clearSelection = useWorkspaceStore((s) => s.clearSelection);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const showFind = useWebviewUIStore((s) => s.showFind)
  const zoomLevels = useWebviewUIStore((s) => s.zoomLevels)
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

  useEffect(() => {
    if (mainContentLayout !== "split") return;
    const container = splitContainerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setSplitContainerWidth(container.getBoundingClientRect().width);
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [mainContentLayout]);

  const fileArea = (
    <div className="relative h-full flex flex-col">
      <TabBar />
      {hasActiveTab && activeTab.type === "webview" && (
        <WebViewToolbar
          url={activeTab.target}
          label={urlToLabel(activeTab.target)}
          zoomLevel={zoomLevels[urlToLabel(activeTab.target)]}
        />
      )}
      {hasActiveTab && activeTab.type === "webview" && showFind && (
        <FindInPageBar
          label={urlToLabel(activeTab.target)}
          onClose={() => useWebviewUIStore.getState().setShowFind(false)}
        />
      )}
      <div className="relative flex-1">
        {hasActiveTab ? (
          <div className={cn(
            "absolute inset-0",
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
        ) : (
          mainContentLayout === "split" ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a file or web tab
            </div>
          ) : null
        )}
      </div>
    </div>
  );

  if (mainContentLayout === "split") {
    return (
      <div
        ref={splitContainerRef}
        className="flex h-full min-h-0 overflow-hidden bg-background"
        data-testid="main-content-split"
      >
        <div
          className="min-w-0 shrink-0 overflow-hidden border-r border-border bg-background"
          style={{ width: mainSplitLeftWidth }}
        >
          {fileArea}
        </div>
        <ResizeHandle
          onResize={handleMainSplitResize}
          className="bg-border/60 hover:bg-primary/50"
          testId="main-content-split-resize-handle"
        />
        <div className="relative min-w-0 flex-1 overflow-hidden bg-background">
          <ErrorBoundary scope="Chat" inline>
            <ChatPanel />
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col">
      {fileArea}
      <div className={`absolute inset-0 ${hasActiveTab ? "invisible" : "visible"}`}>
        <ErrorBoundary scope="Chat" inline>
          <ChatPanel />
        </ErrorBoundary>
      </div>
    </div>
  );
}

// Terminal toggle button in header
function TerminalToggleButton({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const terminalOpen = useTerminalStore(
    s => Boolean(s.panelOpenByWorkspace[workspacePath]),
  );
  const togglePanel = useTerminalStore(s => s.togglePanel);
  return (
    <button
      className={cn(
        "ml-1 rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
        terminalOpen ? "bg-muted text-foreground" : "text-muted-foreground",
      )}
      onClick={() => togglePanel(workspacePath)}
      title={t("terminal.toggle", "Toggle terminal (⌃`)")}
    >
      <TerminalSquare className="h-4 w-4" />
    </button>
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
  icon: ComponentType<{ className?: string }>;
  label: string;
  count?: number;
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
      {!!count && count > 0 && (
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
  const showFind = useWebviewUIStore((s) => s.showFind)
  const zoomLevels = useWebviewUIStore((s) => s.zoomLevels)
  if (!activeTab || activeTab.type !== "webview") return null;
  const webviewLabel = urlToLabel(activeTab.target)
  return (
    <>
      <WebViewToolbar url={activeTab.target} label={webviewLabel} zoomLevel={zoomLevels[webviewLabel]} />
      {showFind && (
        <FindInPageBar label={webviewLabel} onClose={() => useWebviewUIStore.getState().setShowFind(false)} />
      )}
    </>
  );
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
  testId,
}: {
  onResize: (delta: number) => void;
  direction?: "horizontal" | "vertical";
  className?: string;
  testId?: string;
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
      data-testid={testId}
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


// Inner component to access sidebar context
function AppContent() {
  const { t } = useTranslation();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Session store - individual selectors. Note: we subscribe to the
  // *result* of getActiveSession() so re-renders fire when currentSessionId
  // / sessions change. Subscribing to the function ref alone never
  // re-renders since the ref is stable.
  const activeSession = useSessionStore((s) => s.getActiveSession());
  const sessionDiff = useSessionStore((s) => s.sessionDiff);
  const sessions = useSessionStore((s) => s.sessions);
  const reloadActiveSessionMessages = useSessionStore(
    (s) => s.reloadActiveSessionMessages,
  );

  // Workspace store - individual selectors
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isPanelOpen = useWorkspaceStore((s) => s.isPanelOpen);
  const activeTab = useWorkspaceStore((s) => s.activeTab);
  const openPanel = useWorkspaceStore((s) => s.openPanel);
  const closePanel = useWorkspaceStore((s) => s.closePanel);
  const clearWorkspace = useWorkspaceStore((s) => s.clearWorkspace);
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);

  // UI store - individual selectors
  const currentView = useUIStore((s) => s.currentView);
  const closeSettings = useUIStore((s) => s.closeSettings);
  const layoutMode = useUIStore((s) => s.layoutMode);
  const fileModeRightTab = useUIStore((s) => s.fileModeRightTab);
  const setFileModeRightTab = useUIStore((s) => s.setFileModeRightTab);
  const mainContentLayout = useUIStore((s) => s.mainContentLayout);
  const openSettings = useUIStore((s) => s.openSettings);
  const isNewWorkspace = useWorkspaceStore((s) => s.isNewWorkspace);
  const setIsNewWorkspace = useWorkspaceStore((s) => s.setIsNewWorkspace);
  const { state, open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
  const hasActiveFileTab = !!useTabsStore(selectActiveTab);
  const hasHiddenTabs = useTabsStore(selectHasHiddenTabs);
  const workspaceUIVariant = isWorkspaceUIVariant();
  /** Shortcuts open in the left dock for both shells.
   * Only the workspace shell temporarily replaces the sidebar with that dock.
   * Knowledge pops out from the right (via the top-right Knowledge icon). */
  const leftDockActive =
    isPanelOpen &&
    activeTab === "shortcuts";
  const showRightWorkspacePanel = isPanelOpen && !leftDockActive;
  const isCollapsed = state === "collapsed";
  /** Native traffic lights sit over the left column; spare inset header when left dock owns that strip. */
  const hideInsetChromeForLeftDock =
    leftDockActive && currentView !== "settings";
  // In workspace mode, SessionListColumn always sits to the left of SidebarInset
  // and renders its own traffic-light + collapse strip when the sidebar is
  // closed, so the chat header should NOT re-render that strip there.
  const collapsedInsetLeading = isCollapsed && !workspaceUIVariant ? (
    hideInsetChromeForLeftDock ? null : (
      <>
        {(!leftDockActive || currentView === "settings") && <TrafficLights />}
        <SidebarIconGroup className="mr-2" />
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
  const { initialWorkspaceResolved } = useWorkspaceInit();
  useChannelGatewayInit();
  useGitReposInit();
  useCronInit();
  useOssSyncInit();
  useP2pAutoReconnect();
  useMCPFileWatcher(workspacePath);
  useExternalLinkHandler();
  useLayoutModeShortcut();
  usePanelAutoOpen();
  useLayoutModePanelSync();
  useFileTabSync();
  const { rightPanelWidth, handleRightPanelResize } = useResizablePanels();

  // v2 Phase 1: load session list from Supabase once AppContent mounts
  // (i.e. after auth is verified). Phase 2 will replace with realtime sub.
  useEffect(() => {
    void useSessionListStore.getState().load();
  }, []);

  // v2 Phase 1 — Task 1D.4: connect MQTT after auth, subscribe to all teams'
  // session live topics, decode incoming LiveEventEnvelope and append to
  // useSessionStore so ActorMessageList re-renders. The orphan
  // session-event-bus.ts is bypassed: we write straight to the store the UI
  // reads from.
  const userId = useAuthStore((s) => s.session?.user.id ?? null);
  // Wait for session list to populate so we have a real team_id for LWT —
  // the broker's ACL is keyed on team_id and rejects placeholders.
  const firstTeamId = useSessionListStore((s) => s.rows[0]?.team_id ?? null);
  useEffect(() => {
    if (!userId || !firstTeamId) return;
    const accessToken = useAuthStore.getState().session?.access_token ?? null;
    if (!accessToken) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        // amuxd convention: MQTT username = actor_id, password = JWT
        // (see amux/daemon/src/mqtt/client.rs + daemon/server.rs).
        // EMQX validates the JWT and uses actor_id for topic ACL.
        const { data: actorRows, error: actorErr } = await supabase
          .from("actors")
          .select("id, team_id")
          .eq("user_id", userId);
        if (actorErr) throw actorErr;
        const matching = (actorRows ?? []).find((a) => a.team_id === firstTeamId);
        if (!matching) {
          console.warn("[MQTT] no actor for user in team", firstTeamId, "— skipping connect");
          return;
        }
        if (cancelled) return;
        const actorId = matching.id as string;

        await mqttConnect({
          brokerHost: import.meta.env.VITE_MQTT_HOST as string,
          brokerPort: Number(import.meta.env.VITE_MQTT_PORT ?? 1883),
          username: actorId,
          password: accessToken,
          clientId: `teamclaw-${actorId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
          teamId: firstTeamId,
        });
        if (cancelled) return;

        unlisten = await listenForEnvelopes((env) => {
          const sid = sessionIdFromTopic(env.topic);
          if (!sid) return;
          const decoded = decodeLiveEvent(new Uint8Array(env.bytes));
          if (!decoded) return;

          // Case 1: final message.created
          if (decoded.message) {
            const senderActorId = decoded.message.senderActorId;
            const streamingStore = useV2StreamingStore.getState();
            const streamKey = senderActorId
              ? streamingStore.byKey[`${sid}::${senderActorId}`]
              : undefined;
            if (streamKey) {
              // Agent reply for an in-flight stream: finalize the streaming
              // bubble (marks inactive) AND append to the regular message
              // store so the completed reply survives subsequent turns.
              // The bubble disappears on inactive (filtered in ChatPanel);
              // the ChatMessage takes its place in chronological order.
              streamingStore.finalize(sid, senderActorId!, decoded.message.content);
              useSessionStore.getState().appendMessage(sid, decoded.message);
            } else {
              useSessionStore.getState().appendMessage(sid, decoded.message);
            }
            // Write ALL incoming messages into the unified `message` table
            // (origin="mqtt-live"). This replaces the old agent_runtime_event
            // writes for tool-call/result/thinking kinds.
            // The insertAgentRuntimeEvent table stays alive for backwards compat
            // but is no longer the primary read path.
            // TODO(cleanup): remove insertAgentRuntimeEvent writes once all
            //   clients have upgraded past this version and the old read path
            //   in history loader above is cleaned up.
            {
              const m = decoded.message;
              const kindStr =
                m.kind === MessageKind.AGENT_TOOL_CALL
                  ? "agent_tool_call"
                  : m.kind === MessageKind.AGENT_TOOL_RESULT
                    ? "agent_tool_result"
                    : m.kind === MessageKind.AGENT_THINKING
                      ? "agent_thinking"
                      : m.kind === MessageKind.AGENT_REPLY
                        ? "agent_reply"
                        : m.kind === MessageKind.SYSTEM
                          ? "system"
                          : "text";
              const teamId =
                useSessionListStore.getState().rows.find(
                  (r) => r.id === sid,
                )?.team_id ?? "";
              const now = new Date().toISOString();
              const msgRow: MessageRow = {
                id: m.messageId,
                teamId,
                sessionId: m.sessionId,
                turnId: m.turnId || null,
                senderActorId: m.senderActorId || null,
                replyToMessageId: null,
                kind: kindStr,
                content: m.content,
                metadataJson: null,
                model: m.model || null,
                mentionsJson: null,
                origin: "mqtt-live",
                createdAt: new Date(Number(m.createdAt) * 1000).toISOString(),
                updatedAt: now,
                deletedAt: null,
                syncedAt: now,
              };
              upsertMessagesBatch([msgRow]).catch((e) => {
                console.warn("[cache] message upsert failed:", e);
              });
            }
            return;
          }

          // Case 2: streaming acp.event
          if (decoded.acpEvent && decoded.envelope.actorId) {
            const actorId = decoded.envelope.actorId;
            const event = decoded.acpEvent.event;
            if (event?.case === "output") {
              const text = (event.value as { text?: string })?.text ?? "";
              useV2StreamingStore.getState().appendOutput(sid, actorId, text);
            } else if (event?.case === "thinking") {
              const text = (event.value as { text?: string })?.text ?? "";
              useV2StreamingStore.getState().appendThinking(sid, actorId, text);
            } else if (event?.case === "toolUse") {
              const tu = event.value as {
                toolId?: string;
                toolName?: string;
                description?: string;
                params?: Record<string, string>;
              };
              useV2StreamingStore.getState().pushToolUse(sid, actorId, {
                toolId: tu.toolId ?? "",
                toolName: tu.toolName ?? "",
                description: tu.description ?? "",
                params: tu.params ?? {},
              });
            } else if (event?.case === "toolResult") {
              const tr = event.value as { toolId?: string; success?: boolean; summary?: string };
              useV2StreamingStore.getState().completeToolUse(sid, actorId, {
                toolId: tr.toolId ?? "",
                success: !!tr.success,
                summary: tr.summary ?? "",
              });
            } else if (event?.case === "error") {
              const er = event.value as { message?: string; details?: string };
              useV2StreamingStore.getState().setError(
                sid,
                actorId,
                er.message ?? "Agent error",
                er.details ?? "",
              );
            } else if (event?.case === "permissionRequest") {
              const pr = event.value as {
                requestId?: string;
                toolName?: string;
                description?: string;
                params?: Record<string, string>;
              };
              useV2StreamingStore.getState().setPermissionRequest(sid, actorId, {
                requestId: pr.requestId ?? "",
                toolName: pr.toolName ?? "",
                description: pr.description ?? "",
                params: pr.params ?? {},
              });
            } else if (event?.case === "todoUpdate") {
              const tu = event.value as { items?: Array<{ content?: string; status?: number }> };
              const items = (tu.items ?? []).map((it) => ({
                content: it.content ?? "",
                status: (it.status === 1
                  ? ("in_progress" as const)
                  : it.status === 2
                  ? ("completed" as const)
                  : ("pending" as const)),
              }));
              useV2StreamingStore.getState().setTodos(sid, actorId, items);
            }
            // statusChange / availableCommands / raw: MVP no-op (RuntimeInfo retain
            // already surfaces agent status; commands TBD; raw is catch-all).
          }
        });
        if (cancelled) {
          unlisten?.();
          return;
        }

        // Per-session subscribe — only the N most-recent sessions on boot
        // (rows are sorted by last_message_at DESC). Older sessions
        // subscribe lazily when the user activates them. A separate effect
        // keeps the recent slice in sync with useSessionListStore.rows.
        const recentAtBoot = useSessionListStore.getState().rows.slice(0, RECENT_SESSION_SUBSCRIBE_CAP);
        await Promise.all(
          recentAtBoot.map((r) => {
            const topic = `amux/${r.team_id}/session/${r.id}/live`;
            subscribedSessionTopics.add(topic);
            return mqttSubscribe(topic).catch((e) => {
              subscribedSessionTopics.delete(topic);
              console.warn('[MQTT] subscribe failed', topic, e);
            });
          }),
        );
        console.log('[MQTT] receiver wired: subscribed to', recentAtBoot.length, 'recent session/live topics');

        // RPC client: subscribe to the team's rpc/res topic and start correlating.
        await initTeamclawRpc(firstTeamId);
        console.log('[teamclaw-rpc] initialized for team', firstTeamId);

        // Runtime state store: subscribe to daemon-published RuntimeInfo retains.
        await initRuntimeStateStore(firstTeamId);
        console.log('[runtime-state] initialized for team', firstTeamId);

        // Background: sync actor directory into local cache so display-name
        // lookups hit libsql instead of Supabase on subsequent renders.
        void syncActorsForTeam(firstTeamId).catch((e) =>
          console.warn('[cache-sync] actor sync failed:', e),
        );

        // Background: sync sessions into local cache.
        void syncSessionsForTeam(firstTeamId).then(() => {
          // Reload session list from merged local cache after sync finishes.
          void useSessionListStore.getState().load();
        }).catch((e) =>
          console.warn('[cache-sync] session sync failed:', e),
        );
      } catch (err) {
        console.error("[MQTT] receiver wiring failed:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      disposeTeamclawRpc();
      disposeRuntimeStateStore();
    };
  }, [userId, firstTeamId]);

  // Keep session/live subscriptions in sync with the user's most-recent
  // sessions. Rows are sorted by last_message_at DESC, so we slice the top
  // RECENT_SESSION_SUBSCRIBE_CAP and subscribe any not-yet-subscribed.
  // When a new session is created and pushed into rows (newest first),
  // it's auto-included here. Older sessions stay un-subscribed until the
  // user activates one (see the activeSessionId effect below).
  const sessionRowsForSubscribe = useSessionListStore((s) => s.rows);
  useEffect(() => {
    if (!userId || !firstTeamId) return;
    let cancelled = false;
    const recent = sessionRowsForSubscribe.slice(0, RECENT_SESSION_SUBSCRIBE_CAP);
    void (async () => {
      for (const r of recent) {
        if (cancelled) return;
        const topic = `amux/${r.team_id}/session/${r.id}/live`;
        if (subscribedSessionTopics.has(topic)) continue;
        subscribedSessionTopics.add(topic);
        try {
          await mqttSubscribe(topic);
        } catch (e) {
          subscribedSessionTopics.delete(topic);
          console.warn('[MQTT] subscribe failed', topic, e);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sessionRowsForSubscribe, userId, firstTeamId]);

  // Lazy-subscribe on session activation. When the user opens a session
  // that's outside the most-recent slice, subscribe to its live topic so
  // any incoming streaming arrives. Idempotent via the shared dedup set.
  // Reactive on the row's team_id (selector) so this also fires once the
  // session list finishes loading — otherwise a freshly-activated session
  // can race against rows hydration and stay un-subscribed.
  const activeSessionIdForSubscribe = useSessionStore((s) => s.activeSessionId);
  const activeSessionTeamId = useSessionListStore((s) =>
    activeSessionIdForSubscribe
      ? s.rows.find((r) => r.id === activeSessionIdForSubscribe)?.team_id ?? null
      : null,
  );
  useEffect(() => {
    if (!activeSessionIdForSubscribe || !userId || !firstTeamId) return;
    if (!activeSessionTeamId) return;
    void ensureSessionLiveSubscribed(
      activeSessionTeamId,
      activeSessionIdForSubscribe,
    );
  }, [activeSessionIdForSubscribe, activeSessionTeamId, userId, firstTeamId]);

  // v2 Phase 1 → local-first: load message history whenever the active
  // session changes.
  //   1. Tauri: hydrate immediately from local libsql cache (no Supabase wait).
  //   2. Background: delta-sync from Supabase (watermark-based), upsert local,
  //      re-render if anything new arrived.
  //   3. Non-Tauri: full Supabase pull (unchanged behaviour).
  // agent_runtime_event table is no longer read here — those rows were written
  // with origin="mqtt-live" into the message table by new envelope handler code.
  // TODO(cleanup): remove agent_runtime_event table once all clients have
  // upgraded past this version.
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const messageRefreshTrigger = useSessionStore((s) => s.messageRefreshTrigger ?? 0);
  const prevRefreshTriggerRef = useRef(0);
  useEffect(() => {
    if (!currentSessionId) return;
    // A refresh-trigger bump on the SAME session = user pressed ↻.
    const forceFull =
      messageRefreshTrigger !== prevRefreshTriggerRef.current &&
      prevRefreshTriggerRef.current !== 0;
    prevRefreshTriggerRef.current = messageRefreshTrigger;
    let cancelled = false;
    const kindMap: Record<string, MessageKind> = {
      text: MessageKind.TEXT,
      system: MessageKind.SYSTEM,
      agent_thinking: MessageKind.AGENT_THINKING,
      agent_tool_call: MessageKind.AGENT_TOOL_CALL,
      agent_tool_result: MessageKind.AGENT_TOOL_RESULT,
      agent_reply: MessageKind.AGENT_REPLY,
    };

    function cacheRowToProto(r: {
      id: string;
      sessionId: string;
      senderActorId?: string | null;
      kind: string;
      content: string;
      model?: string | null;
      createdAt: string;
    }) {
      return createMessage(MessageSchema, {
        messageId: r.id,
        sessionId: r.sessionId,
        senderActorId: r.senderActorId ?? "",
        kind: kindMap[r.kind] ?? MessageKind.TEXT,
        content: r.content ?? "",
        model: r.model ?? "",
        createdAt: BigInt(Math.floor(new Date(r.createdAt).getTime() / 1000)),
      });
    }

    void (async () => {
      if (isTauri()) {
        // ── Phase 1: instant render from local cache ──────────────────
        const { loadMessagesForSession } = await import("@/lib/local-cache");
        const localMsgs = await loadMessagesForSession(currentSessionId);
        if (cancelled) return;
        if (localMsgs.length > 0) {
          useSessionStore.getState().setMessages(
            currentSessionId,
            localMsgs.map(cacheRowToProto),
          );
        }

        // ── Phase 2: background delta sync from Supabase ─────────────
        const teamId =
          useSessionListStore.getState().rows.find(
            (r) => r.id === currentSessionId,
          )?.team_id ?? "";
        const synced = await syncMessagesForSession(
          currentSessionId,
          teamId,
          { full: forceFull },
        );
        if (forceFull && teamId) {
          // Also force-refresh participants on user-driven refresh.
          const { syncParticipantsForSession } = await import(
            "@/lib/sync/session-participant-sync"
          );
          await syncParticipantsForSession(currentSessionId, teamId, {
            full: true,
          });
        }
        if (cancelled) return;
        if (synced > 0) {
          // Re-read from local cache to surface the newly-synced rows
          const fresh = await loadMessagesForSession(currentSessionId);
          if (!cancelled) {
            useSessionStore.getState().setMessages(
              currentSessionId,
              fresh.map(cacheRowToProto),
            );
          }
        }
        return;
      }

      // ── Non-Tauri: full Supabase pull (unchanged) ─────────────────
      const supabaseResult = await supabase
        .from("messages")
        .select("id, session_id, sender_actor_id, kind, content, model, created_at")
        .eq("session_id", currentSessionId)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (supabaseResult.error) {
        console.warn("[history] load failed:", supabaseResult.error.message);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const supabaseMsgs = (supabaseResult.data ?? []).map((r: any) =>
        createMessage(MessageSchema, {
          messageId: r.id,
          sessionId: r.session_id,
          senderActorId: r.sender_actor_id,
          kind: kindMap[r.kind] ?? MessageKind.TEXT,
          content: r.content ?? "",
          model: r.model ?? "",
          createdAt: BigInt(Math.floor(new Date(r.created_at).getTime() / 1000)),
        }),
      );
      useSessionStore.getState().setMessages(currentSessionId, supabaseMsgs);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, messageRefreshTrigger]);

  /** When left dock opens, hide the main sidebar; restore prior expansion when it closes. */
  const restoreSidebarAfterLeftDockRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (leftDockActive && workspaceUIVariant) {
      if (restoreSidebarAfterLeftDockRef.current === null) {
        restoreSidebarAfterLeftDockRef.current = sidebarOpen;
        if (sidebarOpen) {
          setSidebarOpen(false);
        }
      } else if (sidebarOpen) {
        // User re-opened sidebar while left dock is active — close the dock.
        closePanel();
      }
    } else {
      const shouldExpand = restoreSidebarAfterLeftDockRef.current === true;
      restoreSidebarAfterLeftDockRef.current = null;
      if (shouldExpand) {
        setSidebarOpen(true);
      }
    }
  }, [leftDockActive, workspaceUIVariant, sidebarOpen, setSidebarOpen, closePanel]);

  // If settings is open, show settings page (check first so it works regardless of workspace state)
  if (currentView === "settings") {
    return (
      <>
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

  // File Mode: Completely different layout without sidebar
  if (layoutMode === "file") {
    return (
      <div className="flex h-svh w-full flex-col overflow-hidden bg-background">
        {/* Global connecting overlay — fixed to viewport, covers everything */}
        {/* Header for file mode */}
        <header
          className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background border-b px-4"
          data-tauri-drag-region
        >
          {needsTrafficLightSpacer && <TrafficLights />}

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
                      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                      {(sessions as any[]).slice(0, 20).map((s: any) => (
                        <DropdownMenuItem
                          key={s.id}
                          className={cn(
                            "text-xs truncate",
                            s.id === activeSession?.id && "bg-accent"
                          )}
                          onClick={() => useUIStore.getState().switchToSession(s.id)}
                        >
                          {s.title || t("chat.newChat", "New Chat")}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    onClick={() => useUIStore.getState().startNewChat()}
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
      <AppSidebar />
      {workspaceUIVariant && (
        <div className="w-(--session-list-width) shrink-0 h-svh overflow-hidden">
          <SessionListColumn />
        </div>
      )}
      <SidebarInset className="flex flex-row h-svh overflow-hidden relative">
        <div
          className={cn(
            "shrink-0 overflow-hidden border-border bg-background transition-[width,opacity,transform] duration-500 ease-out",
            leftDockActive
              ? "w-(--sidebar-width) translate-x-0 border-r opacity-100"
              : "pointer-events-none w-0 -translate-x-4 border-r-0 opacity-0",
          )}
        >
          <div className="flex h-full w-(--sidebar-width) flex-col overflow-hidden bg-background">
            {leftDockActive && (
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
                  <RightPanel diff={sessionDiff} />
                </div>
              </>
            )}
          </div>
        </div>
        {/* Main column: header + main content */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
          {/* Header with breadcrumb - sticky */}
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}

            <button
              className={cn(
                "min-w-0 truncate text-sm text-left",
                hasActiveFileTab && "cursor-pointer hover:text-foreground/70 transition-colors"
              )}
              onClick={() => {
                if (hasActiveFileTab) {
                  useTabsStore.getState().hideAll();
                }
              }}
              disabled={!hasActiveFileTab}
            >
              {activeSession?.title || t("chat.newChat", "New Chat")}
            </button>
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

            {/* Panel tabs - right side of header */}
            <div className="ml-auto flex shrink-0 items-center gap-0.5" data-onboarding-id="workspace-panel-tabs">
              {mainContentLayout === "stacked" && (hasActiveFileTab || hasHiddenTabs) && (
                <button
                  className={cn(
                    "rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
                    hasActiveFileTab ? "text-foreground" : "text-muted-foreground",
                  )}
                  onClick={() => {
                    if (hasActiveFileTab) {
                      useTabsStore.getState().hideAll();
                    } else {
                      useTabsStore.getState().restoreLastTab();
                    }
                  }}
                  title={hasActiveFileTab
                    ? t("navigation.hideTabs", "Hide files")
                    : t("navigation.restoreTabs", "Show files")
                  }
                >
                  <AppWindow className="h-4 w-4" />
                </button>
              )}
              {workspacePath && (
                <TerminalToggleButton workspacePath={workspacePath} />
              )}
              <HeaderPanelTab
                icon={Users}
                label={t("chat.actorSheet.title", "Actors")}
                isActive={isPanelOpen && activeTab === "actors"}
                onClick={() => isPanelOpen && activeTab === "actors" ? closePanel() : openPanel("actors")}
              />
              <HeaderPanelTab
                icon={BookOpen}
                label={t("navigation.knowledge", "Knowledge")}
                isActive={isPanelOpen && activeTab === "knowledge"}
                onClick={() => isPanelOpen && activeTab === "knowledge" ? closePanel() : openPanel("knowledge")}
              />
              <HeaderPanelTab
                icon={FolderGit}
                label={t("navigation.changes", "Changes")}
                count={sessionDiff.length}
                isActive={isPanelOpen && activeTab === "diff"}
                onClick={() => isPanelOpen && activeTab === "diff" ? closePanel() : openPanel("diff")}
              />
              {showRightWorkspacePanel && (
                <button
                  className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={closePanel}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </header>

          {/* Main content - Chat or file preview */}
          <div
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
            data-onboarding-id="main-chat-area"
          >
            <MainContent />
          </div>
        </div>

        {/* Right Panel - full height */}
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
              <RightPanel diff={sessionDiff} />
            )}
          </div>
        </div>
      </SidebarInset>
      <OnboardingTour
        id="main-workspace"
        enabled={!!workspacePath}
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
  // ── Global webview shortcuts (find, zoom, context menu) ──
  useWebviewShortcuts()
  useTerminalShortcuts()

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

  // Extracted hooks — initialization, setup guide, telemetry consent
  useTauriBodyClass();
  const workspaceReady = !!useWorkspaceStore((s) => s.workspacePath);
  const { showSetupGuide, dependencies, handleRecheck, handleSetupContinue } = useSetupGuide(workspaceReady);
  const { showConsentDialog, setShowConsentDialog } = useTelemetryConsent(showSetupGuide);

  const spotlightContent = (
    <Suspense fallback={<div className="h-screen w-screen rounded-2xl overflow-hidden" />}>
      <div className="h-screen w-screen rounded-2xl overflow-hidden">
        <SpotlightWindow />
      </div>
    </Suspense>
  )

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
                "--sidebar-width": isWorkspaceUIVariant() ? "220px" : "320px",
                "--session-list-width": "280px",
              } as React.CSSProperties
            }
          >
            <AppContent />
          </SidebarProvider>
          <Toaster
            position="top-center"
            offset={40}
            toastOptions={{
              className: '!bg-popover !text-popover-foreground !border-border !shadow-md !rounded-md !text-xs !py-2 !px-3 !min-h-0 !gap-1.5',
              descriptionClassName: '!text-muted-foreground !text-[11px]',
            }}
          />
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
      <div style={{ display: spotlightMode ? 'contents' : 'none' }}>
        {spotlightContent}
      </div>
      <div style={{ display: spotlightMode ? 'none' : 'contents' }}>
        {mainContent}
      </div>
    </div>
  ) : (
    <>
      <div style={{ display: spotlightMode ? 'contents' : 'none' }}>
        {spotlightContent}
      </div>
      <div style={{ display: spotlightMode ? 'none' : 'contents' }}>
        {mainContent}
      </div>
    </>
  )
}

export default App;
