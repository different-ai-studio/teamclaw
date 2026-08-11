import { useRouter } from "expo-router";
import { useEffect, useState } from "react";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import type { Actor } from "../../src/features/actors/actor-types";
import { TeamStatsSheet } from "../../src/features/actors/screens/TeamStatsSheet";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { supabase } from "../../src/lib/supabase/client";

export default function TeamStatsRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";

  const [actors, setActors] = useState<Actor[]>([]);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void createActorsApi({ getAccessToken: supabaseAccessToken(supabase) })
      .listActors(teamId)
      .then((rows) => {
        if (!cancelled) setActors(rows);
      })
      .catch(() => {
        if (!cancelled) setActors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  return <TeamStatsSheet actors={actors} onClose={() => router.back()} />;
}
