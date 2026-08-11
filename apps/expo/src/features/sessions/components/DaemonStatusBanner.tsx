import { StyleSheet, Text, View } from "react-native";

import { StatusDot } from "../../../ui/atoms/StatusDot";
import { colors, hai, spacing } from "../../../ui/theme";
import { daemonStatusLabel, type DaemonConnectionState } from "../voice-level";

/**
 * Top-of-Sessions pill summarising daemon reachability and the broker host,
 * ported from the iOS `DaemonStatusBanner`. Sage-tinted with a breathing dot
 * when online, muted Pebble when connecting or offline.
 *
 * Distinct from `ConnectionBannerOverlay`, which covers a single session's live
 * stream — this one answers "is the daemon reachable at all", at the top of the
 * list.
 */

export type DaemonStatusBannerProps = {
  connectionState: DaemonConnectionState;
  /** Broker host, shown in mono after the label. Empty hides it. */
  brokerHost?: string;
};

export function DaemonStatusBanner({
  brokerHost = "",
  connectionState,
}: DaemonStatusBannerProps) {
  const isOnline = connectionState === "connected";

  return (
    <View style={[styles.pill, isOnline ? styles.pillOnline : styles.pillOffline]}>
      <StatusDot
        breathing={isOnline}
        color={isOnline ? hai.sage : hai.slate}
        size={8}
      />
      <Text style={[styles.label, isOnline ? styles.labelOnline : styles.labelOffline]}>
        {daemonStatusLabel(connectionState)}
      </Text>
      {brokerHost ? (
        <Text ellipsizeMode="middle" numberOfLines={1} style={styles.host}>
          {brokerHost}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    color: "rgba(94,91,85,0.75)",
    flexShrink: 1,
    fontFamily: "monospace",
    fontSize: 11,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
  },
  labelOffline: {
    color: colors.basalt,
  },
  labelOnline: {
    color: hai.sage,
  },
  pill: {
    alignItems: "center",
    borderRadius: 12,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pillOffline: {
    backgroundColor: "rgba(226,223,217,0.45)",
  },
  pillOnline: {
    backgroundColor: "rgba(107,142,90,0.12)",
  },
});

export type { DaemonConnectionState };

export default DaemonStatusBanner;
