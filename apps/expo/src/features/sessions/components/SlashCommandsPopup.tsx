import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radii, spacing, typography } from "../../../ui/theme";
import { type SlashCommand } from "./slash-commands";

export type SlashCommandsPopupProps = {
  candidates: SlashCommand[];
  onSelect: (command: SlashCommand) => void;
};

/**
 * Floating popup that lists matching slash commands above the
 * composer. Mirrors iOS `SlashCommandsPopup` — paper card with a
 * cinnabar leading slash glyph + bold command name + dim caption.
 * Renders null when there are no candidates so the parent can simply
 * mount it without guarding.
 */
export function SlashCommandsPopup({ candidates, onSelect }: SlashCommandsPopupProps) {
  if (candidates.length === 0) return null;

  return (
    <View style={styles.card}>
      {candidates.slice(0, 5).map((command, index) => (
        <Pressable
          accessibilityRole="button"
          key={command.name}
          onPress={() => onSelect(command)}
          style={({ pressed }) => [
            styles.row,
            index === 0 ? null : styles.rowDivider,
            pressed ? styles.rowPressed : null,
          ]}
        >
          <Text style={styles.slash}>/</Text>
          <Text style={styles.name}>{command.name}</Text>
          <Text numberOfLines={1} style={styles.description}>
            {command.description}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.xs,
    marginHorizontal: spacing.lg,
    overflow: "hidden",
  },
  description: {
    color: colors.slate,
    flexShrink: 1,
    ...typography.caption,
  },
  name: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
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
  slash: {
    color: colors.cinnabar,
    ...typography.body,
    fontWeight: "700",
  },
});

export default SlashCommandsPopup;
