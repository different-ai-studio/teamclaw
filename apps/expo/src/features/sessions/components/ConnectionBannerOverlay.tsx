import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, hai, spacing, typography } from "../../../ui/theme";
import type { SessionDetailConnectionState } from "../session-detail-controller";

export type ConnectionBannerOverlayProps = {
  connectionState: SessionDetailConnectionState | "connected" | "connecting" | "disconnected";
  onReconnect?: () => void;
};

/**
 * Top-of-screen connection banner that mirrors iOS
 * `ConnectionBannerOverlay`. Hidden when the realtime channel is
 * `connected`; shows a slim Cinnabar-tinted strip with a retry hint
 * otherwise. Designed to mount inside the Sessions tab root so it
 * floats above the list / detail content.
 */
export function ConnectionBannerOverlay({
  connectionState,
  onReconnect,
}: ConnectionBannerOverlayProps) {
  if (connectionState === "connected") return null;
  const isConnecting = connectionState === "connecting";

  return (
    <View style={styles.banner}>
      <Ionicons
        color={hai.cinnabarDeep}
        name={isConnecting ? "sync-outline" : "cloud-offline-outline"}
        size={14}
      />
      <Text style={styles.label}>
        {isConnecting ? "Reconnecting…" : "Realtime offline"}
      </Text>
      {!isConnecting && onReconnect ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={6}
          onPress={onReconnect}
          style={({ pressed }) => [styles.cta, pressed ? styles.ctaPressed : null]}
        >
          <Text style={styles.ctaText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.10)",
    borderBottomColor: "rgba(184,75,54,0.25)",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
  },
  cta: {
    paddingHorizontal: 6,
  },
  ctaPressed: {
    opacity: 0.6,
  },
  ctaText: {
    color: hai.cinnabar,
    ...typography.caption,
    fontWeight: "700",
  },
  label: {
    color: colors.basalt,
    flex: 1,
    ...typography.caption,
  },
});

export default ConnectionBannerOverlay;
