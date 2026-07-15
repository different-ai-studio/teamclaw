import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useOnboarding, routeToHref } from "./_layout";
import { PrimaryButton } from "../src/ui/button";
import { AppCard } from "../src/ui/card";
import { colors, spacing, typography } from "../src/ui/theme";

export default function IndexRoute() {
  const { retryBootstrap, state } = useOnboarding();
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
            {state.errorMessage ?? "We couldn't open TeamClaw right now."}
          </Text>
          <PrimaryButton
            isLoading={state.isBusy}
            label="Try again"
            onPress={() => {
              void retryBootstrap().catch(() => {});
            }}
          />
        </AppCard>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AppCard elevated style={styles.card}>
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.coral} size="small" />
          <Text style={styles.title}>Opening TeamClaw</Text>
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
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});
