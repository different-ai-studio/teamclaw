import { create } from "zustand";
import type { ChildStreamingState } from "@/stores/session-types";
import { sessionLookupCache, getSessionById } from "@/stores/session-cache";
import { useSessionStore } from "@/stores/session";
import {
  clearAllChildSessions,
} from "@/lib/opencode/sse";

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
    set({ streamingMessageId: messageId, streamingContent: content ?? "", streamingUpdateTrigger: 0 });
  },

  clearStreaming: () => {
    // CRITICAL: Also clear typewriter buffers to prevent orphaned content
    // If we only clear store state but leave buffer with content, handleMessageCompleted
    // will keep deferring indefinitely (buffer has content but typewriter won't run)
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
export const CHARS_PER_FRAME = 3;

export let textBuffer = "";
export let reasoningBuffers: Map<string, string> = new Map(); // partId -> unrevealed chars
export let rafId: number | null = null;

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
  const oldLength = textBuffer.length;
  textBuffer += delta;
  console.log("[Typewriter] appendTextBuffer:", {
    deltaLength: delta.length,
    oldBufferLength: oldLength,
    newBufferLength: textBuffer.length,
  });
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

  console.log("[Typewriter] Tick:", {
    streamingMessageId,
    activeSessionId,
    textBufferLength: textBuffer.length,
    reasoningBufferCount: reasoningBuffers.size,
  });

  if (!streamingMessageId || !activeSessionId) {
    console.log("[Typewriter] No streaming, clearing buffers");
    textBuffer = "";
    reasoningBuffers.clear();
    rafId = null;
    return;
  }

  const session = getSessionById(activeSessionId);
  if (!session) { textBuffer = ""; reasoningBuffers.clear(); rafId = null; return; }

  const msgIndex = session.messages.findIndex((m) => m.id === streamingMessageId);
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
  const textChars = hasReasoningChars ? 0 : Math.min(CHARS_PER_FRAME, textBuffer.length);

  console.log("[Typewriter] Processing:", {
    textChars,
    hasReasoningChars,
    remainingTextBuffer: textBuffer.length,
    reasoningBufferCount: reasoningBuffers.size,
  });

  if (textChars === 0 && !hasReasoningChars) {
    console.log("[Typewriter] No chars to reveal, stopping tick");
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
    console.log("[Typewriter] Revealed text chunk:", {
      chunkLength: chunk.length,
      totalRevealedLength: revealedText.length,
      remainingBuffer: textBuffer.length,
    });
  }

  // Reveal reasoning chars (same rate per part)
  if (hasReasoningChars) {
    let parts = [...msg.parts];
    for (const [partId, buf] of reasoningBuffers) {
      if (buf.length === 0) continue;
      const chars = Math.min(CHARS_PER_FRAME, buf.length);
      const chunk = buf.slice(0, chars);
      reasoningBuffers.set(partId, buf.slice(chars));

      const idx = parts.findIndex((p) => p.id === partId);
      if (idx !== -1) {
        const existingText = parts[idx].text || "";
        parts = parts.map((p, i) =>
          i === idx
            ? { ...p, text: existingText + chunk, content: existingText + chunk }
            : p,
        );
      } else {
        parts = [...parts, { id: partId, type: "reasoning", text: chunk, content: chunk }];
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

  // Only update the streaming message, preserve all other messages
  const updatedMessages = latestSession.messages.map((m) =>
    m.id === streamingMessageId ? msg : m
  );

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

  console.log("[Typewriter] After reveal:", {
    anyRemaining,
    textBufferLength: textBuffer.length,
    willContinue: anyRemaining,
  });

  if (anyRemaining) {
    rafId = requestAnimationFrame(typewriterTick);
  } else {
    console.log("[Typewriter] All content revealed, stopping");
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

  const msgIndex = session.messages.findIndex((m) => m.id === streamingMessageId);
  if (msgIndex === -1) { textBuffer = ""; reasoningBuffers.clear(); return ""; }

  let msg = { ...session.messages[msgIndex] };

  // Flush text buffer to streamingContent (for display), NOT to msg.content
  let finalStreamingContent = streamingContent;
  if (textBuffer) {
    finalStreamingContent = finalStreamingContent + textBuffer;
    textBuffer = "";
    console.log("[FlushBuffer] Flushed text buffer to streamingContent:", finalStreamingContent.length, "chars");
  }

  // Flush reasoning buffers to parts (for display in thinking blocks)
  if (reasoningBuffers.size > 0) {
    let parts = [...msg.parts];
    for (const [partId, buf] of reasoningBuffers) {
      if (buf.length === 0) continue;
      const idx = parts.findIndex((p) => p.id === partId);
      if (idx !== -1) {
        const existingText = parts[idx].text || "";
        parts = parts.map((p, i) =>
          i === idx
            ? { ...p, text: existingText + buf, content: existingText + buf }
            : p,
        );
      } else {
        parts = [...parts, { id: partId, type: "reasoning", text: buf, content: buf }];
      }
    }
    msg = { ...msg, parts };
    reasoningBuffers.clear();
    console.log("[FlushBuffer] Flushed reasoning buffers to parts");
  }

  // CRITICAL: Re-fetch session to get latest state before final write
  const latestSession = getSessionById(activeSessionId);
  if (!latestSession) return finalStreamingContent;

  // Only update the streaming message's parts (for reasoning), preserve all other messages
  const updatedMessages = latestSession.messages.map((m) =>
    m.id === streamingMessageId ? msg : m
  );

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
    console.log("[Typewriter] Scheduled typewriter tick (bufferLength:", textBuffer.length, ")");
  } else {
    console.log("[Typewriter] Already scheduled, skipping");
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

  // Clear permission if it belongs to this child session (lifecycle binding)
  const sessionState = useSessionStore.getState();
  if (sessionState.pendingPermissionChildSessionId === sessionId) {
    useSessionStore.setState({
      pendingPermission: null,
      pendingPermissionChildSessionId: null,
    });
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
