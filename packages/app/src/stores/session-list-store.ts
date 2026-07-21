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
  softDeleteSession,
  upsertSessionsBatch,
  type SessionRow,
} from "@/lib/local-cache";
import { removeLinkSessionEntriesForSession } from "@/lib/extension-link-session";
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
    created_at: r.createdAt ?? null,
    updated_at: r.updatedAt ?? null,
  };
}

function sortEntries(entries: SessionListEntry[]): SessionListEntry[] {
  return sortSessionListRows(entries);
}

interface State {
  rows: SessionListEntry[];
  loading: boolean;
  error: string | null;
  pinnedSessionIds: string[];
  highlightedSessionIds: string[];
  hasMore: boolean;
  nextCursor: SessionListCursor | null;
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
  load: async () => {
    await get().loadFirstPage();
  },
  loadFirstPage: async (limit = 50) => {
    const session = useAuthStore.getState().session;
    if (!session) {
      set({ rows: [], loading: false, error: null, hasMore: false, nextCursor: null });
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
    if (isTauri() && teamId && existingRows.length === 0) {
      const localRows = await loadSessionsForTeam(teamId);
      if (localRows.length > 0) {
        set({
          rows: filterArchivedEntries(
            sortEntries(localRows.map(mapCacheToEntry)),
          ),
        });
        markStartup("session-list:local-cache");
      }
    }

    let page: SessionListPage;
    try {
      page = await loadPage(limit, null);
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const { rows } = page;
    const nextCursor = resolveNextCursor(page);

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
        createdAt: r.created_at ?? new Date().toISOString(),
        updatedAt: r.updated_at ?? new Date().toISOString(),
        deletedAt: null,
        syncedAt: new Date().toISOString(),
      }));
      await upsertSessionsBatch(cacheRows);
      // Fire-and-forget: pull session → workspace links from the cloud
      // daemon-runtimes list into the local cache so the session-list
      // workspace filter keeps working offline. Non-fatal: offline / no
      // daemon stays silent.
      void syncSessionWorkspaces(teamId).catch(() => {});
    }

    set({
      rows: filterArchivedEntries(sortEntries(rows)),
      loading: false,
      hasMore: nextCursor != null,
      nextCursor,
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
