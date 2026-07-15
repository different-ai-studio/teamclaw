import type { Session } from './session-types';

// Session lookup cache - provides O(1) lookup performance instead of O(n) array search
// This significantly improves performance when there are many sessions (e.g., 100+)
// Exported so streaming.ts can directly mutate for perf (avoids sessions.map in hot path)
export const sessionLookupCache = new Map<string, Session>();

// Update the lookup cache when sessions change
// Call this after any operation that modifies the sessions array
export const updateSessionCache = (sessions: Session[]) => {
  sessionLookupCache.clear();
  sessions.forEach((s) => sessionLookupCache.set(s.id, s));
};

// O(1) session lookup helper - uses cache for fast lookups
// Exported so streaming.ts can use it for O(1) lookups
export const getSessionById = (id: string): Session | undefined => {
  return sessionLookupCache.get(id);
};

// UI-level pagination: how many sessions to show initially and per "load more" click
export const UI_PAGE_SIZE = 50;
