import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, radii, spacing, typography } from "../theme";

export type PillTone = "default" | "active" | "muted" | "warn";

export type PillProps = {
  label: string;
  tone?: PillTone;
  style?: ViewStyle;
};

const TONE: Record<PillTone, { bg: string; fg: string }> = {
  default: { bg: colors.pebble, fg: colors.basalt },
  active: { bg: "rgba(107,142,90,0.18)", fg: colors.sage },
  muted: { bg: "rgba(166,163,156,0.18)", fg: colors.slate },
  warn: { bg: "rgba(184,75,54,0.14)", fg: colors.cinnabar },
};

/**
 * Pebble-fill, basalt-text, mono caps. Tone variants only shift the
 * fill/ink pair while keeping the Hai-correct shape (4px corners,
 * 7px horizontal pad, ~22px tall). Prefer raw text + StatusDot in flow;
 * use Pill sparingly per the design system.
 */
export function Pill({ label, tone = "default", style }: PillProps) {
  const { bg, fg } = TONE[tone];
  return (
    <View style={[styles.pill, { backgroundColor: bg }, style]}>
      <Text style={[styles.label, { color: fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    ...typography.pill,
  },
  pill: {
    alignSelf: "flex-start",
    borderRadius: radii.chip,
    paddingHorizontal: spacing.xs + 3,
    paddingVertical: 3,
  },
});
