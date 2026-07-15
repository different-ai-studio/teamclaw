import type {
  SessionMessage,
  StreamingBuffer,
  TimelineEvent,
} from "./session-types";

export type TimelineState = {
  messages: SessionMessage[];
  streamingByAgent: Map<string, StreamingBuffer>;
};

export function emptyTimelineState(): TimelineState {
  return { messages: [], streamingByAgent: new Map() };
}

function timeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function insertSorted(messages: SessionMessage[], next: SessionMessage): SessionMessage[] {
  const idx = messages.findIndex((m) => m.messageId === next.messageId);
  if (idx >= 0) {
    if (next.content.length > messages[idx].content.length) {
      const out = messages.slice();
      out[idx] = next;
      return out;
    }
    return messages;
  }
  const out = [...messages, next];
  out.sort((a, b) => {
    const dt = timeValue(a.createdAt) - timeValue(b.createdAt);
    if (dt !== 0) return dt;
    return a.messageId.localeCompare(b.messageId);
  });
  return out;
}

function clearStreamingByMessageId(
  streamingByAgent: Map<string, StreamingBuffer>,
  message: SessionMessage,
): Map<string, StreamingBuffer> {
  let changed = false;
  const next = new Map(streamingByAgent);
  const kind = message.kind.trim().toLowerCase();
  const mayBeFinalReply = kind === "agent_reply" || kind === "text";
  for (const [agentId, buf] of next) {
    if (
      buf.messageId === message.messageId ||
      (mayBeFinalReply && agentId === message.senderActorId)
    ) {
      next.delete(agentId);
      changed = true;
    }
  }
  return changed ? next : streamingByAgent;
}

export function reduceTimeline(state: TimelineState, event: TimelineEvent): TimelineState {
  switch (event.kind) {
    case "messageCommitted": {
      const messages = insertSorted(state.messages, event.message);
      const streamingByAgent = clearStreamingByMessageId(
        state.streamingByAgent,
        event.message,
      );
      if (messages === state.messages && streamingByAgent === state.streamingByAgent) {
        return state;
      }
      return { messages, streamingByAgent };
    }
    case "streamingDelta": {
      const prev = state.streamingByAgent.get(event.agentId);
      const next: StreamingBuffer = prev && prev.messageId === event.messageId
        ? {
            ...prev,
            isComplete: event.isComplete ?? prev.isComplete,
            model: event.model || prev.model,
            text: prev.text + event.deltaText,
          }
        : {
            isComplete: event.isComplete,
            messageId: event.messageId,
            model: event.model,
            text: event.deltaText,
            kind: event.messageKind,
            startedAt: event.createdAt,
            senderActorId: event.agentId,
          };
      const streamingByAgent = new Map(state.streamingByAgent);
      streamingByAgent.set(event.agentId, next);
      return { ...state, streamingByAgent };
    }
    case "streamingDone": {
      if (!state.streamingByAgent.has(event.agentId)) return state;
      const streamingByAgent = new Map(state.streamingByAgent);
      streamingByAgent.delete(event.agentId);
      return { ...state, streamingByAgent };
    }
  }
}
