import * as React from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Archive, ArrowLeft, Bot, Loader2, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cn, isTauri } from "@/lib/utils";

import { RuntimeRefreshSessionHint } from "@/components/chat/RuntimeRefreshSessionHint";
import { useSessionStore } from "@/stores/session";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useOutboxStore } from "@/stores/outbox-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useStreamingStore } from "@/stores/streaming";
import { useWorkspaceStore } from "@/stores/workspace";
import { useProviderStore } from "@/stores/provider";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useTeamModeStore } from "@/stores/team-mode";
import { useCurrentTeamStore } from "@/stores/current-team";
import { TEAMCLAW_DIR, CONFIG_FILE_NAME, TEAM_REPO_DIR } from "@/lib/build-config";
import { adaptTeamclawMessages } from "@/lib/v2-message-adapter";
import { notePendingAgentReplyTo } from "@/lib/pending-agent-reply-to";
import { logInterruptMsgDiag } from "@/lib/interrupt-msg-diag";
import { logExtMsgDiag } from "@/lib/extension-msg-diag";
import { isChromeExtension } from "@/lib/platform";
import { useAuthStore } from "@/stores/auth-store";
import { bumpSessionListLastMessage } from "@/lib/session-list-preview";
import { useSessionListStore } from "@/stores/session-list-store";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import {
  DRAFT_SESSION_PICK_KEY,
  useAgentModelPickStore,
} from "@/stores/agent-model-pick-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import { useUIStore } from "@/stores/ui";
import { getBackend } from "@/lib/backend";
import { expandPageLinkTokensInText } from "@/lib/expand-page-link-tokens";
import { create as createMessage } from "@bufbuild/protobuf";
import {
  MessageSchema,
  MessageKind,
} from "@/lib/proto/teamclaw_pb";
import { resolveSessionActivityOwner } from "@/lib/session-list-activity";
import {
  resolveAgentRuntimeIdsForSend,
  resolveSendTeamId,
  trySyncMentionActorIds,
} from "@/lib/send-path-resolve";
import { selectSessionParentLinks } from "@/lib/session-parent-links";
import { resolveCurrentMemberActorId } from "@/lib/current-actor";
import { isAgentActorType } from "@/lib/actor-type";
import type { PromptInputMessage } from "@/packages/ai/prompt-input";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";
import { Button } from "@/components/ui/button";
import { LocalAgentWelcomeEmptyState } from "./LocalAgentWelcomeEmptyState";
import { SessionEmptyThreadState } from "./SessionEmptyThreadState";
import { createQuickSession, describeQuickSessionFailure, type QuickSessionFailureReason } from "@/lib/create-quick-session";
import { promoteCreatedSessionToUi } from "@/lib/promote-created-session";
import { isSoloAgentSession } from "@/lib/session-empty-thread-starters";

import type { Message } from "@/stores/session";
import { ChatInputArea } from "./ChatInputArea";
import { SessionNoticeList } from "./SessionNoticeList";
import { useEngagedAgentRuntimeMap } from "@/hooks/use-engaged-agent-runtime-map";
import { useEngagedAgentUiStates } from "@/hooks/use-engaged-agent-ui-states";
import { useEnsureEngagedRuntimesOnSessionFocus } from "@/hooks/use-ensure-engaged-runtimes-on-session-focus";
import { useReensureRuntimesOnMqttReconnect } from "@/hooks/use-reensure-runtimes-on-mqtt-reconnect";
import {
  quickChatLocalDaemonAgent,
  quickChatWelcomeAgent,
  useQuickChatReadiness,
} from "@/hooks/use-quick-chat-readiness";
import { buildPostSendSessionNotice } from "@/lib/session-agent-notice-text";
import { useSessionNoticeStore } from "@/stores/session-notice-store";
import { toMentionDeliverySnapshot } from "@/lib/session-agent-ui-state";
import { MessageList, type MessageListHandle } from "./MessageList";
import { SessionErrorAlert } from "./SessionErrorAlert";
import { isPersistentSessionTurnError } from "@/lib/agent-turn-error";
import { hasVisiblePendingPermissions } from "./PermissionCard";
import { collectAcpStreamingPermissions } from "@/lib/teamclaw/acp-permission-entries";
import { useSessionPermissionMode } from "@/lib/session-permission-mode";
import { interruptAgentActor } from "@/lib/teamclaw/interrupt-agent";
import { toast } from "sonner";
import { AcpStreamDebugPanel } from "./AcpStreamDebugPanel";
import type { Todo } from "@/stores/session-types";
import { QuestionInputDock } from "./QuestionInputDock";
import { SessionContinueBanner } from "./SessionContinueBanner";
import {
  isStreamInterruptible,
  useV2StreamingStore,
  selectPersistedPlanForSession,
  type StreamingPlanEntry,
} from "@/stores/v2-streaming-store";
import { uploadAttachment } from "@/lib/attachment-upload";
import {
  collectSessionAttachmentUrlsFromText,
  expandSessionAttachmentTokensInText,
  textHasSessionAttachmentTokens,
} from "@/lib/session-attachment-token";
import { resolveSessionEstablishedModel } from "@/lib/session-established-model";
import { ensureSessionLiveSubscribed } from "@/lib/session-live-subscriptions";
import { resolveSessionMentionActorIds } from "@/lib/resolve-session-mention-ids";
import { stripPickerPersonMentionsFromText } from "@/lib/strip-person-mentions";
import {
  expandMemberMentionTokensInText,
  parseMemberMentionsFromText,
  textHasMemberMentionTokens,
} from "@/lib/member-mention-token";
import { buildEnhancedChip, buildStructuredMentionLines } from "@/lib/outgoing-mention-content";
import {
  resolveAgentCatalogModels,
  localRecentModelFallback,
} from '@/lib/agent-model-fallback'
import {
  getKnownLocalDaemonActorId,
} from "@/lib/local-daemon-identity";
import { useLocalDaemonActorId } from "@/lib/daemon-agent-admin";
import { useLocalDaemonCatalogStore } from "@/stores/local-daemon-catalog-store";
import {
  selectAgentModel,
  resolveRuntimeStateEntryForAgent,
  backendTypeFromRuntimeEntry,
} from "@/lib/runtime-state-resolve";
import {
  sessionFlowError,
  sessionFlowLog,
  summarizeText,
} from "@/lib/session-flow-log";
import { TerminalPanel } from "@/components/terminal/TerminalPanel";
import { useTerminalStore } from "@/stores/terminal-store";


const EMPTY_MESSAGES: Message[] = [];
const EMPTY_AGENTS: AttachedAgent[] = [];

function parseSlashToken(body: string): { type: "role" | "skill" | "command"; name: string } {
  if (body.startsWith("role:")) return { type: "role", name: body.slice("role:".length) };
  if (body.startsWith("skill:")) return { type: "skill", name: body.slice("skill:".length) };
  if (body.startsWith("command:")) return { type: "command", name: body.slice("command:".length) };
  return { type: "skill", name: body };
}

// ─── Main component ────────────────────────────────────────────────────────

interface ChatPanelProps {
  /** Compact mode for side panel in file mode layout */
  compact?: boolean;
}

export function ChatPanel({ compact = false }: ChatPanelProps) {
  const { t } = useTranslation();

  // ── UI store selectors ───────────────────────────────────────────────
  const draftPreselectedActor = useUIStore(s => s.draftPreselectedActor);

  // ── Session store selectors (reactive state only) ────────────────────
  const activeSessionId = useSessionSelectionStore(s => s.activeSessionId);
  const ensureParticipants = useSessionParticipantStore(s => s.ensureParticipants);
  const sessionPermissionMode = useSessionPermissionMode(activeSessionId);

  React.useEffect(() => {
    if (!activeSessionId) return;
    void ensureParticipants([activeSessionId]);
  }, [activeSessionId, ensureParticipants]);

  const error = useSessionStore(s => s.error);
  const errorSessionId = useSessionStore(s => s.errorSessionId);
  const isConnected = useSessionStore(s => s.isConnected);
  const streamingMessageId = useStreamingStore(s => s.streamingMessageId);
  const messageQueue = useSessionStore(s => s.messageQueue);
  const sessionError = useSessionStore(s => s.sessionError);
  const inactivityWarning = useSessionStore(s => s.inactivityWarning);
  const todos = useSessionStore(s => s.todos);
  const pendingPermissions = useSessionStore(s => s.pendingPermissions);
  const pendingQuestions = useSessionStore(s => s.pendingQuestions);
  // Only id/parentID — ignore unrelated session field writes (title, preview, …).
  const sessionParentLinksKey = useSessionStore((s) =>
    s.sessions.map((row) => `${row.id}:${row.parentID ?? ""}`).join("|"),
  );
  const sessionParentLinks = React.useMemo(
    () => selectSessionParentLinks(useSessionStore.getState().sessions),
    // sessionParentLinksKey is the change signal; `sessions` is read through
    // getState() so unrelated row writes don't rebuild this list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionParentLinksKey],
  );
  // Fingerprint embedded tool-call permissions on the active session so we
  // recompute showInlineTodo without subscribing to the full sessions array.
  const activeToolPermissionSig = useSessionStore((s) => {
    if (!activeSessionId) return "";
    const session = s.sessions.find((row) => row.id === activeSessionId);
    if (!session) return "";
    const ids: string[] = [];
    for (const message of session.messages || []) {
      for (const toolCall of message.toolCalls || []) {
        const permission = toolCall.permission;
        if (!permission || permission.decision !== "pending") continue;
        if (toolCall.status !== "calling" && toolCall.status !== "waiting") continue;
        ids.push(permission.id);
      }
    }
    return ids.join(",");
  });

  // ── V2 agent streaming (acp.event deltas) ───────────────────────────
  // Render ALL bubbles for the active session — current turn (active or
  // finalized) plus any archived prior turns. The daemon only persists
  // AGENT_REPLY to Supabase, so thinking + tool_calls + plan only survive
  // in the in-memory streaming entry. Filtering by `active` would make
  // them vanish the moment the turn finished. The bubble itself suppresses
  // the outputText after finalize so the persisted AGENT_REPLY ChatMessage
  // doesn't render the reply twice.
  const v2ActiveSessionRevision = useV2StreamingStore((s) =>
    activeSessionId ? (s.revisionBySession[activeSessionId] ?? 0) : 0,
  );
  const persistedSessionPlan = useV2StreamingStore((s) =>
    selectPersistedPlanForSession(s, activeSessionId),
  );
  const v2Streams = React.useMemo(() => {
    const s = useV2StreamingStore.getState();
    const current = Object.values(s.byKey).filter(
      (e) => e.sessionId === activeSessionId,
    );
    const archived = s.archived.filter((e) => e.sessionId === activeSessionId);
    return [...archived, ...current].sort((a, b) => a.lastUpdate - b.lastUpdate);
    // v2ActiveSessionRevision is the change signal; byKey/archived are read via
    // getState() to avoid re-subscribing to the whole store (perf). Do not add
    // byKey/archived to deps — it reintroduces per-delta re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2ActiveSessionRevision, activeSessionId]);

  // Plan entries from the active agent's stream surface in the TodoList dock
  // above the prompt input (v1 style) rather than inline in the message
  // bubble. Render only the most-recently-updated stream's plan to avoid
  // stacking plans from multiple engaged agents — typical sessions have
  // one planner at a time. Mapped to the Todo shape the TodoList consumes.
  const planTodos = React.useMemo((): Todo[] => {
    const mapPlan = (
      entries: StreamingPlanEntry[],
      actorId: string,
    ): Todo[] =>
      entries.map((e, i) => ({
        id: `plan:${actorId}:${i}`,
        status: e.status,
        content: e.content,
        priority: e.priority,
      }));

    const latestWithPlan = [...v2Streams]
      .reverse()
      .find((entry) => entry.planEntries.length > 0);
    if (latestWithPlan) {
      return mapPlan(latestWithPlan.planEntries, latestWithPlan.actorId);
    }
    if (persistedSessionPlan?.planEntries.length) {
      return mapPlan(
        persistedSessionPlan.planEntries,
        persistedSessionPlan.actorId,
      );
    }
    return [];
  }, [v2Streams, persistedSessionPlan]);

  // ── Archived session viewing ────────────────────────────────────────
  const viewingArchivedSessionId = useSessionStore(s => s.viewingArchivedSessionId);
  const archivedSessionMessages = useSessionStore(s =>
    s.viewingArchivedSessionId
      ? (s.archivedSessionMessages[s.viewingArchivedSessionId] || EMPTY_MESSAGES)
      : EMPTY_MESSAGES
  );
  const archivedSession = useSessionStore(s =>
    s.viewingArchivedSessionId
      ? s.archivedSessions.find((session) => session.id === s.viewingArchivedSessionId)
      : undefined
  );
  const archivedSessionError = useSessionStore(s => s.archivedSessionError);
  const isViewingArchived = !!viewingArchivedSessionId;

  // ── Child session viewing ──────────────────────────────────────────
  const viewingChildSessionId = useSessionStore(s => s.viewingChildSessionId);
  const childSessionMessages = useSessionStore(s =>
    s.viewingChildSessionId && !s.viewingArchivedSessionId
      ? (s.childSessionMessages[s.viewingChildSessionId] || EMPTY_MESSAGES)
      : EMPTY_MESSAGES
  );
  const isLoadingChildMessages = useSessionStore(s => s.isLoadingChildMessages);
  const childStreamingContent = useStreamingStore(s =>
    viewingChildSessionId && !isViewingArchived
      ? s.childSessionStreaming[viewingChildSessionId]
      : undefined
  );
  const isViewingChild = !!viewingChildSessionId && !isViewingArchived;
  const acpPendingForTodo = React.useMemo(
    () =>
      collectAcpStreamingPermissions(
        activeSessionId,
        useV2StreamingStore.getState().byKey,
      ),
    // v2ActiveSessionRevision is the change signal; byKey is read via getState()
    // to avoid re-subscribing to the whole store (perf). Do not add byKey to
    // deps — it reintroduces per-delta re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, v2ActiveSessionRevision],
  );
  const showInlineTodo = React.useMemo(() => {
    if (isViewingArchived) return false;
    if (isViewingChild) return false;
    if (todos.length === 0 && messageQueue.length === 0 && planTodos.length === 0)
      return false;
    return !hasVisiblePendingPermissions(
      activeSessionId,
      useSessionStore.getState().sessions,
      pendingPermissions,
      acpPendingForTodo,
      sessionPermissionMode,
    );
    // activeToolPermissionSig / sessionParentLinks are change signals for the
    // getState() read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSessionId,
    acpPendingForTodo,
    activeToolPermissionSig,
    isViewingArchived,
    isViewingChild,
    messageQueue.length,
    pendingPermissions,
    sessionPermissionMode,
    sessionParentLinks,
    todos,
    planTodos.length,
  ]);

  // Render order: planTodos first (live, being worked on) then static todos.
  // Dedup pass not needed — plan ids are namespaced `plan:` while todos use
  // their own id space.
  const combinedTodos = React.useMemo(
    () => (planTodos.length > 0 ? [...planTodos, ...todos] : todos),
    [planTodos, todos],
  );
  const hasComposerPlanData =
    !isViewingArchived &&
    !isViewingChild &&
    (combinedTodos.length > 0 || messageQueue.length > 0);
  const displayedChildSessionMessages = React.useMemo(() => {
    if (!isViewingChild || !viewingChildSessionId) return EMPTY_MESSAGES;

    const hasLiveChildStreaming =
      !!childStreamingContent &&
      (childStreamingContent.isStreaming ||
        !!childStreamingContent.text ||
        !!childStreamingContent.reasoning);

    if (!hasLiveChildStreaming) {
      return childSessionMessages;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasStreamingPlaceholder = childSessionMessages.some((message: any) => message.isStreaming);
    if (hasStreamingPlaceholder) {
      return childSessionMessages;
    }

    const lastTimestamp = childSessionMessages[childSessionMessages.length - 1]?.timestamp;
    const placeholderTimestamp =
      lastTimestamp instanceof Date
        ? new Date(lastTimestamp.getTime() + 1)
        : new Date();

    return [
      ...childSessionMessages,
      {
        id: `child-streaming-${viewingChildSessionId}`,
        sessionId: viewingChildSessionId,
        role: "assistant" as const,
        content: childStreamingContent?.text || "",
        parts: [],
        toolCalls: [],
        isStreaming: true,
        timestamp: placeholderTimestamp,
      },
    ];
  }, [childSessionMessages, childStreamingContent, isViewingChild, viewingChildSessionId]);
  const activeInputQuestion = React.useMemo(() => {
    if (!activeSessionId) return null;
    if (isViewingArchived) return null;
    if (isViewingChild) return null;
    return (
      pendingQuestions.find((question) => {
        if (!question.sessionId) return true;
        return (
          resolveSessionActivityOwner(
            question.sessionId,
            sessionParentLinks,
            question.sessionId,
          ) === activeSessionId
        );
      }) ||
      null
    );
  }, [
    activeSessionId,
    isViewingArchived,
    isViewingChild,
    pendingQuestions,
    sessionParentLinks,
  ]);

  // Actions — accessed via getState() to avoid creating subscriptions.
  // Zustand actions are stable references; subscribing to them wastes equality checks.
  const acts = useSessionStore.getState();
  const removeFromQueue = acts.removeFromQueue;

  const handleInterruptAgent = React.useCallback(
    (agentActorId: string) => {
      if (!activeSessionId) return;
      void (async () => {
        try {
          await interruptAgentActor({
            sessionId: activeSessionId,
            agentActorId,
          });
        } catch (error) {
          toast.error(
            t("chat.interruptFailed", "无法打断 agent 回复"),
            {
              description:
                error instanceof Error ? error.message : String(error),
            },
          );
        }
      })();
    },
    [activeSessionId, t],
  );

  const loadSessions = acts.loadSessions;
  const resetSessions = acts.resetSessions;
  const clearSessionError = acts.clearSessionError;
  const setError = acts.setError;
  const setStoreSelectedModel = acts.setSelectedModel;
  const closeArchivedSession = acts.closeArchivedSession;
  const restoreSession = acts.restoreSession;
  const setViewingChildSession = acts.setViewingChildSession;

  // ── Workspace store ───────────────────────────────────────────────────
  const workspacePath = useWorkspaceStore(s => s.workspacePath);
  // Keep local semaphores that simply mirror "workspace is set"; the legacy
  // separate bootstrapped vs ready flags collapsed into one signal.
  const workspaceBootstrapped = !!workspacePath;
  const workspaceReady = !!workspacePath;
  const currentWorkspaceId = workspacePath ?? "";
  const terminalOpen = useTerminalStore(
    s => Boolean(currentWorkspaceId && s.panelOpenByWorkspace[currentWorkspaceId]),
  );
  const terminalPanelHeight = useTerminalStore(
    s => currentWorkspaceId ? s.panelHeightByWorkspace[currentWorkspaceId] ?? 240 : 240,
  );
  const terminalBottomOffset = terminalOpen && workspacePath ? terminalPanelHeight : 0;

  // ── Local state ───────────────────────────────────────────────────────
  // draftInput lives in ChatInputArea (store subscription) so typing does not
  // re-render this panel / MessageList.
  const [pendingFiles, setPendingFiles] = React.useState<File[]>([]);
  // engagedAgents is per-session: each @-mentioned agent shows as a pill in
  // the prompt-input toolbar. Switching away from a session and back
  // restores its engaged set rather than carrying one across sessions.
  // Draft-first chats (no session yet) surface the preselected agent as a
  // synthetic pill so the composer matches what first-send will create.
  const sessionEngagedAgents = useEngagedAgentStore((s) =>
    activeSessionId ? s.bySession[activeSessionId] ?? EMPTY_AGENTS : EMPTY_AGENTS,
  );
  const engagedAgents = React.useMemo(() => {
    if (sessionEngagedAgents.length > 0) return sessionEngagedAgents;
    if (
      !activeSessionId &&
      draftPreselectedActor?.kind === 'agent'
    ) {
      return [
        {
          id: draftPreselectedActor.id,
          displayName: draftPreselectedActor.displayName,
        },
      ];
    }
    return EMPTY_AGENTS;
  }, [activeSessionId, draftPreselectedActor, sessionEngagedAgents]);
  const engagedAgentIds = React.useMemo(
    () => engagedAgents.map((a) => a.id),
    [engagedAgents],
  );
  const activeStreamingAgentIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const entry of v2Streams) {
      if (isStreamInterruptible(entry)) ids.add(entry.actorId);
    }
    return ids;
  }, [v2Streams]);
  const { agentToRuntimeId, agentToBackendType } = useEngagedAgentRuntimeMap(
    activeSessionId,
    engagedAgentIds,
  );
  const engagedUiEntries = useEngagedAgentUiStates(
    engagedAgents,
    agentToRuntimeId,
    activeStreamingAgentIds,
  );

  const sessionParticipants = useSessionParticipantStore((s) =>
    activeSessionId ? s.participantsBySession[activeSessionId] : undefined,
  );
  const participantsLoading = useSessionParticipantStore((s) =>
    activeSessionId ? s.loadingBySession[activeSessionId] ?? false : false,
  );
  const isSoloAgentSessionActive = React.useMemo(
    () =>
      sessionParticipants && !participantsLoading
        ? isSoloAgentSession(sessionParticipants.map((p) => ({ isAgent: p.isAgent })))
        : false,
    [sessionParticipants, participantsLoading],
  );

  // Re-fetch after roster invalidation (e.g. second agent invited → solo unlocks).
  React.useEffect(() => {
    if (!activeSessionId) return;
    if (sessionParticipants !== undefined || participantsLoading) return;
    void ensureParticipants([activeSessionId]);
  }, [activeSessionId, sessionParticipants, participantsLoading, ensureParticipants]);

  const prevActiveSessionRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const prev = prevActiveSessionRef.current;
    if (prev && prev !== activeSessionId) {
      useSessionNoticeStore.getState().clearSession(prev);
    }
    prevActiveSessionRef.current = activeSessionId;
  }, [activeSessionId]);
  const addAgentForSession = React.useCallback(
    (agent: AttachedAgent) => {
      const sid = useSessionSelectionStore.getState().activeSessionId;
      if (!sid) return;
      useEngagedAgentStore.getState().addAgent(sid, agent);
    },
    [],
  );
  const removeAgentForSession = React.useCallback(
    (agentId: string) => {
      if (isSoloAgentSessionActive) return;
      const sid = useSessionSelectionStore.getState().activeSessionId;
      if (!sid) return;
      useEngagedAgentStore.getState().removeAgent(sid, agentId);
    },
    [isSoloAgentSessionActive],
  );
  const handleSwitchToLocalAgent = React.useCallback(
    (local: AttachedAgent) => {
      if (!activeSessionId) return;
      for (const entry of engagedUiEntries) {
        if (
          entry.uiState === "offline" ||
          entry.uiState === "stale" ||
          entry.uiState === "connecting"
        ) {
          // Same cleanup the pill's own X does (AgentSelectorDock onRemove):
          // a dropped agent's model pick must not outlive it, or the local
          // agent inherits the dead remote's model.
          useAgentModelPickStore.getState().clearPick(activeSessionId, entry.agent.id);
          removeAgentForSession(entry.agent.id);
        }
      }
      addAgentForSession(local);
      // Engaging via the mention pill starts a runtime; switching must too.
      // The local agent's real model only reaches the UI on its RuntimeInfo
      // retain, so without this the pill has nothing to show and falls through
      // to a positional default.
      const teamId =
        useSessionListStore.getState().rows.find((r) => r.id === activeSessionId)?.team_id ??
        useCurrentTeamStore.getState().team?.id ??
        null;
      if (!teamId) return;
      void import("@/lib/teamclaw/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
        void ensureAgentRuntimesForSession({
          sessionId: activeSessionId,
          teamId,
          agentActorIds: [local.id],
          reason: "switch_to_local_agent",
        });
      });
    },
    [activeSessionId, engagedUiEntries, removeAgentForSession, addAgentForSession],
  );

  // Solo sessions (1 human + 1 agent): always show the agent pill so sends
  // route WYSIWYG. Re-engage whenever the pill is missing. When a second
  // agent (or member) joins, roster updates → no longer solo → pill unlocks.
  React.useEffect(() => {
    if (!activeSessionId) return;
    if (engagedAgents.length > 0) return;

    const ensureRuntime = (agentActorId: string) => {
      const teamId =
        useSessionListStore.getState().rows.find((r) => r.id === activeSessionId)?.team_id ??
        useCurrentTeamStore.getState().team?.id ??
        null;
      if (!teamId) return;
      // Start on the model this session has already been running, not on
      // whatever the device MRU offers. Opening a cron session used to spawn a
      // second runtime on the daemon's default model, and since the pill
      // reports the live runtime, a job pinned to Haiku read as "Big Pickle" —
      // and the next message really would have run on it.
      const established =
        resolveSessionEstablishedModel(
          useSessionMessageStore.getState().messages[activeSessionId],
          agentActorId,
        )?.trim() || undefined;
      void import("@/lib/teamclaw/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
        void ensureAgentRuntimesForSession({
          sessionId: activeSessionId,
          teamId,
          agentActorIds: [agentActorId],
          modelId: established,
          reason: "session_auto_engage",
        });
      });
    };

    const engageFromRoster = (
      roster: Array<{ isAgent: boolean; actorId: string; displayName: string }>,
    ) => {
      if (!isSoloAgentSession(roster)) return false;
      const sole = roster.find((p) => p.isAgent);
      if (!sole) return false;
      useEngagedAgentStore.getState().setAgents(activeSessionId, [{
        id: sole.actorId,
        displayName: sole.displayName || "AI",
      }]);
      ensureRuntime(sole.actorId);
      return true;
    };

    // Same rule as resolve-session-mention-ids: an empty roster means the cache
    // has not answered yet, so fall through to the cloud read below instead of
    // concluding this session has no agent to engage.
    if (sessionParticipants !== undefined && sessionParticipants.length > 0) {
      engageFromRoster(sessionParticipants);
      return;
    }

    let cancelled = false;
    void (async () => {
      let actors: Awaited<ReturnType<ReturnType<typeof getBackend>['sessionMembers']['listParticipants']>>;
      try {
        actors = await getBackend().sessionMembers.listParticipants(activeSessionId);
      } catch {
        return;
      }
      if (cancelled) return;
      engageFromRoster(
        actors.map((row) => ({
          isAgent: isAgentActorType(row.actor_type),
          actorId: row.id,
          displayName: row.display_name?.trim() || "AI",
        })),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, engagedAgents.length, sessionParticipants]);

  const sessionRow = useSessionListStore(s => s.rows.find(r => r.id === activeSessionId));
  // Team is workspace-scoped: every session in `rows` shares the same team_id.
  // When activeSessionId is null (brand-new chat), fall back to any row's
  // team_id so SessionActorSheet still has a team context for the add flow.
  const currentTeamId = useCurrentTeamStore(s => s.team?.id ?? null);
  const fallbackTeamId = useSessionListStore(s => s.rows[0]?.team_id ?? null);
  const sheetTeamId = sessionRow?.team_id ?? fallbackTeamId ?? currentTeamId;
  useEnsureEngagedRuntimesOnSessionFocus({
    sessionId: activeSessionId,
    teamId: sheetTeamId,
    engagedUiEntries,
    agentToRuntimeId,
  });
  useReensureRuntimesOnMqttReconnect({
    sessionId: activeSessionId,
    teamId: sheetTeamId,
    engagedUiEntries,
    agentToRuntimeId,
  });

  const handleRetryOfflineAgents = React.useCallback(() => {
    if (!activeSessionId || !sheetTeamId) return;
    const offlineIds = engagedUiEntries
      .filter((e) => e.uiState === "offline")
      .map((e) => e.agent.id);
    if (offlineIds.length === 0) return;
    void import("@/lib/teamclaw/runtime-ensure-scheduler").then(({ resetRuntimeEnsureThrottle }) => {
      resetRuntimeEnsureThrottle();
      void import("@/lib/teamclaw/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
        void ensureAgentRuntimesForSession({
          sessionId: activeSessionId,
          teamId: sheetTeamId,
          agentActorIds: offlineIds,
          reason: "offline_banner_retry",
        });
      });
    });
  }, [activeSessionId, sheetTeamId, engagedUiEntries]);

  const showQuickSessionFailure = React.useCallback(
    (reason: QuickSessionFailureReason) => {
      const { title, description } = describeQuickSessionFailure(reason, t);
      toast.error(title, {
        description,
        ...(reason === "no_agent"
          ? {
              action: {
                label: t("chat.quickSessionSetDefaultAgent", "去设置默认 Agent"),
                onClick: () => useUIStore.getState().openSettings("daemonGeneral"),
              },
            }
          : {}),
      });
    },
    [t],
  );

  const quickChatState = useQuickChatReadiness();
  const { agent: welcomeQuickChatAgent, loading: welcomeQuickChatLoading } = React.useMemo(
    () => quickChatWelcomeAgent(quickChatState),
    [quickChatState],
  );
  const localDaemonAgent = React.useMemo(
    () => quickChatLocalDaemonAgent(quickChatState),
    [quickChatState],
  );
  const [welcomeSessionStarting, setWelcomeSessionStarting] = React.useState(false);

  const [isRestoringArchived, setIsRestoringArchived] = React.useState(false);
  const isRestoringArchivedRef = React.useRef(false);

  // ── Provider store ────────────────────────────────────────────────────
  const initProviderStore = useProviderStore(s => s.initAll);
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId);
  const runtimeModelSignature = useRuntimeStateStore((s) =>
    Object.entries(s.byRuntimeId)
      .map(([runtimeId, entry]) => {
        const models = entry.info.availableModels
          .map((model) => `${model.id}:${model.displayName}`)
          .join("|");
        return `${runtimeId}:${entry.info.agentType}:${entry.info.currentModel}:${models}`;
      })
      .sort()
      .join(";"),
  );

  // ── Active session model ──────────────────────────────────────────────
  // "Which model is this session on" has exactly one answer, produced by
  // `selectAgentModel` — the same resolver the AgentSelectorDock pill uses.
  // It is deliberately NOT mirrored into the provider store: a per-session
  // answer living in a workspace-global key is what made the pill and the send
  // path disagree on a freshly created session.
  const localDaemonActorId = useLocalDaemonActorId();
  const localDaemonCatalog = useLocalDaemonCatalogStore((s) => {
    const path = workspacePath?.trim();
    return path ? s.byWorkspacePath[path] : undefined;
  });
  const modelAgentId = engagedAgentIds[0] ?? "";
  // Draft chats have no session id yet; picks live in the draft scope until
  // `promoteDraftPicks` moves them across at create time.
  const modelPickScopeId = activeSessionId || DRAFT_SESSION_PICK_KEY;
  const activeEstablishedModel = useSessionMessageStore((s) =>
    activeSessionId && modelAgentId
      ? resolveSessionEstablishedModel(s.messages[activeSessionId], modelAgentId)
      : null,
  );
  // Subscribe so an explicit user pick re-renders — selectAgentModel reads the
  // same store through getState() and would otherwise miss the update.
  const activePickEntry = useAgentModelPickStore((s) =>
    modelAgentId ? s.bySessionAgent[`${modelPickScopeId}::${modelAgentId}`] : undefined,
  );
  const remoteDefaultCatalogModels = useRuntimeStateStore((s) =>
    modelAgentId ? s.defaultCatalogByActorId?.[modelAgentId]?.models : undefined,
  );
  const activeSessionModelId = React.useMemo(() => {
    if (!modelAgentId) return "";
    const available = resolveAgentCatalogModels({
      agentId: modelAgentId,
      localDaemonActorId,
      sessionId: activeSessionId,
      byRuntimeId: runtimeStates,
      runtimeInfo: resolveRuntimeStateEntryForAgent(modelAgentId, runtimeStates)?.info,
      localWorkspaceCatalogModels: localDaemonCatalog?.models,
      remoteDefaultCatalogModels,
    });
    return (
      selectAgentModel({
        sessionId: modelPickScopeId,
        agentId: modelAgentId,
        available,
        byRuntimeId: runtimeStates,
        providerFallback:
          localRecentModelFallback({
            agentId: modelAgentId,
            localDaemonActorId,
            recentModels: localDaemonCatalog?.recentModels,
            available,
          }) || undefined,
        sessionEstablishedModel: activeEstablishedModel,
      }).modelId || ""
    );
  }, [
    modelAgentId,
    modelPickScopeId,
    runtimeStates,
    localDaemonActorId,
    localDaemonCatalog,
    activeEstablishedModel,
    activePickEntry,
    remoteDefaultCatalogModels,
  ]);

  // ── Refs ───────────────────────────────────────────────────────────────
  const messageListRef = React.useRef<MessageListHandle>(null);

  // ── Derived values ────────────────────────────────────────────────────
  // v2: messages live in useSessionMessageStore.messages keyed by sessionId.
  // Adapt each Teamclaw_Message → SDK Message shape so legacy MessageList
  // renders unchanged. Phase 2 will replace MessageList with native render.
  const activeMessagesRaw = useSessionMessageStore(s =>
    activeSessionId ? s.messages?.[activeSessionId] : undefined
  );
  const activeMessages = React.useMemo(
    () => adaptTeamclawMessages(activeMessagesRaw),
    [activeMessagesRaw],
  );
  /** Shown messages lag store during fade so old session can fade out before swap */
  const [displaySessionId, setDisplaySessionId] = React.useState<string | null>(activeSessionId);
  const [sessionFadeOpacity, setSessionFadeOpacity] = React.useState(1);

  const displayMessagesRaw = useSessionMessageStore((s) =>
    displaySessionId ? s.messages?.[displaySessionId] : undefined,
  );
  const displayMessages = React.useMemo(
    () => adaptTeamclawMessages(displayMessagesRaw),
    [displayMessagesRaw],
  );

  const activeStreamingAgents = React.useMemo(() => {
    const seen = new Set<string>();
    const agents: Array<{
      actorId: string;
      displayName?: string;
      entry: (typeof v2Streams)[number];
    }> = [];
    for (const entry of v2Streams) {
      if (!isStreamInterruptible(entry) || seen.has(entry.actorId)) continue;
      seen.add(entry.actorId);
      const engaged = engagedAgents.find((agent) => agent.id === entry.actorId);
      agents.push({
        actorId: entry.actorId,
        displayName: engaged?.displayName,
        entry,
      });
    }
    return agents;
  }, [v2Streams, engagedAgents]);

  const SESSION_FADE_MS = 150;

  React.useEffect(() => {
    if (activeSessionId === null) {
      setDisplaySessionId(null);
      setSessionFadeOpacity(1);
      // engagedAgent is per-session now; no need to clear here — the
      // selector returns null for null sessionId automatically.
    }
  }, [activeSessionId]);

  React.useEffect(() => {
    if (activeSessionId === null) return;
    if (displaySessionId === activeSessionId) return;
    if (displaySessionId === null) {
      setDisplaySessionId(activeSessionId);
      setSessionFadeOpacity(1);
      return;
    }
    setSessionFadeOpacity(0);
    const t = window.setTimeout(() => {
      setDisplaySessionId(activeSessionId);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSessionFadeOpacity(1));
      });
    }, SESSION_FADE_MS);
    return () => clearTimeout(t);
  }, [activeSessionId, displaySessionId]);

  const isStreaming = !!streamingMessageId || activeStreamingAgents.length > 0;

  // ── Provider & Team mode init ──────────────────────────────────────
  // Merged to avoid race condition: team mode restarts the agent, which
  // would break a concurrent initProviderStore call.
  React.useEffect(() => {
    if (!workspaceReady) return;

    if (!workspacePath) {
      // No workspace yet, just init providers directly
      initProviderStore();
      return;
    }

    const { loadTeamConfig, applyTeamModel } = useTeamModeStore.getState();
    loadTeamConfig(workspacePath).then(async () => {
      // applyTeamModel is idempotent and self-noops when no team config is loaded.
      await applyTeamModel(workspacePath);
      initProviderStore();
    });
  }, [workspaceReady, workspacePath, initProviderStore]);

  React.useEffect(() => {
    if (!workspaceReady || !runtimeModelSignature) return;
    void initProviderStore();
  }, [workspaceReady, runtimeModelSignature, initProviderStore]);

  // NOTE: there used to be an effect here that resolved the session's model
  // from its `agent_runtimes` rows and wrote the answer back into the provider
  // store's global `currentModelKey`. It is gone on purpose. Writing a
  // per-session answer into a workspace-global key made the two disagree the
  // moment the effect could not run — a draft session has no `activeSessionId`,
  // so the key stayed on whatever the last workspace had persisted while the
  // pill resolved the session's real model independently. `selectAgentModel` is
  // the single resolver now; nothing mirrors its answer anywhere.

  // ── Team config hot reload via file watcher ─────────────────────────
  React.useEffect(() => {
    if (!workspaceBootstrapped || !workspacePath) return;
    const isTauriEnv = isTauri();
    if (!isTauriEnv) return;

    let unlisten: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ path: string; kind: string }>('file-change', (event) => {
        const isTeamConfigChange = event.payload.path.includes(`${TEAMCLAW_DIR}/${CONFIG_FILE_NAME}`);
        const isProviderMetaChange = event.payload.path.includes(`${TEAM_REPO_DIR}/_meta/provider.json`);
        if (!isTeamConfigChange && !isProviderMetaChange) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          console.log('[TeamMode] Team config changed, reloading team config');
          const store = useTeamModeStore.getState();
          const hadTeamConfig = store.teamModelConfig != null;
          await store.loadTeamConfig(workspacePath);
          const hasTeamConfig = useTeamModeStore.getState().teamModelConfig != null;

          if (hasTeamConfig) {
            await store.applyTeamModel(workspacePath);
          } else if (hadTeamConfig) {
            // Team config was cleared — refresh provider store so UI drops the team provider
            await useProviderStore.getState().initAll();
          }
        }, 1000);
      });
    })();

    return () => {
      if (unlisten) unlisten();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [workspaceReady, workspacePath]);

  // Sync the resolved session model to the session store. Its only reader is
  // the FileEditor "ask the agent" entry point (session-messages `sendMessage`).
  React.useEffect(() => {
    if (!activeSessionModelId) return;
    const idx = activeSessionModelId.indexOf("/");
    const providerID = idx > 0 ? activeSessionModelId.slice(0, idx) : "";
    const modelID = idx > 0 ? activeSessionModelId.slice(idx + 1) : activeSessionModelId;
    setStoreSelectedModel({ providerID, modelID, name: modelID });
  }, [activeSessionModelId, setStoreSelectedModel]);

  React.useEffect(() => {
    if (!isTauri() || !activeSessionId) return;

    invoke<boolean>("sync_gateway_session_model", {
      sessionId: activeSessionId,
      model: activeSessionModelId || null,
    }).catch((error) => {
      console.warn("[ChatPanel] Failed to sync gateway session model:", error);
    });
  }, [activeSessionId, activeSessionModelId]);

  // Per-actor draft + voice insert live in ChatInputArea.

  // ── Auto-dismiss error banners after 5 seconds ─────────────────────────
  React.useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error, setError]);

  React.useEffect(() => {
    if (!sessionError) return;
    // Persistent turn errors stay until dismiss or next send.
    if (isPersistentSessionTurnError(sessionError.error?.name)) return;
    const timer = setTimeout(() => clearSessionError(), 15000);
    return () => clearTimeout(timer);
  }, [sessionError, clearSessionError]);

  // SSE connection is managed by SSEProvider in App.tsx (persists across mode switches)

  // Poll for pending permissions as fallback
  const pollPermissions = useSessionStore((s) => s.pollPermissions);
  const hasRunningTools = React.useMemo(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (activeMessages ?? []).some((m: any) => m.toolCalls?.some((tc: any) => tc.status === "calling" || tc.status === "waiting")),
    [activeMessages],
  );
  React.useEffect(() => {
    if (!activeSessionId) return;
    if (!isStreaming && !hasRunningTools) return;
    const interval = setInterval(pollPermissions, 2000);
    return () => clearInterval(interval);
  }, [isStreaming, hasRunningTools, activeSessionId, pollPermissions]);


  // ── Session loading ───────────────────────────────────────────────────
  const prevWorkspaceRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!workspaceBootstrapped || !workspacePath) return;

    const isWorkspaceChange =
      prevWorkspaceRef.current !== null &&
      prevWorkspaceRef.current !== workspacePath;
    prevWorkspaceRef.current = workspacePath;

    let cancelled = false;
    void (async () => {
      if (isWorkspaceChange) {
        // Session list is team-scoped. Crossing workspaces must not always wipe
        // the active session: clicking a session in another workspace sets
        // selection first, then switches workspace in the background. Clearing
        // here would flash the welcome empty state until a second click.
        //
        // Preserve when the active session belongs to the *new* workspace
        // (session-driven switch). Clear when it does not (explicit workspace
        // switch from the local-agent card / settings).
        const activeId = useSessionSelectionStore.getState().activeSessionId;
        const teamId = useCurrentTeamStore.getState().team?.id;
        let preserve = false;
        if (activeId && teamId) {
          const { sessionBelongsToWorkspace } = await import("@/lib/session-by-workspace");
          preserve = await sessionBelongsToWorkspace(teamId, activeId, workspacePath);
        }
        if (cancelled) return;
        if (useWorkspaceStore.getState().workspacePath !== workspacePath) return;
        if (!preserve) {
          resetSessions();
        }
      }

      try {
        await loadSessions(workspacePath);
        if (!cancelled) setError(null);
      } catch (err: unknown) {
        if (!cancelled) {
          console.error("[ChatPanel] Failed to load sessions:", err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceBootstrapped, workspacePath, loadSessions, resetSessions, setError]);

  // NOTE: No polling fallback needed.
  // SSE /event endpoint streams ALL events (Bus.subscribeAll) including
  // session.created and session.updated, which are handled as global events
  // in the SSE client. The SSE connection is established as soon as baseUrl
  // is available, regardless of whether a session is active.

  // ── Input height change → forward to MessageList ───────────────────────
  const handleInputHeightChange = React.useCallback((height: number) => {
    messageListRef.current?.handleInputHeightChange(height);
  }, []);

  const handleComposerFocus = React.useCallback(() => {
    messageListRef.current?.pauseAutoFollowIfReading();
  }, []);

  // ── File handling ─────────────────────────────────────────────────────

  const appendPendingFiles = (files: File[]) => {
    setPendingFiles((prev) => [...prev, ...files]);
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // ── Submit handler ────────────────────────────────────────────────────

  /**
   * Core send logic — takes an EXPLICIT sid so it can be called both from
   * the normal handleSubmit path (activeSessionId) and from the picker-confirm
   * path (freshly-created sessionId).  Must NOT close over activeSessionId.
   */
  const sendIntoSession = async (
    sid: string,
    message: PromptInputMessage,
    extraMentionAgents: AttachedAgent[] = [],
  ) => {
    // v2: workspace-ready gate removed — the legacy sidecar flag is gone.
    // Single-window scope sends via MQTT + Supabase regardless.
    const text = message.text?.trim() || "";
    const humanMentions = parseMemberMentionsFromText(text);
    const mentions = humanMentions.length > 0 ? humanMentions : (message.mentions || []);
    sessionFlowLog("send.begin", {
      sessionId: sid,
      hasText: text.length > 0,
      mentionCount: mentions.length,
      engagedAgentCount: engagedAgents.length,
      extraMentionAgentCount: extraMentionAgents.length,
      attachedFileCount: pendingFiles.length,
      sessionAttachmentTokenCount: collectSessionAttachmentUrlsFromText(text).length,
      ...summarizeText(text),
    });

    if (
      !text &&
      pendingFiles.length === 0 &&
      !textHasSessionAttachmentTokens(text) &&
      mentions.length === 0 &&
      !textHasMemberMentionTokens(text) &&
      engagedAgents.length === 0
    ) {
      return;
    }

    if (
      !text.trim() &&
      pendingFiles.length === 0 &&
      !textHasSessionAttachmentTokens(text) &&
      engagedAgents.length > 0
    ) {
      sessionFlowLog("send.rejected_empty_with_engaged_agent", {
        sessionId: sid,
        engagedAgentIds: engagedAgents.map((a) => a.id),
      }, "warn");
      return;
    }

    // Snapshot file state immediately so the UI clears at once, before any
    // async work. This prevents stale images from leaking into later sends
    // if the user types and submits again while the upload is in flight.
    const currentPendingFiles = pendingFiles;
    const draftSnapshot = useSessionStore.getState().draftInput;
    setPendingFiles([]);
    useSessionStore.getState().setDraftInput("");

    const restoreComposer = () => {
      setPendingFiles(currentPendingFiles);
      useSessionStore.getState().setDraftInput(draftSnapshot);
    };

    // WYSIWYG: pill in footer, typed @, or explicit extra on first send.
    const engagedFromStore = useEngagedAgentStore.getState().get(sid);
    const agentForSend =
      extraMentionAgents[0] ?? engagedAgents[0] ?? engagedFromStore ?? null;
    const memberIds = mentions.map((m) => m.id);
    const agentIds = agentForSend ? [agentForSend.id] : [];
    const displayMentionActorIds = Array.from(new Set(agentIds.filter(Boolean)));
    const _isPlanMode = !!(message as PromptInputMessage & { _planMode?: boolean })._planMode;

    // ── Resolve team / mentions / sender with local-agent latency in mind ──
    // Prefer sync store reads; parallelize any remaining awaits; skip a second
    // listParticipants when the composer pill already names the agent.
    const authSession = useAuthStore.getState().session;
    const teamIdFromSessionList =
      useSessionListStore.getState().rows.find(r => r.id === sid)?.team_id ?? null;
    let teamIdForSend: string | null = teamIdFromSessionList;

    const teamIdPromise = resolveSendTeamId({
      sessionId: sid,
      teamIdFromSessionList,
      fetchSessionTeamId: (sessionId) => {
        sessionFlowLog("send.resolve_team_from_backend.begin", { sessionId });
        return getBackend().sessions.getSessionTeamId(sessionId);
      },
      currentTeamId: () => useCurrentTeamStore.getState().team?.id ?? null,
    });

    const syncMentions = trySyncMentionActorIds(memberIds, agentIds, text);
    const mentionsPromise: Promise<string[]> = syncMentions
      ? Promise.resolve(syncMentions)
      : resolveSessionMentionActorIds(sid, memberIds, agentIds, text);

    // Build outgoing text while network resolves — only needs agentForSend (sync).
    let processedText = expandMemberMentionTokensInText(text, {
      humanMentionInstruction: (name) =>
        t("chat.outgoing.humanMentionInstruction", { name }),
    });
    processedText = stripPickerPersonMentionsFromText(processedText, mentions);
    processedText = expandPageLinkTokensInText(processedText);
    processedText = expandSessionAttachmentTokensInText(processedText);
    processedText = processedText.replace(/@\{([^}]+)\}/g, '[File: $1]');
    // Skill/role invocation wording depends on which backend runs the agent
    // (opencode plugin tools vs Claude Code's native Skill tool).
    const backendTypeForSend = backendTypeFromRuntimeEntry(
      resolveRuntimeStateEntryForAgent(
        agentForSend?.id ?? "",
        useRuntimeStateStore.getState().byRuntimeId,
      ),
    );
    processedText = processedText.replace(/\/\{([^}]+)\}/g, (_full, body) => {
      const token = parseSlashToken(body);
      if (token.type === "role") return buildEnhancedChip("role", token.name, backendTypeForSend);
      if (token.type === "command") return `[Command: ${token.name}]`;
      return buildEnhancedChip("skill", token.name, backendTypeForSend);
    });
    processedText = processedText.replace(/\/<([a-z0-9]+(?:-[a-z0-9]+)*)>/g, (_full, roleName) =>
      buildEnhancedChip("role", roleName, backendTypeForSend),
    );
    processedText = processedText.replace(/\/\[([^\]]+)\]/g, '[Command: $1]');

    const parts: string[] = [];
    const structuredMentions = buildStructuredMentionLines(agentForSend);
    if (structuredMentions.length > 0) {
      parts.push(...structuredMentions);
    }
    const bodyText = processedText.trim();
    if (bodyText) {
      parts.push(bodyText);
    }
    let finalContent = parts.join("\n\n");

    teamIdForSend = await teamIdPromise;
    sessionFlowLog("send.team_resolved", {
      sessionId: sid,
      teamId: teamIdForSend,
      source: teamIdFromSessionList ? "session-list-store" : "backend",
      hasAuthSession: !!authSession,
    });

    const senderPromise =
      authSession && teamIdForSend
        ? resolveCurrentMemberActorId(teamIdForSend, authSession.user.id, {
            currentTeamId: useCurrentTeamStore.getState().team?.id ?? null,
            currentMemberId:
              useCurrentTeamStore.getState().currentMember?.id ?? null,
          })
        : Promise.resolve<string | null>(null);

    const uploadPromise = (async (): Promise<string[]> => {
      const urls: string[] = collectSessionAttachmentUrlsFromText(text);
      if (currentPendingFiles.length === 0 || !teamIdForSend) return urls;
      try {
        sessionFlowLog("send.attachments_upload.begin", {
          sessionId: sid,
          teamId: teamIdForSend,
          pendingFileCount: currentPendingFiles.length,
          pendingFileNames: currentPendingFiles.map((file) => file.name),
        });
        const uploaded = await Promise.all(
          currentPendingFiles.map((file) =>
            uploadAttachment(file, { teamId: teamIdForSend!, sessionId: sid }),
          ),
        );
        for (const att of uploaded) {
          const tokenIsImage =
            att.mimeType.startsWith("image/") ||
            /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|heif)$/i.test(att.fileName);
          if (tokenIsImage) {
            parts.push(`[Image: ${att.fileName}] (url: ${att.signedUrl})`);
          } else {
            parts.push(`[Attachment: ${att.fileName}] (url: ${att.signedUrl})`);
          }
          urls.push(att.signedUrl);
        }
        finalContent = parts.join("\n\n");
        sessionFlowLog("send.attachments_upload.ok", {
          sessionId: sid,
          teamId: teamIdForSend,
          uploadedCount: uploaded.length,
        });
      } catch (e) {
        sessionFlowError("send.attachments_upload.failed", e, {
          sessionId: sid,
          teamId: teamIdForSend,
          pendingFileCount: currentPendingFiles.length,
        });
        console.error("[ChatPanel] attachment upload failed:", e);
        const { toast } = await import("sonner");
        toast.error("Failed to upload attachment — message not sent");
        throw e;
      }
      return urls;
    })();

    let mentionActorIds: string[];
    let senderActorId: string | null;
    let attachmentUrls: string[];
    try {
      sessionFlowLog("send.resolve_sender.begin", {
        sessionId: sid,
        teamId: teamIdForSend,
        userId: authSession?.user.id ?? null,
      });
      [mentionActorIds, senderActorId, attachmentUrls] = await Promise.all([
        mentionsPromise,
        senderPromise,
        uploadPromise,
      ]);
    } catch {
      restoreComposer();
      return;
    }

    sessionFlowLog("send.mentions_resolved", {
      sessionId: sid,
      memberMentionCount: memberIds.length,
      agentMentionCount: agentIds.length,
      mentionActorIds,
      syncFastPath: syncMentions != null,
    });

    const agentRuntimeIdsForSend = resolveAgentRuntimeIdsForSend(
      sid,
      agentForSend?.id ?? null,
      mentionActorIds,
    );

    // Diagnostic: when the user has agents engaged in the pill but the
    // resolved mention list is empty (or contains no agent actors), no
    // daemon will pick the message up — the daemon's
    // `route_session_message` silent-queues every message whose
    // `mention_actor_ids` does not include its own actor. Surface a
    // visible warning so the "send → no reply" UX hangs less.
    if (engagedAgents.length > 0 && agentRuntimeIdsForSend.length === 0) {
      sessionFlowLog("send.no_agent_mentions_despite_engagement", {
        sessionId: sid,
        engagedAgentIds: engagedAgents.map((a) => a.id),
        resolvedMentionActorIds: mentionActorIds,
      }, "warn");
      void import("sonner").then(({ toast }) => {
        toast.warning(t("chat.toast.mentionRouteFailedTitle", "已 @Agent 但无法路由消息"), {
          description: t(
            "chat.toast.mentionRouteFailedBody",
            "消息未包含可解析的 Agent @-mention，daemon 不会回复。请确认 Agent 已加入此会话。",
          ),
        });
      });
    }

    // Optimistic v2 send: synthesize the proto Message and append to the
    // session store immediately so the bubble renders instantly. The actual
    // Supabase insert + MQTT publish are handled asynchronously by
    // `outbox-sender` which retries with exponential backoff on failure.
    // The bubble shows a leading status dot (pending/inFlight/delivered/
    // failed) bound to the matching outbox entry, mirroring iOS.
    const outgoing = finalContent;
    if (outgoing && outgoing.trim()) {
      if (sid && authSession && teamIdForSend) {
        try {
          if (!senderActorId)
            throw new Error(`No actor found for user in team ${teamIdForSend}`);

          const messageId = crypto.randomUUID();
          const createdAt = BigInt(Math.floor(Date.now() / 1000));
          // Must resolve identically to the AgentSelectorDock pill — what the
          // user SEES is what the prompt runs on. That means passing the
          // session's transcript-established model here too; without it the
          // send path fell through to the agent-level runtime retain, which
          // can belong to another session (显示 A 实跑 B).
          const establishedForSend = resolveSessionEstablishedModel(
            useSessionMessageStore.getState().messages[sid],
            agentRuntimeIdsForSend[0] ?? "",
          );
          const sendAgentId = agentRuntimeIdsForSend[0] ?? "";
          const sendByRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
          const localDaemonActorIdForSend = getKnownLocalDaemonActorId();
          const localCatalogWorkspace =
            useWorkspaceStore.getState().workspacePath?.trim() || "";
          const localCatalogForSend = localCatalogWorkspace
            ? useLocalDaemonCatalogStore.getState().byWorkspacePath[
                localCatalogWorkspace
              ]
            : undefined;
          const availableForSend = resolveAgentCatalogModels({
            agentId: sendAgentId,
            localDaemonActorId: localDaemonActorIdForSend,
            sessionId: sid,
            byRuntimeId: sendByRuntimeId,
            runtimeInfo: resolveRuntimeStateEntryForAgent(sendAgentId, sendByRuntimeId)
              ?.info,
            localWorkspaceCatalogModels: localCatalogForSend?.models,
            remoteDefaultCatalogModels:
              useRuntimeStateStore.getState().defaultCatalogByActorId[sendAgentId]?.models,
          });
          // No agent means no model: there is nothing to run the prompt on, so
          // stamping the message with a workspace-global default only recorded
          // a model that was never used. `selectAgentModel` owns every other
          // case — including the fallback, which must be the same device MRU
          // the pill shows.
          const outgoingModel = sendAgentId
            ? selectAgentModel({
                sessionId: sid,
                agentId: sendAgentId,
                available: availableForSend,
                byRuntimeId: sendByRuntimeId,
                providerFallback:
                  localRecentModelFallback({
                    agentId: sendAgentId,
                    localDaemonActorId: localDaemonActorIdForSend,
                    recentModels: localCatalogForSend?.recentModels,
                    available: availableForSend,
                  }) || undefined,
                sessionEstablishedModel: establishedForSend,
              }).modelId || ""
            : "";
          const mentionDeliverySnapshot: Record<string, "offline" | "stale"> = {};
          for (const entry of engagedUiEntries) {
            if (!agentForSend || entry.agent.id !== agentForSend.id) continue;
            const snap = toMentionDeliverySnapshot(entry.uiState);
            if (snap === "offline" || snap === "stale") {
              mentionDeliverySnapshot[entry.agent.id] = snap;
            }
          }
          const outgoingMetadata = {
            mention_actor_ids: mentionActorIds,
            ...(displayMentionActorIds.length > 0
              ? { display_mention_actor_ids: displayMentionActorIds }
              : {}),
            ...(Object.keys(mentionDeliverySnapshot).length > 0
              ? { mention_delivery_snapshot: mentionDeliverySnapshot }
              : {}),
            ...(attachmentUrls.length > 0
              ? { attachment_urls: attachmentUrls }
              : {}),
          };
          sessionFlowLog("send.proto_created", {
            sessionId: sid,
            teamId: teamIdForSend,
            messageId,
            senderActorId,
            mentionActorCount: mentionActorIds.length,
            attachmentUrlCount: attachmentUrls.length,
            model: outgoingModel || null,
            ...summarizeText(outgoing),
          });

          const msg = createMessage(MessageSchema, {
            messageId,
            sessionId: sid,
            senderActorId,
            kind: MessageKind.TEXT,
            content: outgoing,
            metadataJson: JSON.stringify(outgoingMetadata),
            createdAt,
            model: outgoingModel,
          });

          // 1. Optimistic UI append.
          //    dedup-by-id in session-message-store means the eventual live
          //    echo (same messageId) is a no-op.
          useSessionMessageStore.getState().appendMessage(sid, msg);
          useV2StreamingStore.getState().clearStaleStreamErrors(sid);
          // A new prompt supersedes any lingering turn-failure alert.
          if (useSessionStore.getState().errorSessionId === sid) {
            clearSessionError();
          }
          if (displaySessionId !== sid) {
            setDisplaySessionId(sid);
            setSessionFadeOpacity(1);
          }
          // Scroll so afterMessages separator aligns with viewport bottom:
          // new user bubble is fully visible, agent stream UI stays below the fold.
          // isAtBottom is force-enabled so ResizeObserver follows agent replies.
          messageListRef.current?.scrollToLatestMessage();
          sessionFlowLog("send.optimistic_append.ok", {
            sessionId: sid,
            messageId,
            currentMessageCount:
              useSessionMessageStore.getState().messages[sid]?.length ?? 0,
          });

          // MQTT live subscribe is for hearing OTHER members — not delivery.
          // Local agent gets the message via outbox loopback ingest. Do not
          // block the optimistic bubble (or outbox kick) on broker RTT.
          sessionFlowLog("send.subscribe_live.begin", {
            sessionId: sid,
            teamId: teamIdForSend,
          });
          void ensureSessionLiveSubscribed(teamIdForSend, sid)
            .then(() => {
              sessionFlowLog("send.subscribe_live.ok", {
                sessionId: sid,
                teamId: teamIdForSend,
              });
            })
            .catch((subscribeError) => {
              sessionFlowError("send.subscribe_live.best_effort_failed", subscribeError, {
                sessionId: sid,
                teamId: teamIdForSend,
              });
            });

          // 2. Enqueue to outbox immediately — status dot beside the bubble
          //    tracks pending/inFlight/delivered. Do NOT await workspace-hint
          //    Cloud lookups here: on a slow API that was 7–8s of dead air
          //    between bubble and spinner. The outbox sender resolves
          //    workspaceIdHint itself before runtimeStart (after MQTT wake).
          //    notePendingAgentReplyTo only after enqueue succeeds so a failed
          //    send cannot leave stale FIFO ids for a later agent turn.
          sessionFlowLog("send.outbox_enqueue.begin", {
            sessionId: sid,
            teamId: teamIdForSend,
            messageId,
            workspaceIdHint: null,
          });
          await useOutboxStore.getState().enqueue({
            messageId,
            teamId: teamIdForSend,
            sessionId: sid,
            senderActorId,
            content: outgoing,
            model: outgoingModel || null,
            mentionActorIds,
            displayMentionActorIds,
            attachmentUrls,
            workspaceIdHint: null,
          });
          sessionFlowLog("send.outbox_enqueue.ok", {
            sessionId: sid,
            teamId: teamIdForSend,
            messageId,
          });
          if (agentRuntimeIdsForSend.length > 0) {
            notePendingAgentReplyTo(sid, agentRuntimeIdsForSend, messageId);
          }

          bumpSessionListLastMessage(sid, outgoing, { at: new Date().toISOString() });

          const noticeText = buildPostSendSessionNotice(engagedUiEntries, t);
          if (noticeText) {
            useSessionNoticeStore.getState().append(sid, noticeText);
          }

          // Runtime ensure + MQTT publish happen inside the outbox sender
          // (insert → runtimeStart/catchup → mqtt). Do not fire a parallel
          // ensure here — it races ahead of persistence and triggers catchup
          // before the @-mentioned row exists in the backend.
        } catch (e) {
          sessionFlowError("send.failed_before_outbox", e, {
            sessionId: sid,
            teamId: teamIdForSend,
          });
          console.error("[ChatPanel] send enqueue failed:", e);
        }
      } else {
        sessionFlowLog("send.skipped_missing_context", {
          sessionId: sid,
          hasAuthSession: !!authSession,
          teamId: teamIdForSend,
          hasOutgoing: outgoing.trim().length > 0,
        }, "warn");
      }
    }

  };

  const handleSubmit = async (message: PromptInputMessage) => {
    sessionFlowLog("submit.received", {
      activeSessionId,
      hasDraftPreselectedActor: !!draftPreselectedActor,
      mentionCount: message.mentions?.length ?? 0,
      ...summarizeText(message.text ?? ""),
    });
    if (!activeSessionId) {
      // No session yet.
      //   1. Actor-draft mode (user tapped an actor row → draftPreselectedActor
      //      is set): create the session with that one actor and send straight
      //      away — bypasses the new-session dialog by design.
      //   2. Otherwise: redirect into the new-session dialog so the user can
      //      pick participants. The typed text is preserved as the opening
      //      message rather than dropped.
      if (draftPreselectedActor) {
        const picks =
          draftPreselectedActor.kind === 'agent'
            ? {
                agents: [{ id: draftPreselectedActor.id, displayName: draftPreselectedActor.displayName }],
                members: [],
              }
            : {
                agents: [],
                members: [{ id: draftPreselectedActor.id, displayName: draftPreselectedActor.displayName }],
              };
        const draftActorId = draftPreselectedActor.id;
        // Keep draftPreselectedActor until the new session is active —
        // clearing it first flashes LocalAgentWelcomeEmptyState ("… is
        // waiting on this device") for the duration of createSessionShell.
        setWelcomeSessionStarting(true);
        try {
          const created = await createSessionAndSendFirst(message, picks);
          if (created) {
            try {
              localStorage.removeItem(`teamclaw-actor-draft:${draftActorId}`);
            } catch {
              /* localStorage disabled */
            }
            useUIStore.getState().clearActorDraft();
          }
        } finally {
          setWelcomeSessionStarting(false);
        }
        return;
      }
      if (welcomeQuickChatAgent) {
        setWelcomeSessionStarting(true);
        try {
          await createSessionAndSendFirst(message, {
            agents: [{ id: welcomeQuickChatAgent.id, displayName: welcomeQuickChatAgent.displayName }],
            members: [],
          });
        } finally {
          setWelcomeSessionStarting(false);
        }
        return;
      }
      useUIStore.getState().openNewSessionDialog(message.text ?? null);
      sessionFlowLog("submit.open_new_session_dialog", {
        ...summarizeText(message.text ?? ""),
      });
      return;
    }
    await sendIntoSession(activeSessionId, message);
  };

  // ── New-session creation: shared by the picker confirm path and the
  //    actor-draft (preselected actor) path ───────────────────────────────
  const createSessionAndSendFirst = async (
    firstMessage: PromptInputMessage,
    picks: {
      members: { id: string; displayName: string }[]
      agents: { id: string; displayName: string }[]
    },
  ): Promise<boolean> => {
    const teamIdForSend = sheetTeamId;
    sessionFlowLog("session_create.begin", {
      teamId: teamIdForSend,
      pickedMemberCount: picks.members.length,
      pickedAgentCount: picks.agents.length,
      ...summarizeText(firstMessage.text ?? ""),
    });
    if (!teamIdForSend) {
      sessionFlowLog("session_create.missing_team", {}, "warn");
      console.error('[ChatPanel] no team_id available; cannot create session');
      return false;
    }

    const authSession = useAuthStore.getState().session;
    if (!authSession?.user?.id) {
      sessionFlowLog("session_create.missing_auth", {
        teamId: teamIdForSend,
      }, "warn");
      console.error('[ChatPanel] no auth session');
      return false;
    }
    const myActorId = await resolveCurrentMemberActorId(
      teamIdForSend,
      authSession.user.id,
      {
        currentTeamId: useCurrentTeamStore.getState().team?.id ?? null,
        currentMemberId: useCurrentTeamStore.getState().currentMember?.id ?? null,
      },
    );
    if (!myActorId) {
      sessionFlowLog("session_create.missing_actor", {
        teamId: teamIdForSend,
        userId: authSession.user.id,
      }, "warn");
      console.error('[ChatPanel] no actor record for user in team', teamIdForSend);
      const { toast } = await import('sonner');
      toast.error(t('chat.newSessionPicker.createError', 'Failed to create session'));
      return false;
    }

    // Initial title: "ActorName (HH:mm)" when we have exactly one
    // preselected actor (so multiple sessions to the same actor stay
    // distinguishable until the first user message auto-titles the session).
    // Otherwise fall back to the message text or a generic placeholder.
    const soloActor =
      picks.members.length + picks.agents.length === 1
        ? picks.members[0] ?? picks.agents[0]
        : null;
    const pad = (n: number) => n.toString().padStart(2, '0');
    const now = new Date();
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const titleSource = soloActor
      ? `${soloActor.displayName} (${hhmm})`
      : (firstMessage.text ?? '').trim() || 'New chat';

    try {
      const { createSessionShell } = await import('@/lib/session-create');
      const memberIds = picks.members.map((m) => m.id);
      const agentIds = picks.agents.map((a) => a.id);
      const allAdditional = Array.from(new Set([...memberIds, ...agentIds]));
      const draftIdeaId = useUIStore.getState().draftIdeaId;
      sessionFlowLog("session_create.shell.begin", {
        teamId: teamIdForSend,
        creatorActorId: myActorId,
        additionalActorCount: allAdditional.length,
        agentActorCount: agentIds.length,
        hasIdeaId: !!draftIdeaId,
        title: titleSource,
      });
      const { sessionId } = await createSessionShell({
        teamId: teamIdForSend,
        creatorActorId: myActorId,
        title: titleSource,
        additionalActorIds: allAdditional,
        ideaId: draftIdeaId,
      });
      if (soloActor) {
        const { markSessionNeedsAutoTitle } = await import("@/lib/session-auto-title");
        markSessionNeedsAutoTitle(sessionId);
      }
      sessionFlowLog("session_create.shell.ok", {
        teamId: teamIdForSend,
        sessionId,
      });
      if (draftIdeaId) {
        useUIStore.getState().clearDraftIdeaId();
      }

      // Optimistic list row + switch — do not await a full session-list
      // refetch before the user can see the new chat / send completes.
      sessionFlowLog("session_create.promote.begin", {
        teamId: teamIdForSend,
        sessionId,
      });
      await promoteCreatedSessionToUi({
        sessionId,
        teamId: teamIdForSend,
        title: titleSource,
        ideaId: draftIdeaId,
        lastMessagePreview: (firstMessage.text ?? '').trim().slice(0, 120) || null,
      });
      sessionFlowLog("session_create.promote.ok", {
        teamId: teamIdForSend,
        sessionId,
      });

      // Carry any model chosen on the draft pill onto the real session, before
      // the first send resolves a model. Without this the pick is stranded in
      // the draft scope and the send falls through to retain/MRU.
      useAgentModelPickStore.getState().promoteDraftPicks(sessionId);

      // Solo create: mount the pill before send so mention is WYSIWYG.
      const soleAgent =
        picks.members.length === 0 && picks.agents.length === 1
          ? picks.agents[0]
          : null;
      if (soleAgent) {
        useEngagedAgentStore.getState().setAgents(sessionId, [soleAgent]);
      }
      await sendIntoSession(sessionId, firstMessage);

      const autoMentioned = soleAgent ? new Set([soleAgent.id]) : new Set<string>();
      const agentsNeedingCreateEnsure = agentIds.filter((id) => !autoMentioned.has(id));
      if (agentsNeedingCreateEnsure.length > 0) {
        sessionFlowLog("session_create.runtime_start.begin", {
          teamId: teamIdForSend,
          sessionId,
          agentActorIds: agentsNeedingCreateEnsure,
          skippedAutoMentioned: agentIds.filter((id) => autoMentioned.has(id)),
        });
        void import("@/lib/teamclaw/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
          void ensureAgentRuntimesForSession({
            sessionId,
            teamId: teamIdForSend,
            agentActorIds: agentsNeedingCreateEnsure,
            // No modelId: `ensureAgentRuntimesForSession` feeds this to
            // `selectAgentModel` as a providerFallback, and that resolver
            // already reaches the retain and the device MRU on its own.
            reason: "session_create",
          });
        });
      } else if (agentIds.length > 0) {
        sessionFlowLog("session_create.runtime_start.delegated_to_outbox", {
          teamId: teamIdForSend,
          sessionId,
          agentActorIds: agentIds,
        });
      }
      return true;
    } catch (e) {
      sessionFlowError("session_create.failed", e, {
        teamId: teamIdForSend,
      });
      console.error('[ChatPanel] session creation failed:', e);
      const { toast } = await import('sonner');
      toast.error(t('chat.newSessionPicker.createError', 'Failed to create session'));
      return false;
    }
  };

  const handleStartLocalAgentSession = React.useCallback(async () => {
    if (welcomeSessionStarting || quickChatState.kind !== 'ready') return;
    setWelcomeSessionStarting(true);
    try {
      const result = await createQuickSession(quickChatState.target);
      if (!result.ok) {
        showQuickSessionFailure(result.reason);
      }
    } catch (e) {
      console.error('[ChatPanel] local agent welcome start failed', e);
      showQuickSessionFailure('server_error');
    } finally {
      setWelcomeSessionStarting(false);
    }
  }, [quickChatState, showQuickSessionFailure, welcomeSessionStarting]);

  // `createSessionAndSendFirst` is re-created every render and closes over
  // volatile values (sheetTeamId, selectedModelKey, resolved actor). The
  // memoized quick-action callback below must not capture a stale copy, so we
  // reach the latest version through a ref that is refreshed each render.
  const createSessionAndSendFirstRef = React.useRef(createSessionAndSendFirst);
  createSessionAndSendFirstRef.current = createSessionAndSendFirst;

  const handleLocalAgentQuickAction = React.useCallback(async (messageText: string) => {
    if (welcomeSessionStarting || !welcomeQuickChatAgent) return;
    setWelcomeSessionStarting(true);
    try {
      await createSessionAndSendFirstRef.current(
        { text: messageText, mentions: [] },
        {
          agents: [{ id: welcomeQuickChatAgent.id, displayName: welcomeQuickChatAgent.displayName }],
          members: [],
        },
      );
    } finally {
      setWelcomeSessionStarting(false);
    }
  }, [welcomeQuickChatAgent, welcomeSessionStarting]);

  const handleOpenAgentSettings = React.useCallback(() => {
    useUIStore.getState().openSettings('daemonGeneral');
  }, []);

  // ── Empty state ───────────────────────────────────────────────────────
  const handleCloseArchivedSession = React.useCallback(() => {
    closeArchivedSession();
    setViewingChildSession?.(null);
  }, [closeArchivedSession, setViewingChildSession]);

  const handleRestoreArchivedSession = React.useCallback(async () => {
    if (!viewingArchivedSessionId || isRestoringArchivedRef.current) return;
    isRestoringArchivedRef.current = true;
    setIsRestoringArchived(true);
    try {
      await restoreSession(viewingArchivedSessionId);
    } finally {
      isRestoringArchivedRef.current = false;
      setIsRestoringArchived(false);
    }
  }, [restoreSession, viewingArchivedSessionId]);

  const emptyState = React.useMemo(() => {
    if (activeSessionId) {
      if (compact) {
        return null;
      }
      return (
        <SessionEmptyThreadState
          sessionId={activeSessionId}
        />
      );
    }
    if (draftPreselectedActor) {
      return (
        <div
          className={cn(
            "flex flex-col items-center justify-center text-center",
            compact ? "py-8 px-2" : "py-20",
          )}
        >
          <h2
            className={cn(
              "mb-1 font-semibold",
              compact ? "text-sm" : "text-xl",
            )}
          >
            {draftPreselectedActor.displayName}
          </h2>
          <p
            className={cn(
              "text-muted-foreground",
              compact ? "text-xs" : "text-sm",
            )}
          >
            {draftPreselectedActor.kind === 'agent'
              ? t('chat.draftWithAgentHint', '在下方输入消息，发送后创建与该 Agent 的会话')
              : t('chat.draftWithMemberHint', '在下方输入消息，发送后创建与该成员的会话')}
          </p>
          <SessionContinueBanner
            actorId={draftPreselectedActor.id}
            actorName={draftPreselectedActor.displayName}
          />
        </div>
      );
    }
    // Creating the first session from welcome/draft — keep the thread blank
    // instead of flashing the "… is waiting on this device" welcome card.
    if (welcomeSessionStarting) {
      return null;
    }
    if (!compact) {
      return (
        <LocalAgentWelcomeEmptyState
          agent={welcomeQuickChatAgent}
          agentLoading={welcomeQuickChatLoading}
          starting={welcomeSessionStarting}
          onStartConversation={() => void handleStartLocalAgentSession()}
          onQuickAction={(message) => void handleLocalAgentQuickAction(message)}
          onOpenAgentSettings={handleOpenAgentSettings}
        />
      );
    }
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center text-center",
          "py-8 px-2",
        )}
      >
        <h2 className="mb-1 text-sm font-semibold">
          {welcomeQuickChatAgent?.displayName ?? t("chat.agent", "Agent")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t("chat.askAboutFile", "Ask questions about the file")}
        </p>
      </div>
    );
  }, [
    compact,
    t,
    draftPreselectedActor,
    welcomeQuickChatAgent,
    welcomeQuickChatLoading,
    welcomeSessionStarting,
    handleStartLocalAgentSession,
    handleLocalAgentQuickAction,
    handleOpenAgentSettings,
    activeSessionId,
  ]);

  const visibleSessionError =
    sessionError?.sessionId && sessionError.sessionId === displaySessionId
      ? sessionError
      : null;
  const visibleError =
    error && errorSessionId && errorSessionId === displaySessionId
      ? error
      : null;

  // Live streams render in Composer Live Dock. Keep displayV2Streams for
  // timeline diagnostics only (inactive/archived still live in the store).
  const v2DisplayRevision = useV2StreamingStore((s) =>
    displaySessionId ? (s.revisionBySession[displaySessionId] ?? 0) : 0,
  );
  const displayV2Streams = React.useMemo(() => {
    if (!displaySessionId) return [];
    const s = useV2StreamingStore.getState();
    const current = Object.values(s.byKey).filter(
      (e) => e.sessionId === displaySessionId,
    );
    const archived = s.archived.filter((e) => e.sessionId === displaySessionId);
    return [...archived, ...current].sort((a, b) => a.lastUpdate - b.lastUpdate);
    // v2DisplayRevision is the change signal; byKey/archived are read via
    // getState() to avoid re-subscribing to the whole store (perf). Do not add
    // byKey/archived to deps — it reintroduces per-delta re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2DisplayRevision, displaySessionId]);

  const lastTimelineDiagSigRef = React.useRef<string>("");
  React.useEffect(() => {
    if (!displaySessionId) return;
    const timelineMessages = displayMessages ?? [];
    const sig = JSON.stringify({
      messageListCount: timelineMessages.length,
      messageTailIds: timelineMessages.slice(-5).map((message) => message.id),
      bottomStreamCount: displayV2Streams.length,
      bottomStreamIds: displayV2Streams.map((entry) => entry.streamId),
    });
    if (sig === lastTimelineDiagSigRef.current) return;
    lastTimelineDiagSigRef.current = sig;
    logInterruptMsgDiag("ui.timeline", {
      sessionId: displaySessionId,
      messageListCount: timelineMessages.length,
      messageListTail: timelineMessages.slice(-5).map((message) => ({
        id: message.id,
        role: message.role,
        contentLength: (message.content ?? "").trim().length,
        toolCount: message.toolCalls?.length ?? 0,
        partTypes: message.parts?.map((part) => part.type) ?? [],
        timestamp: message.timestamp?.toISOString?.() ?? null,
      })),
      bottomStreamCount: displayV2Streams.length,
      bottomStreams: displayV2Streams.map((entry) => ({
        source: "archiveId" in entry ? "archived" : "byKey",
        archiveId: "archiveId" in entry ? entry.archiveId : null,
        streamId: entry.streamId,
        active: entry.active,
        toolCount: entry.toolCalls.length,
        partTypes: entry.parts.map((part) => part.type),
        lastUpdate: entry.lastUpdate,
      })),
    });
    if (isChromeExtension()) {
      const assistantTail = timelineMessages
        .filter((m) => m.role !== "user" && m.role !== "system")
        .slice(-6);
      logExtMsgDiag("ui.timeline", {
        sessionId: displaySessionId,
        assistantTail: assistantTail.map((m) => ({
          id: m.id,
          role: m.role,
          turnId: m.turnId ?? "",
          replyTo: m.replyToMessageId ?? "",
          contentLen: (m.content ?? "").trim().length,
          isInterrupt: m.id.startsWith("interrupt-"),
          toolCount: m.toolCalls?.length ?? 0,
          partTypes: m.parts?.map((p) => p.type) ?? [],
          hasProcessParts: (m.parts ?? []).some(
            (p) => p.type === "reasoning" || p.type === "tool-call",
          ),
        })),
        interruptVisible: assistantTail.filter((m) =>
          m.id.startsWith("interrupt-"),
        ).length,
        replyToHeaders: assistantTail.filter((m) =>
          Boolean(m.replyToMessageId?.trim()),
        ).length,
      });
    }
  }, [displaySessionId, displayMessages, displayV2Streams]);

  const hasSessionNotices = useSessionNoticeStore((s) =>
    displaySessionId ? (s.bySession[displaySessionId]?.length ?? 0) > 0 : false,
  );
  const messageBottomContent = !isViewingChild &&
    (visibleSessionError || visibleError || hasSessionNotices) ? (
    <>
      {hasSessionNotices ? <SessionNoticeList sessionId={displaySessionId} /> : null}
      {visibleSessionError ? (
        <SessionErrorAlert
          error={visibleSessionError}
          onDismiss={clearSessionError}
        />
      ) : visibleError ? (
        <SessionErrorAlert
          error={visibleError}
          onDismiss={() => setError(null)}
        />
      ) : null}
    </>
  ) : null;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      className={cn(
      "flex flex-col",
        compact ? "h-full w-full relative" : "absolute inset-0",
      )}
    >
      {/* Actors panel mounts in RightPanel for the 'actors' tab; trigger
       *  lives in App.tsx header alongside Knowledge / Changes. */}

      {/* Inactivity warning - task still running but no events */}
      {inactivityWarning && isStreaming && isConnected && (
        <div className="absolute top-2 right-12 z-20 flex items-center gap-2 rounded-full bg-blue-100 px-3 py-1 text-xs text-blue-800">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("chat.taskRunning", "Task running...")}
        </div>
      )}

      {/* ─── Archived session read-only bar ─── */}
      {isViewingArchived && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
          <button
            type="button"
            onClick={handleCloseArchivedSession}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft size={14} />
            <span>{t("chat.backToActiveSession", "Back to active session")}</span>
          </button>
          <div className="min-w-0 flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
            <Archive size={12} />
            <span className="truncate">
              {archivedSession?.title || t("chat.archivedSession", "Archived session")}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={isRestoringArchived}
            onClick={() => void handleRestoreArchivedSession()}
          >
            <RefreshCw className={cn("h-3 w-3", isRestoringArchived && "animate-spin")} />
            {t("chat.restoreSession", "Restore")}
          </Button>
        </div>
      )}

      {/* ─── Child session back bar ─── */}
      {isViewingChild && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/30">
          <button
            type="button"
            onClick={() => useSessionStore.getState().setViewingChildSession(null)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft size={14} />
            <span>{t("chat.backToMainSession", "Back to main session")}</span>
          </button>
          <div className="flex items-center gap-1.5 ml-auto text-xs text-muted-foreground">
            <Bot size={12} />
            <span>Sub-agent</span>
            {childStreamingContent?.isStreaming && (
              <Loader2 size={12} className="animate-spin" />
            )}
          </div>
        </div>
      )}

      {workspaceBootstrapped && !workspaceReady && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 px-4 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div>
              <p className="text-base font-medium">
                {t("chat.startingAgent", "Starting agent...")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("chat.waitingForAgent", "Sessions are ready. Waiting for agent runtime to finish starting.")}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ─── Message List (fade on session switch; input stays stable) ─── */}
      <div
        className={cn(
          "flex-1 min-h-0 flex flex-col overflow-hidden",
          "transition-opacity duration-150 ease-in-out motion-reduce:transition-none",
        )}
        style={{ opacity: isViewingArchived || isViewingChild ? 1 : sessionFadeOpacity }}
      >
        {!isViewingArchived && !isViewingChild ? (
          <AcpStreamDebugPanel sessionId={displaySessionId} />
        ) : null}
        {isViewingArchived ? (
          <MessageList
            ref={messageListRef}
            messages={archivedSessionMessages}
            activeSessionId={viewingArchivedSessionId}
            isStreaming={false}
            streamingMessageId={null}
            compact={compact}
            sessionDirectory={archivedSession?.directory}
          />
        ) : isViewingChild ? (
          isLoadingChildMessages ? (
            <div className="flex items-center justify-center flex-1">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <MessageList
              ref={messageListRef}
              messages={displayedChildSessionMessages}
              activeSessionId={viewingChildSessionId}
              isStreaming={!!childStreamingContent?.isStreaming}
              streamingMessageId={null}
              compact={compact}
            />
          )
        ) : (
          <MessageList
            ref={messageListRef}
            messages={displayMessages ?? []}
            activeSessionId={displaySessionId}
            isStreaming={isStreaming}
            streamingMessageId={streamingMessageId}
            compact={compact}
            emptyState={emptyState}
            bottomContent={messageBottomContent}
          />
        )}
      </div>

      {/* ─── Input Area (with Permission & Error UI above it) ─────────── */}
      {isViewingArchived ? (
        <div className="border-t border-border bg-background px-3 py-3">
          {archivedSessionError && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">
                  {t("chat.archivedSessionLoadError", "Could not load archived session")}
                </div>
                <div className="break-words text-xs text-destructive/80">
                  {archivedSessionError}
                </div>
              </div>
            </div>
          )}
          <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {t("chat.restoreArchivedHint", "Restore this session to continue chatting")}
          </div>
        </div>
      ) : !isViewingChild ? (
        activeInputQuestion ? (
          <QuestionInputDock
            compact={compact}
            pendingQuestion={activeInputQuestion}
            onHeightChange={handleInputHeightChange}
            bottomOffsetPx={terminalBottomOffset}
          />
        ) : activeSessionId || draftPreselectedActor ? (
          <>
            {activeSessionId ? (
              <div className="shrink-0 px-3 pt-2">
                <RuntimeRefreshSessionHint />
              </div>
            ) : null}
            <ChatInputArea
            activeSessionId={activeSessionId}
            compact={compact}
            pendingFiles={pendingFiles}
            onAppendPendingFiles={appendPendingFiles}
            onRemovePendingFile={removePendingFile}
            engagedAgents={engagedAgents}
            engagedUiEntries={engagedUiEntries}
            agentToRuntimeId={agentToRuntimeId}
            agentToBackendType={agentToBackendType}
            localDaemonAgent={localDaemonAgent}
            onSwitchToLocalAgent={handleSwitchToLocalAgent}
            onRetryOfflineAgents={handleRetryOfflineAgents}
            onEngageAgent={(a) => {
              if (!activeSessionId) {
                return;
              }
              addAgentForSession(a);
              if (!sheetTeamId) return;
              void import("@/lib/teamclaw/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
                void ensureAgentRuntimesForSession({
                  sessionId: activeSessionId,
                  teamId: sheetTeamId,
                  agentActorIds: [a.id],
                  reason: "mention_pill",
                });
              });
            }}
            onRemoveAgent={removeAgentForSession}
            agentMentionLocked={isSoloAgentSessionActive}
            sessionModelId={activeSessionModelId}
            activeStreamingAgents={activeStreamingAgents}
            onInterruptAgent={handleInterruptAgent}
            onSubmit={handleSubmit}
            isStreaming={isStreaming}
            messageQueue={messageQueue}
            onRemoveFromQueue={removeFromQueue}
            onHeightChange={handleInputHeightChange}
            onComposerFocus={handleComposerFocus}
            bottomOffsetPx={terminalBottomOffset}
            stackTodos={hasComposerPlanData ? (combinedTodos as Todo[]) : []}
            stackQueue={hasComposerPlanData ? messageQueue : []}
            planSlotHidden={hasComposerPlanData && !showInlineTodo}
          />
          </>
        ) : null
      ) : null}

      {terminalOpen && workspacePath && (
        <TerminalPanel
          workspaceId={workspacePath}
          workspacePath={workspacePath}
          allowedRoots={[workspacePath]}
        />
      )}
    </div>
  );
}
