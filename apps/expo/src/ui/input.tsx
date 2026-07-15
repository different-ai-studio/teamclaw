import { forwardRef } from "react";
import type { ComponentProps } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { colors, radii, spacing, typography } from "./theme";

type NativeInputProps = ComponentProps<typeof TextInput>;

export type AppInputProps = NativeInputProps & {
  label?: string;
  hint?: string;
  errorMessage?: string;
};

export const AppInput = forwardRef<TextInput, AppInputProps>(function AppInput(
  { editable = true, errorMessage, hint, label, style, ...inputProps },
  ref,
) {
  return (
    <View style={styles.container}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.faint}
        ref={ref}
        selectionColor={colors.coral}
        style={[
          styles.input,
          !editable && styles.inputDisabled,
          errorMessage ? styles.inputError : null,
          style,
        ]}
        {...inputProps}
      />
      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      {!errorMessage && hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
    width: "100%",
  },
  error: {
    color: colors.danger,
    ...typography.caption,
  },
  hint: {
    color: colors.mutedForeground,
    ...typography.caption,
  },
  input: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.input,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.foreground,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...typography.body,
  },
  inputDisabled: {
    backgroundColor: colors.panel,
    color: colors.mutedForeground,
  },
  inputError: {
    borderColor: colors.danger,
  },
  label: {
    color: colors.ink2,
    ...typography.cardTitle,
  },
});

export default AppInput;
