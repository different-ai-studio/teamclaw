import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radii, spacing, typography } from "../../../ui/theme";

export type PermissionBannerProps = {
  toolName: string;
  description: string;
  requestId: string;
  isResolved?: boolean;
  /** When isResolved is true, true means Allowed, false means Denied. */
  wasGranted?: boolean | null;
  onGrant?: (requestId: string) => void;
  onDeny?: (requestId: string) => void;
};

/**
 * Inline grant/deny prompt rendered when a `permission_request` message
 * lands in the feed. Mirrors `apps/ios/.../PermissionBanner.swift`:
 *   - Cinnabar shield icon ("the intent moment" where vermillion is OK)
 *   - Tool name + description summary
 *   - Two pill buttons (Deny / Allow) while unresolved
 *   - Inline "Allowed" / "Denied" status once isResolved is true
 */
export function PermissionBanner({
  toolName,
  description,
  requestId,
  isResolved = false,
  wasGranted = null,
  onGrant,
  onDeny,
}: PermissionBannerProps) {
  const summary =
    toolName && description
      ? `${toolName}: ${description}`
      : toolName || description || "Tool permission requested";
  return (
    <View style={styles.outer}>
      <View style={styles.headerRow}>
        <Ionicons color={colors.cinnabar} name="shield-checkmark" size={16} />
        <Text style={styles.title}>Permission Request</Text>
      </View>
      <Text style={styles.body}>{summary}</Text>
      {isResolved ? (
        <View style={styles.resolvedRow}>
          <Ionicons
            color={wasGranted ? colors.sage : colors.cinnabarDeep}
            name={wasGranted ? "checkmark-circle" : "close-circle"}
            size={16}
          />
          <Text
            style={[
              styles.resolvedLabel,
              { color: wasGranted ? colors.sage : colors.cinnabarDeep },
            ]}
          >
            {wasGranted ? "Allowed" : "Denied"}
          </Text>
        </View>
      ) : (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={onDeny ? () => onDeny(requestId) : undefined}
            style={({ pressed }) => [
              styles.button,
              styles.buttonDeny,
              pressed ? styles.buttonPressed : null,
            ]}
          >
            <Text style={[styles.buttonLabel, styles.buttonLabelDeny]}>Deny</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onGrant ? () => onGrant(requestId) : undefined}
            style={({ pressed }) => [
              styles.button,
              styles.buttonAllow,
              pressed ? styles.buttonPressed : null,
            ]}
          >
            <Text style={[styles.buttonLabel, styles.buttonLabelAllow]}>Allow</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  body: {
    color: colors.basalt,
    ...typography.caption,
  },
  button: {
    alignItems: "center",
    borderRadius: radii.pill,
    flex: 1,
    paddingVertical: 8,
  },
  buttonAllow: {
    backgroundColor: "rgba(107,142,90,0.18)",
  },
  buttonDeny: {
    backgroundColor: "rgba(142,58,44,0.10)",
  },
  buttonLabel: {
    ...typography.body,
    fontWeight: "600",
  },
  buttonLabelAllow: {
    color: colors.sage,
  },
  buttonLabelDeny: {
    color: colors.cinnabarDeep,
  },
  buttonPressed: {
    opacity: 0.78,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  outer: {
    backgroundColor: colors.paper,
    borderColor: "rgba(184,75,54,0.30)",
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  resolvedLabel: {
    ...typography.body,
    fontWeight: "600",
  },
  resolvedRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  title: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "700",
  },
});

export default PermissionBanner;
