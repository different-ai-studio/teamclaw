import { StyleSheet, Text, View } from "react-native";

import { colors, spacing, typography } from "../../../ui/theme";

export type DaySeparatorProps = {
  label: string;
};

/**
 * Inline date marker drawn between messages from different days.
 * Mirrors the centered slate eyebrow iOS draws between message
 * groups inside `StreamingDetailView`.
 */
export function DaySeparator({ label }: DaySeparatorProps) {
  return (
    <View style={styles.row}>
      <View style={styles.line} />
      <Text style={styles.label}>{label}</Text>
      <View style={styles.line} />
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    color: colors.slate,
    ...typography.eyebrow,
    fontWeight: "700",
    paddingHorizontal: spacing.md,
  },
  line: {
    backgroundColor: colors.hairline,
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
});

export default DaySeparator;
