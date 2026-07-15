import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { Idea, IdeaStatus } from "../idea-types";

export type IdeaDetailScreenProps = {
  busyAction: "toggleStatus" | "archive" | "save" | null;
  creatorName: string | null;
  idea: Idea | null;
  isLoading: boolean;
  isRefreshing?: boolean;
  onArchive?: () => void;
  onClose: () => void;
  onRefresh?: () => void;
  onSaveContent?: (patch: { title: string; description: string }) => Promise<void>;
  onSelectSession?: (sessionId: string) => void;
  onSetStatus?: (next: IdeaStatus) => void;
  onStartSession?: () => void;
  onToggleStatus?: () => void;
  relatedSessions?: ReadonlyArray<{
    sessionId: string;
    title: string;
    lastMessageAt: string;
  }>;
};

type StatusPill = {
  label: string;
  foreground: string;
  background: string;
};

function statusPill(status: IdeaStatus): StatusPill {
  switch (status) {
    case "done":
      return {
        label: "DONE",
        foreground: hai.sage,
        background: "rgba(107,142,90,0.12)",
      };
    case "in_progress":
      return {
        label: "IN PROGRESS",
        foreground: hai.basalt,
        background: hai.pebble,
      };
    case "open":
    default:
      return {
        label: "OPEN",
        foreground: hai.cinnabar,
        background: "rgba(184,75,54,0.10)",
      };
  }
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

export function IdeaDetailScreen({
  busyAction,
  creatorName,
  idea,
  isLoading,
  isRefreshing,
  onArchive,
  onClose,
  onRefresh,
  onSaveContent,
  onSelectSession,
  onSetStatus,
  onStartSession,
  onToggleStatus,
  relatedSessions,
}: IdeaDetailScreenProps) {
  const [titleDraft, setTitleDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");

  useEffect(() => {
    setTitleDraft(idea?.title ?? "");
    setDescDraft(idea?.description ?? "");
  }, [idea?.ideaId, idea?.title, idea?.description]);

  const dirty =
    idea !== null &&
    (titleDraft.trim() !== idea.title.trim() ||
      descDraft.trim() !== (idea.description ?? "").trim());
  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Idea</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              onRefresh={onRefresh}
              refreshing={Boolean(isRefreshing)}
              tintColor={colors.slate}
            />
          ) : undefined
        }
      >
        {isLoading && idea === null ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.loadingText}>Loading idea…</Text>
          </View>
        ) : idea === null ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>Idea not found</Text>
            <Text style={styles.stateBody}>
              The idea may have been archived or removed.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.hero}>
              <Pressable
                accessibilityLabel="Change idea status"
                accessibilityRole={onSetStatus ? "button" : undefined}
                disabled={!onSetStatus || busyAction !== null}
                hitSlop={4}
                onPress={() => {
                  if (!onSetStatus) return;
                  const labels = ["Open", "In Progress", "Done", "Cancel"];
                  const values: IdeaStatus[] = ["open", "in_progress", "done"];
                  const dispatch = (index: number) => {
                    if (index < 0 || index >= values.length) return;
                    if (values[index] === idea.status) return;
                    onSetStatus(values[index]);
                  };
                  if (Platform.OS === "ios") {
                    ActionSheetIOS.showActionSheetWithOptions(
                      { options: labels, cancelButtonIndex: 3 },
                      dispatch,
                    );
                    return;
                  }
                  Alert.alert("设置状态", undefined, [
                    { text: labels[0], onPress: () => dispatch(0) },
                    { text: labels[1], onPress: () => dispatch(1) },
                    { text: labels[2], onPress: () => dispatch(2) },
                    { text: labels[3], style: "cancel" },
                  ]);
                }}
                style={[styles.pill, { backgroundColor: statusPill(idea.status).background }]}
              >
                <Text style={[styles.pillText, { color: statusPill(idea.status).foreground }]}>
                  {statusPill(idea.status).label}
                  {onSetStatus ? " ▾" : ""}
                </Text>
              </Pressable>
              <TextInput
                editable={!busyAction}
                multiline
                onChangeText={setTitleDraft}
                placeholder="Title"
                placeholderTextColor={hai.slate}
                selectionColor={hai.cinnabar}
                style={[styles.heroTitle, idea.status === "done" ? styles.heroTitleDone : null]}
                value={titleDraft}
              />
            </View>

            <View style={styles.section}>
              <SectionEyebrow label="DESCRIPTION" style={styles.sectionEyebrow} />
              <View style={styles.card}>
                <TextInput
                  editable={!busyAction}
                  multiline
                  onChangeText={setDescDraft}
                  placeholder="Add a description"
                  placeholderTextColor={hai.slate}
                  selectionColor={hai.cinnabar}
                  style={styles.descriptionText}
                  value={descDraft}
                />
              </View>
            </View>

            {dirty && onSaveContent ? (
              <Pressable
                accessibilityRole="button"
                disabled={busyAction !== null || titleDraft.trim().length === 0}
                onPress={() =>
                  onSaveContent({ title: titleDraft.trim(), description: descDraft })
                }
                style={({ pressed }) => [
                  styles.saveButton,
                  busyAction === "save" ? styles.actionBusy : null,
                  pressed ? styles.actionPressed : null,
                ]}
              >
                <Text style={styles.saveButtonText}>
                  {busyAction === "save" ? "Saving…" : "Save changes"}
                </Text>
              </Pressable>
            ) : null}

            <View style={styles.section}>
              <SectionEyebrow label="META" style={styles.sectionEyebrow} />
              <View style={styles.card}>
                <DetailRow label="Workspace" value={idea.workspaceName ?? "—"} />
                <Hairline />
                <DetailRow label="Created by" value={creatorName ?? "—"} />
                <Hairline />
                <DetailRow label="Created" value={formatTimestamp(idea.createdAt)} />
                <Hairline />
                <DetailRow label="Updated" value={formatTimestamp(idea.updatedAt)} />
              </View>
            </View>

            {relatedSessions && relatedSessions.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`RELATED SESSIONS · ${relatedSessions.length}`}
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  {relatedSessions.map((row, index) => (
                    <View key={row.sessionId}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={
                          onSelectSession
                            ? () => onSelectSession(row.sessionId)
                            : undefined
                        }
                        style={({ pressed }) => [
                          styles.detailRow,
                          pressed && onSelectSession ? { opacity: 0.7 } : null,
                        ]}
                      >
                        <Text numberOfLines={1} style={styles.detailLabel}>
                          {row.title || "Untitled session"}
                        </Text>
                        <Text style={styles.detailValue}>
                          {row.lastMessageAt
                            ? new Date(row.lastMessageAt).toLocaleDateString()
                            : "—"}
                        </Text>
                      </Pressable>
                      {index < relatedSessions.length - 1 ? <Hairline /> : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            {onStartSession ? (
              <Pressable
                accessibilityRole="button"
                onPress={onStartSession}
                style={({ pressed }) => [
                  styles.actionButton,
                  styles.actionStart,
                  pressed ? styles.actionPressed : null,
                ]}
              >
                <Text style={[styles.actionText, styles.actionStartText]}>
                  Start a session
                </Text>
              </Pressable>
            ) : null}

            {(onToggleStatus || onArchive) ? (
              <View style={styles.actions}>
                {onToggleStatus ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyAction !== null}
                    onPress={onToggleStatus}
                    style={({ pressed }) => [
                      styles.actionButton,
                      idea.status === "done"
                        ? styles.actionReopen
                        : styles.actionDone,
                      busyAction !== null ? styles.actionBusy : null,
                      pressed && busyAction === null ? styles.actionPressed : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.actionText,
                        idea.status === "done"
                          ? styles.actionReopenText
                          : styles.actionDoneText,
                      ]}
                    >
                      {busyAction === "toggleStatus"
                        ? "Saving…"
                        : idea.status === "done"
                        ? "Reopen"
                        : "Mark done"}
                    </Text>
                  </Pressable>
                ) : null}
                {onArchive ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyAction !== null}
                    onPress={onArchive}
                    style={({ pressed }) => [
                      styles.actionButton,
                      styles.actionArchive,
                      busyAction !== null ? styles.actionBusy : null,
                      pressed && busyAction === null ? styles.actionPressed : null,
                    ]}
                  >
                    <Text style={[styles.actionText, styles.actionArchiveText]}>
                      {busyAction === "archive" ? "Archiving…" : "Archive"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actionArchive: {
    backgroundColor: "rgba(184,75,54,0.10)",
  },
  actionArchiveText: {
    color: hai.cinnabar,
  },
  actionBusy: {
    opacity: 0.5,
  },
  actionButton: {
    alignItems: "center",
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  actionDone: {
    backgroundColor: hai.onyx,
  },
  actionDoneText: {
    color: hai.paper,
  },
  actionPressed: {
    opacity: 0.85,
  },
  actionReopen: {
    backgroundColor: hai.pebble,
  },
  actionStart: {
    backgroundColor: hai.cinnabar,
    marginBottom: spacing.sm,
  },
  actionStartText: {
    color: hai.paper,
  },
  actionReopenText: {
    color: hai.onyx,
  },
  actionText: {
    ...typography.cardTitle,
  },
  actions: {
    gap: spacing.sm,
  },
  saveButton: {
    alignItems: "center",
    backgroundColor: hai.cinnabar,
    borderRadius: radii.button,
    paddingVertical: 12,
  },
  saveButtonText: {
    color: hai.paper,
    ...typography.cardTitle,
  },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  descriptionText: {
    color: colors.onyx,
    padding: spacing.md,
    ...typography.body,
  },
  detailLabel: {
    color: colors.basalt,
    ...typography.body,
  },
  detailRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  detailValue: {
    color: colors.onyx,
    flexShrink: 1,
    ...typography.body,
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
  hero: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    padding: spacing.lg,
  },
  heroTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
    fontSize: 22,
    lineHeight: 28,
  },
  heroTitleDone: {
    color: colors.slate,
    textDecorationLine: "line-through",
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
  pill: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radii.chip,
    height: 20,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  pillText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
  sectionEyebrow: {
    paddingHorizontal: spacing.xs,
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
});

export default IdeaDetailScreen;
