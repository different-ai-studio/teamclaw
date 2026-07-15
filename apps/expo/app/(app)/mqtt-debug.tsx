import { Stack, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  routeToHref,
  useOnboarding,
  useTeamMqtt,
} from "../_layout";
import {
  buildMqttDebugPresentation,
  type MqttDebugStatus,
} from "../../src/features/debug/mqtt-debug-state";
import type { ConnectionState } from "../../src/lib/mqtt/team-mqtt";
import { getOptionalMqttUrl } from "../../src/lib/mqtt/config";
import { StatusDot, type StatusDotKind } from "../../src/ui/atoms/StatusDot";
import { PrimaryButton } from "../../src/ui/button";
import { AppCard } from "../../src/ui/card";
import { colors, spacing, typography } from "../../src/ui/theme";

function dotKind(status: MqttDebugStatus): StatusDotKind {
  switch (status) {
    case "connected":
      return "active";
    case "connecting":
      return "working";
    case "disconnected":
      return "error";
    case "unavailable":
    case "unconfigured":
    default:
      return "muted";
  }
}

function formatTime(value: Date | null): string {
  if (!value) return "尚未收到状态事件";
  return value.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.debugRow}>
      <Text style={styles.debugLabel}>{label}</Text>
      <Text selectable style={styles.debugValue}>
        {value}
      </Text>
    </View>
  );
}

export default function MqttDebugRoute() {
  const router = useRouter();
  const { retryBootstrap, state } = useOnboarding();
  const mqtt = useTeamMqtt();
  const mqttUrl = getOptionalMqttUrl();
  const [observedState, setObservedState] = useState<ConnectionState | null>(null);
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);
  const href = routeToHref(state.route);

  useEffect(() => {
    setObservedState(null);
    setLastEventAt(null);
    if (!mqtt) return;
    return mqtt.onConnectionState((next) => {
      setObservedState(next);
      setLastEventAt(new Date());
    });
  }, [mqtt]);

  const presentation = useMemo(
    () => buildMqttDebugPresentation({ mqtt, mqttUrl, observedState }),
    [mqtt, mqttUrl, observedState],
  );

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Stack.Screen options={{ title: "MQTT Debug" }} />
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace(href ?? "/")}
          style={({ pressed }) => [styles.backButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.backText}>返回</Text>
        </Pressable>
        <Text style={styles.title}>MQTT Debug</Text>
        <Text style={styles.subtitle}>Shared client connection state</Text>
      </View>

      <AppCard style={styles.card}>
        <View style={styles.statusHeader}>
          <StatusDot kind={dotKind(presentation.status)} size={10} />
          <View style={styles.statusTextBlock}>
            <Text style={styles.statusTitle}>{presentation.title}</Text>
            <Text style={styles.statusDetail}>{presentation.detail}</Text>
          </View>
        </View>
      </AppCard>

      <AppCard style={styles.card}>
        <DebugRow label="status" value={presentation.status} />
        <DebugRow label="last event" value={formatTime(lastEventAt)} />
        <DebugRow label="mqtt url" value={mqttUrl ?? "未配置"} />
        <DebugRow label="shared client" value={mqtt ? "present" : "null"} />
        <DebugRow label="route" value={state.route} />
        <DebugRow label="team" value={state.currentTeam?.id ?? "none"} />
        <DebugRow label="actor" value={state.currentMemberActorId ?? "none"} />
      </AppCard>

      <PrimaryButton
        fullWidth={false}
        label="重新 bootstrap"
        onPress={() => {
          void retryBootstrap();
        }}
        style={styles.action}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  action: {
    alignSelf: "flex-start",
  },
  backButton: {
    alignSelf: "flex-start",
    paddingVertical: spacing.xs,
  },
  backText: {
    color: colors.basalt,
    ...typography.body,
  },
  card: {
    gap: spacing.md,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  debugLabel: {
    color: colors.slate,
    minWidth: 92,
    ...typography.monoMeta,
  },
  debugRow: {
    alignItems: "flex-start",
    borderBottomColor: colors.borderSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  debugValue: {
    color: colors.onyx,
    flex: 1,
    ...typography.monoMeta,
  },
  header: {
    gap: spacing.xs,
    paddingTop: spacing.md,
  },
  pressed: {
    opacity: 0.7,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  statusDetail: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  statusHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
  },
  statusTextBlock: {
    flex: 1,
    gap: 2,
  },
  statusTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  subtitle: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  title: {
    color: colors.onyx,
    ...typography.title,
  },
});
