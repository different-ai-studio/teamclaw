import { Ionicons } from "@expo/vector-icons";
import { useCallback } from "react";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { StatusDot, type StatusDotKind } from "../../../ui/atoms/StatusDot";
import { colors, radii, spacing, typography } from "../../../ui/theme";

export type AgentRuntimeState =
  | "spawning"
  | "ready"
  | "idle"
  | "active"
  | "stopped"
  | "error";

export type AgentChip = {
  agentId: string;
  displayName: string;
  runtimeState: AgentRuntimeState;
};

export type AgentChipBarProps = {
  chips: AgentChip[];
  streamingAgentIds?: ReadonlySet<string>;
  onInterrupt?: (agentId: string) => void;
  onRemove?: (agentId: string) => void;
};

function runtimeKind(state: AgentRuntimeState): StatusDotKind {
  switch (state) {
    case "ready":
    case "idle":
      return "active";
    case "active":
      return "working";
    case "error":
      return "error";
    case "spawning":
    case "stopped":
      return "muted";
  }
}

/**
 * Horizontal strip of agent chips that sits above the composer.
 *
 * Mirrors `AgentChipBar.swift` in `apps/ios/Packages/AMUXUI/.../AgentDetail/`.
 * Each chip shows a runtime-state dot, the agent's display name, and either
 * an X button (idle — calls `onRemove`) or a stop button (currently
 * streaming — calls `onInterrupt`). Background is Paper + Cinnabar 12% tint
 * with a 0.5pt Cinnabar 60% stroke, matching the iOS capsule treatment.
 */
export function AgentChipBar({
  chips,
  streamingAgentIds,
  onInterrupt,
  onRemove,
}: AgentChipBarProps) {
  // Interrupting throws away the turn in flight, so it asks first and says
  // what is lost — iOS puts the same sentence in its alert. Removing a chip is
  // reversible, so that stays a single tap.
  const confirmInterrupt = useCallback(
    (agentId: string, displayName: string) => {
      const title = `Interrupt ${displayName}?`;
      const body = `Stop ${displayName}'s current response. The message it was working on won't be saved.`;
      const run = () => onInterrupt?.(agentId);
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title,
            message: body,
            options: ["Interrupt", "Cancel"],
            cancelButtonIndex: 1,
            destructiveButtonIndex: 0,
          },
          (index) => {
            if (index === 0) run();
          },
        );
        return;
      }
      Alert.alert(title, body, [
        { text: "Interrupt", style: "destructive", onPress: run },
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [onInterrupt],
  );

  if (chips.length === 0) {
    return null;
  }

  return (
    <ScrollView
      contentContainerStyle={styles.row}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      style={styles.container}
    >
      {chips.map((chip) => {
        const streaming = streamingAgentIds?.has(chip.agentId) ?? false;
        return (
          <View key={chip.agentId} style={styles.chip}>
            {/* Cinnabar wash over the Paper base. iOS layers the two rather
                than tinting alone: at 12% alpha with no opaque layer under it,
                the chat bubble behind bleeds straight through the chip. */}
            <View style={styles.chipTint} pointerEvents="none" />
            <StatusDot kind={runtimeKind(chip.runtimeState)} size={6} />
            <Text style={styles.label}>{chip.displayName}</Text>
            <Pressable
              accessibilityLabel={
                streaming ? `Interrupt ${chip.displayName}` : `Remove ${chip.displayName}`
              }
              accessibilityRole="button"
              hitSlop={6}
              onPress={() => {
                if (streaming) {
                  confirmInterrupt(chip.agentId, chip.displayName);
                } else {
                  onRemove?.(chip.agentId);
                }
              }}
              style={[styles.action, streaming ? styles.actionStreaming : null]}
            >
              <Ionicons
                color={streaming ? colors.cinnabarDeep : colors.cinnabar}
                name={streaming ? "stop" : "close"}
                size={9}
              />
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.18)",
    borderRadius: 999,
    height: 16,
    justifyContent: "center",
    width: 16,
  },
  actionStreaming: {
    backgroundColor: "rgba(184,75,54,0.22)",
  },
  chipTint: {
    backgroundColor: "rgba(184,75,54,0.12)",
    borderRadius: radii.pill,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  chip: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: "rgba(184,75,54,0.6)",
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
  },
  container: {
    flexGrow: 0,
    paddingVertical: spacing.xs,
  },
  label: {
    color: colors.onyx,
    ...typography.caption,
    fontWeight: "600",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
});

export default AgentChipBar;
