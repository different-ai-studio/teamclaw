import { create } from "zustand";

/**
 * `session_participants.model` — the authoritative answer to "which model is
 * this agent running on in this session" (ADR-0005, written by the daemon per
 * ADR-0007).
 *
 * # Why a store and not just a read
 *
 * `selectAgentModel` is synchronous and runs on every render of the agent pill
 * and on every send. It cannot await a fetch. So the value is fetched once per
 * session and cached here, and the resolver reads the cache.
 *
 * # Why this outranks the transcript scan
 *
 * `session-established-model` derives the same fact by scanning messages for
 * the newest one carrying a model. That works, but it is a reconstruction: it
 * depends on the transcript being loaded, on message `model` fields being
 * stamped, and on the "skip other agents' messages" heuristic holding. The
 * participant row is the fact itself, written by the only component that
 * observes what the runtime settled on. The scan stays as a fallback for the
 * window where a daemon has not yet shipped the write.
 *
 * # Why not fold this into `session-participant-store`
 *
 * That store answers "who is in this session" for the mention popover, and it
 * gets its rows from `sessionMembers.listParticipants` — the actor *directory*
 * (display name, avatar, actor type). The working-state columns are not on that
 * response at all, so folding this in would mean changing which endpoint the
 * mention roster depends on. Different question, different endpoint, kept apart.
 *
 * # Not persisted
 *
 * A cached model for a session the user has not opened since is worth nothing —
 * it is one request away, and a stale pin is exactly what this migration is
 * removing. Cleared on reload with the rest of memory.
 */

/** `${sessionId}::${actorId}` → model id. */
type Key = string;

function key(sessionId: string, actorId: string): Key {
  return `${sessionId.trim()}::${actorId.trim()}`;
}

interface State {
  bySessionActor: Record<Key, string>;
  /** Sessions already fetched, so N pills do not each fire a request. */
  loaded: Record<string, true>;
  setForSession: (sessionId: string, rows: { actorId: string; model: string }[]) => void;
  clear: () => void;
}

export const useParticipantModelStore = create<State>((set) => ({
  bySessionActor: {},
  loaded: {},
  setForSession: (sessionId, rows) => {
    const sid = sessionId.trim();
    if (!sid) return;
    set((s) => {
      const next = { ...s.bySessionActor };
      for (const row of rows) {
        const model = row.model?.trim();
        const actorId = row.actorId?.trim();
        if (!model || !actorId) continue;
        next[key(sid, actorId)] = model;
      }
      return { bySessionActor: next, loaded: { ...s.loaded, [sid]: true } };
    });
  },
  clear: () => set({ bySessionActor: {}, loaded: {} }),
}));

/** Cached authoritative model for `(session, actor)`, or `''` when unknown. */
export function participantModel(
  sessionId: string | null | undefined,
  actorId: string | null | undefined,
): string {
  const sid = sessionId?.trim();
  const aid = actorId?.trim();
  if (!sid || !aid) return "";
  // Never throw: this feeds the pill and the send path, and a missing cache
  // entry must read as "unknown" rather than break either.
  try {
    return useParticipantModelStore.getState().bySessionActor[key(sid, aid)] ?? "";
  } catch {
    return "";
  }
}

/** In-flight fetches, so N pills for one session share one request. */
const inFlight = new Set<string>();

/**
 * Fetch and cache a session's participant models, once.
 *
 * Fire-and-forget: the resolver falls through to the transcript scan and the
 * retain until this lands, so nothing waits on it. Failures are swallowed for
 * the same reason — the fallbacks are still there.
 */
export function ensureParticipantModels(sessionId: string | null | undefined): void {
  const sid = sessionId?.trim();
  if (!sid) return;
  const store = useParticipantModelStore.getState();
  if (store.loaded[sid] || inFlight.has(sid)) return;
  inFlight.add(sid);

  void (async () => {
    try {
      const { getBackend } = await import("@/lib/backend");
      const rows = await getBackend().sessions.getSessionParticipants(sid);
      useParticipantModelStore.getState().setForSession(
        sid,
        rows.map((r) => ({ actorId: r.actor_id, model: r.model ?? "" })),
      );
    } catch (error) {
      console.warn("[participant-model] fetch failed", error);
    } finally {
      inFlight.delete(sid);
    }
  })();
}

/** Test seam — drops the cache and any in-flight dedupe state. */
export function resetParticipantModelsForTests(): void {
  inFlight.clear();
  useParticipantModelStore.getState().clear();
}
