import { create } from "zustand";
import type { ChildStreamingState } from "@/stores/session-types";
import { sessionLookupCache, getSessionById } from "@/stores/session-cache";
import { useSessionStore } from "@/stores/session";
import {
  clearAllChildSessions,
} from "@/lib/opencode/sdk-sse";

// Re-export for convenience
export type { ChildStreamingState };

export interface StreamingState {
  streamingMessageId: string | null;
  streamingContent: string;
  streamingUpdateTrigger: number;
  childSessionStreaming: Record<string, ChildStreamingState>;

  // Actions
  setStreaming: (messageId: string, content?: string) => void;
  clearStreaming: () => void;
  setChildStreaming: (sessionId: string, state: ChildStreamingState) => void;
  updateChildStreaming: (sessionId: string, updates: Partial<ChildStreamingState>) => void;
  clearChildStreaming: (sessionId: string) => void;
  clearAllChildStreaming: () => void;
}

export const useStreamingStore = create<StreamingState>((set) => ({
  streamingMessageId: null,
  streamingContent: "",
  streamingUpdateTrigger: 0,
  childSessionStreaming: {},

  setStreaming: (messageId: string, content?: string) => {
    invalidateStreamingMsgIndex();
    set({ streamingMessageId: messageId, streamingContent: content ?? "", streamingUpdateTrigger: 0 });
  },

  clearStreaming: () => {
    // CRITICAL: Also clear typewriter buffers to prevent orphaned content
    // If we only clear store state but leave buffer with content, handleMessageCompleted
    // will keep deferring indefinitely (buffer has content but typewriter won't run)
    invalidateStreamingMsgIndex();
    clearTypewriterBuffers();
    set({ streamingMessageId: null, streamingContent: "", streamingUpdateTrigger: 0 });
  },

  setChildStreaming: (sessionId: string, state: ChildStreamingState) => {
    set((s) => ({
      childSessionStreaming: {
        ...s.childSessionStreaming,
        [sessionId]: state,
      },
    }));
  },

  updateChildStreaming: (sessionId: string, updates: Partial<ChildStreamingState>) => {
    set((s) => {
      const entry = s.childSessionStreaming[sessionId];
      if (!entry) return s;
      return {
        childSessionStreaming: {
          ...s.childSessionStreaming,
          [sessionId]: { ...entry, ...updates },
        },
      };
    });
  },

  clearChildStreaming: (sessionId: string) => {
    set((s) => {
      const entry = s.childSessionStreaming[sessionId];
      if (!entry) return s;
      return {
        childSessionStreaming: {
          ...s.childSessionStreaming,
          [sessionId]: { ...entry, isStreaming: false },
        },
      };
    });
  },

  clearAllChildStreaming: () => {
    set({ childSessionStreaming: {} });
  },
}));

// --- Module-level variables (moved from session.ts) ---

// Adaptive typewriter speed:
// - BASE_CHARS: minimum chars per frame (smooth typing feel at low throughput)
// - When buffer grows past CATCHUP_THRESHOLD, reveal extra chars proportional to backlog
//   so the UI never falls more than ~0.5s behind the real stream.
// At 60fps: base alone = 180 chars/s. With 500-char buffer: 3 + 500*0.05 = 28 chars/frame = 1680 chars/s.
const BASE_CHARS_PER_FRAME = 3;
const CATCHUP_THRESHOLD = 120;   // buffer chars before catchup kicks in (~0.67s at base rate)
const CATCHUP_RATIO = 0.05;      // fraction of excess buffer to drain per frame

/** Compute how many chars to reveal this frame, adapting to buffer backlog. */
function adaptiveCharsPerFrame(bufferLen: number): number {
  if (bufferLen <= CATCHUP_THRESHOLD) return Math.min(BASE_CHARS_PER_FRAME, bufferLen);
  const excess = bufferLen - CATCHUP_THRESHOLD;
  return Math.min(bufferLen, Math.ceil(BASE_CHARS_PER_FRAME + excess * CATCHUP_RATIO));
}

// Keep the old export name for tests / external references
export const CHARS_PER_FRAME = BASE_CHARS_PER_FRAME;

// Debug logging — off by default; enable via: localStorage.setItem('debug-streaming', '1')
const DEBUG = () => localStorage.getItem('debug-streaming') === '1';

export let textBuffer = "";
export const reasoningBuffers: Map<string, string> = new Map(); // partId -> unrevealed chars
export let rafId: number | null = null;

// --- Cached index for streaming message (avoids O(n) findIndex every frame) ---
let cachedMsgIndex = -1;
let cachedMsgIndexFor: string | null = null; // messageId this index is valid for
let cachedSessionIdFor: string | null = null; // sessionId this index is valid for

/** Resolve the index of the streaming message, using cache when possible. */
function getStreamingMsgIndex(
  messages: readonly { id: string }[],
  messageId: string,
  sessionId: string,
): number {
  // Cache hit: same message + session, and the index still points at the right element
  if (
    cachedMsgIndexFor === messageId &&
    cachedSessionIdFor === sessionId &&
    cachedMsgIndex >= 0 &&
    cachedMsgIndex < messages.length &&
    messages[cachedMsgIndex].id === messageId
  ) {
    return cachedMsgIndex;
  }
  // Cache miss: linear scan and update cache
  const idx = messages.findIndex((m) => m.id === messageId);
  cachedMsgIndex = idx;
  cachedMsgIndexFor = messageId;
  cachedSessionIdFor = sessionId;
  return idx;
}

/** Invalidate the cached index (call when streaming message changes). */
export function invalidateStreamingMsgIndex(): void {
  cachedMsgIndex = -1;
  cachedMsgIndexFor = null;
  cachedSessionIdFor = null;
}

// Clear all typewriter buffers and cancel pending rAF.
// Needed by session.ts when a final text snapshot arrives.
export const clearTypewriterBuffers = () => {
  textBuffer = "";
  reasoningBuffers.clear();
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
};

// Append text to the typewriter buffer (called from session.ts on text_delta)
export const appendTextBuffer = (delta: string) => {
  textBuffer += delta;
};

// Append reasoning to the typewriter buffer (called from session.ts on reasoning_delta)
export const appendReasoningBuffer = (partId: string, delta: string) => {
  const existing = reasoningBuffers.get(partId) || "";
  reasoningBuffers.set(partId, existing + delta);
};

// Check if there's buffered content waiting to be revealed
export const hasBufferedContent = (): boolean => {
  if (textBuffer.length > 0) return true;
  for (const buf of reasoningBuffers.values()) {
    if (buf.length > 0) return true;
  }
  return false;
};

export const childStreamingBuffers = new Map<string, { text: string; reasoning: string }>();
export const childPartTypes = new Map<string, string>(); // partId -> 'text' | 'reasoning'
export let childRafId: number | null = null;

// --- Typewriter tick ---
// KEY PERF CHANGE: updates streaming store's streamingContent and directly mutates
// sessionLookupCache for data consistency. Does NOT call sessions.map() on session store.
// CRITICAL: To prevent race conditions with concurrent message insertions (e.g., child session
// messages), we only update the specific streaming message, not the entire messages array.
export const typewriterTick = () => {
  const streamingState = useStreamingStore.getState();
  const { streamingMessageId } = streamingState;
  const { activeSessionId } = useSessionStore.getState();

  if (!streamingMessageId || !activeSessionId) {
    textBuffer = "";
    reasoningBuffers.clear();
    rafId = null;
    return;
  }

  const session = getSessionById(activeSessionId);
  if (!session) { textBuffer = ""; reasoningBuffers.clear(); rafId = null; return; }

  const msgIndex = getStreamingMsgIndex(session.messages, streamingMessageId, activeSessionId);
  if (msgIndex === -1) { textBuffer = ""; reasoningBuffers.clear(); rafId = null; return; }

  // CRITICAL ARCHITECTURE: Prioritize reasoning over text for sequential display
  // Phase 1: Reveal ALL reasoning parts first (thinking blocks)
  // Phase 2: Only after reasoning is empty, reveal text (message body)
  // This ensures user sees: thinking → (complete) → text, not mixed
  
  let hasReasoningChars = false;
  for (const buf of reasoningBuffers.values()) {
    if (buf.length > 0) { hasReasoningChars = true; break; }
  }

  // If reasoning buffer has content, ONLY reveal reasoning (skip text)
  // If reasoning buffer is empty, then reveal text
  const textChars = hasReasoningChars ? 0 : adaptiveCharsPerFrame(textBuffer.length);

  if (textChars === 0 && !hasReasoningChars) {
    rafId = null;
    return;
  }

  let msg = { ...session.messages[msgIndex] };

  // Reveal text chars (ONLY when reasoning is fully revealed)
  // CRITICAL: Build content ONLY from revealed buffer during streaming.
  // Do NOT append to msg.content, as that may contain stale snapshot data.
  // Instead, build streamingContent independently and let ChatMessage decide:
  // - Streaming: use streamingContent
  // - Completed: use msg.content (built from parts)
  let revealedText = streamingState.streamingContent || "";
  if (textChars > 0) {
    const chunk = textBuffer.slice(0, textChars);
    textBuffer = textBuffer.slice(textChars);
    revealedText = revealedText + chunk;
  }

  // Reveal reasoning chars (adaptive speed per part)
  if (hasReasoningChars) {
    const parts = msg.parts.slice(); // shallow copy once
    for (const [partId, buf] of reasoningBuffers) {
      if (buf.length === 0) continue;
      const chars = adaptiveCharsPerFrame(buf.length);
      const chunk = buf.slice(0, chars);
      reasoningBuffers.set(partId, buf.slice(chars));

      const idx = parts.findIndex((p) => p.id === partId);
      if (idx !== -1) {
        const existingText = parts[idx].text || "";
        parts[idx] = { ...parts[idx], text: existingText + chunk, content: existingText + chunk };
      } else {
        parts.push({ id: partId, type: "reasoning", text: chunk, content: chunk });
      }
    }
    msg = { ...msg, parts };
  }

  // CRITICAL FIX: Re-fetch session to get latest state (may include newly inserted child messages)
  // This prevents race condition where child message insertions get overwritten
  const latestSession = getSessionById(activeSessionId);
  if (!latestSession) {
    textBuffer = "";
    reasoningBuffers.clear();
    rafId = null;
    return;
  }

  // Only update the streaming message via direct index — O(1) instead of O(n) .map()
  const latestIdx = getStreamingMsgIndex(latestSession.messages, streamingMessageId, activeSessionId);
  if (latestIdx === -1) { rafId = null; return; }

  const updatedMessages = latestSession.messages.slice(); // shallow copy
  updatedMessages[latestIdx] = msg;

  const newSession = { ...latestSession, messages: updatedMessages };

  // Directly mutate sessionLookupCache for data consistency (no sessions.map())
  sessionLookupCache.set(activeSessionId, newSession);

  // Update streaming store with revealed text (NOT msg.content)
  // CRITICAL: streamingContent is built ONLY from delta buffer, independent of msg.content.
  // This ensures no duplication when parts snapshots update msg.content.
  const currentTrigger = useStreamingStore.getState().streamingUpdateTrigger;
  useStreamingStore.setState({ 
    streamingContent: revealedText,
    streamingUpdateTrigger: currentTrigger + 1,
  });

  // Check if any buffers still have content
  let anyRemaining = textBuffer.length > 0;
  if (!anyRemaining) {
    for (const buf of reasoningBuffers.values()) {
      if (buf.length > 0) { anyRemaining = true; break; }
    }
  }

  if (anyRemaining) {
    rafId = requestAnimationFrame(typewriterTick);
  } else {
    rafId = null;
  }
};

// --- Force-flush everything remaining in the buffer (used on message completion) ---
// CRITICAL ARCHITECTURE: This function flushes buffer content to streamingContent for final display.
// It does NOT update msg.content - that will be built from parts in handleMessageCompleted.
// Returns the fully revealed streaming content for display purposes only.
export const flushAllPending = (): string => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  const streamingState = useStreamingStore.getState();
  const { streamingMessageId, streamingContent } = streamingState;
  const { activeSessionId } = useSessionStore.getState();

  if (!streamingMessageId || !activeSessionId) {
    textBuffer = "";
    reasoningBuffers.clear();
    return "";
  }

  const session = getSessionById(activeSessionId);
  if (!session) { textBuffer = ""; reasoningBuffers.clear(); return ""; }

  const msgIndex = getStreamingMsgIndex(session.messages, streamingMessageId, activeSessionId);
  if (msgIndex === -1) { textBuffer = ""; reasoningBuffers.clear(); return ""; }

  let msg = { ...session.messages[msgIndex] };

  // Flush text buffer to streamingContent (for display), NOT to msg.content
  let finalStreamingContent = streamingContent;
  if (textBuffer) {
    finalStreamingContent = finalStreamingContent + textBuffer;
    textBuffer = "";
    if (DEBUG()) console.log("[FlushBuffer] Flushed text buffer:", finalStreamingContent.length, "chars");
  }

  // Flush reasoning buffers to parts (for display in thinking blocks)
  if (reasoningBuffers.size > 0) {
    const parts = msg.parts.slice(); // shallow copy once
    for (const [partId, buf] of reasoningBuffers) {
      if (buf.length === 0) continue;
      const idx = parts.findIndex((p) => p.id === partId);
      if (idx !== -1) {
        const existingText = parts[idx].text || "";
        parts[idx] = { ...parts[idx], text: existingText + buf, content: existingText + buf };
      } else {
        parts.push({ id: partId, type: "reasoning", text: buf, content: buf });
      }
    }
    msg = { ...msg, parts };
    reasoningBuffers.clear();
    if (DEBUG()) console.log("[FlushBuffer] Flushed reasoning buffers");
  }

  // CRITICAL: Re-fetch session to get latest state before final write
  const latestSession = getSessionById(activeSessionId);
  if (!latestSession) return finalStreamingContent;

  // Only update the streaming message via direct index — O(1) instead of O(n) .map()
  const latestIdx = getStreamingMsgIndex(latestSession.messages, streamingMessageId, activeSessionId);
  if (latestIdx === -1) return finalStreamingContent;

  const updatedMessages = latestSession.messages.slice();
  updatedMessages[latestIdx] = msg;

  const newSession = { ...latestSession, messages: updatedMessages };
  sessionLookupCache.set(activeSessionId, newSession);

  // Update streamingContent with fully flushed content and trigger scroll
  const currentTrigger = useStreamingStore.getState().streamingUpdateTrigger;
  useStreamingStore.setState({ 
    streamingContent: finalStreamingContent,
    streamingUpdateTrigger: currentTrigger + 1,
  });
  
  // Sync parts back to session store (reasoning blocks need this)
  useSessionStore.setState((store) => ({
    sessions: store.sessions.map((s) =>
      s.id === activeSessionId ? newSession : s,
    ),
  }));

  return finalStreamingContent;
};

export const scheduleTypewriter = () => {
  if (rafId === null) {
    rafId = requestAnimationFrame(typewriterTick);
  }
};

// --- Child session (subagent) streaming ---
export const flushChildStreaming = () => {
  childRafId = null;
  if (childStreamingBuffers.size === 0) return;

  useStreamingStore.setState((state) => {
    const updated = { ...state.childSessionStreaming };
    for (const [sessionId, buffer] of childStreamingBuffers) {
      const entry = updated[sessionId];
      if (entry) {
        updated[sessionId] = {
          ...entry,
          text: buffer.text,
          reasoning: buffer.reasoning,
        };
      }
    }
    return { childSessionStreaming: updated };
  });
};

export const scheduleChildStreamingFlush = () => {
  if (childRafId === null) {
    childRafId = requestAnimationFrame(flushChildStreaming);
  }
};

export const cleanupChildSession = (sessionId: string) => {
  // Don't unregister immediately - keep in childSessionIds for message.completed event
  // It will be cleared when parent session switches (via clearAllChildSessions)
  childStreamingBuffers.delete(sessionId);

  // Update streaming store
  useStreamingStore.getState().clearChildStreaming(sessionId);

  // Clean up permissions and questions belonging to this child session
  const sessionState = useSessionStore.getState();

  const hasPermissions = sessionState.pendingPermissions.some(
    (e) => e.childSessionId === sessionId,
  );
  if (hasPermissions) {
    useSessionStore.setState((state) => ({
      pendingPermissions: state.pendingPermissions.filter(
        (e) => e.childSessionId !== sessionId,
      ),
    }));
  }

  const hasQuestions = sessionState.pendingQuestions.some(
    (q) => q.sessionId === sessionId,
  );
  if (hasQuestions) {
    useSessionStore.setState((state) => ({
      pendingQuestions: state.pendingQuestions.filter(
        (q) => q.sessionId !== sessionId,
      ),
    }));
  }
};

export const cleanupAllChildSessions = () => {
  clearAllChildSessions();
  childStreamingBuffers.clear();
  childPartTypes.clear();
  if (childRafId !== null) {
    cancelAnimationFrame(childRafId);
    childRafId = null;
  }
  useStreamingStore.getState().clearAllChildStreaming();
};
