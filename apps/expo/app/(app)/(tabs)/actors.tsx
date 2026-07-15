import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { routeToHref, useOnboarding } from "../../_layout";
import { createActorsApi } from "../../../src/features/actors/actor-api";
import { createActorsController } from "../../../src/features/actors/actor-controller";
import { ActorsListScreen } from "../../../src/features/actors/screens/ActorsListScreen";
import { supabase } from "../../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../../src/lib/cloud-api/client";

export default function ActorsIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const href = routeToHref(state.route);
  const teamId = state.currentTeam?.id ?? "";
  const controllerRef = useRef<ReturnType<typeof createActorsController> | null>(null);
  const teamIdRef = useRef<string | null>(null);

  if (controllerRef.current === null || teamIdRef.current !== teamId) {
    controllerRef.current = createActorsController(
      createActorsApi({ getAccessToken: supabaseAccessToken(supabase) }),
      teamId,
    );
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

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (state.currentTeam === null) {
    return <Redirect href="/" />;
  }

  return (
    <ActorsListScreen
      currentActorId={state.currentMemberActorId}
      onInvite={() => router.push("/(app)/invite")}
      onLoad={() => {
        void controller.load();
      }}
      onRefresh={() => {
        void controller.refresh();
      }}
      onSelectActor={(actorId) => {
        router.push(`/(app)/actor-detail?actorId=${actorId}`);
      }}
      state={listState}
    />
  );
}
