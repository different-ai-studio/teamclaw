import { Ionicons } from "@expo/vector-icons";
import { useCallback } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { StatusDot } from "../../../ui/atoms/StatusDot";
import { SwipeableRow } from "../../../ui/SwipeableRow";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, hai, iosType, spacing } from "../../../ui/theme";
import {
  agentTrailingLabel,
  canChangeAgentModel,
  lifecycleDotKind,
  type AgentLifecycleState,
} from "../agent-runtime-state";

export type MemberSheetHuman = {
  actorId: string;
  displayName: string;
  isOnline: boolean;
  /** False for yourself — iOS hides the remove control rather than disabling it. */
  canRemove: boolean;
};

export type MemberSheetAgent = {
  actorId: string;
  displayName: string;
  /** Capitalised backend name ("Claude" / "OpenCode" / "Codex"), or "". */
  agentType: string;
  state: AgentLifecycleState;
  availableModels: ReadonlyArray<{ id: string; displayName: string }>;
  currentModel: string | null;
};

export type SessionMemberSheetProps = {
  agents: ReadonlyArray<MemberSheetAgent>;
  humans: ReadonlyArray<MemberSheetHuman>;
  isLoading: boolean;
  onAddAgent?: () => void;
  onAddMember?: () => void;
  onChangeAgentModel?: (actorId: string) => void;
  onClose: () => void;
  onRemoveActor?: (actorId: string) => void;
  onRestartAgentRuntime?: (actorId: string) => void;
};

/** The two 22pt cinnabar add buttons in iOS's `topBarTrailing` slot. */
function ToolbarButton({
  accessibilityLabel,
  iconName,
  onPress,
}: {
  accessibilityLabel: string;
  iconName: React.ComponentProps<typeof Ionicons>["name"];
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={!onPress}
      hitSlop={8}
      onPress={onPress}
      style={styles.toolbarButton}
    >
      <Ionicons
        color={onPress ? hai.cinnabar : colors.slate}
        name={iconName}
        size={22}
      />
    </Pressable>
  );
}

export function SessionMemberSheet({
  agents,
  humans,
  isLoading,
  onAddAgent,
  onAddMember,
  onChangeAgentModel,
  onClose,
  onRemoveActor,
  onRestartAgentRuntime,
}: SessionMemberSheetProps) {
  const isEmpty = humans.length === 0 && agents.length === 0;

  const confirmRemoveHuman = useCallback(
    (human: MemberSheetHuman) => {
      if (!onRemoveActor) return;
      const remove = () => onRemoveActor(human.actorId);
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [`Remove ${human.displayName}`, "Cancel"],
            cancelButtonIndex: 1,
            destructiveButtonIndex: 0,
          },
          (index) => {
            if (index === 0) remove();
          },
        );
        return;
      }
      Alert.alert("Remove from session", human.displayName, [
        { text: "Remove", style: "destructive", onPress: remove },
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [onRemoveActor],
  );

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
        <Text style={styles.headerTitle}>Actors</Text>
        <View style={styles.headerActions}>
          <ToolbarButton
            accessibilityLabel="Add member"
            iconName="person-add-outline"
            onPress={onAddMember}
          />
          <ToolbarButton
            accessibilityLabel="Add agent"
            iconName="sparkles-outline"
            onPress={onAddAgent}
          />
        </View>
      </GlassHeader>

      <ScrollView contentContainerStyle={styles.content}>
        {isLoading && isEmpty ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.loadingText}>Loading actors…</Text>
          </View>
        ) : isEmpty ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>No participants</Text>
            <Text style={styles.stateBody}>
              This session doesn't have any actors yet.
            </Text>
          </View>
        ) : (
          <View style={styles.groups}>
            <View style={styles.section}>
              <SectionEyebrow label="MEMBERS" style={styles.sectionLabel} />
              <View style={styles.card}>
                {humans.length === 0 ? (
                  <Text style={styles.sectionEmpty}>No members yet.</Text>
                ) : (
                  humans.map((human, index) => (
                    <View key={human.actorId}>
                      <HumanMemberRow
                        human={human}
                        onRemove={
                          human.canRemove && onRemoveActor
                            ? () => confirmRemoveHuman(human)
                            : undefined
                        }
                      />
                      {index < humans.length - 1 ? <Hairline /> : null}
                    </View>
                  ))
                )}
              </View>
            </View>

            <View style={styles.section}>
              <SectionEyebrow label="AGENTS" style={styles.sectionLabel} />
              <View style={styles.card}>
                {agents.length === 0 ? (
                  <Text style={styles.sectionEmpty}>
                    No agents in this session yet. Add one from the toolbar.
                  </Text>
                ) : (
                  agents.map((agent, index) => (
                    <View key={agent.actorId}>
                      <AgentMemberRow
                        agent={agent}
                        onChangeModel={
                          onChangeAgentModel
                            ? () => onChangeAgentModel(agent.actorId)
                            : undefined
                        }
                        onRemove={
                          onRemoveActor
                            ? () => onRemoveActor(agent.actorId)
                            : undefined
                        }
                        onRestart={
                          onRestartAgentRuntime
                            ? () => onRestartAgentRuntime(agent.actorId)
                            : undefined
                        }
                      />
                      {index < agents.length - 1 ? <Hairline /> : null}
                    </View>
                  ))
                )}
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function HumanMemberRow({
  human,
  onRemove,
}: {
  human: MemberSheetHuman;
  onRemove?: () => void;
}) {
  return (
    <View style={styles.row}>
      <StatusDot breathing={false} kind={human.isOnline ? "active" : "muted"} size={8} />
      <Text numberOfLines={1} style={styles.rowName}>
        {human.displayName}
      </Text>
      <View style={styles.rowSpacer} />
      {onRemove ? (
        <Pressable
          accessibilityLabel={`Remove ${human.displayName}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onRemove}
          style={styles.rowTrailingButton}
        >
          <Ionicons color={hai.cinnabar} name="close-circle-outline" size={20} />
        </Pressable>
      ) : null}
    </View>
  );
}

function AgentMemberRow({
  agent,
  onChangeModel,
  onRemove,
  onRestart,
}: {
  agent: MemberSheetAgent;
  onChangeModel?: () => void;
  onRemove?: () => void;
  onRestart?: () => void;
}) {
  const trailing = agentTrailingLabel({
    currentModel: agent.currentModel,
    state: agent.state,
  });
  const interactive =
    Boolean(onChangeModel) &&
    canChangeAgentModel({
      availableModels: agent.availableModels,
      state: agent.state,
    });

  const actions = [
    ...(onRestart
      ? [{ label: "Restart", iconName: "refresh-outline" as const, onPress: onRestart }]
      : []),
    ...(onRemove
      ? [
          {
            label: "Remove",
            iconName: "close-outline" as const,
            onPress: onRemove,
            destructive: true,
          },
        ]
      : []),
  ];

  return (
    <SwipeableRow trailingActions={actions}>
      <View style={styles.row}>
        <StatusDot kind={lifecycleDotKind(agent.state)} size={8} />
        <Text numberOfLines={1} style={styles.rowName}>
          {agent.displayName}
        </Text>
        {agent.agentType ? (
          <Text numberOfLines={1} style={styles.rowType}>
            {agent.agentType}
          </Text>
        ) : null}
        <View style={styles.rowSpacer} />
        {trailing.kind === "spinner" ? (
          <ActivityIndicator color={colors.slate} size="small" />
        ) : interactive ? (
          <Pressable
            accessibilityLabel={`Change model for ${agent.displayName}`}
            accessibilityRole="button"
            hitSlop={6}
            onPress={onChangeModel}
            style={styles.modelChip}
          >
            <Text numberOfLines={1} style={styles.modelText}>
              {trailing.kind === "model" ? trailing.text : "default"}
            </Text>
            <Ionicons color={colors.slate} name="chevron-expand" size={12} />
          </Pressable>
        ) : (
          <Text numberOfLines={1} style={styles.modelText}>
            {trailing.kind === "model" ? trailing.text : "default"}
          </Text>
        )}
      </View>
    </SwipeableRow>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
    paddingTop: GLASS_HEADER_HEIGHT,
  },
  groups: {
    gap: spacing.lg,
  },
  headerActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    ...iosType.headline,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  loadingText: {
    color: colors.basalt,
    ...iosType.subheadline,
  },
  modelChip: {
    alignItems: "center",
    flexDirection: "row",
    gap: 2,
    maxWidth: 160,
  },
  modelText: {
    color: colors.basalt,
    flexShrink: 1,
    ...iosType.caption,
  },
  row: {
    alignItems: "center",
    backgroundColor: colors.paper,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
  },
  rowName: {
    color: colors.onyx,
    flexShrink: 1,
    fontWeight: "600",
    ...iosType.body,
  },
  rowSpacer: {
    flexGrow: 1,
    minWidth: 8,
  },
  rowTrailingButton: {
    alignItems: "center",
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  rowType: {
    color: colors.slate,
    flexShrink: 1,
    ...iosType.caption,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
  sectionEmpty: {
    color: colors.slate,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    ...iosType.footnote,
  },
  sectionLabel: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  stateBlock: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  stateBody: {
    color: colors.basalt,
    ...iosType.subheadline,
  },
  stateTitle: {
    color: colors.onyx,
    ...iosType.title3,
  },
  toolbarButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    minWidth: 40,
  },
});

export default SessionMemberSheet;
