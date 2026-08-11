import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, hai, iosType, spacing } from "../../../ui/theme";
import type { MentionTarget } from "./mentions";

export type MentionsPopupProps = {
  candidates: MentionTarget[];
  onSelect: (target: MentionTarget) => void;
};

/**
 * Inline autocomplete for `@`-mentions, ported from iOS `MentionsPopup`.
 *
 * Two things the row has to carry, and Expo's earlier version carried neither:
 * whether the target is a person or an agent, and which agent it is. Both rows
 * looked identical — the same cinnabar `@` and a name — so a session with
 * `claude` and `opencode` in it offered two indistinguishable choices, and a
 * teammate looked exactly like a runtime.
 */
export function MentionsPopup({ candidates, onSelect }: MentionsPopupProps) {
  if (candidates.length === 0) return null;

  return (
    <View style={styles.card}>
      {candidates.map((target, index) => (
        <Pressable
          accessibilityLabel={`${target.kind} ${target.displayName}`}
          accessibilityRole="button"
          key={target.actorId}
          onPress={() => onSelect(target)}
          style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
        >
          <View style={styles.glyph}>
            {target.kind === "agent" ? (
              <View style={styles.agentDot} />
            ) : (
              <Text style={styles.at}>@</Text>
            )}
          </View>
          <View style={styles.text}>
            <Text numberOfLines={1} style={styles.name}>
              {target.displayName}
            </Text>
            {target.subtitle ? (
              <Text numberOfLines={1} style={styles.subtitle}>
                {target.subtitle}
              </Text>
            ) : null}
          </View>
          {index < candidates.length - 1 ? <View style={styles.divider} /> : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  /* Agents get a 6px dot where members get `@` — same slate, different mark. */
  agentDot: {
    backgroundColor: colors.slate,
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  at: {
    color: colors.slate,
    ...iosType.caption,
    fontFamily: iosType.captionMono.fontFamily,
  },
  card: {
    backgroundColor: hai.pebble,
    borderColor: "rgba(34,32,29,0.08)",
    // iOS uses a 4pt radius here, tighter than the app's card radius — the
    // popup reads as an attached menu rather than a floating card.
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.xs,
    marginHorizontal: spacing.lg,
    overflow: "hidden",
  },
  /* Inset to clear the glyph column, as iOS insets its separator by 28. */
  divider: {
    backgroundColor: "rgba(34,32,29,0.08)",
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    left: 28,
    position: "absolute",
    right: 0,
  },
  glyph: {
    alignItems: "center",
    width: 16,
  },
  name: {
    color: colors.onyx,
    fontSize: 14,
    fontWeight: "600",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  rowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
  },
  subtitle: {
    color: colors.slate,
    fontSize: 11,
  },
  text: {
    flex: 1,
    gap: 1,
  },
});

export default MentionsPopup;
