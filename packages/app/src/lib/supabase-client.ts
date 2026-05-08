import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing");
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export interface SessionRow {
  id: string;
  title: string;
  created_by_actor_id: string;
  created_at: string;
  updated_at: string;
}

export async function listSessionsForUser(userId: string): Promise<SessionRow[]> {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, title, created_by_actor_id, created_at, updated_at")
    .eq("created_by_actor_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}
