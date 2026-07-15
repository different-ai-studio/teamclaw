/**
 * useDesktopNotifications — boots the desktop notification dispatcher once the
 * authenticated user-id is available, then exposes it via getDispatcher() so
 * any call-site (e.g. the MQTT ingress in App.tsx) can call maybeNotify()
 * without a React hook boundary.
 *
 * Store keys used (discovered 2026-05-17):
 *   AuthStore:         session?.user?.id  (Supabase auth user UUID)
 *   SessionListStore:  rows[]  ({ id: string, … }) — scoped to current actor's sessions
 *   SessionStore:      currentSessionId  (v2 native active session)
 *   ActorsStore:       byId[actorId].displayName
 *
 * currentActorId is passed from App.tsx (resolved via Supabase actors query during
 * MQTT connect) because no existing store persists it at module scope.
 */
import { useEffect, useRef } from 'react';
import { isTauri } from '@/lib/utils';
import { ensurePermission } from '@/lib/notifications/desktop-notifier';
import { createDispatcher, type Dispatcher } from '@/lib/notifications/message-dispatcher';
import { loadPrefs, isInDndWindow, isSessionMuted } from '@/lib/notifications/preferences';
import { useAuthStore } from '@/stores/auth-store';
import { useSessionListStore } from '@/stores/session-list-store';
import { useSessionStore } from '@/stores/session-store';
import { useActorsStore } from '@/stores/actors-store';

/** Module-scope singleton so non-React ingress code can call it. */
let activeDispatcher: Dispatcher | null = null;

/** Returns the active dispatcher, or null if not yet initialised or permission denied. */
export function getDispatcher(): Dispatcher | null {
  return activeDispatcher;
}

/**
 * Boot-time hook — call once from App.tsx after auth + MQTT setup.
 *
 * @param currentActorId  The actor-table `id` for the signed-in user in the
 *   current team.  Resolved in App.tsx via
 *   `SELECT id FROM actors WHERE user_id = $userId AND team_id = $teamId`.
 *   Pass `null` until the query resolves; the effect re-runs when it arrives.
 *
 * Idempotency: ranRef prevents double-init when deps haven't changed.
 * Sign-out: userId → null clears the dispatcher and resets the init flag.
 */
export function useDesktopNotifications(currentActorId: string | null = null) {
  const userId = useAuthStore((s) => s.session?.user?.id ?? null);
  const ranRef = useRef(false);

  // Clear dispatcher on sign-out so stale user context is never used.
  useEffect(() => {
    if (!userId) {
      activeDispatcher = null;
      ranRef.current = false;
    }
  }, [userId]);

  useEffect(() => {
    if (!isTauri() || !userId || ranRef.current) return;
    ranRef.current = true;

    // Capture both at creation time to avoid stale closures.
    const capturedUserId = userId;
    const capturedActorId = currentActorId;

    void (async () => {
      const granted = await ensurePermission();
      if (!granted) return;

      const prefs = await loadPrefs(capturedUserId);
      if (!prefs.enabled) return;

      activeDispatcher = createDispatcher({
        // currentActorId may be null if the actors query hasn't returned yet.
        // The dispatcher skips notification when currentActorId is null (safe).
        currentActorId: capturedActorId,

        isParticipant: async (sid) => {
          // list_current_actor_sessions RPC already scopes rows to the actor's
          // sessions, so membership check is a simple in-memory lookup.
          const rows = useSessionListStore.getState().rows;
          return rows.some((r) => r.id === sid);
        },

        isSessionMuted: (sid) => isSessionMuted(capturedUserId, sid),

        inDnd: () => isInDndWindow(prefs, new Date()),

        isCurrentlyViewing: (sid) => {
          // SessionStore uses currentSessionId (v2 native); falls back to
          // activeSessionId in the Phase-1E compat shim.
          const state = useSessionStore.getState();
          const activeSid =
            state.currentSessionId ??
            (state as { activeSessionId?: string | null }).activeSessionId ??
            null;
          return activeSid === sid;
        },

        hasFocus: () => typeof document !== 'undefined' && document.hasFocus(),

        getActorDisplayName: async (aid) => {
          const actor = useActorsStore.getState().get(aid);
          return actor?.displayName ?? aid;
        },
      });
    })();
  // Re-run when userId or currentActorId changes (e.g. team switch).
  // ranRef ensures we don't init twice for the same (userId, actorId) pair.
  }, [userId, currentActorId]);
}
