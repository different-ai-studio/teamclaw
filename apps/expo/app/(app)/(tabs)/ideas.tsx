import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { routeToHref, useOnboarding } from "../../_layout";
import { createActorsApi } from "../../../src/features/actors/actor-api";
import { createIdeasApi } from "../../../src/features/ideas/idea-api";
import { createIdeasController } from "../../../src/features/ideas/idea-controller";
import { IdeasListScreen } from "../../../src/features/ideas/screens/IdeasListScreen";
import { supabase } from "../../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../../src/lib/cloud-api/client";

export default function IdeasIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const href = routeToHref(state.route);
  const teamId = state.currentTeam?.id ?? "";
  const controllerRef = useRef<ReturnType<typeof createIdeasController> | null>(null);
  const teamIdRef = useRef<string | null>(null);

  if (controllerRef.current === null || teamIdRef.current !== teamId) {
    controllerRef.current = createIdeasController(createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }), teamId);
    teamIdRef.current = teamId;
  }

  const controller = controllerRef.current;
  const listState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    if (!teamId) return;
    void controller.load();
  }, [controller, teamId]);

  useFocusEffect(
    useCallback(() => {
      if (!teamId) return;
      void controller.refresh();
    }, [controller, teamId]),
  );

  const [actorNames, setActorNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void createActorsApi({ getAccessToken: supabaseAccessToken(supabase) })
      .listActors(teamId)
      .then((rows) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const row of rows) map.set(row.actorId, row.displayName);
        setActorNames(map);
      })
      .catch(() => {
        if (!cancelled) setActorNames(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (state.currentTeam === null) {
    return <Redirect href="/" />;
  }

  return (
    <IdeasListScreen
      actorNames={actorNames}
      currentActorId={state.currentMemberActorId}
      onCreate={() => router.push("/(app)/new-idea")}
      onOpenArchived={() => router.push("/(app)/archived-ideas")}
      onArchiveBatch={async (ideaIds) => {
        const api = createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) });
        for (const id of ideaIds) {
          try {
            await api.archive(id);
          } catch {
            // Continue archiving the rest; controller refresh picks up the partial diff.
          }
        }
        await controller.refresh();
      }}
      onLoad={() => {
        void controller.load();
      }}
      onRefresh={() => {
        void controller.refresh();
      }}
      onSelectIdea={(ideaId) => {
        router.push(`/(app)/idea-detail?ideaId=${ideaId}`);
      }}
      state={listState}
    />
  );
}
