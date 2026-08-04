import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { useAuthStore } from "./auth-store";
import { useCurrentTeamStore } from "./current-team";
import { isTauri } from "@/lib/utils";
import { loadPinnedSessionIds, savePinnedSessionIds } from "./session-pins";
import { syncSessionWorkspaces } from "@/lib/session-workspace-sync";
import { markStartup } from "@/lib/startup-perf";
import {
  loadSessionsForTeam,
  loadSessionIdsForActor,
  softDeleteSession,
  upsertSessionsBatch,
  type SessionRow,
} from "@/lib/local-cache";
import { removeLinkSessionEntriesForSession } from "@/lib/extension-link-session";
import { reportLocalCacheFailure } from "@/lib/telemetry/local-cache-error-report";
import type { SessionListCursor, SessionListPage } from "@/lib/backend/types";
import { sortSessionListRows } from "@/lib/session-list-sort";

// localStorage key for the most-recently-known teamId. Persisted so that
// on first ever app boot the libsql phase-1 hydrate can fire — without it,
// `teamId` is null until the first Supabase RPC returns, defeating the
// "instant render from cache" path on cold start.
const LAST_TEAM_ID_KEY = "teamclaw.sessionList.lastTeamId";
const ARCHIVED_SESSION_IDS_KEY = "teamclaw.sessionList.archivedIds";

function readArchivedSessionIds(): Set<string> {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const raw = localStorage.getItem(ARCHIVED_SESSION_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function rememberArchivedSessionId(sessionId: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const ids = readArchivedSessionIds();
    ids.add(sessionId);
    localStorage.setItem(ARCHIVED_SESSION_IDS_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage unavailable — non-fatal.
  }
}

/**
 * Drop ids the server no longer considers archived.
 *
 * The list RPC returns only rows with `archived_at is null`, so anything that
 * comes back has been un-archived — by another device, or by the gateway,
 * which un-archives a chat when a new message arrives on it. Without this the
 * local list would keep hiding a session that is demonstrably live again:
 * `rememberArchivedSessionId` only ever adds, so the list outlives the state
 * it was mirroring.
 *
 * Only call this with rows from the server. Rows from the libsql cache are not
 * evidence of anything — archived sessions sit there until they are soft
 * deleted, which is exactly why the local list exists.
 */
function forgetArchivedSessionIds(entries: SessionListEntry[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    const archived = readArchivedSessionIds();
    if (archived.size === 0) return;
    let changed = false;
    for (const row of entries) {
      if (archived.delete(row.id)) changed = true;
    }
    if (!changed) return;
    localStorage.setItem(ARCHIVED_SESSION_IDS_KEY, JSON.stringify([...archived]));
  } catch {
    // localStorage unavailable — non-fatal.
  }
}

function filterArchivedEntries(entries: SessionListEntry[]): SessionListEntry[] {
  const archived = readArchivedSessionIds();
  if (archived.size === 0) return entries;
  return entries.filter((row) => !archived.has(row.id));
}

function readLastTeamId(): string | null {
  try {
    return typeof localStorage !== "undefined"
      ? localStorage.getItem(LAST_TEAM_ID_KEY)
      : null;
  } catch {
    return null;
  }
}

function writeLastTeamId(teamId: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LAST_TEAM_ID_KEY, teamId);
    }
  } catch {
    // localStorage unavailable (private mode, etc.) — non-fatal.
  }
}

export interface SessionListEntry {
  id: string;
  title: string;
  team_id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  mode: "solo" | "collab" | "control";
  idea_id: string | null;
  has_unread: boolean;
  /** How the session was created: 'user' | 'cron' | 'gateway'. */
  source?: string | null;
  /** For source='cron', the cron job id that created it. */
  cron_job_id?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function mapCacheToEntry(r: SessionRow): SessionListEntry {
  return {
    id: r.id,
    title: r.title ?? "",
    team_id: r.teamId,
    last_message_at: r.lastMessageAt ?? null,
    last_message_preview: r.lastMessagePreview ?? null,
    mode: (r.mode as SessionListEntry["mode"]) ?? "solo",
    idea_id: r.ideaId ?? null,
    has_unread: false,
    source: r.source ?? null,
    cron_job_id: r.cronJobId ?? null,
    created_at: r.createdAt ?? null,
    updated_at: r.updatedAt ?? null,
  };
}

function sortEntries(entries: SessionListEntry[]): SessionListEntry[] {
  return sortSessionListRows(entries);
}

/**
 * Surface a failed list refresh to the user.
 *
 * The store's `error` field has no renderer — nothing reads it — so a failing
 * GET /v1/sessions used to be completely silent: the sidebar just kept showing
 * whatever it already had, with no hint that it had gone stale. The refresh is
 * also debounced off realtime events (App.tsx), so a backend that is down would
 * fire this repeatedly; the fixed toast id collapses those into one.
 *
 * Imported lazily so the store keeps working headless (tests, non-UI callers).
 */
function notifyRefreshFailed(message: string): void {
  void (async () => {
    const [{ toast }, { default: i18n }] = await Promise.all([
      import("sonner"),
      import("@/lib/i18n"),
    ]);
    toast.error(i18n.t("sessions.list.refreshFailed"), {
      id: "session-list-refresh-failed",
      description: message,
    });
  })().catch(() => {
    // Toasting is best-effort; never let it mask the original failure.
  });
}

interface State {
  rows: SessionListEntry[];
  loading: boolean;
  error: string | null;
  pinnedSessionIds: string[];
  highlightedSessionIds: string[];
  hasMore: boolean;
  nextCursor: SessionListCursor | null;
  /**
   * True once the server has returned at least one session row since sign-in.
   * Gates the empty-response guard in `loadFirstPage` — see the comment there.
   */
  serverConfirmed: boolean;
  load: () => Promise<void>;
  loadFirstPage: (limit?: number) => Promise<void>;
  loadMore: (limit?: number) => Promise<void>;
  upsertRows: (rows: SessionListEntry[]) => void;
  patchRow: (sessionId: string, patch: Partial<SessionListEntry>) => void;
  /** Patch preview fields and re-sort by last_message_at. */
  bumpLastMessage: (
    sessionId: string,
    patch: Pick<SessionListEntry, "last_message_preview" | "last_message_at"> &
      Partial<Pick<SessionListEntry, "has_unread">>,
  ) => void;
  removeRow: (sessionId: string) => void;
  markSessionViewed: (sessionId: string, lastReadMessageId?: string | null) => Promise<void>;
  initPinnedSessionIds: (teamId?: string | null) => void;
  toggleSessionPinned: (sessionId: string, teamId?: string | null) => void;
  addHighlightedSession: (sessionId: string, ttlMs?: number) => void;
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<boolean>;
  /** Like archiveSession but does not surface failures on the store error field. */
  archiveSessionQuiet: (sessionId: string) => Promise<boolean>;
}

function mergeRows(existing: SessionListEntry[], incoming: SessionListEntry[]): SessionListEntry[] {
  const byId = new Map(existing.map((row) => [row.id, row] as const));
  for (const row of incoming) byId.set(row.id, row);
  return sortEntries(Array.from(byId.values()));
}

function cursorFromRows(rows: SessionListEntry[]): State["nextCursor"] {
  if (rows.length === 0) return null;
  const row = rows[rows.length - 1];
  return {
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    id: row.id,
  };
}

async function loadPage(limit: number, cursor: State["nextCursor"]) {
  return getBackend().sessions.listCurrentActorSessions({
    limit,
    cursor,
  });
}

function resolveNextCursor(page: SessionListPage): State["nextCursor"] {
  return page.nextCursor === undefined ? cursorFromRows(page.rows) : page.nextCursor;
}

function applyArchivedSessionLocalState(
  get: () => State,
  sessionId: string,
  archivedAt: string,
): void {
  rememberArchivedSessionId(sessionId);
  void removeLinkSessionEntriesForSession(sessionId).catch((error) => {
    console.warn("[session-list] failed to clear link-session map for archived session", error);
  });
  if (isTauri()) {
    void softDeleteSession(sessionId, archivedAt).catch(() => {});
  }
  get().removeRow(sessionId);
}

export const useSessionListStore = create<State>((set, get) => ({
  rows: [],
  loading: false,
  error: null,
  pinnedSessionIds: [],
  highlightedSessionIds: [],
  hasMore: false,
  nextCursor: null,
  serverConfirmed: false,
  load: async () => {
    await get().loadFirstPage();
  },
  loadFirstPage: async (limit = 50) => {
    const session = useAuthStore.getState().session;
    if (!session) {
      set({
        rows: [],
        loading: false,
        error: null,
        hasMore: false,
        nextCursor: null,
        // Signing out re-arms the empty-response guard: the next account's
        // first page has proven nothing yet.
        serverConfirmed: false,
      });
      return;
    }
    set({ loading: true, error: null });
    markStartup("session-list:start");

    // Derive the team_id for libsql hydrate:
    //   1. First row already in store (set by prior load), OR
    //   2. localStorage cache from a previous app session (so first boot
    //      still gets phase-1 instant render before the Supabase RPC).
    // The Supabase RPC below populates either path going forward.
    const existingRows = useSessionListStore.getState().rows;
    // Prefer the active team from current-team store. Falling back to
    // localStorage when it's still null lets phase-1 hydrate fire on cold
    // boot, but using it once current-team is known would cause a
    // local_cache team-gate mismatch panic after switching accounts/teams.
    const activeTeamId = useCurrentTeamStore.getState().team?.id ?? null;
    const teamId = activeTeamId ?? existingRows[0]?.team_id ?? readLastTeamId();

    // ── Phase 1: hydrate instantly from local cache (Tauri only) ──────────
    // Skip when we already have RPC rows — reloading would flash archived
    // sessions that still sit in libsql until soft-deleted.
    const currentMemberActorId = useCurrentTeamStore.getState().currentMember?.id ?? null;
    if (isTauri() && teamId && currentMemberActorId && existingRows.length === 0) {
      // The cache is an accelerator, never a gate. A rejection here (most
      // often the current-team gate disagreeing with `teamId`) used to reject
      // this whole function, leaving `loading: true` forever — the list span
      // its spinner and the rejection surfaced as an unhandled rejection.
      try {
        const [localRows, actorSessionIds] = await Promise.all([
          loadSessionsForTeam(teamId),
          loadSessionIdsForActor(teamId, currentMemberActorId),
        ]);
        const actorSessionIdSet = new Set(actorSessionIds);
        const currentActorRows = localRows.filter((row) => actorSessionIdSet.has(row.id));
        if (currentActorRows.length > 0) {
          set({
            rows: filterArchivedEntries(
              sortEntries(currentActorRows.map(mapCacheToEntry)),
            ),
          });
          markStartup("session-list:local-cache");
        }
      } catch (error) {
        reportLocalCacheFailure("session_load_team", error, { teamId });
      }
    }

    let page: SessionListPage;
    try {
      page = await loadPage(limit, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ loading: false, error: message });
      notifyRefreshFailed(message);
      return;
    }
    const { rows } = page;
    const nextCursor = resolveNextCursor(page);

    // ── Empty-response guard ─────────────────────────────────────────────
    // GET /v1/sessions answers "you have no sessions" and "I cannot see your
    // sessions" with the same 200 + `items: []`: every visibility gate on that
    // endpoint fails closed (no actor row for the caller, no
    // session_participants row, RLS/org scoping) and returns an empty list
    // rather than an error. Until the server has handed us a row at least
    // once, an empty page is therefore not evidence that the list is empty —
    // and overwriting the phase-1 hydrate with it blanks a list the user can
    // plainly see, while the rows still sit in libsql.
    //
    // Once any page has come back with rows, `serverConfirmed` flips and a
    // later empty page is taken at face value, so archiving the last session
    // (here or on another device) still empties the list as it should.
    if (rows.length === 0 && get().rows.length > 0 && !get().serverConfirmed) {
      console.warn(
        "[session-list] server returned 0 sessions and none were confirmed before; keeping cached rows",
      );
      set({ loading: false, hasMore: false, nextCursor: null });
      markStartup("session-list:loaded");
      return;
    }

    // Persist teamId for the next cold boot — pick from fresh rows if we have
    // any; otherwise keep whatever the libsql hydrate already exposed.
    const freshTeamId = rows[0]?.team_id ?? teamId;
    if (freshTeamId) writeLastTeamId(freshTeamId);

    if (isTauri() && teamId && rows.length > 0) {
      const cacheRows: SessionRow[] = rows.map((r) => ({
        id: r.id,
        teamId: r.team_id,
        title: r.title ?? null,
        mode: r.mode ?? null,
        primaryAgentId: null,
        ideaId: r.idea_id ?? null,
        summary: null,
        lastMessagePreview: r.last_message_preview ?? null,
        lastMessageAt: r.last_message_at ?? null,
        createdBy: null,
        metadataJson: null,
        source: r.source ?? null,
        cronJobId: r.cron_job_id ?? null,
        createdAt: r.created_at ?? new Date().toISOString(),
        updatedAt: r.updated_at ?? new Date().toISOString(),
        deletedAt: null,
        syncedAt: new Date().toISOString(),
      }));
      try {
        await upsertSessionsBatch(cacheRows);
      } catch (error) {
        // Same contract as the hydrate above: a cache write must never stop
        // the freshly-fetched rows from rendering.
        reportLocalCacheFailure("session_upsert_batch", error, { teamId });
      }
      // Fire-and-forget: refresh the viewer's workspace context so newly
      // connected agents and newly registered workspaces are picked up. The
      // session → workspace links themselves are no longer prefetched here —
      // they come off each session's participant rows on demand (ADR-0005).
      void syncSessionWorkspaces(teamId).catch(() => {});
    }

    forgetArchivedSessionIds(rows);
    set({
      rows: filterArchivedEntries(sortEntries(rows)),
      loading: false,
      hasMore: nextCursor != null,
      nextCursor,
      serverConfirmed: get().serverConfirmed || rows.length > 0,
    });
    markStartup("session-list:loaded");
  },
  loadMore: async (limit = 50) => {
    const session = useAuthStore.getState().session;
    if (!session) return;
    const cursor = get().nextCursor;
    if (!cursor) return;

    set({ loading: true, error: null });
    let page: SessionListPage;
    try {
      page = await loadPage(limit, cursor);
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const { rows } = page;
    const nextCursor = resolveNextCursor(page);
    forgetArchivedSessionIds(rows);
    const nextRows = filterArchivedEntries(mergeRows(get().rows, rows));
    set({
      rows: nextRows,
      loading: false,
      hasMore: nextCursor != null,
      nextCursor,
    });
  },
  upsertRows: (rows) => set((state) => ({ rows: mergeRows(state.rows, rows) })),
  patchRow: (sessionId, patch) => set((state) => ({
    rows: state.rows.map((row) =>
      row.id === sessionId ? { ...row, ...patch } : row,
    ),
  })),
  bumpLastMessage: (sessionId, patch) =>
    set((state) => ({
      rows: sortEntries(
        state.rows.map((row) =>
          row.id === sessionId ? { ...row, ...patch } : row,
        ),
      ),
    })),
  removeRow: (sessionId) => set((state) => ({
    rows: state.rows.filter((row) => row.id !== sessionId),
  })),
  markSessionViewed: async (sessionId, lastReadMessageId = null) => {
    try {
      await getBackend().sessions.markCurrentActorSessionViewed(sessionId, lastReadMessageId);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    get().patchRow(sessionId, { has_unread: false });
  },
  initPinnedSessionIds: (teamId = null) => {
    set({ pinnedSessionIds: loadPinnedSessionIds(teamId) });
  },
  toggleSessionPinned: (sessionId, teamId = null) => {
    const cur = get().pinnedSessionIds;
    const next = cur.includes(sessionId)
      ? cur.filter((id) => id !== sessionId)
      : [...cur, sessionId];
    savePinnedSessionIds(teamId, next);
    set({ pinnedSessionIds: next });
  },
  addHighlightedSession: (sessionId, ttlMs = 4000) => {
    const cur = get().highlightedSessionIds;
    if (cur.includes(sessionId)) return;
    set({ highlightedSessionIds: [...cur, sessionId] });
    setTimeout(() => {
      const latest = useSessionListStore.getState().highlightedSessionIds;
      useSessionListStore.setState({
        highlightedSessionIds: latest.filter((id) => id !== sessionId),
      });
    }, ttlMs);
  },
  updateSessionTitle: async (sessionId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await getBackend().sessions.updateSessionTitle(sessionId, trimmed);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    get().patchRow(sessionId, { title: trimmed });
  },
  archiveSession: async (sessionId) => {
    const archivedAt = new Date().toISOString();
    try {
      await getBackend().sessions.archiveSession(sessionId, archivedAt);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    applyArchivedSessionLocalState(get, sessionId, archivedAt);
    return true;
  },
  archiveSessionQuiet: async (sessionId) => {
    const archivedAt = new Date().toISOString();
    try {
      await getBackend().sessions.archiveSession(sessionId, archivedAt);
    } catch (error) {
      console.warn("[session-list] archive failed", sessionId, error);
      return false;
    }
    applyArchivedSessionLocalState(get, sessionId, archivedAt);
    return true;
  },
}));
