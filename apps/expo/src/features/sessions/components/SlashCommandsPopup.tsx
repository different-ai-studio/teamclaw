import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { t } from "../../../lib/i18n";
import { colors, hai, iosType, spacing } from "../../../ui/theme";
import { type SlashCommand } from "./slash-commands";

export type SlashCommandsPopupProps = {
  candidates: SlashCommand[];
  onSelect: (command: SlashCommand) => void;
};

/** iOS caps the popup at 200pt and scrolls beyond it. */
const MAX_POPUP_HEIGHT = 200;

/**
 * Inline autocomplete for ACP slash commands, ported from iOS
 * `SlashCommandsPopup`.
 *
 * Two lines per row, not one. The top line pairs `/name` with the command's
 * `inputHint` pushed to the right; the description sits underneath. Expo used
 * to lay all three out inline and **drop the hint entirely**, so a command
 * taking an argument looked exactly like one that does not — the runtime sends
 * the hint, the type carries it, and only the view discarded it.
 */
export function SlashCommandsPopup({ candidates, onSelect }: SlashCommandsPopupProps) {
  const { t: tHook } = useTranslation();
  if (candidates.length === 0) return null;

  return (
    <View style={styles.card}>
      <ScrollView bounces={false} style={styles.scroll}>
        {candidates.map((command, index) => (
          <Pressable
            accessibilityHint={tHook("Inserts this command into the message")}
            accessibilityLabel={accessibilityLabel(command)}
            accessibilityRole="button"
            key={command.name}
            onPress={() => onSelect(command)}
            style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
          >
            <View style={styles.titleRow}>
              <Text numberOfLines={1} style={styles.name}>
                /{command.name}
              </Text>
              <View style={styles.titleSpacer} />
              {command.inputHint ? (
                <Text numberOfLines={1} style={styles.hint}>
                  {command.inputHint.toUpperCase()}
                </Text>
              ) : null}
            </View>
            {command.description ? (
              <Text numberOfLines={1} style={styles.description}>
                {command.description}
              </Text>
            ) : null}
            {index < candidates.length - 1 ? <View style={styles.divider} /> : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function accessibilityLabel(command: SlashCommand): string {
  const base = t("slash {{name}}. {{description}}", {
    name: command.name,
    description: command.description,
  });
  return command.inputHint
    ? t("{{base}}. argument {{hint}}", { base, hint: command.inputHint })
    : base;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: hai.pebble,
    borderColor: "rgba(34,32,29,0.08)",
    // 4pt, tighter than the app's card radius — this reads as a menu attached
    // to the composer, not a floating card.
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.xs,
    marginHorizontal: spacing.lg,
    overflow: "hidden",
  },
  description: {
    color: colors.basalt,
    fontSize: 12,
  },
  divider: {
    backgroundColor: "rgba(34,32,29,0.08)",
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    left: 12,
    position: "absolute",
    right: 0,
  },
  /* Mono, tracked and dimmed — reads as a placeholder, not a second label. */
  hint: {
    color: colors.slate,
    fontFamily: iosType.captionMono.fontFamily,
    fontSize: 10,
    letterSpacing: 2.8,
    opacity: 0.7,
  },
  name: {
    color: colors.onyx,
    flexShrink: 1,
    fontFamily: iosType.captionMono.fontFamily,
    fontSize: 15,
    fontWeight: "600",
  },
  row: {
    gap: 2,
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
  scroll: {
    maxHeight: MAX_POPUP_HEIGHT,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  titleSpacer: {
    flexGrow: 1,
    minWidth: 8,
  },
});

export default SlashCommandsPopup;
