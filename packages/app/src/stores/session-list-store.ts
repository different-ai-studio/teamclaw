import { create } from "zustand";
import { supabase } from "@/lib/supabase-client";
import { useAuthStore } from "./auth-store";

export interface SessionListEntry {
  id: string;
  title: string;
  team_id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  mode: "solo" | "collab" | "control";
}

interface State {
  rows: SessionListEntry[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export const useSessionListStore = create<State>((set) => ({
  rows: [],
  loading: false,
  error: null,
  load: async () => {
    const session = useAuthStore.getState().session;
    if (!session) {
      set({ rows: [], loading: false, error: null });
      return;
    }
    set({ loading: true, error: null });
    const { data, error } = await supabase
      .from("sessions")
      .select("id, title, team_id, mode, last_message_at, last_message_preview")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(50);
    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    set({ rows: (data as SessionListEntry[]) ?? [], loading: false });
  },
}));
