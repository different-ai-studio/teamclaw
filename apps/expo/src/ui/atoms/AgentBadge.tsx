import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, radii, spacing, theme } from "../theme";

import { StatusDot, type StatusDotKind } from "./StatusDot";

export type AgentBadgeProps = {
  label: string;
  status?: StatusDotKind | "none";
  /** Foreground/text color. Defaults to onyx. */
  fg?: string;
  /** Background color. Defaults to pebble. */
  bg?: string;
  /** Overrides the status dot's colour — iOS drives it off runtime status. */
  dotColor?: string;
  /** Overrides whether the status dot breathes (iOS: only while running). */
  breathing?: boolean;
  style?: ViewStyle;
};

/**
 * 22px-tall agent identifier: small status dot + glyph. Matches the iOS
 * `AgentRowView.badgeView`: 7px hpad, 6px radius, 5px status dot, 5px gap, and
 * a bold 11px label at 0.2 tracking.
 *
 * The label is set in the sans face, not mono: DESIGN.md describes it as a
 * "monospace glyph" but the shipping Swift uses `.system(size: 11, weight:
 * .bold)`, and matching what iOS renders beats matching what the doc says.
 */
export function AgentBadge({
  label,
  status = "active",
  fg = colors.onyx,
  bg = colors.pebble,
  dotColor,
  breathing,
  style,
}: AgentBadgeProps) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }, style]}>
      {status !== "none" ? (
        <StatusDot breathing={breathing} color={dotColor} kind={status} size={5} />
      ) : null}
      <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: "center",
    borderRadius: radii.card,
    flexDirection: "row",
    gap: spacing.xs + 1,
    height: 22,
    paddingHorizontal: 7,
  },
  label: {
    fontFamily: theme.fontFamilies.sans,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
});
