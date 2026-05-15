import { create } from "zustand";
import { supabase } from "@/lib/supabase-client";
import { useAuthStore } from "./auth-store";

export interface CurrentTeam {
  id: string;
  name: string;
  slug: string;
}

interface State {
  team: CurrentTeam | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  rename: (newName: string) => Promise<boolean>;
}

export const useCurrentTeamStore = create<State>((set, get) => ({
  team: null,
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    const session = useAuthStore.getState().session;
    if (!session) {
      set({ team: null, loading: false, error: null });
      return;
    }

    set({ loading: true, error: null });
    const { data, error } = await supabase
      .from("teams")
      .select("id, name, slug, created_at")
      .order("created_at", { ascending: true })
      .limit(1);

    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    const row = data?.[0];
    set({
      team: row ? { id: row.id, name: row.name, slug: row.slug } : null,
      loading: false,
    });
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
    const { data, error } = await supabase.rpc("rename_team", {
      p_team_id: team.id,
      p_name: trimmed,
    });

    if (error) {
      set({ saving: false, error: error.message });
      return false;
    }
    const row = Array.isArray(data) ? data[0] : data;
    set({
      team: row
        ? { id: row.team_id, name: row.team_name, slug: row.team_slug }
        : { ...team, name: trimmed },
      saving: false,
    });
    return true;
  },
}));
