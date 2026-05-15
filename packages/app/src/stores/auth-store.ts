import { create } from "zustand";
import { supabase } from "@/lib/supabase-client";
import type { Session } from "@supabase/supabase-js";

interface AuthState {
  session: Session | null;
  loading: boolean;
  errorMessage: string | null;
  otpEmail: string | null;
  hydrate: () => Promise<void>;
  sendOtp: (email: string) => Promise<boolean>;
  verifyOtp: (code: string) => Promise<void>;
  resetOtp: () => void;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  loading: true,
  errorMessage: null,
  otpEmail: null,
  hydrate: async () => {
    set({ loading: true, errorMessage: null });
    const { data } = await supabase.auth.getSession();
    set({ session: data.session, loading: false });
    supabase.auth.onAuthStateChange((_event, session) => {
      set({ session });
    });
  },
  sendOtp: async (email) => {
    set({ loading: true, errorMessage: null });
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) {
      set({ loading: false, errorMessage: error.message });
      return false;
    }
    set({ loading: false, otpEmail: email });
    return true;
  },
  verifyOtp: async (code) => {
    const email = get().otpEmail;
    if (!email) {
      set({ errorMessage: "No pending sign-in. Re-enter your email." });
      return;
    }
    set({ loading: true, errorMessage: null });
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (error) {
      set({ loading: false, errorMessage: error.message });
      return;
    }
    set({ session: data.session, loading: false, otpEmail: null });
  },
  resetOtp: () => set({ otpEmail: null, errorMessage: null }),
  signOut: async () => {
    await supabase.auth.signOut();
    set({ session: null, otpEmail: null });
  },
}));
