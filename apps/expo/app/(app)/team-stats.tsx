import { useRouter } from "expo-router";
import { useEffect, useState } from "react";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import type { Actor } from "../../src/features/actors/actor-types";
import { TeamStatsSheet } from "../../src/features/actors/screens/TeamStatsSheet";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import type { Idea } from "../../src/features/ideas/idea-types";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import type { SessionSummary } from "../../src/features/sessions/session-types";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { supabase } from "../../src/lib/supabase/client";

export default function TeamStatsRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";

  const [actors, setActors] = useState<Actor[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [actorRows, ideaRows, sessionRows] = await Promise.all([
          createActorsApi({ getAccessToken: supabaseAccessToken(supabase) }).listActors(teamId),
          createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }).listIdeas(teamId, {
            includeArchived: true,
          }),
          createConfiguredSessionsApi(supabase).listSessions(teamId),
        ]);
        if (cancelled) return;
        setActors(actorRows);
        setIdeas(ideaRows);
        setSessions(sessionRows);
      } catch {
        if (cancelled) return;
        setActors([]);
        setIdeas([]);
        setSessions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  return (
    <TeamStatsSheet
      actors={actors}
      ideas={ideas}
      onClose={() => router.back()}
      sessions={sessions}
    />
  );
}
