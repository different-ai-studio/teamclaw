import { create, toBinary } from "@bufbuild/protobuf";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
  type Message,
  type LiveEventEnvelope,
} from "@teamclaw/app/proto/teamclaw_pb";
import {
  AgentStatus,
  type AcpEvent,
  type AcpPlanEntry,
} from "@teamclaw/app/proto/amux_pb";

import { decodeLiveEvent } from "../../lib/teamclaw/live-events";
import type { TeamMqttClient } from "../../lib/mqtt/team-mqtt";
import { uuidV4 } from "../../lib/uuid";
import type { Actor } from "../actors/actor-types";
import { setOutboxStatus, syncOutboxFromDao } from "./outbox-store";
import type { OutboxDao } from "./outbox-db";
import type { OutboxSender } from "./outbox-sender";
import { peekPendingAttachments, takePendingAttachments } from "./pending-attachments";
import { resolveMentionActorIdsForComposer } from "./session-mention-resolver";
import type { SessionDetailCache } from "./session-detail-cache";
import {
  buildSessionDetailState,
  type SessionDetailState,
  type SessionMessage,
  type SessionSummary,
  type StreamingBuffer,
  type TimelineEvent,
} from "./session-types";
import { reduceTimeline, emptyTimelineState, type TimelineState } from "./timeline-reducer";
import type { createCloudSessionsApi } from "./cloud-api";

export type SessionDetailConnectionState = "connecting" | "connected" | "disconnected";

export type SessionDetailControllerState = {
  status: SessionDetailState["status"];
  session: SessionSummary | null;
  messages: SessionMessage[];
  errorMessage: string | null;
  connectionState: SessionDetailConnectionState;
  composerText: string;
  isSending: boolean;
  isRefreshing: boolean;
  sendErrorMessage: string | null;
  replyTarget: { messageId: string; content: string } | null;
  streamingByAgent: ReadonlyMap<string, StreamingBuffer>;
  /**
   * Cursor for the next-older page, or null when there is no more history to
   * fetch. The server returns only the most recent 50 messages, so anything
   * before that has to be pulled in explicitly via `loadOlder`.
   */
  olderCursor: string | null;
  isLoadingOlder: boolean;
};

type SessionsApi = ReturnType<typeof createCloudSessionsApi>;

type SessionDetailControllerDeps = {
  api: Pick<
    SessionsApi,
    | "getSession"
    | "insertOutgoingMessage"
    | "listMessages"
    | "markSessionRead"
    | "resolveMemberActorId"
  > &
    // Optional so cache-only / test doubles that implement just `listMessages`
    // stay valid: without it there is simply no older history to page into.
    Partial<Pick<SessionsApi, "listMessagePage">>;
  currentMemberActorId: string | null;
  getAuth: () => Promise<{ accessToken: string | null; userId: string | null }>;
  getTeamActors?: () => ReadonlyArray<Actor>;
  mqtt: Pick<TeamMqttClient, "subscribe" | "publish" | "onConnectionState">;
  mqttUrl: string | null;
  sessionId: string;
  teamId: string;
  cache?: SessionDetailCache;
  outbox?: { sender: OutboxSender; dao: OutboxDao };
};

type SessionDetailController = {
  subscribe: (listener: () => void) => () => void;
  getState: () => SessionDetailControllerState;
  load: (options?: { preserveExisting?: boolean }) => Promise<void>;
  /**
   * Pull the next-older page of history and merge it in. No-op when there is
   * nothing older (`state.olderCursor === null`) or a fetch is already in
   * flight. The timeline reducer inserts sorted, so ordering takes care of
   * itself.
   */
  loadOlder: () => Promise<void>;
  setComposerText: (value: string) => void;
  setReplyTarget: (target: { messageId: string; content: string } | null) => void;
  sendMessage: () => Promise<void>;
  dispose: () => Promise<void>;
};

/** Matches the server default; also the size of each "load older" step. */
const MESSAGE_PAGE_SIZE = 50;

const initialState: SessionDetailControllerState = {
  status: "loading",
  session: null,
  messages: [],
  errorMessage: null,
  connectionState: "disconnected",
  composerText: "",
  isSending: false,
  isRefreshing: false,
  sendErrorMessage: null,
  replyTarget: null,
  streamingByAgent: emptyTimelineState().streamingByAgent,
  olderCursor: null,
  isLoadingOlder: false,
};

function toIsoFromSeconds(value: bigint): string {
  return new Date(Number(value) * 1000).toISOString();
}

function liveEventCreatedAt(envelope: LiveEventEnvelope): string {
  return envelope.sentAt > BigInt(0)
    ? toIsoFromSeconds(envelope.sentAt)
    : new Date().toISOString();
}

function kindToString(kind: MessageKind): string {
  switch (kind) {
    case MessageKind.SYSTEM:
      return "system";
    case MessageKind.AGENT_THINKING:
      return "agent_thinking";
    case MessageKind.AGENT_TOOL_CALL:
      return "agent_tool_call";
    case MessageKind.AGENT_TOOL_RESULT:
      return "agent_tool_result";
    case MessageKind.AGENT_REPLY:
      return "agent_reply";
    case MessageKind.TEXT:
    default:
      return "text";
  }
}

function mapProtoMessage(message: Message, teamId: string): SessionMessage | null {
  if (!message.messageId || !message.sessionId) {
    return null;
  }

  return {
    content: message.content ?? "",
    createdAt: toIsoFromSeconds(message.createdAt),
    kind: kindToString(message.kind),
    messageId: message.messageId,
    metadata: null,
    model: message.model ?? "",
    replyToMessageId: message.replyToMessageId ?? "",
    senderActorId: message.senderActorId ?? "",
    sessionId: message.sessionId,
    teamId,
    turnId: message.turnId ?? "",
  };
}

function runtimeMessageId(
  envelope: LiveEventEnvelope,
  actorId: string,
  eventCase: string,
): string {
  const eventId = envelope.eventId || `${envelope.sentAt.toString()}:${eventCase}`;
  return `acp:${envelope.sessionId}:${actorId}:${eventId}`;
}

function planStatusPrefix(status: string): string {
  switch (status) {
    case "completed":
      return "[done]";
    case "in_progress":
      return "[wip]";
    case "cancelled":
      return "[cancelled]";
    case "pending":
    default:
      return "[todo]";
  }
}

function planUpdateText(entries: readonly AcpPlanEntry[]): string {
  return entries
    .map((entry) => `${planStatusPrefix(entry.status)} ${entry.content.trim()}`.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function createRuntimeMessage(input: {
  actorId: string;
  content: string;
  createdAt: string;
  envelope: LiveEventEnvelope;
  kind: string;
  metadata?: Record<string, unknown> | null;
  model?: string;
  teamId: string;
}): SessionMessage {
  return {
    content: input.content,
    createdAt: input.createdAt,
    kind: input.kind,
    messageId: runtimeMessageId(input.envelope, input.actorId, input.kind),
    metadata: input.metadata ?? null,
    model: input.model ?? "",
    replyToMessageId: "",
    senderActorId: input.actorId,
    sessionId: input.envelope.sessionId || "",
    teamId: input.teamId,
    turnId: "",
  };
}

function runtimeMessageFromAcpEvent(
  acpEvent: AcpEvent,
  envelope: LiveEventEnvelope,
  actorId: string,
  teamId: string,
): SessionMessage | null {
  const event = acpEvent.event;
  const createdAt = liveEventCreatedAt(envelope);
  switch (event.case) {
    case "thinking": {
      const content = event.value.text;
      if (!content) return null;
      return createRuntimeMessage({
        actorId,
        content,
        createdAt,
        envelope,
        kind: "agent_thinking",
        model: acpEvent.model,
        teamId,
      });
    }
    case "toolUse": {
      const params = event.value.params ?? {};
      const paramsText = Object.entries(params)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
      const content = [
        event.value.toolName || "Tool",
        event.value.description,
        paramsText ? `(${paramsText})` : "",
      ].filter(Boolean).join(" ");
      return createRuntimeMessage({
        actorId,
        content,
        createdAt,
        envelope,
        kind: "agent_tool_call",
        metadata: {
          tool_id: event.value.toolId,
          tool_kind: event.value.toolKind,
          tool_name: event.value.toolName,
          params,
        },
        teamId,
      });
    }
    case "toolResult": {
      return createRuntimeMessage({
        actorId,
        content: event.value.summary || (event.value.success ? "Tool completed" : "Tool failed"),
        createdAt,
        envelope,
        kind: "agent_tool_result",
        metadata: {
          success: event.value.success,
          tool_id: event.value.toolId,
        },
        teamId,
      });
    }
    case "error": {
      const content = [event.value.message, event.value.details].filter(Boolean).join("\n\n");
      return createRuntimeMessage({
        actorId,
        content: content || "Agent error",
        createdAt,
        envelope,
        kind: "agent_error",
        teamId,
      });
    }
    case "permissionRequest": {
      return createRuntimeMessage({
        actorId,
        content: event.value.description,
        createdAt,
        envelope,
        kind: "permission_request",
        metadata: {
          params: event.value.params ?? {},
          request_id: event.value.requestId,
          tool_id: event.value.requestId,
          tool_name: event.value.toolName,
        },
        teamId,
      });
    }
    case "planUpdate": {
      const content = planUpdateText(event.value.entries);
      if (!content) return null;
      return createRuntimeMessage({
        actorId,
        content,
        createdAt,
        envelope,
        kind: "plan_update",
        teamId,
      });
    }
    default:
      return null;
  }
}

function nextStatusForMessages(
  session: SessionSummary | null,
  messages: SessionMessage[],
  fallback: SessionDetailControllerState["status"],
): SessionDetailControllerState["status"] {
  if (!session) {
    return fallback;
  }

  return messages.length > 0 ? "ready" : "empty";
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function timelineFromMessages(
  messages: readonly SessionMessage[],
  streamingByAgent: ReadonlyMap<string, StreamingBuffer> = new Map(),
): TimelineState {
  let next: TimelineState = {
    messages: [],
    streamingByAgent: new Map(streamingByAgent),
  };
  for (const message of messages) {
    next = reduceTimeline(next, { kind: "messageCommitted", message });
  }
  return next;
}

export function createSessionDetailController(
  deps: SessionDetailControllerDeps,
): SessionDetailController {
  const listeners = new Set<() => void>();
  let state = initialState;
  let timeline: TimelineState = emptyTimelineState();
  let disposed = false;
  let unsubscribeSession: (() => void) | null = null;
  let cleanupConnectionStateListener: (() => void) | null = null;
  let loadToken = 0;
  /** Held outside `state` so a reload can reset it before the first setState. */
  let olderCursor: string | null = null;
  let loadingOlder = false;
  /**
   * Whether `olderCursor` has been established for the current load generation.
   *
   * `connectRealtime` re-fetches the newest page to catch up, and it also runs
   * on every reconnect. Without this guard that catch-up would overwrite the
   * cursor — throwing away however far back the user had paged, and re-offering
   * "load older" for history already on screen (or after it had been
   * exhausted). Only the first fetch of a generation gets to set it.
   */
  let olderCursorInitialized = false;

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  /**
   * The newest page of history, plus a cursor into whatever is older.
   *
   * Falls back to the unpaged `listMessages` when the dependency does not
   * provide `listMessagePage` — cache-only sources and test doubles hand back
   * everything they have at once, so there is nothing older to page into and a
   * null cursor is the honest answer.
   */
  async function fetchNewestPage(): Promise<{
    messages: SessionMessage[];
    nextCursor: string | null;
  }> {
    if (deps.api.listMessagePage) {
      return deps.api.listMessagePage(deps.teamId, deps.sessionId, { limit: MESSAGE_PAGE_SIZE });
    }
    return {
      messages: await deps.api.listMessages(deps.teamId, deps.sessionId),
      nextCursor: null,
    };
  }

  function setState(nextState: SessionDetailControllerState) {
    state = nextState;
    emit();
  }

  function disconnectRealtime() {
    cleanupConnectionStateListener?.();
    cleanupConnectionStateListener = null;
    unsubscribeSession?.();
    unsubscribeSession = null;
  }

  async function resolveSenderActorId(): Promise<string> {
    if (deps.currentMemberActorId) {
      return deps.currentMemberActorId;
    }

    const auth = await deps.getAuth();
    if (!auth.userId) {
      throw new Error("无法读取当前用户信息。");
    }

    const resolved = await deps.api.resolveMemberActorId(deps.teamId, auth.userId);
    if (!resolved) {
      throw new Error("无法解析当前团队里的成员身份。");
    }

    return resolved;
  }

  function publishTimelineState(next: TimelineState) {
    timeline = next;
    setState({
      ...state,
      messages: next.messages,
      streamingByAgent: next.streamingByAgent,
      status: nextStatusForMessages(state.session, next.messages, state.status),
    });
  }

  function applyAcpEvent(acpEvent: AcpEvent, envelope: LiveEventEnvelope): boolean {
    const actorId = envelope.actorId;
    if (!actorId) return false;

    const event = acpEvent.event;
    const createdAt = liveEventCreatedAt(envelope);
    let next: TimelineState | null = null;

    if (event.case === "output") {
      const prev = timeline.streamingByAgent.get(actorId);
      const text = event.value.text ?? "";
      if (!prev && !text && !event.value.isComplete) {
        return false;
      }
      next = reduceTimeline(timeline, {
        kind: "streamingDelta",
        agentId: actorId,
        messageId: prev?.messageId ?? runtimeMessageId(envelope, actorId, "agent_reply"),
        messageKind: "agent_reply",
        deltaText: text,
        createdAt,
        isComplete: event.value.isComplete,
        model: acpEvent.model,
      });
    } else if (event.case === "statusChange") {
      if (event.value.newStatus !== AgentStatus.IDLE) {
        return false;
      }
      const prev = timeline.streamingByAgent.get(actorId);
      if (!prev || prev.isComplete) {
        return false;
      }
      next = reduceTimeline(timeline, {
        kind: "streamingDelta",
        agentId: actorId,
        messageId: prev.messageId,
        messageKind: prev.kind,
        deltaText: "",
        createdAt,
        isComplete: true,
        model: prev.model,
      });
    } else {
      const message = runtimeMessageFromAcpEvent(
        acpEvent,
        envelope,
        actorId,
        deps.teamId,
      );
      if (!message) {
        return false;
      }
      next = reduceTimeline(timeline, { kind: "messageCommitted", message });
    }

    if (next === timeline) {
      return false;
    }
    publishTimelineState(next);
    return true;
  }

  async function connectRealtime(_session: SessionSummary, currentToken: number) {
    if (disposed || currentToken !== loadToken) {
      return;
    }

    try {
      cleanupConnectionStateListener = deps.mqtt.onConnectionState((connectionState) => {
        if (disposed || currentToken !== loadToken) {
          return;
        }

        setState({
          ...state,
          connectionState,
        });
      });

      const topic = `amux/${deps.teamId}/session/${deps.sessionId}/live`;
      unsubscribeSession = deps.mqtt.subscribe(topic, (payload) => {
        if (disposed || currentToken !== loadToken) {
          return;
        }

        const decoded = decodeLiveEvent(payload);
        if (!decoded) {
          return;
        }

        if (decoded.acpEvent) {
          applyAcpEvent(decoded.acpEvent, decoded.envelope);
          return;
        }

        if (!decoded.message) {
          return;
        }

        const nextMessage = mapProtoMessage(decoded.message, deps.teamId);
        if (!nextMessage) {
          return;
        }

        const event: TimelineEvent = { kind: "messageCommitted", message: nextMessage };
        const next = reduceTimeline(timeline, event);
        publishTimelineState(next);
        void deps.cache?.saveMessages(deps.sessionId, next.messages);

        // Live-update the read marker so the Sessions list stays clean
        // while the detail screen is open. We pass the senderActorId
        // through so a future receipts UI can resolve "who's read up
        // to where" without an extra lookup.
        if (
          deps.currentMemberActorId &&
          nextMessage.senderActorId !== deps.currentMemberActorId
        ) {
          void deps.api
            .markSessionRead(deps.sessionId, deps.currentMemberActorId, nextMessage.messageId)
            .catch(() => {
              // best-effort
            });
        }
      });

      const latestPage = await fetchNewestPage();

      if (disposed || currentToken !== loadToken) {
        disconnectRealtime();
        return;
      }

      if (!olderCursorInitialized) {
        olderCursor = latestPage.nextCursor;
        olderCursorInitialized = true;
      }
      let next = timeline;
      for (const m of latestPage.messages) {
        next = reduceTimeline(next, { kind: "messageCommitted", message: m });
      }
      timeline = next;

      setState({
        ...state,
        connectionState: "connected",
        messages: next.messages,
        streamingByAgent: next.streamingByAgent,
        status: nextStatusForMessages(state.session, next.messages, state.status),
        olderCursor,
      });
    } catch (error) {
      if (disposed || currentToken !== loadToken) {
        return;
      }

      console.warn(
        "MQTT realtime connect failed",
        error instanceof Error ? error.message : error,
      );
      setState({
        ...state,
        connectionState: "disconnected",
        sendErrorMessage: state.sendErrorMessage,
      });
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState() {
      return state;
    },
    async loadOlder() {
      // Nothing older, no pager, or a fetch already running.
      if (!olderCursor || loadingOlder || !deps.api.listMessagePage) return;

      loadingOlder = true;
      const cursor = olderCursor;
      const tokenAtStart = loadToken;
      setState({ ...state, isLoadingOlder: true });

      try {
        const page = await deps.api.listMessagePage(deps.teamId, deps.sessionId, {
          limit: MESSAGE_PAGE_SIZE,
          cursor,
        });
        // A reload (or dispose) raced us — its fresher timeline and cursor win.
        if (disposed || loadToken !== tokenAtStart) return;

        let next = timeline;
        for (const m of page.messages) {
          next = reduceTimeline(next, { kind: "messageCommitted", message: m });
        }
        timeline = next;
        olderCursor = page.nextCursor;

        setState({
          ...state,
          messages: timeline.messages,
          streamingByAgent: timeline.streamingByAgent,
          olderCursor,
          isLoadingOlder: false,
        });
      } catch {
        // Keep the cursor so the user can retry; just stop the spinner. The
        // existing timeline is untouched, so a failure costs nothing visible.
        if (disposed || loadToken !== tokenAtStart) return;
        setState({ ...state, isLoadingOlder: false });
      } finally {
        loadingOlder = false;
      }
    },
    async load(options) {
      loadToken += 1;
      const currentToken = loadToken;
      olderCursor = null;
      olderCursorInitialized = false;
      const preserveExisting = options?.preserveExisting === true && state.session !== null;
      disconnectRealtime();

      if (preserveExisting) {
        setState({
          ...state,
          connectionState: "connecting",
          errorMessage: null,
          isRefreshing: true,
          sendErrorMessage: null,
        });
      } else {
        timeline = emptyTimelineState();
        setState({
          ...state,
          status: "loading",
          session: null,
          messages: [],
          errorMessage: null,
          connectionState: "disconnected",
          isRefreshing: false,
          sendErrorMessage: null,
          streamingByAgent: timeline.streamingByAgent,
        });
      }

      deps.outbox?.sender.start();

      // Hydrate from disk first so the user sees the timeline immediately on
      // cold start. The network results below overlay on top once they land.
      if (deps.cache && !preserveExisting) {
        void deps.cache.load(deps.sessionId).then((cached) => {
          if (disposed || currentToken !== loadToken || !cached) return;
          if (state.session) return; // network beat the disk read
          timeline = timelineFromMessages(cached.messages);
          const detailState = buildSessionDetailState(cached.session, cached.messages);
          setState({
            ...state,
            status: detailState.status,
            session: cached.session,
            messages: detailState.messages,
            errorMessage: null,
            streamingByAgent: timeline.streamingByAgent,
          });
        });
      }

      const [sessionResult, messagesResult] = await Promise.allSettled([
        deps.api.getSession(deps.teamId, deps.sessionId),
        fetchNewestPage(),
      ]);

      if (disposed || currentToken !== loadToken) {
        return;
      }

      if (sessionResult.status === "rejected") {
        // If cached rows already paint, keep them and surface the network
        // error inline rather than blanking the screen.
        if (state.session) {
          setState({
            ...state,
            status: "error",
            errorMessage: toErrorMessage(sessionResult.reason, "加载会话失败。"),
            isRefreshing: false,
          });
        } else {
          setState({
            ...state,
            status: "error",
            errorMessage: toErrorMessage(sessionResult.reason, "加载会话失败。"),
            isRefreshing: false,
          });
        }
        return;
      }

      const session = sessionResult.value;
      if (!session) {
        timeline = emptyTimelineState();
        setState({
          ...state,
          status: "not-found",
          session: null,
          messages: [],
          isRefreshing: false,
          streamingByAgent: timeline.streamingByAgent,
        });
        return;
      }

      if (messagesResult.status === "rejected") {
        setState({
          ...state,
          status: "error",
          session,
          messages: state.messages,
          errorMessage: toErrorMessage(messagesResult.reason, "加载消息失败。"),
          isRefreshing: false,
        });
        await connectRealtime(session, currentToken);
        return;
      }

      olderCursor = messagesResult.value.nextCursor;
      olderCursorInitialized = true;
      timeline = timelineFromMessages(
        messagesResult.value.messages,
        preserveExisting ? timeline.streamingByAgent : undefined,
      );
      const detailState = buildSessionDetailState(session, timeline.messages);
      setState({
        ...state,
        status: detailState.status,
        session,
        messages: detailState.messages,
        errorMessage: null,
        isRefreshing: preserveExisting,
        streamingByAgent: timeline.streamingByAgent,
        olderCursor,
        isLoadingOlder: false,
      });

      // Persist authoritative network state for the next cold start.
      void deps.cache?.save(deps.sessionId, {
        session,
        messages: detailState.messages,
      });

      await connectRealtime(session, currentToken);
      if (!disposed && currentToken === loadToken && state.isRefreshing) {
        setState({
          ...state,
          isRefreshing: false,
        });
      }
    },
    setComposerText(value) {
      setState({
        ...state,
        composerText: value,
        sendErrorMessage: null,
      });
    },
    setReplyTarget(target) {
      setState({
        ...state,
        replyTarget: target,
      });
    },
    async sendMessage() {
      const content = state.composerText.trim();
      const session = state.session;

      if (!session) {
        return;
      }

      const hasPendingAttachments =
        peekPendingAttachments(deps.teamId, deps.sessionId).length > 0;
      if (!content && !hasPendingAttachments) {
        return;
      }

      if (state.connectionState !== "connected") {
        setState({
          ...state,
          sendErrorMessage:
            state.connectionState === "connecting"
              ? "实时连接准备中，请稍后再试。"
              : "实时连接暂时不可用，仍可稍后重试发送。",
        });
        return;
      }

      setState({
        ...state,
        isSending: true,
        sendErrorMessage: null,
      });

      let outboxMessageId: string | null = null;
      try {
        const auth = await deps.getAuth();
        if (!auth.accessToken) {
          throw new Error("实时连接暂时不可用，仍可稍后重试发送。");
        }

        const actorId = await resolveSenderActorId();
        const createdAt = new Date().toISOString();
        const createdAtSeconds = BigInt(Math.floor(Date.parse(createdAt) / 1000));
        const messageId = uuidV4();
        outboxMessageId = messageId;
        setOutboxStatus(messageId, "sending");

        const pendingAttachments = takePendingAttachments(deps.teamId, deps.sessionId);
        const attachmentsPayload = pendingAttachments.length > 0
          ? pendingAttachments.map((row) => ({
              url: row.publicUrl || row.path,
              path: row.path,
              mime: row.mime,
              size: row.size,
            }))
          : undefined;

        const replyTo = state.replyTarget?.messageId ?? null;
        const mentionActorIds = resolveMentionActorIdsForComposer({
          content,
          session,
          teamActors: deps.getTeamActors?.() ?? [],
        });

        await deps.api.insertOutgoingMessage({
          id: messageId,
          teamId: deps.teamId,
          sessionId: deps.sessionId,
          senderActorId: actorId,
          content,
          createdAt,
          metadata: { mention_actor_ids: mentionActorIds },
          attachments: attachmentsPayload,
          replyToMessageId: replyTo,
        });

        const optimisticMessage: SessionMessage = {
          content,
          createdAt,
          kind: "text",
          messageId,
          metadata: { mention_actor_ids: mentionActorIds },
          model: "",
          replyToMessageId: replyTo ?? "",
          senderActorId: actorId,
          sessionId: deps.sessionId,
          teamId: deps.teamId,
          turnId: "",
          attachments: attachmentsPayload,
        };

        const optimisticNext = reduceTimeline(timeline, { kind: "messageCommitted", message: optimisticMessage });
        timeline = optimisticNext;
        const mergedMessages = optimisticNext.messages;
        setState({
          ...state,
          composerText: "",
          messages: mergedMessages,
          streamingByAgent: optimisticNext.streamingByAgent,
          replyTarget: null,
          status: nextStatusForMessages(session, mergedMessages, state.status),
        });

        if (deps.outbox) {
          await deps.outbox.sender.enqueue({
            messageId,
            sessionId: deps.sessionId,
            teamId: deps.teamId,
            senderActorId: actorId,
            content,
            mentionActorIds,
            replyToMessageId: replyTo,
            attachments: pendingAttachments.map((row) => ({
              url: row.publicUrl || row.path,
              path: row.path,
              mime: row.mime,
              size: row.size,
            })),
            createdAt: Date.parse(createdAt),
          });
          await syncOutboxFromDao(deps.outbox.dao, [messageId]);
        } else {
          // Fallback path (existing inline publish)
          const protoMessage = create(MessageSchema, {
            messageId,
            sessionId: deps.sessionId,
            senderActorId: actorId,
            kind: MessageKind.TEXT,
            content,
            createdAt: createdAtSeconds,
          });
          const sessionMessage = create(SessionMessageEnvelopeSchema, {
            message: protoMessage,
            mentionActorIds,
          });
          const envelope = create(LiveEventEnvelopeSchema, {
            eventId: uuidV4(),
            eventType: "message.created",
            sessionId: deps.sessionId,
            actorId,
            sentAt: createdAtSeconds,
            body: toBinary(SessionMessageEnvelopeSchema, sessionMessage),
          });

          try {
            await deps.mqtt.publish(
              `amux/${deps.teamId}/session/${deps.sessionId}/live`,
              toBinary(LiveEventEnvelopeSchema, envelope),
              false,
            );
          } catch {
            setOutboxStatus(messageId, "failed");
            setState({
              ...state,
              messages: mergedMessages,
              streamingByAgent: optimisticNext.streamingByAgent,
              status: nextStatusForMessages(session, mergedMessages, state.status),
              composerText: "",
              isSending: false,
              sendErrorMessage: "消息已写入，但实时分发失败，请稍后刷新确认。",
            });
            return;
          }
        }

        setOutboxStatus(messageId, "sent");
        setState({
          ...state,
          messages: mergedMessages,
          streamingByAgent: optimisticNext.streamingByAgent,
          status: nextStatusForMessages(session, mergedMessages, state.status),
          composerText: "",
          isSending: false,
          sendErrorMessage: null,
        });
      } catch (error) {
        if (outboxMessageId) {
          setOutboxStatus(outboxMessageId, "failed");
        }
        setState({
          ...state,
          isSending: false,
          sendErrorMessage: toErrorMessage(error, "发送失败。"),
        });
      }
    },
    async dispose() {
      disposed = true;
      deps.outbox?.sender.stop();
      disconnectRealtime();
      setState({
        ...state,
        connectionState: "disconnected",
      });
    },
  };
}
