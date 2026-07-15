import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radii, spacing, typography } from "../../../ui/theme";
import type { MentionTarget } from "./mentions";

export type MentionsPopupProps = {
  candidates: MentionTarget[];
  onSelect: (target: MentionTarget) => void;
};

export function MentionsPopup({ candidates, onSelect }: MentionsPopupProps) {
  if (candidates.length === 0) return null;

  return (
    <View style={styles.card}>
      {candidates.map((target, index) => (
        <Pressable
          accessibilityRole="button"
          key={target.actorId}
          onPress={() => onSelect(target)}
          style={({ pressed }) => [
            styles.row,
            index === 0 ? null : styles.rowDivider,
            pressed ? styles.rowPressed : null,
          ]}
        >
          <Text style={styles.at}>@</Text>
          <Text style={styles.name}>{target.displayName}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  at: {
    color: colors.cinnabar,
    ...typography.body,
    fontWeight: "700",
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.xs,
    marginHorizontal: spacing.lg,
    overflow: "hidden",
  },
  name: {
    color: colors.onyx,
    ...typography.body,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  rowDivider: {
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
});

export default MentionsPopup;
