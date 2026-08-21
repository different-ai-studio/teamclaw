import { Redirect, useRouter } from "expo-router";

import { ChooseAuthScreen } from "../src/features/onboarding/screens/ChooseAuthScreen";
import { savePendingInviteToken } from "../src/features/onboarding/pending-invite";

import { routeToHref, useOnboarding } from "./_layout";

export default function ChooseAuthRoute() {
  const router = useRouter();
  const { state, applyServerChange } = useOnboarding();

  if (state.route !== "needsAuth") {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  return (
    <ChooseAuthScreen
      errorMessage={state.errorMessage}
      isBusy={state.isBusy}
      onServerChanged={applyServerChange}
      onSignInOrRegister={() => {
        router.push("/auth");
      }}
      onJoinWithToken={async (token) => {
        // Stash the token and route to sign-in. Member invites cannot be
        // claimed without a real account, so the claim happens after auth —
        // RootLayout's pending-invite effect picks it up once the route
        // reaches `ready`.
        await savePendingInviteToken(token);
        router.push("/auth");
      }}
    />
  );
}
