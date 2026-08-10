import { Redirect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useOnboarding, routeToHref } from "./_layout";
import { ApertureSplashScreen } from "../src/features/onboarding/screens/ApertureSplashScreen";
import { PrimaryButton } from "../src/ui/button";
import { AppCard } from "../src/ui/card";
import { colors, spacing, typography } from "../src/ui/theme";

export default function IndexRoute() {
  const { controller, retryBootstrap, state } = useOnboarding();
  const href = routeToHref(state.route);
  // Bootstrap often resolves in well under one lap of the mark. iOS waits for
  // the animation before moving on (`ApertureSplashView.onLapFinished`); hold
  // the redirect the same way so the splash isn't torn down mid-lap.
  const [lapFinished, setLapFinished] = useState(false);
  const handleLapFinished = useCallback(() => setLapFinished(true), []);

  if (href && lapFinished) {
    return <Redirect href={href} />;
  }

  if (state.route === "failed") {
    return (
      <View style={styles.screen}>
        <AppCard elevated style={styles.card}>
          <Text style={styles.title}>We hit a loading problem</Text>
          <Text style={styles.body}>
            {state.errorMessage ?? "We couldn't open TeamClu right now."}
          </Text>
          <PrimaryButton
            isLoading={state.isBusy}
            label="Try again"
            onPress={() => {
              void retryBootstrap().catch(() => {});
            }}
          />

          {/*
            Retry alone is a trap. Bootstrap reports every failure the same way,
            including an expired or otherwise rejected session — and that class
            of failure never recovers by retrying, so the screen becomes a
            permanent dead end that survives even killing the app, because the
            bad session is in storage. Signing out clears it.

            iOS shows both buttons here for the same reason
            (`onboardingError.retryButton` + `onboardingError.signOutButton`).
          */}
          <Pressable
            accessibilityRole="button"
            disabled={state.isBusy}
            onPress={() => {
              void controller.signOut().catch(() => {});
            }}
            style={({ pressed }) => [
              styles.signOut,
              pressed && !state.isBusy ? styles.signOutPressed : null,
            ]}
            testID="onboardingError.signOutButton"
          >
            <Text style={styles.signOutLabel}>Sign out and start over</Text>
          </Pressable>
        </AppCard>
      </View>
    );
  }

  return <ApertureSplashScreen onLapFinished={handleLapFinished} />;
}

const styles = StyleSheet.create({
  body: {
    color: colors.ink2,
    ...typography.body,
  },
  card: {
    gap: spacing.md,
    maxWidth: 440,
    width: "100%",
  },
  screen: {
    alignItems: "center",
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: "center",
    padding: spacing.xxl,
  },
  signOut: {
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  signOutLabel: {
    color: colors.danger,
    ...typography.body,
    fontWeight: "600",
  },
  signOutPressed: {
    opacity: 0.6,
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});
