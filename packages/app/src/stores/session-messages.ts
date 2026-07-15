import { create as createProtoMessage, toBinary } from "@bufbuild/protobuf";
import { mqttPublish } from "@/lib/mqtt-bridge";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
} from "@/lib/proto/teamclaw_pb";
import { getBackend } from "@/lib/backend";
import { resolveCurrentMemberActorId } from "@/lib/current-actor";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useSessionListStore } from "@/stores/session-list-store";
import type { SendMessageFilePart } from "./session-types";
import type {
  Message,
  QueuedMessage,
  SessionState,
} from "./session-types";
import type { SearchResult } from "@/stores/knowledge";
import { updateSessionCache } from "./session-cache";
import { clearMessageTimeout } from "./session-internals";
import {
  useStreamingStore,
  cleanupAllChildSessions,
} from "@/stores/streaming";
import { trackEvent } from "@/lib/analytics";
import { insertMessageSorted } from "@/lib/insert-message-sorted";
import { isAgentActorType } from "@/lib/actor-type";
import {
  resolvePendingPermissionActivityOwner,
  resolvePendingQuestionActivityOwner,
} from "@/lib/session-list-activity";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

async function resolveMentionActorIdsForSession(
  sessionId: string,
  engagedAgentId: string | null,
): Promise<string[]> {
  if (engagedAgentId) return [engagedAgentId];

  // Honor an explicit "Remove mention" — see matching guard in ChatPanel's
  // copy of this resolver. Without it the sole-agent fallback below would
  // silently re-engage the agent the user just unpinned.
  if (useEngagedAgentStore.getState().wasExplicitlyCleared[sessionId]) {
    return [];
  }

  let participants: Array<{ id: string; actor_type?: string | null }>;
  try {
    participants = await getBackend().sessionMembers.listParticipants(sessionId);
  } catch (participantError) {
    console.warn("[SendMessage] failed to load session participants:", participantError);
    return [];
  }

  const agents = participants.filter((row) => isAgentActorType(row.actor_type));

  // Sole-agent send fallback — see ChatPanel.resolveMentionActorIdsForSession.
  // Multi-person sessions still route to the sole agent here; only open-time
  // pill auto-engage is restricted to solo pairs (isSoloAgentSession).
  return agents.length === 1
    ? [agents[0].id]
    : [];
}

export function createMessageActions(set: SessionSet, get: SessionGet) {
  async function ensureDaemonSessionForSend(content: string): Promise<string | null> {
    const existing = get().activeSessionId;
    if (existing) return existing;

    const authSession = useAuthStore.getState().session;
    const currentTeam = useCurrentTeamStore.getState().team;
    const currentMember = useCurrentTeamStore.getState().currentMember;
    if (!authSession || !currentTeam?.id) return null;

    const creatorActorId = await resolveCurrentMemberActorId(
      currentTeam.id,
      authSession.user.id,
      {
        currentTeamId: currentTeam.id,
        currentMemberId: currentMember?.id ?? null,
      },
    );
    if (!creatorActorId) {
      throw new Error(`No member actor found for team ${currentTeam.id}`);
    }

    const agentRows = (await getBackend().actors.listActorDirectory(currentTeam.id))
      .filter((row) => row.actor_type === "agent")
      .slice(0, 2);

    const soleAgent =
      (agentRows ?? []).length === 1
        ? agentRows[0]
        : null;

    const { createSessionShell } = await import("@/lib/session-create");
    const { sessionId } = await createSessionShell({
      teamId: currentTeam.id,
      creatorActorId,
      title: content.trim().slice(0, 80) || "New chat",
      additionalActorIds: soleAgent ? [soleAgent.id] : [],
    });

    await useSessionListStore.getState().load();
    set({
      activeSessionId: sessionId,
      currentSessionId: sessionId,
      isLoading: false,
    } as Partial<SessionState>);

    if (soleAgent) {
      useEngagedAgentStore.getState().setAgents(sessionId, [{
        id: soleAgent.id,
        displayName: soleAgent.display_name || "AI",
      }]);
    }

    return sessionId;
  }

  async function sendViaDaemon(
    sessionId: string,
    content: string,
    userMessage: Message,
  ): Promise<void> {
    const authSession = useAuthStore.getState().session;
    if (!authSession) throw new Error("No authenticated user session");

    let teamId =
      useSessionListStore.getState().rows.find((row) => row.id === sessionId)?.team_id ?? null;
    if (!teamId) {
      teamId = await getBackend().sessions.getSessionTeamId(sessionId);
    }
    if (!teamId) throw new Error(`No team_id found for session ${sessionId}`);

    const currentTeam = useCurrentTeamStore.getState().team;
    const currentMember = useCurrentTeamStore.getState().currentMember;
    const senderActorId = await resolveCurrentMemberActorId(
      teamId,
      authSession.user.id,
      {
        currentTeamId: currentTeam?.id ?? null,
        currentMemberId: currentMember?.id ?? null,
      },
    );
    if (!senderActorId) {
      throw new Error(`No actor found for user in team ${teamId}`);
    }

    const engagedAgent = useEngagedAgentStore.getState().get(sessionId);
    const mentionActorIds = await resolveMentionActorIdsForSession(
      sessionId,
      engagedAgent?.id ?? null,
    );
    const messageId = crypto.randomUUID();
    const createdAt = BigInt(Math.floor(Date.now() / 1000));
    const selectedModel = get().selectedModel;
    const messageModel = selectedModel?.modelID ?? "";

    const protoMessage = createProtoMessage(MessageSchema, {
      messageId,
      sessionId,
      senderActorId,
      kind: MessageKind.TEXT,
      content,
      createdAt,
      model: messageModel,
    });
    const sessionEnvelope = createProtoMessage(SessionMessageEnvelopeSchema, {
      message: protoMessage,
      mentionActorIds,
    });
    const liveEnvelope = createProtoMessage(LiveEventEnvelopeSchema, {
      eventId: crypto.randomUUID(),
      eventType: "message.created",
      sessionId,
      actorId: senderActorId,
      sentAt: createdAt,
      body: toBinary(SessionMessageEnvelopeSchema, sessionEnvelope),
    });

    await getBackend().messages.insertOutgoingMessage({
      id: messageId,
      teamId,
      sessionId,
      senderActorId,
      kind: "text",
      content,
      model: messageModel || null,
      metadata: { mention_actor_ids: mentionActorIds },
    });

    await mqttPublish(
      `amux/${teamId}/session/${sessionId}/live`,
      toBinary(LiveEventEnvelopeSchema, liveEnvelope),
      false,
    );

    (get() as any).appendMessage(sessionId, protoMessage);
    set((state) => {
      const newSessions = state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              messages: insertMessageSorted(session.messages, userMessage),
              title:
                session.messages.length === 0
                  ? content.slice(0, 50) + (content.length > 50 ? "..." : "")
                  : session.title,
              updatedAt: new Date(),
            }
          : session,
      );
      updateSessionCache(newSessions);
      return {
        sessions: newSessions,
        sessionError: null,
      };
    });
  }

  return {
    // RAG V2: Auto-inject knowledge from pre-inference search
    autoInjectKnowledge: async (userMessage: string): Promise<{ context?: string; chunks?: SearchResult[] }> => {
      try {
        const { useKnowledgeStore } = await import('./knowledge')
        const config = useKnowledgeStore.getState().config

        if (!config || !config.autoInjectEnabled) {
          return {}
        }

        const topK = config.autoInjectTopK
        const minScore = config.autoInjectThreshold
        const maxTokens = config.autoInjectMaxTokens

        console.log('[RAG Auto-Inject] Searching with:', { topK, minScore, maxTokens })

        const searchForAutoInject = useKnowledgeStore.getState().searchForAutoInject
        const results = await searchForAutoInject(userMessage, topK, minScore)

        if (results.length === 0) {
          console.log('[RAG Auto-Inject] No results above threshold, skipping injection')
          return {}
        }

        console.log(`[RAG Auto-Inject] Found ${results.length} results above threshold`)

        const contextLines: string[] = [
          '## \u76f8\u5173\u77e5\u8bc6\u5e93\u5185\u5bb9',
          '',
          '\u4ee5\u4e0b\u662f\u4ece\u77e5\u8bc6\u5e93\u4e2d\u68c0\u7d22\u5230\u7684\u76f8\u5173\u4fe1\u606f\uff0c\u8bf7\u53c2\u8003\u8fd9\u4e9b\u5185\u5bb9\u56de\u7b54\u7528\u6237\u95ee\u9898\uff1a',
          '',
        ]

        let estimatedTokens = contextLines.join('\n').length / 4
        const includedChunks: SearchResult[] = []

        for (let i = 0; i < results.length; i++) {
          const result = results[i]
          const chunk = [
            `### \u7247\u6bb5 ${i + 1} (\u6765\u6e90: ${result.source}, \u76f8\u4f3c\u5ea6: ${result.score.toFixed(2)})`,
            result.heading ? `**\u7ae0\u8282**: ${result.heading}` : '',
            '',
            result.content,
            '',
          ].filter(Boolean).join('\n')

          const chunkTokens = chunk.length / 4

          if (estimatedTokens + chunkTokens > maxTokens) {
            console.log(`[RAG Auto-Inject] Reached token limit (${maxTokens}), stopping at ${i} chunks`)
            break
          }

          contextLines.push(chunk)
          estimatedTokens += chunkTokens
          includedChunks.push(result)
        }

        const injectedContext = contextLines.join('\n')
        console.log(`[RAG Auto-Inject] Injected ${estimatedTokens.toFixed(0)} tokens from ${includedChunks.length} chunks`)

        return {
          context: injectedContext,
          chunks: includedChunks
        }
      } catch (error) {
        console.error('[RAG Auto-Inject] Failed:', error)
        return {}
      }
    },

    // Send a message to the active session (auto-creates Cloud session if needed)
    sendMessage: async (content: string, _agent?: string, imageParts?: SendMessageFilePart[]) => {
      if (!content.trim() && (!imageParts || imageParts.length === 0)) return;

      const activeSessionId = await ensureDaemonSessionForSend(content);
      if (!activeSessionId) {
        console.error("[Session] No active session and could not create Cloud session");
        return;
      }

      const { streamingMessageId } = useStreamingStore.getState();
      const { messageQueue: currentQueue } = get();
      console.log("[SendMessage] entry:", {
        streamingMessageId,
        queueLength: currentQueue.length,
        content: content.trim().slice(0, 30),
      });

      if (streamingMessageId) {
        console.log("[SendMessage] QUEUED (streamingMessageId is set):", streamingMessageId);
        const queuedMessage: QueuedMessage = {
          id: `queue-${Date.now()}`,
          content: content.trim(),
          timestamp: new Date(),
        };
        set((state) => ({
          messageQueue: [...state.messageQueue, queuedMessage],
        }));
        return;
      }

      if (imageParts && imageParts.length > 0) {
        console.warn("[SendMessage] Image attachments require ChatPanel outbox path; skipping legacy send");
        return;
      }

      trackEvent("message_sent");

      const now = Date.now();
      const userMessage: Message = {
        id: `temp-user-${now}`,
        sessionId: activeSessionId,
        role: "user",
        content: content.trim(),
        parts: [{ id: `part-${now}`, type: "text", content: content.trim() }],
        timestamp: new Date(now),
      };

      try {
        await sendViaDaemon(activeSessionId, content.trim(), userMessage);
      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : "Failed to send message",
          errorSessionId: activeSessionId,
        });
      }
    },

    // Abort the current session's operation
    abortSession: async () => {
      const { activeSessionId } = get();
      if (!activeSessionId) return;
      const { streamingMessageId, childSessionStreaming } = useStreamingStore.getState();
      const childSessionIds = Object.entries(childSessionStreaming || {})
        .filter(([, state]) => state.isStreaming)
        .map(([sessionId]) => sessionId);
      const abortedSessionIds = new Set([activeSessionId, ...childSessionIds]);
      const removeAbortedPendingInteractions = (state: SessionState) => ({
        pendingQuestions: state.pendingQuestions.filter((question) => {
          const owner = resolvePendingQuestionActivityOwner(question, state.sessions, activeSessionId);
          return !owner || !abortedSessionIds.has(owner);
        }),
        pendingPermissions: state.pendingPermissions.filter((entry) => {
          const owner = resolvePendingPermissionActivityOwner(entry, state.sessions, activeSessionId);
          return (
            (!owner || !abortedSessionIds.has(owner)) &&
            (!entry.childSessionId || !abortedSessionIds.has(entry.childSessionId)) &&
            (!entry.permission.sessionID || !abortedSessionIds.has(entry.permission.sessionID))
          );
        }),
      });

      try {
        clearMessageTimeout();
        const { interruptAllActiveAgents } = await import("@/lib/teamclaw/interrupt-agent");
        await interruptAllActiveAgents(activeSessionId);

        useStreamingStore.getState().clearStreaming();
        cleanupAllChildSessions();
        set((state) => ({
          ...removeAbortedPendingInteractions(state),
          sessionError: null,
          sessions: state.sessions.map((s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.isStreaming || m.id === streamingMessageId
                ? { ...m, isStreaming: false }
                : m,
            ),
          })),
        }));

        setTimeout(() => {
          const { messageQueue, sendMessage: send } = get();
          if (messageQueue.length > 0) {
            const nextMessage = messageQueue[0];
            set((state) => ({
              messageQueue: state.messageQueue.slice(1),
            }));
            send(nextMessage.content);
          }
        }, 500);
      } catch (error) {
        useStreamingStore.getState().clearStreaming();
        cleanupAllChildSessions();
        set({
          error:
            error instanceof Error ? error.message : "Failed to abort session",
        });
      }
    },

    // Remove a message from the queue
    removeFromQueue: (id: string) => {
      set((state) => ({
        messageQueue: state.messageQueue.filter((m) => m.id !== id),
      }));
    },

    // Reload messages for the active session from the v2 message store
    reloadActiveSessionMessages: async () => {
      const { useSessionMessageStore } = await import("./session-message-store");
      await useSessionMessageStore.getState().reloadActiveSessionMessages();
    },
  };
}
