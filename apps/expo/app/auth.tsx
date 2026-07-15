import * as Linking from "expo-linking";
import { Redirect, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";

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
          redirectTo: Linking.createURL("auth/callback"),
          openAuthSession: WebBrowser.openAuthSessionAsync,
        })
      }
      onSignInWithGoogle={() =>
        controller.signInWithOAuth("google", {
          redirectTo: Linking.createURL("auth/callback"),
          openAuthSession: WebBrowser.openAuthSessionAsync,
        })
      }
      onVerifyOtp={controller.verifyOtp}
    />
  );
}
