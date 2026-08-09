import { Redirect } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useOnboarding, routeToHref } from "./_layout";
import { PrimaryButton } from "../src/ui/button";
import { AppCard } from "../src/ui/card";
import { colors, spacing, typography } from "../src/ui/theme";

export default function IndexRoute() {
  const { controller, retryBootstrap, state } = useOnboarding();
  const href = routeToHref(state.route);

  if (href) {
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

  return (
    <View style={styles.screen}>
      <AppCard elevated style={styles.card}>
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.coral} size="small" />
          <Text style={styles.title}>Opening TeamClu</Text>
        </View>
        <Text style={styles.body}>
          Checking your session and workspace so we can send you to the right place.
        </Text>
      </AppCard>
    </View>
  );
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
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
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
