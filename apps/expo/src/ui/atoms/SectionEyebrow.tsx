import { StyleSheet, Text, type TextStyle } from "react-native";

import { colors, typography } from "../theme";

export type SectionEyebrowProps = {
  label: string;
  num?: string | number;
  style?: TextStyle;
};

/**
 * Mono, uppercase, wide tracking. The `num` slot renders before the
 * label for "01 · ONBOARDING"-style eyebrows. Slate @ 70% opacity
 * matches the iOS spec for quiet section heads.
 */
export function SectionEyebrow({ label, num, style }: SectionEyebrowProps) {
  return (
    <Text style={[styles.eyebrow, style]}>
      {num !== undefined ? `${num}  ` : ""}
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    color: colors.slate,
    opacity: 0.7,
    ...typography.eyebrow,
  },
});
