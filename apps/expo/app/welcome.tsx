import { Redirect, useRouter } from "expo-router";

import { WelcomeScreen } from "../src/features/onboarding/screens/WelcomeScreen";

import { routeToHref, useOnboarding } from "./_layout";

export default function WelcomeRoute() {
  const router = useRouter();
  const { state } = useOnboarding();

  if (state.route !== "needsAuth") {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  return (
    <WelcomeScreen
      onGetStarted={() => {
        router.push("/choose-auth");
      }}
    />
  );
}
