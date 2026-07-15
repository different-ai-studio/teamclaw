import { Redirect, useRouter } from "expo-router";

import { ChooseAuthScreen } from "../src/features/onboarding/screens/ChooseAuthScreen";
import { savePendingInviteToken } from "../src/features/onboarding/pending-invite";

import { routeToHref, useOnboarding } from "./_layout";

export default function ChooseAuthRoute() {
  const router = useRouter();
  const { controller, state } = useOnboarding();

  if (state.route !== "needsAuth") {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  return (
    <ChooseAuthScreen
      errorMessage={state.errorMessage}
      isBusy={state.isBusy}
      onCreatePrivateWorkspace={() => {
        void controller.signInAnonymously();
      }}
      onSignInOrRegister={() => {
        router.push("/auth");
      }}
      onJoinWithToken={async (token) => {
        // Stash the token, then anonymous sign-in. RootLayout's pending-invite
        // effect picks it up once the route transitions to `ready` and claims
        // the team — same pipeline iOS uses (AppOnboardingCoordinator.claimInviteSmart).
        await savePendingInviteToken(token);
        await controller.signInAnonymously();
      }}
    />
  );
}
