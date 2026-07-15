import AsyncStorage from "@react-native-async-storage/async-storage";

import type { SessionSummary } from "./session-types";

const STORAGE_PREFIX = "teamclaw.sessionsCache.v1.";

function storageKey(teamId: string): string {
  return `${STORAGE_PREFIX}${teamId}`;
}

export type SessionsCache = {
  load: (teamId: string) => Promise<SessionSummary[] | null>;
  save: (teamId: string, sessions: SessionSummary[]) => Promise<void>;
  clear: (teamId: string) => Promise<void>;
};

/**
 * AsyncStorage-backed cache for the sessions list. iOS reads its
 * sessions instantly from SwiftData on cold start; this gives the Expo
 * client an equivalent first-paint by hydrating from disk while the
 * network fetch is in flight.
 *
 * Cached values are clamped to ~200 sessions per team to keep
 * AsyncStorage writes cheap. Older entries fall off the bottom.
 */
const MAX_CACHED_SESSIONS = 200;

export function createSessionsCache(): SessionsCache {
  return {
    async load(teamId) {
      if (!teamId) return null;
      try {
        const raw = await AsyncStorage.getItem(storageKey(teamId));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed as SessionSummary[];
      } catch {
        return null;
      }
    },
    async save(teamId, sessions) {
      if (!teamId) return;
      try {
        const head = sessions.slice(0, MAX_CACHED_SESSIONS);
        await AsyncStorage.setItem(storageKey(teamId), JSON.stringify(head));
      } catch {
        // best-effort — cache is a hint, never a source of truth
      }
    },
    async clear(teamId) {
      if (!teamId) return;
      try {
        await AsyncStorage.removeItem(storageKey(teamId));
      } catch {
        // ignore
      }
    },
  };
}
