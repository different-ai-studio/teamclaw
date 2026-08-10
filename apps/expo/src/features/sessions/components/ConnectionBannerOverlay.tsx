import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, hai, spacing, typography } from "../../../ui/theme";
import type { SessionDetailConnectionState } from "../session-detail-controller";

export type ConnectionBannerOverlayProps = {
  connectionState: SessionDetailConnectionState | "connected" | "connecting" | "disconnected";
  onReconnect?: () => void;
};

/**
 * Top-of-screen connection banner, mirroring iOS `ConnectionBanner`. Hidden
 * while connected — agent availability is surfaced on the Actors tab, not
 * here.
 *
 * The two states are coloured apart, as iOS colours them: reconnecting is
 * amber because the client is still trying, disconnected is cinnabar because
 * it has stopped. Both used to be cinnabar, so "working on it" and "gave up"
 * looked identical.
 *
 * Shape is a deliberate divergence: iOS floats a capsule pill, this is a
 * full-width strip with its own Retry control. The strip suits a banner that
 * has to sit under a pinned glass header without colliding with it.
 */
export function ConnectionBannerOverlay({
  connectionState,
  onReconnect,
}: ConnectionBannerOverlayProps) {
  if (connectionState === "connected") return null;
  const isConnecting = connectionState === "connecting";
  const accent = isConnecting ? RECONNECTING_ACCENT : hai.cinnabarDeep;

  return (
    <View style={[styles.banner, isConnecting ? styles.bannerConnecting : null]}>
      <Ionicons
        color={accent}
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

/**
 * The amber `StatusDot` uses for "in flight". Hai ships no yellow, and iOS
 * reaches for the system one here.
 */
const RECONNECTING_ACCENT = "#C68A3A";

const styles = StyleSheet.create({
  bannerConnecting: {
    backgroundColor: "rgba(198,138,58,0.10)",
    borderBottomColor: "rgba(198,138,58,0.25)",
  },
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
