import {
  useEffect,
  useState,
  useRef,
  MouseEvent as ReactMouseEvent,
  type ComponentType,
} from "react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import { Toaster, toast } from "sonner";
import { cn, isTauri, removeStartupSkeleton } from "@/lib/utils";
import { capabilities, isChromeExtension } from "@/lib/platform";
import { scheduleReleaseStuckModalLayers } from "@/lib/modal-layer-cleanup";
import { appDisplayName, buildConfig } from "@/lib/build-config";
import { buildSessionDeeplink } from "@/lib/session-deeplink";
import { markStartup } from "@/lib/startup-perf";
import {
  BookOpen,
  Share2,
  FolderGit,
  ChevronLeft,
  X,
  PanelRightClose,
  Link2,
  Loader2,
  RotateCw,
  MessageSquarePlus,
  AppWindow,
  Users,
  TerminalSquare,
} from "lucide-react";
import { FileContentViewer } from "@/components/FileEditor";
import {
  useWorkspaceInit,
  useChannelGatewayInit,
  useGitReposInit,
  useCronInit,
  useWorkspaceRuntimeRefreshPoll,
  useOpenCodePreload,

  useExternalLinkHandler,
  useTauriBodyClass,
  useSetupGuide,
  useTelemetryConsent,
} from "@/hooks/useAppInit";
import {
  useDesktopNotifications,
  getDispatcher,
} from "@/hooks/useDesktopNotifications";
import { useMemberPresenceHeartbeat } from "@/hooks/useMemberPresenceHeartbeat";
import { useExtensionSessionCleanup } from "@/hooks/useExtensionSessionCleanup";
import {
  usePanelAutoOpen,
  useFileTabSync,
  useResizablePanels,
} from "@/hooks/useFileEditorState";
import { useMCPFileWatcher } from "@/hooks/useMCPFileWatcher";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarSecondColumn } from "@/components/sidebar/SidebarSecondColumn";
import { NarrowChatHeader } from "@/components/responsive/NarrowChatHeader";
import { useLayoutBreakpoint } from "@/hooks/use-layout-breakpoint";
import { TeamShareDetailPane } from "@/components/teamshare/TeamShareDetailPane";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { NewSessionDialog } from "@/components/chat/NewSessionDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { UpdateDialogContainer } from "@/components/updater/UpdateDialog";
import { RightPanel } from "@/components/panel";
import { ExtensionSettings, Settings } from "@/components/settings";
import { FeedbackDialog } from "@/components/settings/FeedbackDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SetupGuide } from "@/components/SetupGuide";
import { TelemetryConsentDialog } from "@/components/telemetry/TelemetryConsentDialog";
import { WelcomeScreen } from "@/components/auth/WelcomeScreen";
import { hasSeenWelcome, markWelcomeSeen } from "@/stores/deps";
import { RuntimeRefreshWorkspaceBanner } from "@/components/workspace/RuntimeRefreshBanner";
import { useSessionStore } from "@/stores/session";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useAuthStore } from "@/stores/auth-store";
import {
  mqttSubscribe,
  listenForEnvelopes,
  listenForDaemonLiveStatus,
} from "@/lib/mqtt-bridge";
import { connectMqttWithFreshAuth } from "@/lib/mqtt-connect-with-fresh-auth";
import { mqttConnectionKey } from "@/lib/mqtt-connection-key";
import { describeJwt, recordMqttDiag } from "@/lib/mqtt-diagnostics";
import { useMqttReconnectStore } from "@/stores/mqtt-reconnect";
import { getEffectiveServerConfig } from "@/lib/server-config";
import { initTeamclawRpc, disposeTeamclawRpc } from "@/lib/teamclaw-rpc";
import {
  disposeRemoteToolsRpcServer,
  initRemoteToolsRpcServer,
  registerPlatformExecutors,
} from "@/lib/remote-tools";
import {
  decodeLiveEvent,
  sessionIdFromLiveEvent,
  streamActorIdFromLiveEvent,
} from "@/lib/teamclaw-events";
import { handleAcpPermissionRequest } from "@/lib/teamclaw/handle-acp-permission-request";
import { handleSessionEventPermissionResolved } from "@/lib/teamclaw/handle-session-event-permission-resolved";
import { tryBindChildFromPermission } from "@/lib/teamclaw/subagent-acp-binding";
import { routeSubagentAcpEvent } from "@/lib/teamclaw/subagent-acp-route";
import {
  resolveOrphanSubagentParentToolId,
  shouldBufferUnboundChildAcpEvent,
  shouldRouteOrphanSubagentEvent,
} from "@/lib/teamclaw/subagent-acp-routing";
import { handleInboxEnvelope, scheduleSessionListRefresh } from "@/lib/inbox-handler";
import {
  bumpSessionListLastMessage,
  messageKindUpdatesSessionPreview,
} from "@/lib/session-list-preview";
import { executeAgentTurnFlush } from "@/lib/agent-turn-flush";
import { resolveInterruptedPlaceholdersToDrop } from "@/lib/interrupted-stream-placeholder";
import {
  removePendingAgentReplyTo,
  resolvePendingAgentReplyTo,
} from "@/lib/pending-agent-reply-to";
import {
  bufferStreamDelta,
  flushStreamDeltasFor,
  flushAllStreamDeltas,
} from "@/lib/stream-delta-buffer";
import { recordLatencyProbe } from "@/lib/latency-probe";
import {
  bumpLiveDuplicateDropped,
  setDaemonLiveConnected,
} from "@/lib/live-dedup-stats";
import {
  cloneStreamEntrySnapshot,
  resolveStreamEntryForPersist,
  syncStreamingToolOutputsFromLocalCache,
} from "@/lib/streaming-persist";
import {
  logInterruptMsgDiag,
  summarizeFlushDecision,
  summarizePendingReplies,
  summarizeStreamEntry,
} from "@/lib/interrupt-msg-diag";
import {
  logExtMsgDiag,
  summarizeProtoForExtDiag,
  summarizeProtosForExtDiag,
} from "@/lib/extension-msg-diag";
import { logStreamToolDiag } from "@/lib/stream-tool-diag";
import { useOutboxStore } from "@/stores/outbox-store";
import { startOutboxSender } from "@/services/outbox-sender";
import { useAcpDebugStore } from "@/stores/acp-debug-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { initRuntimeStateStore, disposeRuntimeStateStore } from "@/stores/runtime-state-store";
import { initActorPresenceStore, disposeActorPresenceStore } from "@/stores/actor-presence-store";
import { getBackend } from "@/lib/backend";
import { getVersion } from "@tauri-apps/api/app";
import { getDesktopDeviceId } from "./lib/backend/cloud-api/device-id";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageSchema, MessageKind, type Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import { messageRowsToProto } from "@/lib/session-export/collect";
import { historyRowsToMessageRows } from "@/lib/message-history-map";
import {
  agentStreamKey,
  buildInterruptedStreamAnchor,
  isAgentActiveStatus,
  isTerminalAgentStatus,
  isToolOnlyTurnAnchor,
  mergePendingAgentReplies,
  normalizeToolResultEvent,
  normalizeToolUseEvent,
  registerDiscardPendingStreamReply,
  rememberLiveEventId,
  streamEntryHasVisibleContent,
} from "@/lib/live-agent-stream";
import { resetClientChatState } from "@/lib/reset-client-chat-state";
import { startEmbedPageContextListener, consumePendingLinkContext } from "@/lib/embed-page-context";
import { startEmbedLinkOpenListener } from "@/lib/embed-link-session";
import {
  mapAcpPlanEntries,
  syncPlanFromTodoTool,
  syncPlanFromTodoToolResult,
} from "@/lib/sync-plan-from-todowrite";
import { useUIStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useLocalStatsStore } from "@/stores/local-stats";
import { useTabsStore, selectActiveTab, selectHasHiddenTabs } from "@/stores/tabs";
import { useTerminalStore } from "@/stores/terminal-store";
import { TabBar } from "@/components/tab-bar/TabBar";
import { TabContentRenderer } from "@/components/tab-bar/TabContentRenderer";
import { WebViewToolbar } from "@/components/tab-bar/WebViewToolbar";
import { FindInPageBar } from "@/components/tab-bar/FindInPageBar";
import { urlToLabel } from "@/lib/webview-utils";
import { create } from "zustand";
import {
  upsertMessagesBatch,
  softDeleteMessage,
  type MessageRow,
} from "@/lib/local-cache";
import { syncActorsForTeam } from "@/lib/sync/actor-sync";
import { syncIdeasForTeam } from "@/lib/sync/idea-sync";
import { syncMessagesForSession } from "@/lib/sync/message-sync";
import { syncSessionsForTeam } from "@/lib/sync/session-sync";
import { Button } from "@/components/ui/button";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { parseInviteDeeplink, claimInviteToken } from "@/lib/invite-deeplink";
import { parseSessionDeeplink } from "@/lib/session-deeplink";
import { CloudApiError } from "@/lib/backend/cloud-api/http";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useTeamShareStore, isShareModeLocked } from "@/stores/team-share";
import { resolveCurrentMemberActorId } from "@/lib/current-actor";
import { installV2E2EControl, isV2E2EControlActive } from "@/lib/e2e/v2-control";
import {
  ensureSessionLiveSubscribed,
  ensureTeamSessionLiveSubscribed,
  hasTeamSessionLiveSubscription,
  resetSessionLiveSubscriptionState,
} from "@/lib/session-live-subscriptions";
import { TrafficLights } from "@/components/ui/traffic-lights";
import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";

export { ensureSessionLiveSubscribed } from "@/lib/session-live-subscriptions";

/** How many most-recent sessions get auto-subscribed on boot / list reload.
 * Older sessions subscribe lazily when the user opens them (see the
 * activeSessionId effect in AppContent). */
const RECENT_SESSION_SUBSCRIBE_CAP = 10;
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
/** Track the local-daemon SSE fast-path status (observability only). */
function useDaemonLiveStatus() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenForDaemonLiveStatus((connected) => {
      setDaemonLiveConnected(connected);
      console.info(`[daemon-live] fast-path ${connected ? "connected" : "down"}`);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

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
  const reloadActiveSessionMessages = useSessionStore(
    (s) => s.reloadActiveSessionMessages,
  );

  // Workspace store - individual selectors
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isPanelOpen = useWorkspaceStore((s) => s.isPanelOpen);
  const activeTab = useWorkspaceStore((s) => s.activeTab);
  const openPanel = useWorkspaceStore((s) => s.openPanel);
  const closePanel = useWorkspaceStore((s) => s.closePanel);

  const breakpoint = useLayoutBreakpoint();

  // UI store - individual selectors
  const embedMode = useUIStore((s) => s.embedMode);
  const currentView = useUIStore((s) => s.currentView);
  const sidebarFilter = useUIStore((s) => s.sidebarFilter);
  const teamShareMode = sidebarFilter?.kind === "teamShare" && buildConfig.features.teamShareBrowser;
  const closeSettings = useUIStore((s) => s.closeSettings);
  const authSession = useAuthStore((s) => s.session);
  const loadCurrentTeam = useCurrentTeamStore((s) => s.load);
  // Team-share state drives the top-right "team shared files" tab visibility.
  // Refresh it centrally (below) so the tab reflects the true share mode even
  // before the user ever opens the panel or Settings → Team.
  const teamSharedTabMode = useTeamShareStore((s) => s.status.mode);
  const refreshTeamShare = useTeamShareStore((s) => s.refresh);
  const mainContentLayout = useUIStore((s) => s.mainContentLayout);
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
  const hasActiveFileTab = !!useTabsStore(selectActiveTab);
  const hasHiddenTabs = useTabsStore(selectHasHiddenTabs);
  /** Shortcuts open in the left dock for both shells.
   * Only the workspace shell temporarily replaces the sidebar with that dock.
   * Files pops out from the right (via the top-right files icon). */
  const leftDockActive =
    isPanelOpen &&
    activeTab === "shortcuts";
  const showRightWorkspacePanel = isPanelOpen && !leftDockActive;
  const settingsOpen = currentView === "settings";
  /** Extension welcome has its own empty state — skip duplicate "New Chat" header. */
  const showChatSessionHeader = !(embedMode && !activeSession);

  const handleCloseSettings = React.useCallback(() => {
    setFeedbackOpen(false);
    closeSettings();
    // DialogContent also schedules cleanup; this covers programmatic close paths.
    scheduleReleaseStuckModalLayers();
  }, [closeSettings]);

  useEffect(() => {
    void loadCurrentTeam();
  }, [authSession?.user.id, loadCurrentTeam]);

  // In workspace mode, SessionListColumn always sits to the left of SidebarInset
  // and renders its own traffic-light + collapse strip when the sidebar is
  // closed, so the chat header should NOT re-render that strip there.
  const collapsedInsetLeading = null;
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false);
  // Resolved by the MQTT-connect effect; passed to the notification dispatcher.
  const [myActorId, setMyActorId] = useState<string | null>(null);
  // Extracted hooks — initialization, panel state, keyboard shortcuts
  const { initialWorkspaceResolved, openCodeError } = useWorkspaceInit();
  const daemonHttpReady = useWorkspaceStore((s) => s.daemonHttpReady);

  // Surface a local amuxd daemon connection failure as a persistent toast
  // instead of taking over the whole window. The rest of the UI stays usable;
  // the toast auto-dismisses once the daemon becomes reachable.
  useEffect(() => {
    const DAEMON_TOAST_ID = "amuxd-daemon-unavailable";
    if (isTauri() && workspacePath && !daemonHttpReady && openCodeError) {
      toast.error(openCodeError, {
        id: DAEMON_TOAST_ID,
        duration: Infinity,
        description: t(
          "workspace.daemonUnavailableHint",
          "Start amuxd on this machine (e.g. pnpm daemon:run), confirm the HTTP port/token files exist under ~/.amuxd/, then retry.",
        ),
        action: {
          label: t("common.retry", "Retry"),
          onClick: () => window.location.reload(),
        },
      });
    } else {
      toast.dismiss(DAEMON_TOAST_ID);
    }
  }, [workspacePath, daemonHttpReady, openCodeError, t]);

  useDesktopNotifications(myActorId);
  useChannelGatewayInit();
  useGitReposInit();
  useCronInit();
  useWorkspaceRuntimeRefreshPoll();
  useMCPFileWatcher(workspacePath);
  useExternalLinkHandler();
  usePanelAutoOpen();
  useFileTabSync();
  useEffect(() => {
    const stopPageContext = startEmbedPageContextListener()
    const stopLinkOpen = startEmbedLinkOpenListener()
    void consumePendingLinkContext()
    return () => {
      stopPageContext()
      stopLinkOpen()
    }
  }, []);

  // v2 Phase 1: load session list from Supabase once AppContent mounts
  // (i.e. after auth is verified). Phase 2 will replace with realtime sub.
  useEffect(() => {
    if (isV2E2EControlActive()) return;
    void useSessionListStore.getState().load();
  }, []);

  // Desktop: hand off from the static #skeleton once the workspace resolves to
  // real three-column content. AuthGate keeps the skeleton up through every
  // loading gate and lets App own the final removal, so cold start is
  // skeleton → real UI with no intermediate blank.
  //
  // Extension/web: there is no workspace gate — initialWorkspaceResolved flips
  // true almost immediately. App must NOT tear the skeleton down here while
  // AuthGate still returns null (auth hydrate / team bootstrap / myTeams);
  // otherwise #root is empty and the side panel flashes white for seconds.
  // AuthGate removes the skeleton when it finally renders children.
  useEffect(() => {
    if (!initialWorkspaceResolved) return;
    if (!capabilities.workspace) return;
    removeStartupSkeleton();
    if (workspacePath) markStartup("first-content");
  }, [initialWorkspaceResolved, workspacePath]);

  // Boot the outbox: hydrate any pending/failed rows from libsql so a
  // crashed/closed app resumes in-flight sends, then start the sender loop
  // (idempotent). `startOutboxSender` schedules a tick every second; the
  // first tick fires immediately after hydration.
  useEffect(() => {
    void (async () => {
      await useOutboxStore.getState().hydrate();
      startOutboxSender();
    })();
  }, []);

  // v2 Phase 1 — Task 1D.4: connect MQTT after auth, subscribe to all teams'
  // session live topics, decode incoming LiveEventEnvelope and append to
  // useSessionStore so ActorMessageList re-renders. The orphan
  // session-event-bus.ts is bypassed: we write straight to the store the UI
  // reads from.
  const userId = useAuthStore((s) => s.session?.user.id ?? null);
  // Wait for a team id for MQTT ACL. The active team from settings is the
  // authoritative source — populated by AuthGate / loadCurrentTeam after login.
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null);
  useMemberPresenceHeartbeat(currentTeamId, myActorId);
  useExtensionSessionCleanup();

  // Keep team-share status fresh so the top-right "team shared files" tab shows
  // only when share is actually enabled (shareMode != null). Without this the
  // status would stay null until the user visited the panel or Settings → Team.
  useEffect(() => {
    if (!currentTeamId || !workspacePath) return;
    void refreshTeamShare(currentTeamId, workspacePath);
  }, [currentTeamId, workspacePath, refreshTeamShare]);

  // Clear in-memory chat when the signed-in user or active team changes.
  // signOut resets before unmount; this effect owns team-switch / adoptSession.
  const chatIdentityKey =
    userId && currentTeamId ? `${userId}::${currentTeamId}` : null;
  const prevChatIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatIdentityKey) {
      prevChatIdentityRef.current = null;
      return;
    }
    if (
      prevChatIdentityRef.current !== null &&
      prevChatIdentityRef.current !== chatIdentityKey
    ) {
      resetClientChatState();
      if (!isV2E2EControlActive()) {
        void useSessionListStore.getState().loadFirstPage();
      }
    }
    prevChatIdentityRef.current = chatIdentityKey;
  }, [chatIdentityKey]);

  // Report this desktop install's tauri client version once per team selection.
  useEffect(() => {
    if (!currentTeamId) return;
    let cancelled = false;
    void (async () => {
      let version: string;
      try {
        version = await getVersion(); // throws outside Tauri (web preview) — skip then
      } catch {
        return;
      }
      if (cancelled) return;
      await getBackend().telemetry.reportClientVersion(currentTeamId, {
        clientType: "tauri",
        version,
        deviceId: getDesktopDeviceId(),
        build: null,
      });
    })();
    return () => { cancelled = true; };
  }, [currentTeamId]);

  const mqttTeamId = currentTeamId;
  const mqttAccessToken = useAuthStore((s) => s.session?.access_token ?? null);
  const mqttReconnectNonce = useMqttReconnectStore((s) => s.nonce);
  const mqttAuthKey = mqttConnectionKey({
    userId,
    teamId: mqttTeamId,
    accessToken: mqttAccessToken,
  });
  const pendingStreamRepliesRef = useRef<Record<string, TeamclawMessage[]>>({});
  /** Set on terminal statusChange; late message.created triggers flush. */
  const terminalFlushPendingRef = useRef<Record<string, boolean>>({});
  const seenLiveEventIdsRef = useRef<Set<string>>(new Set());

  function clearTurnAgentReplyParking(streamKey: string) {
    delete pendingStreamRepliesRef.current[streamKey];
  }

  function clearTerminalFlushPending(streamKey: string) {
    delete terminalFlushPendingRef.current[streamKey];
  }

  const flushTurnAgentReplyInFlightRef = useRef<Record<string, boolean>>({});
  /** Eager client flush when terminal arrives before daemon agent_reply (interrupt + tool). */
  const interruptedStreamFlushRef = useRef<
    Record<string, { streamId: string; messageId: string }>
  >({});
  /** Real AGENT_REPLY won the race — in-flight eager flush must not commit. */
  const interruptedFlushSupersededRef = useRef<Record<string, boolean>>({});
  /** streamId that was superseded; blocks re-flush of the same interrupted turn. */
  const interruptedFlushSupersededStreamIdRef = useRef<Record<string, string>>({});

  // Drop the synthetic interrupt-<streamId> anchor from BOTH the in-memory
  // message store AND the libsql cache, so it never survives a reload as a
  // duplicate bubble alongside the real reply.
  function dropInterruptedPlaceholderRow(sessionId: string, messageId: string) {
    logExtMsgDiag("interrupt.drop", {
      sessionId,
      messageId,
      isInterrupt: messageId.startsWith("interrupt-"),
    });
    useSessionMessageStore.getState().removeMessageById(sessionId, messageId);
    void softDeleteMessage(messageId, new Date().toISOString()).catch((e) => {
      console.warn(
        "[interrupt] cache removal of synthetic placeholder failed",
        e,
      );
      logExtMsgDiag("interrupt.drop.cacheFail", {
        sessionId,
        messageId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }

  function removeInterruptedStreamPlaceholder(
    sessionId: string,
    actorId: string,
    streamId: string | undefined,
  ) {
    const streamKey = agentStreamKey(sessionId, actorId);
    const placeholder = interruptedStreamFlushRef.current[streamKey];
    if (!placeholder || !streamId || placeholder.streamId !== streamId) {
      logExtMsgDiag("interrupt.removeByStream.miss", {
        sessionId,
        actorId,
        streamId: streamId ?? null,
        hasPlaceholder: Boolean(placeholder),
        placeholderStreamId: placeholder?.streamId ?? null,
        placeholderMessageId: placeholder?.messageId ?? null,
      });
      return;
    }
    dropInterruptedPlaceholderRow(sessionId, placeholder.messageId);
    delete interruptedStreamFlushRef.current[streamKey];
  }

  // When the daemon's REAL agent_reply for a turn arrives after the live stream
  // was already detached (mid-stream interrupt eager-flush), the parking branch
  // no longer finds a live streamEntry and falls through to plain appendMessage.
  // Drop every synthetic interrupt-* for this actor (tracked ref + store rows)
  // and mark the in-flight eager flush superseded so it cannot re-insert.
  function removeInterruptedStreamPlaceholderForRealReply(
    sessionId: string,
    actorId: string,
  ) {
    const streamKey = agentStreamKey(sessionId, actorId);
    interruptedFlushSupersededRef.current[streamKey] = true;
    const tracked = interruptedStreamFlushRef.current[streamKey];
    const liveStreamId =
      useV2StreamingStore.getState().byKey[streamKey]?.streamId?.trim() || "";
    const supersededStreamId = (tracked?.streamId || liveStreamId).trim();
    if (supersededStreamId) {
      interruptedFlushSupersededStreamIdRef.current[streamKey] = supersededStreamId;
    }
    const { messageIds } = resolveInterruptedPlaceholdersToDrop({
      tracked,
      messages: useSessionMessageStore.getState().messages[sessionId] ?? [],
      actorId,
    });
    if (messageIds.length === 0 && !tracked) {
      logExtMsgDiag("interrupt.removeForRealReply.miss", {
        sessionId,
        actorId,
        note: "no tracked placeholder and no interrupt-* rows — ok if eager flush never ran",
      });
      return;
    }
    logExtMsgDiag("interrupt.removeForRealReply.hit", {
      sessionId,
      actorId,
      placeholderMessageId: tracked?.messageId ?? null,
      placeholderStreamId: tracked?.streamId ?? null,
      droppedIds: messageIds,
      superseded: true,
      supersededStreamId: supersededStreamId || null,
    });
    for (const messageId of messageIds) {
      dropInterruptedPlaceholderRow(sessionId, messageId);
    }
    delete interruptedStreamFlushRef.current[streamKey];
  }

  function teamIdForSession(sessionId: string): string {
    return (
      useSessionListStore.getState().rows.find((r) => r.id === sessionId)
        ?.team_id ?? ""
    );
  }

  function flushInterruptedStreamArtifacts(
    sessionId: string,
    actorId: string,
    trigger: string,
  ): boolean {
    // Snapshots live byKey state below for persist — drain buffered text first.
    flushStreamDeltasFor(sessionId, actorId);
    const streamKey = agentStreamKey(sessionId, actorId);
    if (flushTurnAgentReplyInFlightRef.current[streamKey]) {
      logInterruptMsgDiag("flush.interrupted.skip.inFlight", {
        sessionId,
        actorId,
        trigger,
      });
      return false;
    }

    const liveStreamEntry = useV2StreamingStore.getState().byKey[streamKey];
    const streamEntryForPersist = resolveStreamEntryForPersist(
      sessionId,
      actorId,
      liveStreamEntry,
    );
    if (!streamEntryForPersist || !streamEntryHasVisibleContent(streamEntryForPersist)) {
      return false;
    }

    const snapshot = cloneStreamEntrySnapshot(streamEntryForPersist);
    const existing = interruptedStreamFlushRef.current[streamKey];
    if (existing?.streamId === snapshot.streamId) {
      logInterruptMsgDiag("flush.interrupted.skip.already", {
        sessionId,
        actorId,
        trigger,
        streamId: snapshot.streamId,
        messageId: existing.messageId,
      });
      return true;
    }

    // Real AGENT_REPLY already superseded this interrupted turn — do not clear
    // that flag and re-insert interrupt-*. Only allow a later flush when the
    // snapshot is a different streamId (new agent turn).
    const supersededStreamId =
      interruptedFlushSupersededStreamIdRef.current[streamKey];
    if (interruptedFlushSupersededRef.current[streamKey]) {
      if (!supersededStreamId || supersededStreamId === snapshot.streamId) {
        logInterruptMsgDiag("flush.interrupted.skip.superseded", {
          sessionId,
          actorId,
          trigger,
          streamId: snapshot.streamId,
          supersededStreamId: supersededStreamId || null,
        });
        return false;
      }
      delete interruptedFlushSupersededRef.current[streamKey];
      delete interruptedFlushSupersededStreamIdRef.current[streamKey];
    }

    const syntheticReply = buildInterruptedStreamAnchor(
      sessionId,
      actorId,
      snapshot,
    );
    const pendingReplyTo = resolvePendingAgentReplyTo(
      sessionId,
      actorId,
      syntheticReply.replyToMessageId,
    );
    if (pendingReplyTo) {
      syntheticReply.replyToMessageId = pendingReplyTo;
    }
    logInterruptMsgDiag("flush.interrupted.start", {
      sessionId,
      actorId,
      trigger,
      streamId: snapshot.streamId,
      messageId: syntheticReply.messageId,
      ...summarizeStreamEntry(snapshot, "snapshot"),
    });
    logExtMsgDiag("flush.interrupted.start", {
      sessionId,
      actorId,
      trigger,
      ...summarizeProtoForExtDiag(syntheticReply),
      ...summarizeStreamEntry(snapshot, "snapshot"),
    });

    // Register BEFORE async persist so a racing real AGENT_REPLY can find and
    // supersede this placeholder (previously only set in afterEnriched).
    // Do NOT clear interruptedFlushSupersededRef here — a racing real reply may
    // have already set it true between the check above and this register.
    interruptedStreamFlushRef.current[streamKey] = {
      streamId: snapshot.streamId,
      messageId: syntheticReply.messageId,
    };
    logExtMsgDiag("flush.interrupted.placeholderRecorded.early", {
      sessionId,
      actorId,
      ...summarizeProtoForExtDiag(syntheticReply),
    });

    flushTurnAgentReplyInFlightRef.current[streamKey] = true;
    const streamEntrySnapshot = snapshot;
    useV2StreamingStore
      .getState()
      .detachLiveStreamForPersist(sessionId, actorId, snapshot.streamId);

    void executeAgentTurnFlush({
      sessionId,
      actorId,
      trigger,
      teamId: teamIdForSession(sessionId),
      reply: syntheticReply,
      pendingReplies: [],
      streamEntrySnapshot,
      persistedStage: "flush.interrupted.persisted",
      shouldCommit: () => !interruptedFlushSupersededRef.current[streamKey],
      afterEnriched: (enrichedReply) => {
        if (interruptedFlushSupersededRef.current[streamKey]) {
          logExtMsgDiag("flush.interrupted.superseded.beforeCommit", {
            sessionId,
            actorId,
            ...summarizeProtoForExtDiag(enrichedReply),
          });
          dropInterruptedPlaceholderRow(sessionId, enrichedReply.messageId);
          delete interruptedStreamFlushRef.current[streamKey];
          return;
        }
        interruptedStreamFlushRef.current[streamKey] = {
          streamId: snapshot.streamId,
          messageId: enrichedReply.messageId,
        };
        logExtMsgDiag("flush.interrupted.placeholderRecorded", {
          sessionId,
          actorId,
          ...summarizeProtoForExtDiag(enrichedReply),
          store: summarizeProtosForExtDiag(
            useSessionMessageStore.getState().messages[sessionId] ?? [],
          ),
        });
      },
    }).finally(() => {
      delete flushTurnAgentReplyInFlightRef.current[streamKey];
      useV2StreamingStore
        .getState()
        .clearInterruptedFlushPending(sessionId, actorId);
    });

    return true;
  }

  function flushTurnAgentReply(
    sessionId: string,
    actorId: string,
    trigger = "unknown",
  ): boolean {
    // Reads live byKey stream state below — drain buffered text deltas so the
    // persisted reply includes every arrived chunk (guards the interrupt race).
    flushStreamDeltasFor(sessionId, actorId);
    const streamKey = agentStreamKey(sessionId, actorId);
    if (flushTurnAgentReplyInFlightRef.current[streamKey]) {
      logInterruptMsgDiag("flush.skip.inFlight", { sessionId, actorId, trigger });
      return false;
    }

    const allPendingReplies = pendingStreamRepliesRef.current[streamKey];
    if (!allPendingReplies?.length) {
      logInterruptMsgDiag("flush.skip.noPending", {
        sessionId,
        actorId,
        trigger,
        terminalFlushPending: Boolean(terminalFlushPendingRef.current[streamKey]),
        ...summarizeStreamEntry(
          useV2StreamingStore.getState().byKey[streamKey],
          "live",
        ),
        archivedCount: useV2StreamingStore.getState().archived.filter(
          (entry) => entry.sessionId === sessionId && entry.actorId === actorId,
        ).length,
      });
      return false;
    }

    // Parking is keyed by session::actor only, so a late reply from a PRIOR
    // turn can land in the same bucket as the current turn's slices. Flush only
    // the triggering turn (the most recently parked reply) and leave any other
    // turn's entries parked, so turn A's text is never stitched into turn B's
    // persisted message.
    const triggerTurnId =
      allPendingReplies[allPendingReplies.length - 1]?.turnId ?? "";
    const pendingReplies = allPendingReplies.filter(
      (m) => (m.turnId ?? "") === triggerTurnId,
    );
    const otherTurnReplies = allPendingReplies.filter(
      (m) => (m.turnId ?? "") !== triggerTurnId,
    );

    const liveStreamEntry = useV2StreamingStore.getState().byKey[streamKey];
    const streamEntryForPersist = resolveStreamEntryForPersist(
      sessionId,
      actorId,
      liveStreamEntry,
    );
    const flushDecision = summarizeFlushDecision({
      pending: pendingReplies,
      liveStream: liveStreamEntry,
      resolvedStream: streamEntryForPersist,
    });
    const mergedReply = mergePendingAgentReplies(
      pendingReplies,
      streamEntryForPersist,
    );
    if (!mergedReply) {
      logInterruptMsgDiag("flush.skip.mergeNull", {
        sessionId,
        actorId,
        trigger,
        ...flushDecision,
      });
      return false;
    }

    const pendingReplyTo = resolvePendingAgentReplyTo(
      sessionId,
      actorId,
      mergedReply.replyToMessageId,
    );
    if (pendingReplyTo) {
      mergedReply.replyToMessageId = pendingReplyTo;
    }

    logInterruptMsgDiag("flush.start", {
      sessionId,
      actorId,
      trigger,
      ...flushDecision,
    });
    flushTurnAgentReplyInFlightRef.current[streamKey] = true;
    const pendingSnapshot = [...pendingReplies];
    const streamEntrySnapshot = streamEntryForPersist
      ? cloneStreamEntrySnapshot(streamEntryForPersist)
      : undefined;
    // Retain any other-turn replies so they can flush under their own turn
    // instead of being stitched into this one.
    if (otherTurnReplies.length > 0) {
      pendingStreamRepliesRef.current[streamKey] = otherTurnReplies;
    } else {
      clearTurnAgentReplyParking(streamKey);
    }

    void executeAgentTurnFlush({
      sessionId,
      actorId,
      trigger,
      teamId: teamIdForSession(sessionId),
      reply: mergedReply,
      pendingReplies: pendingSnapshot,
      streamEntrySnapshot,
      beforePersist: () => {
        useV2StreamingStore.getState().finalize(sessionId, actorId);
      },
      afterEnriched: () => {
        removeInterruptedStreamPlaceholder(
          sessionId,
          actorId,
          streamEntrySnapshot?.streamId,
        );
      },
      persistedStage: "flush.persisted",
    }).finally(() => {
      delete flushTurnAgentReplyInFlightRef.current[streamKey];
      useV2StreamingStore
        .getState()
        .clearInterruptedFlushPending(sessionId, actorId);
    });

    return true;
  }

  useEffect(() => {
    registerDiscardPendingStreamReply((sessionId, actorId) => {
      const streamKey = agentStreamKey(sessionId, actorId);
      logInterruptMsgDiag("flush.discardPending", {
        sessionId,
        actorId,
        ...summarizePendingReplies(pendingStreamRepliesRef.current[streamKey]),
      });
      clearTurnAgentReplyParking(streamKey);
      clearTerminalFlushPending(streamKey);
    });
    return () => {
      registerDiscardPendingStreamReply(null);
    };
  }, []);

  useEffect(() => {
    if (!mqttAuthKey || !userId || !mqttTeamId || !mqttAccessToken) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const wiringId = crypto.randomUUID();
    recordMqttDiag("app-mqtt", "wiring:effect-start", {
      wiringId,
      userId,
      teamId: mqttTeamId,
      mqttAuthKey,
      accessToken: describeJwt(mqttAccessToken),
      reconnectNonce: mqttReconnectNonce,
    });

    void (async () => {
      try {
        markStartup("mqtt:start");
        recordMqttDiag("app-mqtt", "wiring:start", { wiringId });
        // amuxd convention: MQTT username = actor_id, password = JWT
        // (see amux/daemon/src/mqtt/client.rs + daemon/server.rs).
        // EMQX validates the JWT and uses actor_id for topic ACL.
        const actorId = await resolveCurrentMemberActorId(mqttTeamId, userId, {
          currentTeamId: useCurrentTeamStore.getState().team?.id ?? null,
          currentMemberId: useCurrentTeamStore.getState().currentMember?.id ?? null,
        });
        recordMqttDiag("app-mqtt", "actor:resolved", { wiringId, actorId, userId, teamId: mqttTeamId });
        if (!actorId) {
          console.warn("[MQTT] no actor for user in team", mqttTeamId, "— skipping connect");
          recordMqttDiag("app-mqtt", "actor:missing", { wiringId, userId, teamId: mqttTeamId });
          return;
        }
        if (cancelled) {
          recordMqttDiag("app-mqtt", "wiring:cancelled-after-actor", { wiringId });
          return;
        }
        setMyActorId(actorId);
        const serverConfig = await getEffectiveServerConfig();
        const brokerHost = serverConfig.mqttHost;
        const brokerPort = serverConfig.mqttPort ?? 1883;
        const useTls = serverConfig.mqttUseTls ?? false;
        const brokerUrl = serverConfig.mqttUrl
          ?? `${useTls ? "mqtts" : "mqtt"}://${brokerHost ?? ""}:${brokerPort}`;
        recordMqttDiag("app-mqtt", "server-config:effective", {
          wiringId,
          brokerHost,
          brokerPort,
          useTls,
          brokerUrl,
          hasConfiguredMqttUsername: Boolean(serverConfig.mqttUsername?.trim()),
          hasConfiguredMqttPassword: Boolean(serverConfig.mqttPassword?.trim()),
          cloudApiUrl: serverConfig.cloudApiUrl,
        });
        if (!brokerHost) {
          console.warn("[MQTT] missing broker host — configure it in Settings > Server");
          recordMqttDiag("app-mqtt", "server-config:missing-broker-host", { wiringId });
          return;
        }
        console.info("[MQTT] connecting", {
          brokerHost,
          brokerPort,
          useTls,
          brokerUrl,
          teamId: mqttTeamId,
          actorId,
        });

        const configuredMqttUsername = serverConfig.mqttUsername?.trim();
        const configuredMqttPassword = serverConfig.mqttPassword?.trim();
        const useConfiguredMqttCredentials = Boolean(configuredMqttUsername && configuredMqttPassword);
        const clientId = `teamclaw-${actorId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
        recordMqttDiag("app-mqtt", "connect:before", {
          wiringId,
          clientId,
          username: useConfiguredMqttCredentials ? configuredMqttUsername : actorId,
          usingConfiguredCredentials: useConfiguredMqttCredentials,
          password: useConfiguredMqttCredentials ? "[configured-password]" : describeJwt(mqttAccessToken),
        });

        await connectMqttWithFreshAuth({
          brokerUrl,
          brokerHost,
          brokerPort,
          username: useConfiguredMqttCredentials ? configuredMqttUsername! : actorId,
          clientId,
          teamId: mqttTeamId,
          useTls,
          configuredPassword: useConfiguredMqttCredentials ? configuredMqttPassword! : undefined,
        });
        recordMqttDiag("app-mqtt", "connect:after", { wiringId, clientId });
        markStartup("mqtt:connected");
        resetSessionLiveSubscriptionState();
        if (cancelled) {
          recordMqttDiag("app-mqtt", "wiring:cancelled-after-connect", { wiringId });
          return;
        }

        // FC fans out to inbox/<auth.user_id> (see push-dispatch.ts), not actor_id.
        try {
          recordMqttDiag("app-mqtt", "inbox:subscribe-before", { wiringId, topic: `inbox/${userId}` });
          await mqttSubscribe(`inbox/${userId}`);
          recordMqttDiag("app-mqtt", "inbox:subscribe-ok", { wiringId, topic: `inbox/${userId}` });
        } catch (e) {
          console.warn("[inbox] subscribe failed", e);
          recordMqttDiag("app-mqtt", "inbox:subscribe-error", {
            wiringId,
            topic: `inbox/${userId}`,
            error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
          });
        }
        if (cancelled) {
          recordMqttDiag("app-mqtt", "wiring:cancelled-after-inbox", { wiringId });
          return;
        }

        recordMqttDiag("app-mqtt", "listen:before", { wiringId });
        unlisten = await listenForEnvelopes((env) => {
          if (env.topic.startsWith("inbox/")) {
            handleInboxEnvelope(env, userId, useSessionListStore.getState());
            return;
          }
          const decoded = decodeLiveEvent(new Uint8Array(env.bytes));
          if (!decoded) return;
          const sid = sessionIdFromLiveEvent(decoded, env.topic) ?? "";

          if (
            sid &&
            env.topic.includes("/session/") &&
            !rememberLiveEventId(
              seenLiveEventIdsRef.current,
              sid,
              decoded.envelope.eventId,
            )
          ) {
            // Second copy of a dual-path event (local daemon SSE fast-path +
            // MQTT deliver the same eventId) or an MQTT redelivery.
            bumpLiveDuplicateDropped();
            return;
          }

          if (env.topic.includes("/session/") && env.topic.endsWith("/live")) {
            const mentionActorIds =
              decoded.envelope.eventType === "message.created"
                ? decoded.sessionMessage?.mentionActorIds ?? []
                : undefined;
            useAcpDebugStore.getState().append({
              sessionId: sid,
              topic: env.topic,
              actorId: decoded.envelope.actorId,
              eventCase: `live:${decoded.envelope.eventType || "unknown"}`,
              envelopeMeta: {
                eventId: decoded.envelope.eventId,
                eventType: decoded.envelope.eventType,
                sentAt: decoded.envelope.sentAt?.toString?.() ?? "",
                actorId: decoded.envelope.actorId,
                sessionId: decoded.envelope.sessionId,
                hasAcpEvent: Boolean(decoded.acpEvent),
                acpCase: decoded.acpEvent?.event?.case ?? null,
                ...(mentionActorIds !== undefined
                  ? {
                      mentionActorIds,
                      contentPreview: decoded.sessionMessage?.message?.content?.slice(0, 80) ?? "",
                    }
                  : {}),
              },
              acpEvent: decoded.acpEvent,
            });
          }

          if (!sid) return;

          if (
            decoded.envelope.eventType === "session_participant.created" ||
            decoded.envelope.eventType === "session_participant.updated" ||
            decoded.envelope.eventType === "session_participant.deleted" ||
            decoded.envelope.eventType === "participant.added" ||
            decoded.envelope.eventType === "participant.removed" ||
            decoded.envelope.eventType === "session.participant.added" ||
            decoded.envelope.eventType === "session.participant.removed"
          ) {
            const teamId =
              useSessionListStore.getState().rows.find((r) => r.id === sid)
                ?.team_id ?? mqttTeamId;
            void useSessionParticipantStore
              .getState()
              .refreshSession(sid, teamId)
              .catch((e) => {
                console.warn("[participants] refresh failed:", e);
                useSessionParticipantStore.getState().invalidateSessions([sid]);
              });
            return;
          }

          // Case 1: final message.created
          if (decoded.message) {
            // This branch reads/finalizes ordered stream state below — drain
            // any buffered text deltas so finalize/persist see all arrived text.
            flushAllStreamDeltas();
            const msg = decoded.message;
            const senderActorId = msg.senderActorId;
            const streamingStore = useV2StreamingStore.getState();
            const streamKey = senderActorId ? agentStreamKey(sid, senderActorId) : "";
            const streamEntry = streamKey
              ? streamingStore.byKey[streamKey]
              : undefined;
            let parkedAgentReply = false;
            if (
              streamEntry &&
              senderActorId &&
              msg.kind === MessageKind.AGENT_REPLY
            ) {
              // Mid-turn daemon AgentReply slices stay parked until terminal
              // statusChange (or a late message.created after terminal).
              parkedAgentReply = true;
              const pendingReplies =
                pendingStreamRepliesRef.current[streamKey] ?? [];
              const nextPendingReplies = pendingReplies.some(
                (message) => message.messageId === msg.messageId,
              )
                ? pendingReplies
                : [...pendingReplies, msg];
              if (nextPendingReplies !== pendingReplies) {
                pendingStreamRepliesRef.current[streamKey] = nextPendingReplies;
              }
              const resolvedStreamEntry = resolveStreamEntryForPersist(
                sid,
                senderActorId,
                streamEntry,
              );
              const terminalPending = Boolean(
                terminalFlushPendingRef.current[streamKey],
              );
              const toolOnlyAnchor = isToolOnlyTurnAnchor(
                nextPendingReplies,
                resolvedStreamEntry,
              );
              const shouldFlush =
                terminalPending || toolOnlyAnchor;
              logInterruptMsgDiag("mqtt.agentReply.parked", {
                sessionId: sid,
                actorId: senderActorId,
                messageId: msg.messageId,
                turnId: msg.turnId,
                contentLength: (msg.content ?? "").trim().length,
                terminalPending,
                toolOnlyAnchor,
                shouldFlush,
                ...summarizeFlushDecision({
                  pending: nextPendingReplies,
                  liveStream: streamEntry,
                  resolvedStream: resolvedStreamEntry,
                }),
              });
              if (shouldFlush) {
                flushTurnAgentReply(
                  sid,
                  senderActorId,
                  terminalPending
                    ? "mqtt.message.created.terminalPending"
                    : "mqtt.message.created.toolOnlyAnchor",
                );
              }
            } else if (streamEntry && senderActorId) {
              streamingStore.finalize(
                sid,
                senderActorId,
                decoded.message.content,
              );
              useSessionMessageStore.getState().appendMessage(sid, decoded.message);
            } else {
              // Late REAL agent_reply after the live stream was detached by an
              // eager interrupt-flush: purge the synthetic anchor first so the
              // real reply doesn't duplicate it (survives reload otherwise).
              if (senderActorId && msg.kind === MessageKind.AGENT_REPLY) {
                removeInterruptedStreamPlaceholderForRealReply(sid, senderActorId);
                // Direct-append skips flushTurnAgentReply — still drop the
                // stamped parent from the local FIFO so a later flush cannot
                // reuse a stale user message id.
                const stampedReplyTo = msg.replyToMessageId?.trim();
                if (stampedReplyTo) {
                  removePendingAgentReplyTo(sid, senderActorId, stampedReplyTo);
                }
                logExtMsgDiag("mqtt.agentReply.lateAppend.noPartsPersist", {
                  sessionId: sid,
                  actorId: senderActorId,
                  note: "late AGENT_REPLY after stream detach — append without persistStreamingPartsForReply",
                  ...summarizeProtoForExtDiag(msg),
                });
              }
              useSessionMessageStore.getState().appendMessage(sid, decoded.message);
              if (senderActorId && msg.kind === MessageKind.AGENT_REPLY) {
                logExtMsgDiag("mqtt.agentReply.lateAppend.storeSnapshot", {
                  sessionId: sid,
                  ...summarizeProtosForExtDiag(
                    useSessionMessageStore.getState().messages[sid] ?? [],
                  ),
                });
              }
            }

            if (
              msg.kind === MessageKind.TEXT ||
              (msg.kind === MessageKind.AGENT_REPLY && !parkedAgentReply)
            ) {
              useV2StreamingStore.getState().clearStaleStreamErrors(
                sid,
                msg.kind === MessageKind.AGENT_REPLY ? senderActorId : undefined,
              );
            }

            if (
              !parkedAgentReply &&
              messageKindUpdatesSessionPreview(decoded.message.kind)
            ) {
              const listStore = useSessionListStore.getState();
              const sessionInList = listStore.rows.some((r) => r.id === sid);
              if (sessionInList) {
                const createdAtSec = Number(decoded.message.createdAt);
                bumpSessionListLastMessage(sid, decoded.message.content, {
                  at: Number.isFinite(createdAtSec) && createdAtSec > 0
                    ? new Date(createdAtSec * 1000).toISOString()
                    : undefined,
                });
              } else {
                // Invited to a new session: bump is a no-op until the row exists.
                scheduleSessionListRefresh(() => listStore.loadFirstPage());
              }
            }

            // Write ALL incoming messages into the unified `message` table
            // (origin="mqtt-live"). This replaces the old agent_runtime_event
            // writes for tool-call/result/thinking kinds.
            // The insertAgentRuntimeEvent table stays alive for backwards compat
            // but is no longer the primary read path.
            // TODO(cleanup): remove insertAgentRuntimeEvent writes once all
            //   clients have upgraded past this version and the old read path
            //   in history loader above is cleaned up.
            if (!parkedAgentReply) {
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
                replyToMessageId: m.replyToMessageId?.trim() || null,
                kind: kindStr,
                content: m.content,
                metadataJson: m.metadataJson || null,
                model: m.model || null,
                mentionsJson: null,
                origin: "mqtt-live",
                createdAt: new Date(Number(m.createdAt) * 1000).toISOString(),
                updatedAt: now,
                deletedAt: null,
                syncedAt: now,
                partsJson: (m as unknown as { partsJson?: string | null }).partsJson ?? null,
              };
              upsertMessagesBatch([msgRow]).catch((e) => {
                console.warn("[cache] message upsert failed:", e);
              });
            }
            // Desktop notification: fire-and-forget; dispatcher filters own
            // messages, DnD, focus, mute — no action needed on error.
            {
              const dm = decoded.message;
              const dmKind =
                dm.kind === MessageKind.AGENT_TOOL_CALL ? "agent_tool_call"
                : dm.kind === MessageKind.AGENT_TOOL_RESULT ? "agent_tool_result"
                : dm.kind === MessageKind.AGENT_THINKING ? "agent_thinking"
                : dm.kind === MessageKind.AGENT_REPLY ? "agent_reply"
                : dm.kind === MessageKind.SYSTEM ? "system"
                : "text";
              getDispatcher()?.maybeNotify({
                id: dm.messageId,
                session_id: dm.sessionId,
                sender_actor_id: dm.senderActorId,
                kind: dmKind,
                content: dm.content,
              }).catch((e) => {
                console.warn("[notifications] maybeNotify failed:", e);
              });
            }
            return;
          }

          // Case 2a: SessionEvent (e.g. PermissionResolved) arrives as
          // LiveEventEnvelope event_type=acp.event with Amux payload.sessionEvent.
          // Must run outside `if (decoded.acpEvent)` — that field is only set for
          // payload.case === "acpEvent".
          if (decoded.amuxEnvelope?.payload?.case === "sessionEvent") {
            const se = decoded.amuxEnvelope.payload.value?.event;
            if (se?.case === "permissionResolved") {
              const requestId = (se.value as { requestId?: string })?.requestId ?? "";
              handleSessionEventPermissionResolved({
                requestId,
                sessionIdHint: sid,
              });
            }
            return;
          }

          // Case 2: streaming acp.event
          if (decoded.acpEvent) {
            // Dev-only one-way latency probe (no-op unless the local daemon
            // runs with AMUX_LATENCY_PROBE=1). See lib/latency-probe.ts.
            recordLatencyProbe(decoded.amuxEnvelope?.sourcePeerId);
            const actorId = streamActorIdFromLiveEvent(decoded);
            if (!actorId) return;
            const acpSid = decoded.amuxEnvelope?.acpSessionId?.trim() ?? "";
            if (acpSid) {
              const streamStore = useV2StreamingStore.getState();
              const eventCase = decoded.acpEvent.event?.case;
              if (eventCase !== "permissionRequest") {
                const parentToolId = streamStore.childAcpSessionToToolId[acpSid];
                if (parentToolId) {
                  routeSubagentAcpEvent(sid, actorId, parentToolId, decoded.acpEvent);
                  return;
                }
                if (shouldBufferUnboundChildAcpEvent(sid, actorId, acpSid, streamStore)) {
                  streamStore.bufferPendingSubagentEvent(acpSid, decoded.acpEvent);
                  return;
                }
              }
            } else {
              const streamStoreForOrphan = useV2StreamingStore.getState();
              const orphanTaskToolId = resolveOrphanSubagentParentToolId(
                sid,
                actorId,
                streamStoreForOrphan,
              );
              if (
                orphanTaskToolId &&
                shouldRouteOrphanSubagentEvent(decoded.acpEvent, orphanTaskToolId)
              ) {
                routeSubagentAcpEvent(
                  sid,
                  actorId,
                  orphanTaskToolId,
                  decoded.acpEvent,
                );
                return;
              }
            }

            const event = decoded.acpEvent.event;

            // Non-text events read/mutate ordered stream state — drain any
            // buffered text deltas for this stream first so parts ordering
            // matches arrival order.
            if (event?.case !== "output" && event?.case !== "thinking") {
              flushStreamDeltasFor(sid, actorId);
            }

            // acp.event detail already logged in the live:* line above.
            if (event?.case === "output") {
              const text = (event.value as { text?: string })?.text ?? "";
              bufferStreamDelta("output", sid, actorId, text);
            } else if (event?.case === "thinking") {
              const text = (event.value as { text?: string })?.text ?? "";
              bufferStreamDelta("thinking", sid, actorId, text);
            } else if (event?.case === "toolUse") {
              const tu = normalizeToolUseEvent(event.value);
              useV2StreamingStore.getState().pushToolUse(sid, actorId, {
                toolId: tu.toolId,
                toolName: tu.toolName,
                description: tu.description,
                params: tu.params,
                toolKind: tu.toolKind,
                content: tu.content,
                locations: tu.locations,
                acpStatus: tu.acpStatus,
                rawInput: tu.rawInput,
                rawOutput: tu.rawOutput,
              });
              // Capture skill invocations for local stats + cloud leaderboard.
              // tu.toolName is "skill" for Skill tool calls; tu.params.name is
              // the skill slug (e.g. "sentry-fix").
              if (
                (tu.toolName === "skill" || tu.params?.description === "skill") &&
                tu.params?.name
              ) {
                const wp = useWorkspaceStore.getState().workspacePath;
                if (wp) {
                  void useLocalStatsStore.getState().incrementSkillUsage(wp, tu.params.name);
                }
              }
              syncPlanFromTodoTool(sid, actorId, {
                toolName: tu.toolName,
                params: tu.params,
                description: tu.description,
              });
            } else if (event?.case === "toolResult") {
              const tr = normalizeToolResultEvent(event.value);
              logStreamToolDiag("mqtt.toolResult", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                toolId: tr.toolId,
                success: tr.success,
              });
              useV2StreamingStore.getState().completeToolUse(sid, actorId, {
                toolId: tr.toolId,
                success: tr.success,
                summary: tr.summary,
                content: tr.content,
                rawOutput: tr.rawOutput,
              });
              syncPlanFromTodoToolResult(sid, actorId, {
                toolId: tr.toolId,
                success: tr.success,
                summary: tr.summary,
              });
              void syncStreamingToolOutputsFromLocalCache(sid, actorId);
              window.setTimeout(() => {
                void syncStreamingToolOutputsFromLocalCache(sid, actorId);
              }, 500);
            } else if (event?.case === "statusChange") {
              const sc = event.value as { oldStatus?: number; newStatus?: number };
              logStreamToolDiag("mqtt.statusChange", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                oldStatus: sc.oldStatus,
                newStatus: sc.newStatus,
              });
              if (isAgentActiveStatus(sc.newStatus)) {
                const flushed = flushTurnAgentReply(
                  sid,
                  actorId,
                  "mqtt.statusChange.active",
                );
                logInterruptMsgDiag("mqtt.statusChange.active", {
                  sessionId: sid,
                  actorId,
                  oldStatus: sc.oldStatus,
                  newStatus: sc.newStatus,
                  flushedPreviousTurn: flushed,
                  ...summarizePendingReplies(
                    pendingStreamRepliesRef.current[agentStreamKey(sid, actorId)],
                  ),
                });
                clearTerminalFlushPending(agentStreamKey(sid, actorId));
                useV2StreamingStore.getState().beginPlanningPlaceholder(sid, actorId);
              } else if (isTerminalAgentStatus(sc.newStatus)) {
                const streamKey = agentStreamKey(sid, actorId);
                terminalFlushPendingRef.current[streamKey] = true;
                const flushed = flushTurnAgentReply(
                  sid,
                  actorId,
                  "mqtt.statusChange.terminal",
                );
                logInterruptMsgDiag("mqtt.statusChange.terminal", {
                  sessionId: sid,
                  actorId,
                  oldStatus: sc.oldStatus,
                  newStatus: sc.newStatus,
                  flushed,
                  ...summarizePendingReplies(
                    pendingStreamRepliesRef.current[streamKey],
                  ),
                  ...summarizeStreamEntry(
                    useV2StreamingStore.getState().byKey[streamKey],
                    "live",
                  ),
                });
                if (flushed) {
                  clearTerminalFlushPending(streamKey);
                } else {
                  const streamEntry =
                    useV2StreamingStore.getState().byKey[streamKey];
                  if (streamEntryHasVisibleContent(streamEntry)) {
                    // Live Dock only shows active streams; when daemon
                    // message.created lags statusChange.terminal, flush from
                    // the in-memory transcript instead of dropping the turn.
                    const eagerFlushed = flushInterruptedStreamArtifacts(
                      sid,
                      actorId,
                      "mqtt.statusChange.terminal.eager",
                    );
                    logInterruptMsgDiag("mqtt.statusChange.terminal.eager", {
                      sessionId: sid,
                      actorId,
                      eagerFlushed,
                      ...summarizeStreamEntry(streamEntry, "live"),
                    });
                    if (eagerFlushed) {
                      clearTerminalFlushPending(streamKey);
                    } else {
                      useV2StreamingStore.getState().finishSessionActor(sid, actorId, {
                        reason: "statusChange.terminal",
                      });
                    }
                  } else {
                    useV2StreamingStore.getState().setError(
                      sid,
                      actorId,
                      t(
                        "daemon.agentRuntime.emptyReply",
                        "Agent returned no output. The selected model may be unavailable or misconfigured.",
                      ),
                      "",
                    );
                  }
                }
              }
            } else if (event?.case === "error") {
              const er = event.value as { message?: string; details?: string };
              terminalFlushPendingRef.current[agentStreamKey(sid, actorId)] = true;
              flushTurnAgentReply(sid, actorId, "mqtt.error");
              // Localize known daemon-emitted errors (the daemon is
              // locale-agnostic and emits English for iOS/logs). Keep the raw
              // message for anything we don't recognize. Sentinel matches
              // `emit_acp_error(.., "Model provider not responding", ..)` in
              // apps/daemon/src/runtime/adapter.rs (prompt stall watchdog).
              const localizedMessage =
                er.message === "Model provider not responding"
                  ? t(
                      "daemon.agentRuntime.providerStalled",
                      "The model provider stopped responding. It may be unavailable or rate-limited — please retry or switch models.",
                    )
                  : (er.message ?? "Agent error");
              useV2StreamingStore.getState().setError(
                sid,
                actorId,
                localizedMessage,
                er.details ?? "",
              );
            } else if (event?.case === "permissionRequest") {
              const pr = event.value as {
                requestId?: string;
                toolName?: string;
                description?: string;
                params?: Record<string, string>;
                options?: Array<{ optionId?: string; kind?: string; name?: string }>;
              };
              logStreamToolDiag("mqtt.permissionRequest", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                requestId: pr.requestId,
                toolName: pr.toolName,
                description: pr.description,
                isDoomLoop: pr.toolName === "doom_loop",
              });
              tryBindChildFromPermission(
                sid,
                actorId,
                pr.params?.childSessionId ?? "",
                pr.params?.toolCallId,
              );
              void handleAcpPermissionRequest({
                sessionId: sid,
                agentActorId: actorId,
                request: {
                  requestId: pr.requestId ?? "",
                  toolName: pr.toolName ?? "",
                  description: pr.description ?? "",
                  params: pr.params ?? {},
                  requesterActorId: pr.params?.requester_actor_id?.trim() || undefined,
                  options: (pr.options ?? []).map((o) => ({
                    optionId: o.optionId ?? "",
                    kind: o.kind ?? "",
                    name: o.name ?? "",
                  })),
                },
              });
            } else if (event?.case === "planUpdate") {
              const pu = event.value as { entries?: Array<{ content?: string; priority?: string; status?: string }> };
              useV2StreamingStore.getState().setPlan(
                sid,
                actorId,
                mapAcpPlanEntries(pu.entries ?? []),
              );
            }
            // statusChange / availableCommands / raw: MVP no-op (RuntimeInfo retain
            // already surfaces agent status; commands TBD; raw is catch-all).
          }
        });
        recordMqttDiag("app-mqtt", "listen:after", { wiringId });
        if (cancelled) {
          unlisten?.();
          recordMqttDiag("app-mqtt", "wiring:cancelled-after-listen", { wiringId });
          return;
        }

        // Prefer the member ACL's team-wide session/live subscription so
        // desktop receives replies for sessions that another logged-in client
        // created or moved. Fall back to the old recent-session slice if a
        // broker still has older ACL claims.
        const recentAtBoot = useSessionListStore.getState().rows.slice(0, RECENT_SESSION_SUBSCRIBE_CAP);
        try {
          recordMqttDiag("app-mqtt", "session-live-wildcard:subscribe-before", {
            wiringId,
            topic: `amux/${mqttTeamId}/session/+/live`,
          });
          await ensureTeamSessionLiveSubscribed(mqttTeamId);
          console.log('[MQTT] receiver wired: subscribed to team session/live wildcard');
          recordMqttDiag("app-mqtt", "session-live-wildcard:subscribe-ok", {
            wiringId,
            topic: `amux/${mqttTeamId}/session/+/live`,
          });
        } catch (e) {
          console.warn('[MQTT] team session/live wildcard subscribe failed; falling back to recent sessions', e);
          recordMqttDiag("app-mqtt", "session-live-wildcard:subscribe-error", {
            wiringId,
            topic: `amux/${mqttTeamId}/session/+/live`,
            error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
            fallbackCount: recentAtBoot.length,
          });
          await Promise.all(
            recentAtBoot.map((r) =>
              ensureSessionLiveSubscribed(r.team_id, r.id).catch((err) => {
                console.warn('[MQTT] subscribe failed', `amux/${r.team_id}/session/${r.id}/live`, err);
              }),
            ),
          );
          console.log('[MQTT] receiver wired: subscribed to', recentAtBoot.length, 'recent session/live topics');
        }

        // RPC client: subscribe to the team's rpc/res topic and start correlating.
        recordMqttDiag("app-mqtt", "rpc:init-before", {
          wiringId,
          topic: `amux/${mqttTeamId}/+/rpc/res`,
        });
        registerPlatformExecutors();
        await initTeamclawRpc(mqttTeamId, actorId);
        await initRemoteToolsRpcServer({ teamId: mqttTeamId, actorId });
        console.log('[teamclaw-rpc] initialized for team', mqttTeamId);
        recordMqttDiag("app-mqtt", "rpc:init-ok", { wiringId, topic: `amux/${mqttTeamId}/+/rpc/res` });

        // Runtime state store: subscribe to daemon-published RuntimeInfo retains.
        recordMqttDiag("app-mqtt", "runtime-state:init-before", {
          wiringId,
          topic: `amux/${mqttTeamId}/+/runtime/+/state`,
        });
        await initRuntimeStateStore(mqttTeamId);
        console.log('[runtime-state] initialized for team', mqttTeamId);
        recordMqttDiag("app-mqtt", "runtime-state:init-ok", { wiringId });

        // Actor presence: subscribe to daemon LWT-backed online/offline state.
        recordMqttDiag("app-mqtt", "presence:init-before", {
          wiringId,
          topic: `amux/${mqttTeamId}/+/state`,
        });
        await initActorPresenceStore(mqttTeamId);
        console.log('[device-presence] initialized for team', mqttTeamId);
        recordMqttDiag("app-mqtt", "presence:init-ok", { wiringId });
        recordMqttDiag("app-mqtt", "wiring:ready", { wiringId });

        // Background: sync actor directory into local cache so display-name
        // lookups hit libsql instead of Supabase on subsequent renders.
        void syncActorsForTeam(mqttTeamId).catch((e) =>
          console.warn('[cache-sync] actor sync failed:', e),
        );

        // Background: sync ideas into local cache.
        void syncIdeasForTeam(mqttTeamId).catch((e) =>
          console.warn('[cache-sync] idea sync failed:', e),
        );

        // Background: sync sessions into local cache. E2E control owns the
        // session-list rows while active, so skip normal hydration/reloads.
        if (!isV2E2EControlActive()) {
          void syncSessionsForTeam(mqttTeamId).then(() => {
            if (isV2E2EControlActive()) return;
            // Reload session list from merged local cache after sync finishes.
            void useSessionListStore.getState().load();
          }).catch((e) =>
            console.warn('[cache-sync] session sync failed:', e),
          );
        }
      } catch (err) {
        console.error("[MQTT] receiver wiring failed:", err);
        recordMqttDiag("app-mqtt", "wiring:error", {
          wiringId,
          error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
      recordMqttDiag("app-mqtt", "wiring:cleanup", { wiringId });
      unlisten?.();
      pendingStreamRepliesRef.current = {};
      terminalFlushPendingRef.current = {};
      interruptedStreamFlushRef.current = {};
      interruptedFlushSupersededRef.current = {};
      interruptedFlushSupersededStreamIdRef.current = {};
      disposeTeamclawRpc();
      disposeRemoteToolsRpcServer();
      disposeRuntimeStateStore();
      disposeActorPresenceStore();
    };
  }, [mqttAuthKey, userId, mqttTeamId, mqttAccessToken, mqttReconnectNonce]);

  // Keep session/live subscriptions in sync with the user's most-recent
  // sessions. Rows are sorted by last_message_at DESC, so we slice the top
  // RECENT_SESSION_SUBSCRIBE_CAP and subscribe any not-yet-subscribed.
  // When a new session is created and pushed into rows (newest first),
  // it's auto-included here. Older sessions stay un-subscribed until the
  // user activates one (see the activeSessionId effect below).
  const sessionRowsForSubscribe = useSessionListStore((s) => s.rows);
  useEffect(() => {
    if (!userId || !mqttTeamId) return;
    if (hasTeamSessionLiveSubscription(mqttTeamId)) return;
    let cancelled = false;
    const recent = sessionRowsForSubscribe.slice(0, RECENT_SESSION_SUBSCRIBE_CAP);
    void (async () => {
      for (const r of recent) {
        if (cancelled) return;
        await ensureSessionLiveSubscribed(r.team_id, r.id).catch((e) => {
          console.warn('[MQTT] subscribe failed', `amux/${r.team_id}/session/${r.id}/live`, e);
        });
      }
    })();
    return () => { cancelled = true; };
  }, [sessionRowsForSubscribe, userId, mqttTeamId]);

  // Lazy-subscribe on session activation. When the user opens a session
  // that's outside the most-recent slice, subscribe to its live topic so
  // any incoming streaming arrives. Idempotent via the shared dedup set.
  // Reactive on the row's team_id (selector) so this also fires once the
  // session list finishes loading — otherwise a freshly-activated session
  // can race against rows hydration and stay un-subscribed.
  const activeSessionIdForSubscribe = useSessionSelectionStore((s) => s.activeSessionId);
  const activeSessionTeamId = useSessionListStore((s) =>
    activeSessionIdForSubscribe
      ? s.rows.find((r) => r.id === activeSessionIdForSubscribe)?.team_id ?? null
      : null,
  );
  useEffect(() => {
    if (!activeSessionIdForSubscribe || !userId || !mqttTeamId) return;
    if (!activeSessionTeamId) return;
    void ensureSessionLiveSubscribed(
      activeSessionTeamId,
      activeSessionIdForSubscribe,
    );
  }, [activeSessionIdForSubscribe, activeSessionTeamId, userId, mqttTeamId]);

  // v2 Phase 1 → local-first: load message history whenever the active
  // session changes.
  //   1. Tauri: hydrate immediately from local libsql cache (no Supabase wait).
  //   2. Background: delta-sync from Supabase (watermark-based), upsert local,
  //      re-render if anything new arrived.
  //   3. Extension: chrome.storage.local cache (same MessageRow shape) + full
  //      cloud pull; COALESCE preserves local parts_json.
  //   4. Other Non-Tauri: full backend pull.
  // agent_runtime_event table is no longer read here — those rows were written
  // with origin="mqtt-live" into the message table by new envelope handler code.
  // TODO(cleanup): remove agent_runtime_event table once all clients have
  // upgraded past this version.
  const currentSessionId = useSessionSelectionStore((s) => s.currentSessionId);
  const hasCurrentSession = Boolean(currentSessionId);
  const messageRefreshTrigger = useSessionMessageStore((s) => s.messageRefreshTrigger);
  const messageRefreshForceFull = useSessionMessageStore((s) => s.messageRefreshForceFull);
  const prevRefreshTriggerRef = useRef(0);

  // Extension: prune message cache on sidepanel open (in addition to write/load).
  useEffect(() => {
    if (!isChromeExtension()) return;
    void import("@/lib/extension-message-cache").then(({ pruneExtensionMessageCache }) =>
      pruneExtensionMessageCache(),
    );
  }, []);

  useEffect(() => {
    if (!currentSessionId) return;
    if (isV2E2EControlActive()) return;
    // A refresh-trigger bump on the SAME session = user pressed ↻, or an
    // explicit full reload (e.g. opening a cron session from run history).
    const triggerBumped =
      messageRefreshTrigger !== prevRefreshTriggerRef.current;
    const forceFull =
      messageRefreshForceFull ||
      (triggerBumped && prevRefreshTriggerRef.current !== 0);
    prevRefreshTriggerRef.current = messageRefreshTrigger;
    if (messageRefreshForceFull) {
      useSessionMessageStore.setState({ messageRefreshForceFull: false });
    }
    let cancelled = false;
    const kindMap: Record<string, MessageKind> = {
      text: MessageKind.TEXT,
      system: MessageKind.SYSTEM,
      agent_thinking: MessageKind.AGENT_THINKING,
      agent_tool_call: MessageKind.AGENT_TOOL_CALL,
      agent_tool_result: MessageKind.AGENT_TOOL_RESULT,
      agent_reply: MessageKind.AGENT_REPLY,
    };

    void (async () => {
      if (isTauri()) {
        // ── Phase 1: instant render from local cache ──────────────────
        const { loadMessagesForSession } = await import("@/lib/local-cache");
        const localMsgs = await loadMessagesForSession(
          currentSessionId,
          false,
          workspacePath,
        );
        if (cancelled) return;
        if (localMsgs.length > 0) {
          useSessionMessageStore.getState().setMessages(
            currentSessionId,
            messageRowsToProto(localMsgs),
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
          const fresh = await loadMessagesForSession(
            currentSessionId,
            false,
            workspacePath,
          );
          if (!cancelled) {
            useSessionMessageStore.getState().setMessages(
              currentSessionId,
              messageRowsToProto(fresh),
            );
          }
        }
        return;
      }

      // ── Extension: local-first (chrome.storage) + full cloud pull ─
      // Same shape as desktop: hydrate cache → upsert cloud rows (COALESCE
      // parts_json) → re-read. Eviction runs inside the cache writes / load.
      if (isChromeExtension()) {
        const { loadMessagesForSession, upsertMessagesBatch } = await import(
          "@/lib/local-cache"
        );
        const localMsgs = await loadMessagesForSession(currentSessionId, false);
        if (cancelled) return;
        if (localMsgs.length > 0) {
          const localProtos = messageRowsToProto(localMsgs);
          useSessionMessageStore
            .getState()
            .setMessages(currentSessionId, localProtos);
          logExtMsgDiag("history.ext.hydrateLocal", {
            sessionId: currentSessionId,
            ...summarizeProtosForExtDiag(localProtos),
          });
        }

        let historyRows;
        try {
          historyRows = await getBackend().messages.listMessages(currentSessionId);
        } catch (error) {
          console.warn(
            "[history] load failed:",
            error instanceof Error ? error.message : error,
          );
          if (!cancelled && localMsgs.length === 0) {
            useSessionMessageStore.getState().setMessages(currentSessionId, []);
          }
          return;
        }
        if (cancelled) return;

        const teamId =
          useSessionListStore.getState().rows.find((r) => r.id === currentSessionId)
            ?.team_id ?? "";
        const memoryBeforeCloud = useSessionMessageStore.getState().messages[
          currentSessionId
        ] ?? [];
        logExtMsgDiag("history.ext.beforeCloudUpsert", {
          sessionId: currentSessionId,
          cloudCount: historyRows.length,
          memory: summarizeProtosForExtDiag(memoryBeforeCloud),
        });
        await upsertMessagesBatch(
          historyRowsToMessageRows(historyRows, {
            teamId,
            origin: getBackend().kind,
          }),
        );
        if (cancelled) return;

        const fresh = await loadMessagesForSession(currentSessionId, false);
        if (!cancelled) {
          const freshProtos = messageRowsToProto(fresh);
          useSessionMessageStore
            .getState()
            .setMessages(currentSessionId, freshProtos);
          logExtMsgDiag("history.ext.afterSetMessages", {
            sessionId: currentSessionId,
            note: "whole-replace from cache after cloud upsert — check partsLen / interruptCount",
            ...summarizeProtosForExtDiag(freshProtos),
          });
        }
        return;
      }

      // ── Non-Tauri web: full backend pull ──────────────────────────
      let historyRows;
      try {
        historyRows = await getBackend().messages.listMessages(currentSessionId);
      } catch (error) {
        console.warn("[history] load failed:", error instanceof Error ? error.message : error);
        if (!cancelled) {
          useSessionMessageStore.getState().setMessages(currentSessionId, []);
        }
        return;
      }
      if (cancelled) return;
      const backendMsgs = historyRows.map((r) => {
        const metadataJson =
          r.metadata == null
            ? ""
            : typeof r.metadata === "string"
              ? r.metadata
              : JSON.stringify(r.metadata);
        return createMessage(MessageSchema, {
          messageId: r.id,
          sessionId: r.session_id,
          senderActorId: r.sender_actor_id ?? "",
          kind: kindMap[r.kind] ?? MessageKind.TEXT,
          content: r.content ?? "",
          model: r.model ?? "",
          turnId: r.turn_id ?? "",
          replyToMessageId: r.reply_to_message_id ?? "",
          metadataJson,
          createdAt: BigInt(Math.floor(new Date(r.created_at).getTime() / 1000)),
        });
      });
      useSessionMessageStore.getState().setMessages(currentSessionId, backendMsgs);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, messageRefreshTrigger, messageRefreshForceFull, workspacePath]);

  /** When left dock opens, hide the main sidebar; restore prior expansion when it closes. */
  const restoreSidebarAfterLeftDockRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (leftDockActive) {
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
  }, [leftDockActive, sidebarOpen, setSidebarOpen, closePanel]);

  const settingsModal = (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleCloseSettings();
        }
      }}
    >
      <DialogContent
        aria-label={t("common.settings", "Settings")}
        className="flex h-[min(780px,calc(100vh-5rem))] w-[min(960px,calc(100vw-4rem))] max-w-none grid-cols-none flex-col gap-0 overflow-hidden rounded-[14px] border-border bg-paper p-0 shadow-2xl sm:max-w-none"
        showCloseButton={false}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex h-12 shrink-0 flex-row items-center gap-2 border-b border-border bg-paper px-5 py-0 text-left">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[15px] font-bold leading-none text-foreground">
              {t("common.settings", "Settings")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("settings.description", "Configure TeamClaw settings.")}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground hover:bg-selected hover:text-foreground"
            onClick={() => setFeedbackOpen(true)}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {t('settings.feedback.title', 'Send Feedback')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-selected hover:text-foreground"
            onClick={handleCloseSettings}
            aria-label={t("common.close", "Close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>
        <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        <div className="min-h-0 flex-1 overflow-hidden">
          {embedMode ? <ExtensionSettings /> : <Settings />}
        </div>
      </DialogContent>
    </Dialog>
  );

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
            <span className="font-medium">{appDisplayName}</span>
          </header>
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SidebarInset>
        {settingsModal}
      </>
    );
  }

  return (
    <>
      {breakpoint === 'wide' && <AppSidebar />}
      {breakpoint !== 'narrow' && (
        <div className="w-(--session-list-width) shrink-0 h-svh overflow-hidden">
          <SidebarSecondColumn showNewSessionActions={breakpoint === 'medium'} />
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
          {breakpoint === 'narrow' && <NarrowChatHeader />}
          {teamShareMode ? (
            <TeamShareDetailPane />
          ) : (
          <>
          {/* Header with breadcrumb - sticky */}
          {showChatSessionHeader ? (
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
            {activeSession && (
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(buildSessionDeeplink(activeSession.id));
                    toast.success(t("chat.shareLinkCopied", "会话链接已复制"));
                  } catch {
                    toast.error(t("chat.shareLinkCopyFailed", "复制失败"));
                  }
                }}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t("chat.copyShareLink", "复制会话分享链接")}
              >
                <Link2 className="h-3.5 w-3.5" />
              </button>
            )}

            {/* Panel tabs - right side of header */}
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
              {capabilities.workspace && workspacePath && (
                <TerminalToggleButton workspacePath={workspacePath} />
              )}
              {hasCurrentSession && (
                <HeaderPanelTab
                  icon={Users}
                  label={t("chat.actorSheet.title", "Actors")}
                  isActive={isPanelOpen && activeTab === "actors"}
                  onClick={() => isPanelOpen && activeTab === "actors" ? closePanel() : openPanel("actors")}
                />
              )}
              {capabilities.workspace && (
                <HeaderPanelTab
                  icon={BookOpen}
                  label={t("navigation.files", "files")}
                  isActive={isPanelOpen && activeTab === "files"}
                  onClick={() => isPanelOpen && activeTab === "files" ? closePanel() : openPanel("files")}
                />
              )}
              {capabilities.workspace && isShareModeLocked(teamSharedTabMode) && (
                <HeaderPanelTab
                  icon={Share2}
                  label={t("navigation.teamSharedFiles", "team shared files")}
                  isActive={isPanelOpen && activeTab === "teamShared"}
                  onClick={() =>
                    isPanelOpen && activeTab === "teamShared" ? closePanel() : openPanel("teamShared")
                  }
                />
              )}
              {capabilities.workspace && hasCurrentSession && (
                <HeaderPanelTab
                  icon={FolderGit}
                  label={t("navigation.changes", "Changes")}
                  count={sessionDiff.length}
                  isActive={isPanelOpen && activeTab === "diff"}
                  onClick={() => isPanelOpen && activeTab === "diff" ? closePanel() : openPanel("diff")}
                />
              )}
              {showRightWorkspacePanel && (
                <button
                  className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={closePanel}
                  title={t("navigation.collapsePanel", "Collapse panel")}
                >
                  <PanelRightClose className="h-4 w-4" />
                </button>
              )}
            </div>
          </header>
          ) : null}

          <RuntimeRefreshWorkspaceBanner />

          {/* Main content - Chat or file preview */}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <MainContent />
          </div>
          </>
          )}
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
      {settingsModal}
    </>
  );
}

function App() {
  React.useEffect(() => {
    installV2E2EControl();
  }, []);

  // ── Global webview shortcuts (find, zoom, context menu) ──
  useWebviewShortcuts()
  useTerminalShortcuts()
  useDaemonLiveStatus()

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

  // ── Deeplink: teamclaw://invite?token=… ───────────────────────────────────
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;

    async function handle(urls: string[]) {
      for (const raw of urls) {
        const token = parseInviteDeeplink(raw);
        if (!token) continue;
        // Member invites require a real account. If the user isn't signed in
        // yet (or is still anonymous), stash the token and let sign-in +
        // AuthGate's pending-invite effect claim it once they're authenticated.
        const authState = useAuthStore.getState();
        if (!authState.session || authState.session.user?.is_anonymous) {
          authState.setPendingInviteToken(token);
          continue;
        }
        try {
          const claim = await claimInviteToken(token);
          await useCurrentTeamStore.getState().reloadAndSwitchTo(claim.teamId);
          // Re-onboard the local daemon to the freshly-claimed team. The
          // daemon-onboarding store's refresh() detects the team mismatch and
          // the DaemonOnboardingWizard handles re-onboard. Best-effort only.
          if (isTauri()) {
            try {
              const { useDaemonOnboardingStore } = await import("@/stores/daemon-onboarding");
              await useDaemonOnboardingStore.getState().refresh();
            } catch (e) {
              console.warn("[invite] daemon refresh after claim failed", e);
            }
          }
          // TODO(Task 12): surface <JoinTeamFlow teamId={claim.teamId}
          //   workspacePath={currentWorkspacePath} /> in an onboarding sheet
          //   here so the joiner auto-pulls workspace config and enters the
          //   team secret. Component lives at
          //   packages/app/src/components/onboarding/JoinTeamFlow.tsx.
        } catch (err) {
          console.error('[invite] claim failed', err);
        }
      }
    }

    // Cold start — link that launched the app
    getCurrent().then((urls) => { if (urls) handle(urls); }).catch(() => {});

    // Hot delivery while app is already open
    onOpenUrl(handle).then((u) => { unlisten = u; }).catch(() => {});

    return () => { unlisten?.(); };
  }, []);

  // ── Deeplink: teamclaw://session/<uuid> ───────────────────────────────────
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;

    async function handle(urls: string[]) {
      for (const raw of urls) {
        const sessionId = parseSessionDeeplink(raw);
        if (!sessionId) continue;
        // Best-effort: only act for a real signed-in user. No stash / no
        // cold-start resume — a non-logged-in launch just drops the link.
        const authState = useAuthStore.getState();
        if (!authState.session || authState.session.user?.is_anonymous) continue;
        try {
          const session = await getBackend().sessions.joinSession(sessionId);
          const teamId = session.team_id;
          const currentTeamId = useCurrentTeamStore.getState().team?.id ?? null;
          if (teamId && teamId !== currentTeamId) {
            await useCurrentTeamStore.getState().reloadAndSwitchTo(teamId);
          }
          await useUIStore.getState().switchToSession(sessionId);
          // Refresh the session list so the freshly-joined session appears in
          // the left column without waiting for a remount.
          await useSessionListStore.getState().load();
        } catch (err) {
          if (err instanceof CloudApiError && err.status === 403) {
            toast.error(i18n.t("session.deeplink.noAccess", "无权访问该会话"));
          } else if (err instanceof CloudApiError && err.status === 404) {
            toast.error(i18n.t("session.deeplink.notFound", "会话不存在或已被删除"));
          } else {
            toast.error(i18n.t("session.deeplink.openFailed", "打开会话失败"));
          }
          console.error("[session-deeplink] join failed", err);
        }
      }
    }

    // Cold start — link that launched the app
    getCurrent().then((urls) => { if (urls) handle(urls); }).catch(() => {});

    // Hot delivery while app is already open
    onOpenUrl(handle).then((u) => { unlisten = u; }).catch(() => {});

    return () => { unlisten?.(); };
  }, []);

  // Extracted hooks — initialization, setup guide, telemetry consent
  useTauriBodyClass();
  useOpenCodePreload();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const daemonHttpReady = useWorkspaceStore((s) => s.daemonHttpReady);
  const setupReady = !workspacePath || daemonHttpReady || !isTauri();
  const { showSetupGuide, dependencies, handleRecheck, handleSetupContinue } = useSetupGuide(setupReady);
  const { showConsentDialog, setShowConsentDialog } = useTelemetryConsent(showSetupGuide);

  // First-run welcome — the very first screen, shown before dependency setup.
  // Dismissing it (Get started) is what unblocks the dependency initialization.
  const [welcomeAck, setWelcomeAck] = useState(() => !isTauri() || hasSeenWelcome());
  const showWelcome = isTauri() && !welcomeAck;

  // Welcome / dependency-setup are immediately-interactive first-run screens — if
  // either shows, hand off from the static skeleton right away (AppContent owns
  // the removal on the normal path; this covers the screens that render instead).
  useEffect(() => {
    if (showWelcome || showSetupGuide) removeStartupSkeleton();
  }, [showWelcome, showSetupGuide]);

  const mainContent = showWelcome ? (
    <WelcomeScreen
      onContinue={() => {
        markWelcomeSeen();
        setWelcomeAck(true);
      }}
    />
  ) : (
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
                "--sidebar-width": "220px",
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
          <NewSessionDialog />
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
      {mainContent}
    </div>
  ) : (
    <>{mainContent}</>
  )
}

export default App;
