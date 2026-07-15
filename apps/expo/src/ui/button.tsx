import type { ComponentProps } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radii, spacing, typography } from "./theme";

type PressableProps = ComponentProps<typeof Pressable>;

export type PrimaryButtonProps = PressableProps & {
  label: string;
  hint?: string;
  isLoading?: boolean;
  fullWidth?: boolean;
};

export function PrimaryButton({
  accessibilityRole = "button",
  disabled = false,
  fullWidth = true,
  hint,
  isLoading = false,
  label,
  style,
  ...pressableProps
}: PrimaryButtonProps) {
  const isDisabled = disabled || isLoading;

  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        fullWidth && styles.fullWidth,
        isDisabled && styles.buttonDisabled,
        pressed && !isDisabled && styles.buttonPressed,
        typeof style === "function" ? style({ pressed }) : style,
      ]}
      {...pressableProps}
    >
      <View style={styles.content}>
        {isLoading ? (
          <ActivityIndicator color={colors.paper} size="small" />
        ) : (
          <Text style={styles.label}>{label}</Text>
        )}
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    backgroundColor: colors.coral,
    borderRadius: radii.button,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonPressed: {
    opacity: 0.9,
  },
  content: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
  },
  fullWidth: {
    width: "100%",
  },
  hint: {
    color: colors.coralSoft,
    ...typography.monoMeta,
  },
  label: {
    color: colors.paper,
    ...typography.cardTitle,
  },
});

export default PrimaryButton;
