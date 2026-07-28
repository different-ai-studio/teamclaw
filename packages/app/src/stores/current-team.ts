import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { useAuthStore } from "./auth-store";
import { trackEvent } from "@/lib/analytics";

export async function setLocalCacheTeamGate(teamId: string | null): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("local_cache_set_current_team", { teamId });
  } catch (error) {
    // Non-fatal: browser preview or missing tauri runtime. The gate is a
    // defense-in-depth layer, not a correctness requirement.
    console.debug("[CurrentTeam] local_cache_set_current_team unavailable", error);
  }
}

export interface CurrentTeam {
  id: string;
  name: string;
  slug: string;
}

export interface CurrentTeamMember {
  id: string;
  displayName: string;
  role: string | null;
  joinedAt: string | null;
}

/**
 * Persisted snapshot of the resolved current team. Cached to localStorage so a
 * returning user can render the shell optimistically on cold start instead of
 * blocking first paint behind the ~1.4–1.8s team-bootstrap network round-trips
 * (listCurrentUserTeams + member). The live `load()` still runs in the
 * background (App mounts and calls it) to revalidate and reconcile.
 */
export interface CachedCurrentTeam {
  team: CurrentTeam | null;
  currentMember: CurrentTeamMember | null;
  /** Auth user id the cache belongs to — guards against cross-user reuse. */
  teamUserId: string | null;
}

const CACHE_KEY = "teamclaw:current-team";

export function readCachedCurrentTeam(): CachedCurrentTeam | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCurrentTeam;
    // Only honor a cache that actually identifies a team and its owning user.
    if (!parsed?.team?.id || !parsed.teamUserId) return null;
    return {
      team: parsed.team,
      currentMember: parsed.currentMember ?? null,
      teamUserId: parsed.teamUserId,
    };
  } catch {
    return null;
  }
}

export function writeCachedCurrentTeam(snapshot: CachedCurrentTeam): void {
  try {
    if (!snapshot.team || !snapshot.teamUserId) {
      localStorage.removeItem(CACHE_KEY);
      return;
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Private mode / quota / no localStorage — the cache is a best-effort
    // optimization, never a correctness requirement.
  }
}

/** Initial store slice, hydrated synchronously from the persisted cache. */
export function initialCurrentTeamState(): Pick<State, "team" | "currentMember" | "teamUserId"> {
  const cached = readCachedCurrentTeam();
  return {
    team: cached?.team ?? null,
    currentMember: cached?.currentMember ?? null,
    teamUserId: cached?.teamUserId ?? null,
  };
}

interface State {
  team: CurrentTeam | null;
  currentMember: CurrentTeamMember | null;
  /** Auth user id the current `team` was resolved for. Guards the RLS-lag
   * preserve below from carrying one user's team into another's session. */
  teamUserId: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  /**
   * Set the current team WITHOUT touching the server-side active org.
   * Internal: only safe when the team is already inside the active org.
   * Every other caller must use `enterTeam`.
   */
  reloadAndSwitchTo: (teamId: string) => Promise<void>;
  enterTeam: (teamId: string, opts?: { assumeActive?: boolean }) => Promise<void>;
  switchToTeam: (teamId: string) => Promise<void>;
  setActiveTeam: (team: CurrentTeam) => Promise<void>;
  rename: (newName: string) => Promise<boolean>;
  /** Rename the current user's own member actor (their display name). */
  renameCurrentMember: (newName: string) => Promise<boolean>;
}

export const useCurrentTeamStore = create<State>((set, get) => ({
  ...initialCurrentTeamState(),
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    const session = useAuthStore.getState().session;
    if (!session) {
      await setLocalCacheTeamGate(null);
      set({ team: null, currentMember: null, teamUserId: null, loading: false, error: null });
      return;
    }

    set({ loading: true, error: null });
    let row;
    try {
      // Listing the whole active org rather than `limit: 1` is deliberate.
      // The old code took the first row — an arbitrary pick ordered by
      // created_at — which silently relocated multi-team users to a team they
      // never chose on every mount, and dragged the local-cache team gate with
      // it. That gate then disagreed with the team the rest of the UI was
      // still working on, which is what produced the `team gate mismatch`
      // rejections. Keep the held team whenever it is still a member of the
      // active org; only fall back to the first row when it is not.
      const rows = await getBackend().teams.listCurrentUserTeams({ limit: 50 });
      const heldId = get().team?.id;
      row = (heldId ? rows.find((t) => t.id === heldId) : undefined) ?? rows[0];
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    // RLS replica lag guard: AuthGate auto-creates/joins a team for a fresh
    // (e.g. anonymous) session and populates this store via setActiveTeam, but
    // the just-written membership row is not always visible to this follow-up
    // listCurrentUserTeams() yet. When that race returns an empty list, do NOT
    // clobber the team AuthGate just set to null — that left the team-share
    // settings page unable to see the team (showing the git form / prereq
    // notice even after OSS was enabled). A genuinely team-less session keeps
    // team === null, so this only preserves a team we already hold.
    //
    // Cross-user guard: only preserve when the held team was resolved for the
    // CURRENT user. After logout + re-login (e.g. a new anonymous user) the new
    // user's team list lags RLS; without this check the previous user's team
    // would be preserved and team actions would target the wrong (foreign,
    // already-locked) team.
    if (!row && get().team && get().teamUserId === session.user.id) {
      set({ loading: false });
      return;
    }
    const activeTeam = row ? { id: row.id, name: row.name, slug: row.slug ?? "" } : null;
    await setLocalCacheTeamGate(activeTeam?.id ?? null);
    const currentMember = activeTeam
      ? await loadCurrentMember(activeTeam.id, session.user.id)
      : null;
    set({
      team: activeTeam,
      currentMember,
      teamUserId: activeTeam ? session.user.id : null,
      loading: false,
    });
  },

  reloadAndSwitchTo: async (teamId: string) => {
    const session = useAuthStore.getState().session;
    if (!session) {
      await setLocalCacheTeamGate(null);
      set({ team: null, currentMember: null, teamUserId: null, loading: false, error: null });
      return;
    }

    // Gate must be moved BEFORE any local_cache_* call for the new team so the
    // backend accepts hydration loads for the team we're switching to.
    await setLocalCacheTeamGate(teamId);

    set({ loading: true, error: null });
    let data;
    try {
      data = await getBackend().teams.getTeam(teamId);
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const activeTeam = data ? { id: data.id, name: data.name, slug: data.slug ?? "" } : null;
    const currentMember = activeTeam
      ? await loadCurrentMember(activeTeam.id, session.user.id)
      : null;
    set({
      team: activeTeam,
      currentMember,
      teamUserId: activeTeam ? session.user.id : null,
      loading: false,
    });
  },

  /**
   * The single supported way to enter a team.
   *
   * TeamClaw is strict single-org: `amux.current_org_id()` gates every
   * team-scoped RLS policy, and a team outside the active org is invisible —
   * reads return nothing and writes are denied. Setting the current team
   * without moving the server-side active org therefore produces a client that
   * believes it is in a team the server will refuse every request for:
   * "Failed to create session", an empty session list, and a local-cache gate
   * pointing at a different team than the UI.
   *
   * So: activate first (which mints a session carrying the new org), adopt it,
   * and only then set the client-side team.
   *
   * `assumeActive` skips the activation round-trip. Only pass it when the team
   * is already known to be in the active org — e.g. it came back from
   * `listCurrentUserTeams`, which is itself an active-org listing.
   */
  enterTeam: async (teamId: string, opts) => {
    if (!opts?.assumeActive) {
      const { refreshToken } = await getBackend().teams.activateTeam(teamId);
      // Installs the JWT carrying the new org_id (fires onAuthStateChange →
      // auth-store.session). Without this the org switch is server-only and
      // the very next request still authenticates as the old org.
      if (refreshToken) await getBackend().auth.adoptSession(refreshToken);
    }
    await get().reloadAndSwitchTo(teamId);
  },

  switchToTeam: async (teamId: string) => {
    set({ loading: true, error: null });
    try {
      await get().enterTeam(teamId);
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    // 4) Tauri：daemon 重新 onboard 到新 team（绑定新 actor/凭证）。
    try {
      const { isTauri } = await import("@/lib/utils");
      if (isTauri()) {
        const { useDaemonOnboardingStore } = await import("./daemon-onboarding");
        await useDaemonOnboardingStore.getState().refresh();
      }
    } catch (e) {
      console.warn("[CurrentTeam] daemon refresh after switch failed", e);
    }
    set({ loading: false });
    void trackEvent("team_switched");
  },

  setActiveTeam: async (team) => {
    const session = useAuthStore.getState().session;
    await setLocalCacheTeamGate(team.id);
    const currentMember = session
      ? await loadCurrentMember(team.id, session.user.id)
      : null;
    set({ team, currentMember, teamUserId: session?.user.id ?? null, loading: false, error: null });
  },

  rename: async (newName) => {
    const team = get().team;
    if (!team) {
      set({ error: "no current team" });
      return false;
    }
    const trimmed = newName.trim();
    if (!trimmed) {
      set({ error: "team name is required" });
      return false;
    }

    set({ saving: true, error: null });
    try {
      const renamed = await getBackend().teams.renameTeam(team.id, trimmed);
      set({
        team: {
          id: renamed.id || team.id,
          name: renamed.name || trimmed,
          slug: renamed.slug ?? team.slug,
        },
        saving: false,
      });
      return true;
    } catch (error) {
      set({
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },

  renameCurrentMember: async (newName) => {
    const member = get().currentMember;
    if (!member) {
      set({ error: "no current member" });
      return false;
    }
    const trimmed = newName.trim();
    if (!trimmed) {
      set({ error: "display name is required" });
      return false;
    }
    if (trimmed === member.displayName) return true;

    set({ saving: true, error: null });
    try {
      const updated = await getBackend().actors.updateCurrentActorProfile({
        actorId: member.id,
        displayName: trimmed,
      });
      const nextName = updated.display_name || trimmed;
      set({ currentMember: { ...member, displayName: nextName }, saving: false });

      // Best-effort: refresh the cached Actor so chat/sidebar reflect the new
      // name without a reload. Only patches an already-cached entry.
      try {
        const { useActorsStore } = await import("./actors-store");
        const cached = useActorsStore.getState().get(member.id);
        if (cached) useActorsStore.getState().upsert({ ...cached, displayName: nextName });
      } catch {
        // actors-store unavailable / not yet populated — non-fatal.
      }
      return true;
    } catch (error) {
      set({
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },
}));

// Persist the resolved team identity on every change so the next cold start can
// hydrate it synchronously (see initialCurrentTeamState). Writing on every
// state change is cheap and keeps the cache authoritative without threading a
// save call through each resolution site.
useCurrentTeamStore.subscribe((state) => {
  writeCachedCurrentTeam({
    team: state.team,
    currentMember: state.currentMember,
    teamUserId: state.teamUserId,
  });
});

async function loadCurrentMember(teamId: string, userId: string): Promise<CurrentTeamMember | null> {
  try {
    return await getBackend().directory.getCurrentTeamMember(teamId, userId);
  } catch (error) {
    console.warn("[CurrentTeam] failed to load current member", error);
    return null;
  }
}
