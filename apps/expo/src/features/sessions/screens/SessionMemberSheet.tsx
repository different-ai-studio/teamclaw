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

import { ActorRow } from "../../actors/components/ActorRow";
import { isAgentActor, isMemberActor, type Actor } from "../../actors/actor-types";
import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, spacing, typography } from "../../../ui/theme";

export type SessionMemberSheetProps = {
  actors: Actor[];
  currentActorId: string | null;
  isLoading: boolean;
  /** Maps actorId → current model id, used to label the row's trailing chip. */
  agentModelByActorId?: ReadonlyMap<string, string | null>;
  onAddAgent?: () => void;
  onAddMember?: () => void;
  onChangeAgentModel?: (actorId: string) => void;
  onClose: () => void;
  onRemoveActor?: (actorId: string) => void;
  onRestartAgentRuntime?: (actorId: string) => void;
};

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
        color={onPress ? colors.onyx : colors.slate}
        name={iconName}
        size={22}
      />
    </Pressable>
  );
}

export function SessionMemberSheet({
  actors,
  currentActorId,
  isLoading,
  agentModelByActorId,
  onAddAgent,
  onAddMember,
  onChangeAgentModel,
  onClose,
  onRemoveActor,
  onRestartAgentRuntime,
}: SessionMemberSheetProps) {
  const humans = actors.filter(isMemberActor);
  const agents = actors.filter(isAgentActor);

  const showHumanActionSheet = useCallback(
    (actor: Actor) => {
      if (!onRemoveActor) return;
      const labels = [`Remove ${actor.displayName}`, "Cancel"];
      const dispatch = (index: number) => {
        if (index === 0) onRemoveActor(actor.actorId);
      };
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: labels,
            cancelButtonIndex: 1,
            destructiveButtonIndex: 0,
          },
          dispatch,
        );
        return;
      }
      Alert.alert("Remove from session", actor.displayName, [
        { text: labels[0], style: "destructive", onPress: () => dispatch(0) },
        { text: labels[1], style: "cancel" },
      ]);
    },
    [onRemoveActor],
  );

  const showAgentActionSheet = useCallback(
    (actor: Actor) => {
      // Mirrors iOS SessionMemberSheet swipe actions (Change model / Restart /
      // Remove). React Native doesn't have a 1:1 swipeActions equivalent on
      // ScrollView rows, so we surface the same menu via long-press instead.
      const labels: string[] = [];
      const handlers: Array<() => void> = [];
      if (onChangeAgentModel) {
        labels.push("Change model…");
        handlers.push(() => onChangeAgentModel(actor.actorId));
      }
      if (onRestartAgentRuntime) {
        labels.push("Restart runtime");
        handlers.push(() => onRestartAgentRuntime(actor.actorId));
      }
      if (onRemoveActor) {
        labels.push(`Remove ${actor.displayName}`);
        handlers.push(() => onRemoveActor(actor.actorId));
      }
      if (labels.length === 0) return;
      labels.push("Cancel");

      const destructiveButtonIndex = onRemoveActor ? labels.length - 2 : -1;
      const cancelButtonIndex = labels.length - 1;

      const dispatch = (index: number) => {
        const handler = handlers[index];
        if (handler) handler();
      };

      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: labels,
            cancelButtonIndex,
            destructiveButtonIndex:
              destructiveButtonIndex >= 0 ? destructiveButtonIndex : undefined,
          },
          dispatch,
        );
        return;
      }
      Alert.alert(
        actor.displayName,
        undefined,
        labels.map((label, index) => {
          if (index === cancelButtonIndex) {
            return { text: label, style: "cancel" as const };
          }
          if (index === destructiveButtonIndex) {
            return {
              text: label,
              style: "destructive" as const,
              onPress: () => dispatch(index),
            };
          }
          return { text: label, onPress: () => dispatch(index) };
        }),
      );
    },
    [onChangeAgentModel, onRemoveActor, onRestartAgentRuntime],
  );

  const agentRowDisabled =
    !onChangeAgentModel && !onRestartAgentRuntime && !onRemoveActor;

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
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
      </View>
      <Hairline />

      <ScrollView contentContainerStyle={styles.content}>
        {isLoading && actors.length === 0 ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.loadingText}>Loading members…</Text>
          </View>
        ) : actors.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>No participants</Text>
            <Text style={styles.stateBody}>
              This session doesn't have any actors yet.
            </Text>
          </View>
        ) : (
          <View style={styles.groups}>
            {humans.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`MEMBERS · ${humans.length}`}
                  style={styles.sectionLabel}
                />
                <View>
                  {humans.map((actor, index) => (
                    <Pressable
                      delayLongPress={350}
                      disabled={!onRemoveActor || actor.actorId === currentActorId}
                      key={actor.actorId}
                      onLongPress={() => showHumanActionSheet(actor)}
                    >
                      <ActorRow actor={actor} isMe={actor.actorId === currentActorId} />
                      {index < humans.length - 1 ? (
                        <Hairline style={styles.rowDivider} />
                      ) : null}
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
            {agents.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`AGENTS · ${agents.length}`}
                  style={styles.sectionLabel}
                />
                <View>
                  {agents.map((actor, index) => {
                    const model = agentModelByActorId?.get(actor.actorId) ?? null;
                    return (
                      <Pressable
                        delayLongPress={350}
                        disabled={agentRowDisabled}
                        key={actor.actorId}
                        onLongPress={() => showAgentActionSheet(actor)}
                      >
                        <View style={styles.agentRow}>
                          <View style={styles.agentRowMain}>
                            <ActorRow actor={actor} />
                          </View>
                          {model || onChangeAgentModel ? (
                            <Pressable
                              accessibilityLabel="Change model"
                              accessibilityRole="button"
                              disabled={!onChangeAgentModel}
                              hitSlop={6}
                              onPress={() => onChangeAgentModel?.(actor.actorId)}
                              style={styles.modelChip}
                            >
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.modelChipText,
                                  model ? null : styles.modelChipTextMuted,
                                ]}
                              >
                                {model ?? "default"}
                              </Text>
                              {onChangeAgentModel ? (
                                <Ionicons
                                  color={colors.slate}
                                  name="chevron-down"
                                  size={12}
                                />
                              ) : null}
                            </Pressable>
                          ) : null}
                        </View>
                        {index < agents.length - 1 ? (
                          <Hairline style={styles.rowDivider} />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  agentRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  agentRowMain: {
    flex: 1,
  },
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  groups: {
    gap: spacing.lg,
  },
  headerActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
  },
  headerBar: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
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
    ...typography.secondaryBody,
  },
  modelChip: {
    alignItems: "center",
    flexDirection: "row",
    gap: 2,
    marginRight: spacing.lg,
    maxWidth: 140,
  },
  modelChipText: {
    color: colors.basalt,
    ...typography.caption,
  },
  modelChipTextMuted: {
    color: colors.slate,
  },
  rowDivider: {
    marginLeft: 70,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
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
    ...typography.secondaryBody,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  toolbarButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    minWidth: 40,
  },
});

export default SessionMemberSheet;
