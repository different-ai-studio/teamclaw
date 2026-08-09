import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useOnboarding, routeToHref } from "./_layout";
import { colors, spacing, typography } from "../src/ui/theme";

/**
 * Landing route for the `teamclaw://auth-callback` deep link.
 *
 * The OS routes this URL two places at once: to `Linking`, where the root
 * layout hands it to `completeOAuthFromUrl` to actually exchange the code, and
 * to expo-router, which treats `/auth-callback` as a navigation target. With
 * no file to match it the user landed on "Unmatched Route — Page could not be
 * found" *after a successful sign-in*, which is why this screen exists.
 *
 * It deliberately does no auth work of its own — the exchange is already
 * running, and spending the one-time PKCE code twice would fail the second
 * time. It just holds the user still until onboarding knows where they belong.
 *
 * iOS handles the same URL in `AMUXApp.swift` (`case "auth-callback"`), which
 * likewise forwards it rather than treating it as a screen.
 */
export default function AuthCallbackRoute() {
  const { state } = useOnboarding();

  // Redirecting on `route` alone sent the user to `/welcome` for the whole
  // exchange — a successful Google sign-in looked like being dumped back on
  // the first screen. `needsAuth` is simply what the state machine says until
  // a session exists, so wait it out.
  if (state.isBusy) {
    return <Progress />;
  }

  if (state.route === "needsAuth") {
    // Signing in didn't produce a session. Go back to the form, which renders
    // `errorMessage` — the welcome screen shows nothing, so a real failure
    // there is indistinguishable from "nothing happened".
    return <Redirect href="/auth" />;
  }

  const href = routeToHref(state.route);
  if (href) {
    return <Redirect href={href} />;
  }

  // `failed` has no href; `/` renders it with retry + sign out.
  if (state.route === "failed") {
    return <Redirect href="/" />;
  }

  return <Progress />;
}

function Progress() {
  return (
    <View style={styles.screen}>
      <ActivityIndicator color={colors.coral} size="small" />
      <Text style={styles.title}>Finishing sign-in</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: "center",
    backgroundColor: colors.background,
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.xxl,
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});
