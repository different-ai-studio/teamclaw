import AsyncStorage from "@react-native-async-storage/async-storage";

import type { SessionMessage, SessionSummary } from "./session-types";

const SESSION_PREFIX = "teamclaw.sessionDetail.v1.session.";
const MESSAGES_PREFIX = "teamclaw.sessionDetail.v1.messages.";

function sessionKey(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

function messagesKey(sessionId: string): string {
  return `${MESSAGES_PREFIX}${sessionId}`;
}

export type SessionDetailCacheEntry = {
  session: SessionSummary;
  messages: SessionMessage[];
};

export type SessionDetailCache = {
  load: (sessionId: string) => Promise<SessionDetailCacheEntry | null>;
  save: (sessionId: string, entry: SessionDetailCacheEntry) => Promise<void>;
  saveMessages: (sessionId: string, messages: SessionMessage[]) => Promise<void>;
  clear: (sessionId: string) => Promise<void>;
};

/**
 * AsyncStorage-backed cache for an individual session's metadata + message
 * timeline. Mirrors iOS's SwiftData detail-screen hydration — load instantly
 * from disk, then let the network refresh overlay on top.
 *
 * Per-session timelines are clamped to the most recent 200 messages to keep
 * write costs reasonable. Older history reloads from Supabase when the user
 * scrolls back.
 */
const MAX_CACHED_MESSAGES = 200;

export function createSessionDetailCache(): SessionDetailCache {
  return {
    async load(sessionId) {
      if (!sessionId) return null;
      try {
        const [rawSession, rawMessages] = await Promise.all([
          AsyncStorage.getItem(sessionKey(sessionId)),
          AsyncStorage.getItem(messagesKey(sessionId)),
        ]);
        if (!rawSession) return null;
        const session = JSON.parse(rawSession) as SessionSummary;
        const messages = rawMessages
          ? (JSON.parse(rawMessages) as SessionMessage[])
          : [];
        if (!Array.isArray(messages)) return { session, messages: [] };
        return { session, messages };
      } catch {
        return null;
      }
    },
    async save(sessionId, entry) {
      if (!sessionId) return;
      try {
        const tail = entry.messages.slice(-MAX_CACHED_MESSAGES);
        await Promise.all([
          AsyncStorage.setItem(sessionKey(sessionId), JSON.stringify(entry.session)),
          AsyncStorage.setItem(messagesKey(sessionId), JSON.stringify(tail)),
        ]);
      } catch {
        // best-effort
      }
    },
    async saveMessages(sessionId, messages) {
      if (!sessionId) return;
      try {
        const tail = messages.slice(-MAX_CACHED_MESSAGES);
        await AsyncStorage.setItem(messagesKey(sessionId), JSON.stringify(tail));
      } catch {
        // best-effort
      }
    },
    async clear(sessionId) {
      if (!sessionId) return;
      try {
        await Promise.all([
          AsyncStorage.removeItem(sessionKey(sessionId)),
          AsyncStorage.removeItem(messagesKey(sessionId)),
        ]);
      } catch {
        // ignore
      }
    },
  };
}
