import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useOnboarding, routeToHref } from "./_layout";
import { colors, spacing, typography } from "../src/ui/theme";

/**
 * Landing route for the `teamclaw://auth-callback` deep link.
 *
 * The OAuth flow itself is completed by `openAuthSessionAsync`, which resolves
 * with the callback URL and hands it to `signInWithOAuth`. But the redirect is
 * also a real deep link into the app, so expo-router receives
 * `/auth-callback` as a navigation target — and with no file to match it, the
 * user landed on "Unmatched Route — Page could not be found" *after a
 * successful sign-in*.
 *
 * So this screen deliberately does no auth work: completing the callback a
 * second time would re-spend a one-time PKCE code. It only holds the user
 * still while the session settles, then forwards to wherever onboarding says
 * they belong.
 *
 * iOS handles the same URL in `AMUXApp.swift` (`case "auth-callback"`), which
 * likewise just forwards it rather than treating it as a screen.
 */
export default function AuthCallbackRoute() {
  const { state } = useOnboarding();
  const href = routeToHref(state.route);

  if (href) {
    return <Redirect href={href} />;
  }

  // `loading` / `failed` have no href. Bootstrap is mid-flight right after a
  // sign-in, so this is the expected state for a moment — show progress rather
  // than a dead end, and let the redirect fire once the route resolves.
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
