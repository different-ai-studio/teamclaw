import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, radii, spacing, typography } from "../theme";

import { StatusDot, type StatusDotKind } from "./StatusDot";

export type AgentBadgeProps = {
  label: string;
  status?: StatusDotKind | "none";
  /** Foreground/text color. Defaults to onyx. */
  fg?: string;
  /** Background color. Defaults to pebble. */
  bg?: string;
  style?: ViewStyle;
};

/**
 * 22px-tall agent identifier: small status dot + monospace glyph.
 * Matches the iOS spec: 7px hpad, 6px radius, agent-specific fg/bg
 * pair, 5px status dot, mono uppercase label.
 */
export function AgentBadge({
  label,
  status = "active",
  fg = colors.onyx,
  bg = colors.pebble,
  style,
}: AgentBadgeProps) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }, style]}>
      {status !== "none" ? <StatusDot kind={status} size={5} /> : null}
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
    ...typography.pill,
    fontSize: 10,
    letterSpacing: 1.4,
  },
});
