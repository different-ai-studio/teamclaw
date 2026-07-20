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
import { useVoiceInputStore } from "@/stores/voice-input";
import { useWorkspaceStore } from "@/stores/workspace";
import { useProviderStore, type ModelOption } from "@/stores/provider";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useTeamModeStore } from "@/stores/team-mode";
import { useCurrentTeamStore } from "@/stores/current-team";
import { TEAMCLAW_DIR, CONFIG_FILE_NAME, TEAM_REPO_DIR } from "@/lib/build-config";
import { adaptTeamclawMessages } from "@/lib/v2-message-adapter";
import { notePendingAgentReplyTo } from "@/lib/pending-agent-reply-to";
import { logInterruptMsgDiag } from "@/lib/interrupt-msg-diag";
import { useAuthStore } from "@/stores/auth-store";
import { bumpSessionListLastMessage } from "@/lib/session-list-preview";
import { useSessionListStore } from "@/stores/session-list-store";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
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
import { resolveCurrentMemberActorId } from "@/lib/current-actor";
import { isAgentActorType } from "@/lib/actor-type";
import { resolveSessionWorkspaceHintForRuntimeStart } from "@/lib/teamclaw/resolve-runtime-start-workspace";
import type { PromptInputMessage } from "@/packages/ai/prompt-input";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";
import { Button } from "@/components/ui/button";
import { LocalAgentWelcomeEmptyState } from "./LocalAgentWelcomeEmptyState";
import { SessionEmptyThreadState } from "./SessionEmptyThreadState";
import { createQuickSession, describeQuickSessionFailure, type QuickSessionFailureReason } from "@/lib/create-quick-session";
import { createQuickEmptySession } from "@/lib/quick-empty-session";
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
import { getFileName } from "./utils/fileUtils";
import { MessageList, type MessageListHandle } from "./MessageList";
import { SessionErrorAlert } from "./SessionErrorAlert";
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
import { loadSessionActiveModel } from "@/lib/session-active-model";
import { ensureSessionLiveSubscribed } from "@/lib/session-live-subscriptions";
import { resolveActorIdsFromAtText } from "@/lib/resolve-text-mentions";
import { stripPickerPersonMentionsFromText } from "@/lib/strip-person-mentions";
import {
  expandMemberMentionTokensInText,
  parseMemberMentionsFromText,
  textHasMemberMentionTokens,
} from "@/lib/member-mention-token";
import { buildStructuredMentionLines } from "@/lib/outgoing-mention-content";
import { selectAgentModel, providerModelKeyFromOption } from "@/lib/runtime-state-resolve";
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

function buildEnhancedChip(
  type: "role" | "skill",
  name: string,
): string {
  const label = type === "role" ? "Role" : "Skill";
  const toolCall =
    type === "role"
      ? `role_load({ name: "${name}" })`
      : `skill({ name: "${name}" })`;
  return `[${label}: ${name}|instruction:You must call ${toolCall} before any other action.]`;
}

async function resolveMentionActorIdsForSession(
  sessionId: string,
  memberIds: string[],
  agentIds: string[],
  messageText = "",
): Promise<string[]> {
  const fromText = await resolveActorIdsFromAtText(sessionId, messageText);
  if (fromText.agentIds.length > 0) {
    const engaged = useEngagedAgentStore.getState();
    let participants: Array<{ id: string; display_name?: string | null }>;
    try {
      participants = await getBackend().sessionMembers.listParticipants(sessionId);
    } catch {
      participants = [];
    }
    for (const agentId of fromText.agentIds) {
      const row = participants.find((p) => p.id === agentId);
      engaged.addAgent(sessionId, {
        id: agentId,
        displayName: row?.display_name || "AI",
      });
      break;
    }
  }

  const explicit = Array.from(
    new Set([
      ...memberIds,
      ...agentIds.slice(0, 1),
      ...fromText.memberIds,
      ...(fromText.agentIds[0] ? [fromText.agentIds[0]] : []),
    ]),
  );
  if (explicit.length > 0) return explicit;

  // No explicit mentions. If the user explicitly cleared the engaged agents
  // ("Remove mention" → engagedAgents went from non-empty to empty), honor
  // that intent — sending without @ should NOT silently re-engage anyone.
  // Without this guard the fallback below would auto-mention the sole
  // session agent and effectively undo the user's Remove Mention click.
  if (useEngagedAgentStore.getState().wasExplicitlyCleared[sessionId]) {
    return [];
  }

  let participants: Array<{ id: string; actor_type?: string | null; display_name?: string | null }>;
  try {
    participants = await getBackend().sessionMembers.listParticipants(sessionId);
  } catch (participantError) {
    console.warn("[ChatPanel] failed to load session participants:", participantError);
    return [];
  }

  const agents = participants.filter((row) => isAgentActorType(row.actor_type));

  // Sole-agent send fallback: any session with exactly one agent participant
  // routes to that agent when the user sends without @. This is independent
  // of isSoloAgentSession, which only gates open-time pill auto-engage.
  return agents.length === 1
    ? [agents[0].id]
    : [];
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
  const draftInput = useSessionStore(s => s.draftInput);
  const todos = useSessionStore(s => s.todos);
  const pendingPermissions = useSessionStore(s => s.pendingPermissions);
  const pendingQuestions = useSessionStore(s => s.pendingQuestions);
  const sessions = useSessionStore(s => s.sessions);

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
      sessions,
      pendingPermissions,
      acpPendingForTodo,
      sessionPermissionMode,
    );
  }, [
    activeSessionId,
    acpPendingForTodo,
    isViewingArchived,
    isViewingChild,
    messageQueue.length,
    pendingPermissions,
    sessionPermissionMode,
    sessions,
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
          resolveSessionActivityOwner(question.sessionId, sessions, question.sessionId) ===
          activeSessionId
        );
      }) ||
      null
    );
  }, [activeSessionId, isViewingArchived, isViewingChild, pendingQuestions, sessions]);

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
  const setDraftInput = acts.setDraftInput;
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
  const inputValue = draftInput;
  const setInputValue = setDraftInput;
  const [attachedFiles, setAttachedFiles] = React.useState<string[]>([]);
  // engagedAgents is per-session: each @-mentioned agent shows as a pill in
  // the prompt-input toolbar. Switching away from a session and back
  // restores its engaged set rather than carrying one across sessions.
  // For brand-new chats (activeSessionId === null), the list is empty.
  const engagedAgents = useEngagedAgentStore((s) =>
    activeSessionId ? s.bySession[activeSessionId] ?? EMPTY_AGENTS : EMPTY_AGENTS,
  );
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
      const sid = useSessionSelectionStore.getState().activeSessionId;
      if (!sid) return;
      useEngagedAgentStore.getState().removeAgent(sid, agentId);
    },
    [],
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
          removeAgentForSession(entry.agent.id);
        }
      }
      addAgentForSession(local);
    },
    [activeSessionId, engagedUiEntries, removeAgentForSession, addAgentForSession],
  );

  // Existing sessions can be reopened after a reload with no in-memory
  // engaged agents selected. Solo sessions (2 participants: 1 human + 1 agent)
  // auto-engage the agent pill so sends still trigger a reply.
  // Note: send-time mention fallback (resolveMentionActorIdsForSession) still
  // auto-mentions the sole session agent in multi-person sessions — only this
  // open-time pill auto-engage is restricted to solo pairs.
  // Runs at most once per sessionId per app lifetime so that explicitly
  // removing a mention ("Remove mention" in the agent pill dropdown) isn't
  // immediately undone by this effect re-firing on engagedAgents.length 1→0.
  const autoEngagedSessionsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!activeSessionId) return;
    if (autoEngagedSessionsRef.current.has(activeSessionId)) return;
    if (engagedAgents.length > 0) {
      autoEngagedSessionsRef.current.add(activeSessionId);
      return;
    }
    autoEngagedSessionsRef.current.add(activeSessionId);

    let cancelled = false;
    void (async () => {
      let actors: Awaited<ReturnType<ReturnType<typeof getBackend>['sessionMembers']['listParticipants']>>;
      try {
        actors = await getBackend().sessionMembers.listParticipants(activeSessionId);
      } catch {
        return;
      }
      if (cancelled) return;

      if (isSoloAgentSession(actors)) {
        const soleAgent = actors.find((row) => isAgentActorType(row.actor_type))!;
        useEngagedAgentStore.getState().setAgents(activeSessionId, [{
          id: soleAgent.id,
          displayName: soleAgent.display_name || "AI",
        }]);
        const teamId =
          useSessionListStore.getState().rows.find((r) => r.id === activeSessionId)?.team_id ??
          useCurrentTeamStore.getState().team?.id ??
          null;
        if (teamId) {
          void import("@/lib/teamclaw/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
            void ensureAgentRuntimesForSession({
              sessionId: activeSessionId,
              teamId,
              agentActorIds: [soleAgent.id],
              reason: "session_auto_engage",
            });
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, engagedAgents.length]);

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
  });
  useReensureRuntimesOnMqttReconnect({
    sessionId: activeSessionId,
    teamId: sheetTeamId,
    engagedUiEntries,
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

  const [imageFiles, setImageFiles] = React.useState<File[]>([]);
  const [isRestoringArchived, setIsRestoringArchived] = React.useState(false);
  const isRestoringArchivedRef = React.useRef(false);

  const isImagePath = React.useCallback((path: string) => {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|heif)$/i.test(path);
  }, []);

  const extractImageAttachmentTokens = React.useCallback(
    (text: string): { cleaned: string; imagePaths: string[] } => {
      // Support tolerant attachment token parsing from pasted text.
      // Examples:
      // [Attachment: a.png] (path: /x/a.png)
      // [Attachment:a.png](path:/x/a.png)
      const attachmentPattern = /\[Attachment:\s*([^\]]+)\]\s*\(([^)]*)\)/gi;
      const imagePaths: string[] = [];

      let cleaned = text.replace(attachmentPattern, (full, _name, info) => {
        const pathMatch = String(info).match(/path:\s*([^,)]+)/i);
        const fullPath = pathMatch ? pathMatch[1].trim() : "";
        if (fullPath && isImagePath(fullPath)) {
          imagePaths.push(fullPath);
          return "";
        }
        return full;
      });

      // Extra defensive pass: line-wise removal for any remaining textual
      // attachment tokens that point to image paths.
      const filteredLines = cleaned.split("\n").filter((line) => {
        if (!line.includes("[Attachment:")) return true;
        const pathMatch = line.match(/path:\s*([^)]+)\)?/i);
        const maybePath = pathMatch ? pathMatch[1].trim() : "";
        if (maybePath && isImagePath(maybePath)) return false;
        return true;
      });

      cleaned = filteredLines.join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/ {2,}/g, " ")
        .trimStart();

      return { cleaned, imagePaths };
    },
    [isImagePath],
  );

  // ── Provider store ────────────────────────────────────────────────────
  const currentModelKey = useProviderStore(s => s.currentModelKey);
  const initProviderStore = useProviderStore(s => s.initAll);
  const storeSelectModel = useProviderStore(s => s.selectModel);
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
  // Derive selected model from currentModelKey + models. Use useMemo with a
  // ref to avoid returning a new object when the logical value hasn't changed.
  // This prevents re-render cascades when initAll() rebuilds the models array
  // with identical data (fixes TEAMCLAW-REACT-1R).
  const providerModels = useProviderStore(s => s.models);
  const selectedModelOptionRef = React.useRef<ModelOption | null>(null);
  const selectedModelOption = React.useMemo(() => {
    if (!currentModelKey) {
      selectedModelOptionRef.current = null;
      return null;
    }
    const idx = currentModelKey.indexOf('/');
    if (idx < 0) {
      selectedModelOptionRef.current = null;
      return null;
    }
    const providerId = currentModelKey.substring(0, idx);
    const modelId = currentModelKey.substring(idx + 1);
    const found = providerModels.find((m) => m.provider === providerId && m.id === modelId) || null;
    const prev = selectedModelOptionRef.current;
    if (prev && found && prev.id === found.id && prev.provider === found.provider && prev.name === found.name) {
      return prev; // stable reference
    }
    selectedModelOptionRef.current = found;
    return found;
  }, [currentModelKey, providerModels]);

  const selectedModelKey = React.useMemo(
    () => (currentModelKey ?? providerModelKeyFromOption(selectedModelOption)) || null,
    [currentModelKey, selectedModelOption],
  );

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

  React.useEffect(() => {
    if (!activeSessionId || providerModels.length === 0) return;
    let cancelled = false;
    void (async () => {
      const resolved = await loadSessionActiveModel({
        sessionId: activeSessionId,
        runtimeStates,
        models: providerModels,
      });
      if (cancelled || !resolved) return;
      const nextKey = `${resolved.provider}/${resolved.modelId}`;
      if (useProviderStore.getState().currentModelKey === nextKey) return;
      sessionFlowLog("session_model.apply_to_provider", {
        sessionId: activeSessionId,
        provider: resolved.provider,
        modelId: resolved.modelId,
        source: resolved.source,
      });
      await storeSelectModel(resolved.provider, resolved.modelId, resolved.name);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, providerModels, runtimeStates, storeSelectModel]);

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

  // Sync selected model to session store
  React.useEffect(() => {
    if (selectedModelOption) {
      setStoreSelectedModel({
        providerID: selectedModelOption.provider,
        modelID: selectedModelOption.id,
        name: selectedModelOption.name,
      });
    }
  }, [currentModelKey, selectedModelOption]);

  React.useEffect(() => {
    if (!isTauri() || !activeSessionId) return;

    const modelKey = selectedModelOption
      ? `${selectedModelOption.provider}/${selectedModelOption.id}`
      : null;

    invoke<boolean>("sync_gateway_session_model", {
      sessionId: activeSessionId,
      model: modelKey,
    }).catch((error) => {
      console.warn("[ChatPanel] Failed to sync gateway session model:", error);
    });
  }, [activeSessionId, selectedModelOption]);

  // ── Per-actor draft persistence ──────────────────────────────────────
  // When the user taps an actor in the Actors tab without sending anything
  // and then navigates away (different actor, settings, etc.), their
  // typed-but-unsent text persists in localStorage keyed by actor id and
  // is restored next time they preselect the same actor.
  const draftStorageKey = draftPreselectedActor
    ? `teamclaw-actor-draft:${draftPreselectedActor.id}`
    : null;
  const justRestoredDraftRef = React.useRef(false);

  // Restore saved draft when actor changes.
  React.useEffect(() => {
    if (!draftStorageKey) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(draftStorageKey);
    } catch {
      /* localStorage disabled */
    }
    if (saved != null && saved !== inputValue) {
      justRestoredDraftRef.current = true;
      setInputValue(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftStorageKey]);

  // Debounced persist on input change. Skips the tick immediately after a
  // restore so we don't overwrite what we just read.
  React.useEffect(() => {
    if (!draftStorageKey) return;
    if (justRestoredDraftRef.current) {
      justRestoredDraftRef.current = false;
      return;
    }
    const handle = setTimeout(() => {
      try {
        if (inputValue) {
          localStorage.setItem(draftStorageKey, inputValue);
        } else {
          localStorage.removeItem(draftStorageKey);
        }
      } catch {
        /* localStorage disabled */
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [draftStorageKey, inputValue]);

  // Voice input / "Add to Agent": append transcript or file mention to input
  React.useEffect(() => {
    const unregister = useVoiceInputStore.getState().registerInsertToChatHandler(
      (transcript) => {
        const prev = useSessionStore.getState().draftInput;
        // Deduplicate @{filepath} mentions — prevent double insertion
        const mentionMatch = transcript.match(/@\{([^}]+)\}/);
        if (mentionMatch && prev.includes(mentionMatch[0])) return;
        setInputValue(prev + (prev ? " " : "") + transcript);
      },
    );
    return unregister;
  }, []);

  // ── Auto-dismiss error banners after 5 seconds ─────────────────────────
  React.useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error, setError]);

  React.useEffect(() => {
    if (!sessionError) return;
    // Retry errors are cleared by handleSessionStatus when session transitions
    // to busy or idle — don't auto-dismiss them.
    const isRetryError = sessionError.error?.name === 'RetryError';
    if (isRetryError) return;
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

      if (isWorkspaceChange) {
      resetSessions();
      }

    console.log("[ChatPanel] Workspace bootstrapped, loading sessions for:", workspacePath);
        loadSessions(workspacePath)
      .then(() => setError(null))
      .catch((err: unknown) =>
        console.error("[ChatPanel] Failed to load sessions:", err),
      );
  }, [workspaceBootstrapped, workspacePath, loadSessions, resetSessions]);

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

  const handleFilesChange = (paths: string[]) => {
    setAttachedFiles((prev) => [...prev, ...paths]);
  };

  const handleInputChange = React.useCallback(
    (nextValue: string) => {
      const { cleaned, imagePaths } = extractImageAttachmentTokens(nextValue);
      if (imagePaths.length > 0) {
        setAttachedFiles((prev) => {
          const seen = new Set(prev);
          const uniqueNew = imagePaths.filter((p) => !seen.has(p));
          return uniqueNew.length > 0 ? [...prev, ...uniqueNew] : prev;
        });
      }
      setInputValue(cleaned);
    },
    [extractImageAttachmentTokens, setInputValue],
  );

  // Fallback sanitizer: if input text is injected through another path,
  // still normalize it and convert image attachment tokens into previews.
  React.useEffect(() => {
    if (!inputValue) return;
    const { cleaned, imagePaths } = extractImageAttachmentTokens(inputValue);

    if (imagePaths.length > 0) {
      setAttachedFiles((prev) => {
        const seen = new Set(prev);
        const uniqueNew = imagePaths.filter((p) => !seen.has(p));
        return uniqueNew.length > 0 ? [...prev, ...uniqueNew] : prev;
      });
    }

    if (cleaned !== inputValue) {
      setInputValue(cleaned);
    }
  }, [inputValue, extractImageAttachmentTokens, setInputValue]);

  const removeFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleImageFilesChange = (files: File[]) => {
    setImageFiles((prev) => [...prev, ...files]);
  };

  const removeImageFile = (index: number) => {
    setImageFiles((prev) => prev.filter((_, i) => i !== index));
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
      attachedFileCount: attachedFiles.length,
      imageFileCount: imageFiles.length,
      ...summarizeText(text),
    });

    if (
      !text &&
      attachedFiles.length === 0 &&
      mentions.length === 0 &&
      !textHasMemberMentionTokens(text) &&
      imageFiles.length === 0 &&
      engagedAgents.length === 0
    ) {
      return;
    }

    if (
      !text.trim() &&
      attachedFiles.length === 0 &&
      imageFiles.length === 0 &&
      engagedAgents.length > 0
    ) {
      sessionFlowLog("send.rejected_empty_with_engaged_agent", {
        sessionId: sid,
        engagedAgentIds: engagedAgents.map((a) => a.id),
      }, "warn");
      void import("sonner").then(({ toast }) => {
        toast.warning(t("chat.toast.emptyMessageTitle", "请输入消息内容"), {
          description: t(
            "chat.toast.emptyMessageWithAgent",
            "已选择 Agent 时需要输入文字或附件才会发送。",
          ),
        });
      });
      return;
    }

    // Snapshot file state immediately so the UI clears at once, before any
    // async work. This prevents stale images from leaking into later sends
    // if the user types and submits again while the upload is in flight.
    const currentImageFiles = imageFiles;
    const currentAttachedFiles = attachedFiles;
    setInputValue("");
    setAttachedFiles([]);
    setImageFiles([]);

    // Single engaged agent: @ a new agent replaces the dock pill.
    const agentForSend = extraMentionAgents[0] ?? engagedAgents[0] ?? null;
    const memberIds = mentions.map((m) => m.id);
    const agentIds = agentForSend ? [agentForSend.id] : [];
    const displayMentionActorIds = Array.from(new Set(agentIds.filter(Boolean)));
    const mentionActorIds = await resolveMentionActorIdsForSession(
      sid,
      memberIds,
      agentIds,
      text,
    );
    sessionFlowLog("send.mentions_resolved", {
      sessionId: sid,
      memberMentionCount: memberIds.length,
      agentMentionCount: agentIds.length,
      mentionActorIds,
    });
    const _isPlanMode = !!(message as PromptInputMessage & { _planMode?: boolean })._planMode;


    // Resolve teamId early — needed for attachment upload path before building content.
    const authSession = useAuthStore.getState().session;
    const teamIdFromSessionList =
      useSessionListStore.getState().rows.find(r => r.id === sid)?.team_id ?? null;
    let teamIdForSend: string | null = teamIdFromSessionList;
    if (!teamIdForSend && sid) {
      sessionFlowLog("send.resolve_team_from_backend.begin", {
        sessionId: sid,
      });
      teamIdForSend = await getBackend().sessions.getSessionTeamId(sid);
    }
    // Creating a brand-new session: there is no `sid` yet and no session-list
    // row to read team_id from, so fall back to the currently selected team.
    // Without this, createSessionShell() posts teamId: null and the Cloud API
    // rejects it with "teamId is required".
    if (!teamIdForSend) {
      teamIdForSend = useCurrentTeamStore.getState().team?.id ?? null;
    }
    sessionFlowLog("send.team_resolved", {
      sessionId: sid,
      teamId: teamIdForSend,
      source: teamIdFromSessionList ? "session-list-store" : "backend",
      hasAuthSession: !!authSession,
    });

    let agentRuntimeIdsForSend: string[] = [];
    if (teamIdForSend && mentionActorIds.length > 0) {
      let participantsForRuntime: Array<{ id: string; actor_type?: string | null }> = [];
      try {
        participantsForRuntime = await getBackend().sessionMembers.listParticipants(sid);
      } catch (runtimeParticipantError) {
        console.warn("[ChatPanel] failed to load participants for runtime ensure:", runtimeParticipantError);
      }
      agentRuntimeIdsForSend = mentionActorIds.filter((id) => {
        const row = participantsForRuntime.find((p) => p.id === id);
        return row ? isAgentActorType(row.actor_type) : false;
      });
    }

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

    let finalContent: string;

    // Human @ chips expand inline (like Skill); agent stays in prefix line.
    let processedText = expandMemberMentionTokensInText(text, {
      humanMentionInstruction: (name) =>
        t("chat.outgoing.humanMentionInstruction", { name }),
    });
    processedText = stripPickerPersonMentionsFromText(processedText, mentions);

    processedText = expandPageLinkTokensInText(processedText);

    // Replace @{filepath} with [File: filepath] inline
    processedText = processedText.replace(/@\{([^}]+)\}/g, '[File: $1]');

    // Replace unified /{type:name} inline, while keeping legacy formats readable.
    processedText = processedText.replace(/\/\{([^}]+)\}/g, (_full, body) => {
      const token = parseSlashToken(body);
      if (token.type === "role") return buildEnhancedChip("role", token.name);
      if (token.type === "command") return `[Command: ${token.name}]`;
      return buildEnhancedChip("skill", token.name);
    });
    processedText = processedText.replace(/\/<([a-z0-9]+(?:-[a-z0-9]+)*)>/g, (_full, roleName) =>
      buildEnhancedChip("role", roleName),
    );
    processedText = processedText.replace(/\/\[([^\]]+)\]/g, '[Command: $1]');

    const parts: string[] = [];

    const structuredMentions = buildStructuredMentionLines(agentForSend);
    if (structuredMentions.length > 0) {
      parts.push(...structuredMentions);
    }

    // Add attached files at the beginning
    if (currentAttachedFiles.length > 0) {
      for (const filePath of currentAttachedFiles) {
        parts.push(`[Attachment: ${getFileName(filePath)}] (path: ${filePath})`);
      }
    }

    // Add the processed text (with inline [File: ...] replacements). Agent
    // mentions are rendered from metadata only; they must not become prompt
    // text delivered to the runtime.
    const bodyText = processedText.trim();
    if (bodyText) {
      parts.push(bodyText);
    }

    finalContent = parts.join("\n\n");

    // Upload pasted images to Supabase Storage before sending.
    // Mirrors iOS AttachmentUploadManager: upload first, then include signed
    // URL in message content so agents and other clients can access the file.
    const attachmentUrls: string[] = [];
    if (currentImageFiles.length > 0 && teamIdForSend) {
      try {
        sessionFlowLog("send.attachments_upload.begin", {
          sessionId: sid,
          teamId: teamIdForSend,
          imageFileCount: currentImageFiles.length,
          imageFileNames: currentImageFiles.map((file) => file.name),
        });
        const uploaded = await Promise.all(
          currentImageFiles.map((file) =>
            uploadAttachment(file, { teamId: teamIdForSend!, sessionId: sid }),
          ),
        );
        for (const att of uploaded) {
          parts.push(`[Image: ${att.fileName}] (url: ${att.signedUrl})`);
          attachmentUrls.push(att.signedUrl);
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
          imageFileCount: currentImageFiles.length,
        });
        console.error("[ChatPanel] attachment upload failed:", e);
        const { toast } = await import("sonner");
        toast.error("Failed to upload attachment — message not sent");
        return;
      }
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
          sessionFlowLog("send.subscribe_live.begin", {
            sessionId: sid,
            teamId: teamIdForSend,
          });
          await ensureSessionLiveSubscribed(teamIdForSend, sid);
          sessionFlowLog("send.subscribe_live.ok", {
            sessionId: sid,
            teamId: teamIdForSend,
          });

          sessionFlowLog("send.resolve_sender.begin", {
            sessionId: sid,
            teamId: teamIdForSend,
            userId: authSession.user.id,
          });
          const senderActorId = await resolveCurrentMemberActorId(
            teamIdForSend,
            authSession.user.id,
            {
              currentTeamId: useCurrentTeamStore.getState().team?.id ?? null,
              currentMemberId:
                useCurrentTeamStore.getState().currentMember?.id ?? null,
            },
          );
          if (!senderActorId)
            throw new Error(`No actor found for user in team ${teamIdForSend}`);

          const messageId = crypto.randomUUID();
          const createdAt = BigInt(Math.floor(Date.now() / 1000));
          const outgoingModel =
            agentRuntimeIdsForSend.length > 0
              ? selectAgentModel({
                  sessionId: sid,
                  agentId: agentRuntimeIdsForSend[0],
                  available: [],
                  byRuntimeId: useRuntimeStateStore.getState().byRuntimeId,
                  providerFallback: selectedModelKey ?? undefined,
                }).modelId || ""
              : selectedModelKey ?? "";
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

          // 2. Enqueue to outbox — status dot beside the bubble tracks
          //    pending/inFlight/delivered. Network + runtime work continue
          //    asynchronously after the bubble is visible.
          //    notePendingAgentReplyTo only after enqueue succeeds so a failed
          //    send cannot leave stale FIFO ids for a later agent turn.
          let workspaceIdHint: string | null = null;
          if (agentRuntimeIdsForSend.length > 0 && teamIdForSend) {
            let localDaemonActorId: string | null = null;
            if (isTauri()) {
              try {
                const { getLocalDaemonActorId } = await import("@/lib/daemon-agent-admin");
                localDaemonActorId = await getLocalDaemonActorId();
              } catch {
                localDaemonActorId = null;
              }
            }
            workspaceIdHint =
              (await resolveSessionWorkspaceHintForRuntimeStart({
                teamId: teamIdForSend,
                localWorkspacePath: workspacePath,
                sessionId: sid,
                agentActorIds: agentRuntimeIdsForSend,
                localDaemonActorId,
              })) || null;
          }
          sessionFlowLog("send.outbox_enqueue.begin", {
            sessionId: sid,
            teamId: teamIdForSend,
            messageId,
            workspaceIdHint,
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
            workspaceIdHint,
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
        try {
          localStorage.removeItem(`teamclaw-actor-draft:${draftPreselectedActor.id}`);
        } catch {
          /* localStorage disabled */
        }
        useUIStore.getState().clearActorDraft();
        await createSessionAndSendFirst(message, picks);
        return;
      }
      if (welcomeQuickChatAgent) {
        await createSessionAndSendFirst(message, {
          agents: [{ id: welcomeQuickChatAgent.id, displayName: welcomeQuickChatAgent.displayName }],
          members: [],
        });
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
  ) => {
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
      return;
    }

    const authSession = useAuthStore.getState().session;
    if (!authSession?.user?.id) {
      sessionFlowLog("session_create.missing_auth", {
        teamId: teamIdForSend,
      }, "warn");
      console.error('[ChatPanel] no auth session');
      return;
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
      return;
    }

    // Initial title: "ActorName (HH:mm)" when we have exactly one
    // preselected actor (so multiple sessions to the same actor stay
    // distinguishable in the list until agent auto-rename kicks in).
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
      sessionFlowLog("session_create.shell.ok", {
        teamId: teamIdForSend,
        sessionId,
      });
      if (draftIdeaId) {
        useUIStore.getState().clearDraftIdeaId();
      }

      // Subscribe to the new session's live topic before publishing the
      // first message — otherwise the daemon's acp.event + message.created
      // can arrive before the reactive per-rows subscribe catches up.
      sessionFlowLog("session_create.subscribe_live.begin", {
        teamId: teamIdForSend,
        sessionId,
      });
      await ensureSessionLiveSubscribed(teamIdForSend, sessionId).catch((e) => {
        console.warn('[ChatPanel] live subscribe failed (non-fatal):', e);
      });
      sessionFlowLog("session_create.subscribe_live.ok", {
        teamId: teamIdForSend,
        sessionId,
      });

      // Refresh session-list-store so the new row appears in the sidebar
      // and sendIntoSession can find it by id.
      sessionFlowLog("session_create.session_list_reload.begin", {
        teamId: teamIdForSend,
        sessionId,
      });
      await useSessionListStore.getState().load();
      sessionFlowLog("session_create.session_list_reload.ok", {
        teamId: teamIdForSend,
        sessionId,
        rowCount: useSessionListStore.getState().rows.length,
      });
      useSessionStore.getState().addHighlightedSession(sessionId);
      sessionFlowLog("session_create.switch.begin", {
        sessionId,
      });
      await useUIStore.getState().switchToSession(sessionId);
      sessionFlowLog("session_create.switch.ok", {
        sessionId,
      });

      // Auto-engage + auto-mention ONLY when there's exactly one agent
      // (no members). Anything more ambiguous leaves the dock empty and
      // routes to the user.
      const soleAgent =
        picks.members.length === 0 && picks.agents.length === 1
          ? picks.agents[0]
          : null;
      if (soleAgent) {
        useEngagedAgentStore.getState().setAgents(sessionId, [soleAgent]);
      }
      const autoMentionAgents: AttachedAgent[] = soleAgent ? [soleAgent] : [];
      await sendIntoSession(sessionId, firstMessage, autoMentionAgents);

      // Fire-and-forget runtime spawn — UI has already moved into the
      // session; status dots update via RuntimeInfo subscriptions.
      if (picks.agents.length > 0) {
        sessionFlowLog("session_create.runtime_start.begin", {
          teamId: teamIdForSend,
          sessionId,
          agentActorIds: agentIds,
        });
        void import("@/lib/teamclaw/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
          void ensureAgentRuntimesForSession({
            sessionId,
            teamId: teamIdForSend,
            agentActorIds: agentIds,
            modelId: selectedModelKey ?? undefined,
            reason: "session_create",
          });
        });
      }
    } catch (e) {
      sessionFlowError("session_create.failed", e, {
        teamId: teamIdForSend,
      });
      console.error('[ChatPanel] session creation failed:', e);
      const { toast } = await import('sonner');
      toast.error(t('chat.newSessionPicker.createError', 'Failed to create session'));
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

  const handleStartDraftSession = React.useCallback(async () => {
    if (welcomeSessionStarting || !draftPreselectedActor) return;
    setWelcomeSessionStarting(true);
    try {
      const actor = draftPreselectedActor;
      const created = await createQuickEmptySession({
        additionalActorIds: [actor.id],
        titleName: actor.displayName,
        engagedAgent:
          actor.kind === 'agent'
            ? { id: actor.id, displayName: actor.displayName }
            : null,
        agentActorIdsForRuntime: actor.kind === 'agent' ? [actor.id] : [],
        runtimeReason: 'actor_draft_start',
      });
      if (!created) {
        toast.error(t('chat.newSessionPicker.createError', 'Failed to create session'));
        return;
      }
      try {
        localStorage.removeItem(`teamclaw-actor-draft:${actor.id}`);
      } catch {
        /* localStorage disabled */
      }
    } catch (e) {
      console.error('[ChatPanel] actor draft start failed', e);
      toast.error(t('chat.newSessionPicker.createError', 'Failed to create session'));
    } finally {
      setWelcomeSessionStarting(false);
    }
  }, [draftPreselectedActor, t, welcomeSessionStarting]);

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

  const handlePrefillComposer = React.useCallback((text: string) => {
    setInputValue(text);
    useUIStore.getState().requestComposerFocus();
  }, [setInputValue]);

  const emptyState = React.useMemo(() => {
    if (activeSessionId) {
      if (compact) {
        return null;
      }
      return (
        <SessionEmptyThreadState
          sessionId={activeSessionId}
          onPrefillComposer={handlePrefillComposer}
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
              ? t('chat.draftWithAgentHint', '点击下方开始与该 Agent 的新会话')
              : t('chat.draftWithMemberHint', '点击下方开始与该成员的新会话')}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-4 bg-coral text-white hover:bg-coral/90"
            disabled={welcomeSessionStarting}
            onClick={() => void handleStartDraftSession()}
          >
            {welcomeSessionStarting ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t('chat.draftStartConversation', '开始对话')}
          </Button>
          <SessionContinueBanner
            actorId={draftPreselectedActor.id}
            actorName={draftPreselectedActor.displayName}
          />
        </div>
      );
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
    handleStartDraftSession,
    handleStartLocalAgentSession,
    handleLocalAgentQuickAction,
    handleOpenAgentSettings,
    activeSessionId,
    handlePrefillComposer,
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
      ) : !isViewingChild && activeSessionId && (
        activeInputQuestion ? (
          <QuestionInputDock
            compact={compact}
            pendingQuestion={activeInputQuestion}
            onHeightChange={handleInputHeightChange}
            bottomOffsetPx={terminalBottomOffset}
          />
        ) : (
          <>
            {activeSessionId ? (
              <div className="shrink-0 px-3 pt-2">
                <RuntimeRefreshSessionHint />
              </div>
            ) : null}
            <ChatInputArea
            activeSessionId={activeSessionId}
            compact={compact}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            attachedFiles={attachedFiles}
            onFilesChange={handleFilesChange}
            onRemoveFile={removeFile}
            engagedAgents={engagedAgents}
            engagedUiEntries={engagedUiEntries}
            agentToRuntimeId={agentToRuntimeId}
            agentToBackendType={agentToBackendType}
            localDaemonAgent={localDaemonAgent}
            onSwitchToLocalAgent={handleSwitchToLocalAgent}
            onRetryOfflineAgents={handleRetryOfflineAgents}
            onEngageAgent={(a) => {
              if (!activeSessionId) {
                void import("sonner").then(({ toast }) => {
                  toast.info(t("chat.toast.sendFirstToCreateSession", "请先发送一条消息创建会话"), {
                    description: t(
                      "chat.toast.mentionNeedsOpenSession",
                      "@ Agent 需要在已打开的会话中使用。",
                    ),
                  });
                });
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
            activeStreamingAgents={activeStreamingAgents}
            onInterruptAgent={handleInterruptAgent}
            imageFiles={imageFiles}
            onImageFilesChange={handleImageFilesChange}
            onRemoveImageFile={removeImageFile}
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
        )
      )}

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
