import { create } from "zustand";
import { supabase } from "@/lib/supabase-client";
import type { Session } from "@supabase/supabase-js";

interface AuthState {
  session: Session | null;
  loading: boolean;
  errorMessage: string | null;
  hydrate: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  loading: true,
  errorMessage: null,
  hydrate: async () => {
    set({ loading: true, errorMessage: null });
    const { data } = await supabase.auth.getSession();
    set({ session: data.session, loading: false });
    supabase.auth.onAuthStateChange((_event, session) => {
      set({ session });
    });
  },
  signIn: async (email, password) => {
    set({ loading: true, errorMessage: null });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      set({ loading: false, errorMessage: error.message });
      return;
    }
    set({ session: data.session, loading: false });
  },
  signUp: async (email, password) => {
    set({ loading: true, errorMessage: null });
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      set({ loading: false, errorMessage: error.message });
      return;
    }
    set({ session: data.session, loading: false });
  },
  signOut: async () => {
    await supabase.auth.signOut();
    set({ session: null });
  },
}));
