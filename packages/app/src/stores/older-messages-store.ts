import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { upsertMessagesBatch, loadMessagesForSession } from "@/lib/local-cache";
import { historyRowsToMessageRows } from "@/lib/message-history-map";
import { messageRowsToProto } from "@/lib/session-export/collect";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionListStore } from "@/stores/session-list-store";

/** Matches the server default; also the size of each "load older" step. */
export const MESSAGE_PAGE_SIZE = 50;

type OlderMessagesState = {
  /**
   * Per-session cursor into history older than what has been fetched, or null
   * when the start of the session has been reached. Absent means "not known
   * yet" — the session's first page has not landed.
   */
  cursorBySession: Record<string, string | null>;
  loadingBySession: Record<string, boolean>;

  /** Called by the history loader once the newest page lands. */
  setCursor: (sessionId: string, cursor: string | null) => void;
  /** Drop per-session state, e.g. when a session is closed. */
  reset: (sessionId: string) => void;
  /**
   * Fetch the next-older page, merge it into the local cache, and refresh the
   * in-memory timeline. No-op when there is nothing older or a fetch is
   * already in flight.
   */
  loadOlder: (sessionId: string) => Promise<void>;
};

export const useOlderMessagesStore = create<OlderMessagesState>((set, get) => ({
  cursorBySession: {},
  loadingBySession: {},

  setCursor(sessionId, cursor) {
    set((s) => ({ cursorBySession: { ...s.cursorBySession, [sessionId]: cursor } }));
  },

  reset(sessionId) {
    set((s) => {
      const cursorBySession = { ...s.cursorBySession };
      const loadingBySession = { ...s.loadingBySession };
      delete cursorBySession[sessionId];
      delete loadingBySession[sessionId];
      return { cursorBySession, loadingBySession };
    });
  },

  async loadOlder(sessionId) {
    const cursor = get().cursorBySession[sessionId];
    if (!cursor || get().loadingBySession[sessionId]) return;

    set((s) => ({ loadingBySession: { ...s.loadingBySession, [sessionId]: true } }));
    try {
      const page = await getBackend().messages.listMessagePage(sessionId, {
        limit: MESSAGE_PAGE_SIZE,
        cursor,
      });

      const teamId =
        useSessionListStore.getState().rows.find((r) => r.id === sessionId)?.team_id ?? "";
      // Write through the same cache the timeline reads from, so older rows
      // survive a session switch and a restart rather than being re-fetched.
      await upsertMessagesBatch(
        historyRowsToMessageRows(page.rows, { teamId, origin: getBackend().kind }),
      );
      const fresh = await loadMessagesForSession(sessionId, false);
      useSessionMessageStore.getState().setMessages(sessionId, messageRowsToProto(fresh));

      set((s) => ({ cursorBySession: { ...s.cursorBySession, [sessionId]: page.nextCursor } }));
    } catch (error) {
      // Keep the cursor so the user can retry. The timeline is untouched, so a
      // failure costs nothing visible beyond the spinner stopping.
      console.warn(
        "[older-messages] load failed:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      set((s) => ({ loadingBySession: { ...s.loadingBySession, [sessionId]: false } }));
    }
  },
}));
