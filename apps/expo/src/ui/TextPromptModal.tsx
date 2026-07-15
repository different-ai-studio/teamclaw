import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Hairline } from "./atoms/Hairline";
import { colors, radii, spacing, typography } from "./theme";

export type TextPromptModalProps = {
  cancelLabel?: string;
  confirmLabel?: string;
  description?: string | null;
  initialValue?: string;
  isVisible: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  title: string;
};

/**
 * Cross-platform text prompt. iOS's `Alert.prompt` does not exist on
 * Android, so a custom Modal is the only way to keep parity. Stays
 * intentionally minimal — single text field, two buttons, no validation
 * hooks. Caller is responsible for trimming / dispatching the value.
 */
export function TextPromptModal({
  cancelLabel = "Cancel",
  confirmLabel = "Done",
  description = null,
  initialValue = "",
  isVisible,
  onCancel,
  onSubmit,
  placeholder,
  title,
}: TextPromptModalProps) {
  const [value, setValue] = useState(initialValue);

  // Reset when reopened so stale text from a prior session doesn't
  // bleed into the next prompt.
  useEffect(() => {
    if (isVisible) setValue(initialValue);
  }, [isVisible, initialValue]);

  const handleSubmit = () => {
    onSubmit(value);
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      transparent
      visible={isVisible}
    >
      <KeyboardAvoidingView
        behavior={Platform.select({ ios: "padding", default: undefined })}
        style={styles.backdrop}
      >
        <Pressable
          accessibilityLabel="Dismiss"
          onPress={onCancel}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          {description ? <Text style={styles.description}>{description}</Text> : null}
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onChangeText={setValue}
            onSubmitEditing={handleSubmit}
            placeholder={placeholder}
            placeholderTextColor={colors.slate}
            returnKeyType="done"
            selectionColor={colors.cinnabar}
            style={styles.input}
            value={value}
          />
          <Hairline style={styles.divider} />
          <View style={styles.buttons}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
            >
              <Text style={styles.buttonText}>{cancelLabel}</Text>
            </Pressable>
            <View style={styles.buttonDivider} />
            <Pressable
              accessibilityRole="button"
              onPress={handleSubmit}
              style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
            >
              <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
                {confirmLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: "center",
    backgroundColor: "rgba(34,32,29,0.35)",
    flex: 1,
    justifyContent: "center",
    padding: spacing.lg,
  },
  button: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingVertical: spacing.md,
  },
  buttonDivider: {
    backgroundColor: colors.hairline,
    width: StyleSheet.hairlineWidth,
  },
  buttonPressed: {
    opacity: 0.6,
  },
  buttonText: {
    color: colors.basalt,
    ...typography.body,
    fontWeight: "500",
  },
  buttonTextPrimary: {
    color: colors.cinnabar,
    fontWeight: "700",
  },
  buttons: {
    flexDirection: "row",
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 380,
    width: "100%",
  },
  description: {
    color: colors.basalt,
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    ...typography.secondaryBody,
  },
  divider: {
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.mist,
    borderColor: colors.hairline,
    borderRadius: radii.input,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.onyx,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.sm,
    ...typography.body,
  },
  title: {
    color: colors.onyx,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    ...typography.cardTitle,
  },
});

export default TextPromptModal;
