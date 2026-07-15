import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radii, spacing, typography } from "../../../ui/theme";

export type ZeroAgentReminderSheetProps = {
  onAdd: () => void;
  onDismiss: () => void;
};

/**
 * Lightweight reminder shown the first time a team member opens a team that
 * has zero agent actors. Mirrors `apps/ios/.../ZeroAgentReminderSheet.swift`
 * — same copy, same two-button layout, same medium detent.
 */
export function ZeroAgentReminderSheet({ onAdd, onDismiss }: ZeroAgentReminderSheetProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.spacer} />
      <View style={styles.iconWrap}>
        <Ionicons color={colors.cinnabar} name="hardware-chip-outline" size={56} />
        <Text style={styles.title}>Add your first agent</Text>
        <Text style={styles.body}>
          This team doesn't have any agents yet. Add one to start streaming sessions.
        </Text>
      </View>
      <View style={styles.spacer} />
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          onPress={onAdd}
          style={({ pressed }) => [
            styles.primary,
            pressed ? styles.primaryPressed : null,
          ]}
        >
          <Text style={styles.primaryLabel}>Add agent</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={onDismiss}
          style={styles.secondary}
        >
          <Text style={styles.secondaryLabel}>Maybe later</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing.sm,
    paddingBottom: spacing.xxxl,
    paddingHorizontal: spacing.xl,
  },
  body: {
    color: colors.basalt,
    paddingHorizontal: spacing.lg,
    textAlign: "center",
    ...typography.secondaryBody,
  },
  iconWrap: {
    alignItems: "center",
    gap: spacing.md,
  },
  primary: {
    alignItems: "center",
    backgroundColor: colors.cinnabar,
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  primaryLabel: {
    color: colors.paper,
    ...typography.cardTitle,
  },
  primaryPressed: {
    opacity: 0.88,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
    paddingTop: spacing.lg,
  },
  secondary: {
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  secondaryLabel: {
    color: colors.basalt,
    ...typography.caption,
  },
  spacer: {
    flex: 1,
  },
  title: {
    color: colors.onyx,
    ...typography.cardTitle,
    fontSize: 22,
    fontWeight: "700",
  },
});

export default ZeroAgentReminderSheet;
