import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { TeamSummary } from "../onboarding-types";
import { AppCard } from "../../../ui/card";
import { colors, radii, spacing, typography } from "../../../ui/theme";

type HomeScreenProps = {
  currentMemberActorId: string | null;
  isAnonymous: boolean;
  isBusy: boolean;
  isSignOutPending: boolean;
  team: TeamSummary;
  onSignOut: () => Promise<void>;
};

export function HomeScreen({
  currentMemberActorId,
  isAnonymous,
  isBusy: _isBusy,
  isSignOutPending,
  team,
  onSignOut,
}: HomeScreenProps) {
  const [localError, setLocalError] = useState<string | null>(null);

  const signOut = async () => {
    setLocalError(null);

    try {
      await onSignOut();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Couldn't sign out right now.");
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{team.name}</Text>
          <View style={styles.metaRow}>
            <View style={styles.metaPill}>
              <Text style={styles.metaPillText}>{isAnonymous ? "Guest session" : "Authenticated"}</Text>
            </View>
            <View style={styles.metaPill}>
              <Text style={styles.metaPillText}>{team.role}</Text>
            </View>
          </View>
        </View>

        <Pressable
          disabled={isSignOutPending}
          onPress={() => {
            void signOut();
          }}
          style={({ pressed }) => [
            styles.signOutButton,
            pressed && !isSignOutPending && styles.pressed,
            isSignOutPending && styles.disabled,
          ]}
        >
          <Text style={styles.signOutText}>
            {isSignOutPending ? "Signing out..." : "Sign out"}
          </Text>
        </Pressable>
      </View>

      <AppCard elevated style={styles.card}>
        <Text style={styles.cardTitle}>Current workspace</Text>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Team</Text>
          <Text style={styles.detailValue}>{team.name}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Slug</Text>
          <Text style={styles.detailMono}>{team.slug}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Member actor</Text>
          <Text style={styles.detailMono}>{currentMemberActorId ?? "Not provisioned yet"}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Identity</Text>
          <Text style={styles.detailValue}>{isAnonymous ? "Anonymous guest" : "Verified account"}</Text>
        </View>
        {localError ? <Text style={styles.error}>{localError}</Text> : null}
      </AppCard>

      <AppCard compact style={styles.placeholderCard}>
        <Text style={styles.cardTitle}>What comes next</Text>
        <Text style={styles.placeholderBody}>
          Session list, team activity, and shared notes will connect into this shell in later
          tasks.
        </Text>
      </AppCard>

      <AppCard compact style={styles.placeholderCard}>
        <Text style={styles.cardTitle}>Invite flow placeholder</Text>
        <Text style={styles.placeholderBody}>
          This space is reserved for teammate invites and onboarding checkpoints once the
          broader app capabilities land.
        </Text>
      </AppCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
  },
  cardTitle: {
    color: colors.foreground,
    ...typography.cardTitle,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.xxl,
  },
  detailLabel: {
    color: colors.mutedForeground,
    flex: 1,
    ...typography.caption,
  },
  detailMono: {
    color: colors.foreground,
    flex: 1.4,
    textAlign: "right",
    ...typography.monoMeta,
  },
  detailRow: {
    alignItems: "center",
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    paddingTop: spacing.sm,
  },
  detailValue: {
    color: colors.foreground,
    flex: 1.4,
    textAlign: "right",
    ...typography.secondaryBody,
  },
  disabled: {
    opacity: 0.4,
  },
  error: {
    color: colors.danger,
    marginTop: spacing.xs,
    ...typography.caption,
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
  },
  metaPill: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  metaPillText: {
    color: colors.ink2,
    ...typography.caption,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  placeholderBody: {
    color: colors.ink2,
    ...typography.secondaryBody,
  },
  placeholderCard: {
    gap: spacing.xs,
  },
  pressed: {
    opacity: 0.85,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  signOutButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radii.button,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  signOutText: {
    color: colors.foreground,
    ...typography.cardTitle,
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
  titleBlock: {
    flex: 1,
    gap: spacing.sm,
  },
});
