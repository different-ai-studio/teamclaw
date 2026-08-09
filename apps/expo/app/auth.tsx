import { Redirect, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";

import { OAUTH_REDIRECT_URL } from "../src/features/onboarding/onboarding-oauth";
import { AuthScreen } from "../src/features/onboarding/screens/AuthScreen";

import { routeToHref, useOnboarding } from "./_layout";

WebBrowser.maybeCompleteAuthSession();

export default function AuthRoute() {
  const router = useRouter();
  const { controller, state } = useOnboarding();

  if (state.route !== "needsAuth") {
    const href = routeToHref(state.route);
    return <Redirect href={href ?? "/"} />;
  }

  return (
    <AuthScreen
      errorMessage={state.errorMessage}
      isBusy={state.isBusy}
      pendingEmail={state.pendingEmailOTPEmail}
      onBack={() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace("/choose-auth");
        }
      }}
      onRequestOtp={controller.requestOtp}
      onResetPendingEmail={controller.resetPendingEmail}
      onSignInWithApple={() =>
        controller.signInWithOAuth("apple", {
          redirectTo: OAUTH_REDIRECT_URL,
          openAuthSession: WebBrowser.openAuthSessionAsync,
        })
      }
      onSignInWithGoogle={() =>
        controller.signInWithOAuth("google", {
          redirectTo: OAUTH_REDIRECT_URL,
          openAuthSession: WebBrowser.openAuthSessionAsync,
        })
      }
      onSignInWithPassword={controller.signInWithPassword}
      onVerifyOtp={controller.verifyOtp}
    />
  );
}
