import { Redirect } from "expo-router";

import { CreateTeamScreen } from "../src/features/onboarding/screens/CreateTeamScreen";

import { routeToHref, useOnboarding } from "./_layout";

export default function CreateTeamRoute() {
  const { controller, state } = useOnboarding();

  if (state.route !== "createTeam") {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  return (
    <CreateTeamScreen
      errorMessage={state.errorMessage}
      isAnonymous={state.isAnonymous}
      isBusy={state.isBusy}
      onCreateTeam={controller.createTeam}
    />
  );
}
