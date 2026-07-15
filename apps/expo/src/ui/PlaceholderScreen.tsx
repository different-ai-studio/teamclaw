import { StyleSheet, Text, View } from "react-native";

import { SectionEyebrow } from "./atoms/SectionEyebrow";
import { colors, spacing, typography } from "./theme";

export type PlaceholderScreenProps = {
  eyebrow: string;
  title: string;
  body: string;
};

/**
 * Quiet "coming soon" surface used while a Tab is awaiting its own
 * sub-spec implementation. Mirrors the Hai principle 不足の美 — a list
 * of three things does not need a card around it.
 */
export function PlaceholderScreen({ eyebrow, title, body }: PlaceholderScreenProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.copy}>
        <SectionEyebrow label={eyebrow} />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.basalt,
    ...typography.body,
  },
  copy: {
    gap: spacing.md,
    maxWidth: 440,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
  },
  title: {
    color: colors.onyx,
    ...typography.title,
  },
});
