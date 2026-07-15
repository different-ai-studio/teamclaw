import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { colors, hai, radii, spacing, typography } from "./theme";

type IconName = ComponentProps<typeof Ionicons>["name"];

export type PermissionPrimerSheetProps = {
  body: string;
  cancelLabel?: string;
  ctaLabel?: string;
  iconName: IconName;
  onCancel: () => void;
  onContinue: () => void;
  title: string;
  visible: boolean;
};

/**
 * Reusable iOS-style "permission primer" sheet. Sits between the user
 * tapping a button and the actual OS permission prompt so the app can
 * explain *why* it needs the permission before the system dialog
 * fires. Mirrors the pattern Apple recommends — see
 * `AVFoundation.AVAuthorizationStatus.notDetermined` flows in iOS.
 */
export function PermissionPrimerSheet({
  body,
  cancelLabel = "Not now",
  ctaLabel = "Continue",
  iconName,
  onCancel,
  onContinue,
  title,
  visible,
}: PermissionPrimerSheetProps) {
  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible={visible}>
      <Pressable onPress={onCancel} style={styles.backdrop}>
        <Pressable onPress={(e) => e.stopPropagation()} style={styles.sheet}>
          <View style={styles.iconTile}>
            <Ionicons color={hai.paper} name={iconName} size={24} />
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.body}>{body}</Text>

          <Pressable
            accessibilityRole="button"
            onPress={onContinue}
            style={({ pressed }) => [styles.cta, pressed ? styles.ctaPressed : null]}
          >
            <Text style={styles.ctaText}>{ctaLabel}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onCancel}
            style={({ pressed }) => [styles.cancel, pressed ? styles.cancelPressed : null]}
          >
            <Text style={styles.cancelText}>{cancelLabel}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: "center",
    backgroundColor: "rgba(34,32,29,0.55)",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  body: {
    color: colors.basalt,
    textAlign: "center",
    ...typography.secondaryBody,
  },
  cancel: {
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  cancelPressed: {
    opacity: 0.6,
  },
  cancelText: {
    color: colors.slate,
    ...typography.body,
  },
  cta: {
    alignItems: "center",
    backgroundColor: hai.cinnabar,
    borderRadius: radii.button,
    marginTop: spacing.sm,
    paddingVertical: 12,
    width: "100%",
  },
  ctaPressed: {
    opacity: 0.88,
  },
  ctaText: {
    color: hai.paper,
    ...typography.cardTitle,
  },
  iconTile: {
    alignItems: "center",
    backgroundColor: hai.cinnabar,
    borderRadius: 999,
    height: 52,
    justifyContent: "center",
    width: 52,
  },
  sheet: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderRadius: 20,
    gap: spacing.md,
    padding: spacing.xl,
    width: "100%",
  },
  title: {
    color: colors.onyx,
    textAlign: "center",
    ...typography.cardTitle,
  },
});

export default PermissionPrimerSheet;
