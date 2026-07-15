import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";

import { Hairline } from "../../../ui/atoms/Hairline";
import { StatusDot } from "../../../ui/atoms/StatusDot";
import { colors, hai, spacing, typography } from "../../../ui/theme";
import {
  AgentChipBar,
  type AgentChip,
} from "../components/AgentChipBar";
import { ConnectionBannerOverlay } from "../components/ConnectionBannerOverlay";
import { DaySeparator } from "../components/DaySeparator";
import { buildThinkingPreview } from "../components/agent-thinking-presentation";
import { dayLabel, isSameCalendarDay } from "../components/day-separator-labels";
import { MentionsPopup } from "../components/MentionsPopup";
import {
  applyMention,
  filterMentionCandidates,
  mentionQuery,
  type MentionTarget,
} from "../components/mentions";
import { SessionComposerShell } from "../components/SessionComposerShell";
import { SessionMessageRow } from "../components/SessionMessageRow";
import { SessionPlansPanel } from "../components/SessionPlansPanel";
import {
  getOutboxSnapshot,
  subscribeOutbox,
  type OutboxStatus,
} from "../outbox-store";
import {
  getPendingAttachmentSnapshot,
  removePendingAttachment,
  subscribePendingAttachments,
} from "../pending-attachments";
import {
  deriveAgentPlanSnapshots,
  type AgentPlanSnapshot,
} from "../plan-snapshot";
import { SlashCommandsPopup } from "../components/SlashCommandsPopup";
import {
  filterSlashCommands,
  BUILT_IN_SLASH_COMMANDS,
  slashPrefix,
  type SlashCommand,
} from "../components/slash-commands";
import { TodoDock } from "../components/TodoDock";
import type {
  SessionDetailConnectionState,
  SessionDetailControllerState,
} from "../session-detail-controller";
import {
  buildSessionFeedSources,
  type AgentTurnFeedItem,
  type SessionFeedSource,
} from "../session-feed-items";
import {
  isFeedNearBottom,
  shouldAutoScrollForNewFeedItem,
  shouldAutoScrollFeed,
} from "../session-feed-scroll";
import {
  buildAgentTurnDetailGroups,
  type AgentTurnDetailGroupKind,
} from "../session-turn-detail";
import type { SessionMessage, SessionSummary } from "../session-types";

type SessionDetailRenderableState = SessionDetailControllerState & {
  status: "empty" | "ready" | "error";
  session: SessionSummary;
};

type SessionDetailScreenProps = {
  agentChips?: AgentChip[];
  composerText: string;
  connectionState: SessionDetailConnectionState;
  headerAvatars?: ReadonlyArray<{ actorId: string; avatarUrl?: string | null; initial: string }>;
  isSending: boolean;
  onChangeRuntimeModel?: () => void;
  runtimeInfo?: { status: string; currentModel: string | null } | null;
  isMuted?: boolean;
  mentionPool?: ReadonlyArray<MentionTarget>;
  onAgentInterrupt?: (agentId: string) => void;
  onAgentRemove?: (agentId: string) => void;
  onAttach?: () => void;
  onBack: () => void;
  onChangeComposerText: (value: string) => void;
  isRefreshing?: boolean;
  onClearReply?: () => void;
  onDeleteMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string, currentContent: string) => void;
  onGrantPermission?: (requestId: string, message: SessionMessage) => void;
  onDenyPermission?: (requestId: string, message: SessionMessage) => void;
  resolvedPermissionsByRequestId?: ReadonlyMap<string, boolean>;
  onReconnect?: () => void;
  onRefresh?: () => void;
  onOpenMembers?: () => void;
  onRetryFailed?: (messageId: string) => void;
  onReplyToMessage?: (messageId: string) => void;
  onSend: () => void;
  onShare?: () => void;
  onToggleMute?: () => void;
  ownActorId?: string;
  replyTarget?: { messageId: string; content: string } | null;
  senderAvatars?: ReadonlyMap<string, string | null>;
  /** Optional override for per-actor avatar glyph (e.g. CC/OC/CX). */
  senderAvatarGlyphs?: ReadonlyMap<string, string>;
  senderNames?: ReadonlyMap<string, string>;
  sendErrorMessage: string | null;
  slashCommands?: readonly SlashCommand[];
  state: SessionDetailRenderableState;
  streamingAgentIds?: ReadonlySet<string>;
  todoText?: string;
};

function runtimeStatusKind(
  status: string,
): "active" | "working" | "idle" | "error" | "muted" {
  switch (status.trim().toLowerCase()) {
    case "ready":
    case "idle":
      return "active";
    case "running":
    case "streaming":
      return "working";
    case "spawning":
    case "starting":
      return "idle";
    case "error":
    case "failed":
      return "error";
    case "stopped":
    case "exited":
      return "muted";
    default:
      return "idle";
  }
}

function connectionDescriptor(
  state: SessionDetailConnectionState,
): { dot: "active" | "idle" | "error"; label: string } {
  switch (state) {
    case "connected":
      return { dot: "active", label: "Live" };
    case "connecting":
      return { dot: "idle", label: "Connecting" };
    case "disconnected":
    default:
      return { dot: "error", label: "Offline" };
  }
}

function SessionHeader({
  connectionState,
  headerAvatars,
  isMuted,
  onBack,
  onOpenMembers,
  onShare,
  onTogglePlans,
  plansPanelOpen,
  onToggleMute,
  session,
}: {
  connectionState: SessionDetailConnectionState;
  headerAvatars?: ReadonlyArray<{ actorId: string; avatarUrl?: string | null; initial: string }>;
  isMuted?: boolean;
  onBack: () => void;
  onOpenMembers?: () => void;
  onShare?: () => void;
  onTogglePlans?: () => void;
  plansPanelOpen?: boolean;
  onToggleMute?: () => void;
  session: SessionSummary;
}) {
  const title = session.title.trim() || "Untitled session";
  const status = connectionDescriptor(connectionState);

  return (
    <View>
      <View style={styles.headerBar}>
        <Pressable hitSlop={8} onPress={onBack} style={styles.headerSlot}>
          <Ionicons name="chevron-back" size={26} color={colors.onyx} />
        </Pressable>
        {headerAvatars && headerAvatars.length > 0 ? (
          <View style={styles.headerAvatars}>
            {headerAvatars.slice(0, 3).map((avatar, index) => (
              <View
                key={avatar.actorId}
                style={[styles.headerAvatarTile, { marginLeft: index === 0 ? 0 : -8 }]}
              >
                {avatar.avatarUrl ? (
                  <Image
                    accessibilityRole="image"
                    source={{ uri: avatar.avatarUrl }}
                    style={styles.headerAvatarImage}
                  />
                ) : (
                  <Text style={styles.headerAvatarInitial}>{avatar.initial}</Text>
                )}
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.headerTitleBlock}>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {title}
          </Text>
          <View style={styles.headerStatus}>
            <StatusDot kind={status.dot} size={6} />
            <Text style={styles.headerStatusLabel}>{status.label}</Text>
            <Text style={styles.headerSeparator}>·</Text>
            <Text style={styles.headerStatusLabel}>
              {session.participantCount}{" "}
              {session.participantCount === 1 ? "actor" : "actors"}
            </Text>
          </View>
        </View>
        {onTogglePlans ? (
          <Pressable
            accessibilityLabel={plansPanelOpen ? "Hide plans" : "Show plans"}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onTogglePlans}
            style={styles.headerSlot}
          >
            <Ionicons
              color={plansPanelOpen ? colors.cinnabar : colors.onyx}
              name="list-outline"
              size={20}
            />
          </Pressable>
        ) : null}
        {onShare ? (
          <Pressable hitSlop={8} onPress={onShare} style={styles.headerSlot}>
            <Ionicons color={colors.onyx} name="share-outline" size={20} />
          </Pressable>
        ) : null}
        <Pressable hitSlop={8} onPress={onOpenMembers} style={styles.headerSlot}>
          <Ionicons
            name="people-outline"
            size={22}
            color={onOpenMembers ? colors.onyx : colors.slate}
          />
        </Pressable>
        {onToggleMute ? (
          <Pressable
            accessibilityLabel={isMuted ? "Unmute notifications" : "Mute notifications"}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onToggleMute}
            style={styles.headerSlot}
          >
            <Ionicons
              color={isMuted ? colors.cinnabar : colors.onyx}
              name={isMuted ? "notifications-off-outline" : "notifications-outline"}
              size={20}
            />
          </Pressable>
        ) : null}
      </View>
      <Hairline />
    </View>
  );
}

function streamPreview(text: string): string {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function formatTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function detailGroupIcon(kind: AgentTurnDetailGroupKind): keyof typeof Ionicons.glyphMap {
  switch (kind) {
    case "thinking":
      return "sparkles-outline";
    case "tools":
      return "terminal-outline";
    case "plan":
      return "list-outline";
    case "events":
    default:
      return "ellipse-outline";
  }
}

function runtimeEventBody(message: SessionMessage): string {
  const body = message.content.trim();
  if (message.kind.trim().toLowerCase() === "agent_thinking") {
    return buildThinkingPreview(body, 120);
  }
  if (body) return body;
  return "Working…";
}

function agentTurnPreview(turn: AgentTurnFeedItem): string {
  const finalBody = turn.finalMessage?.content.trim();
  if (finalBody) return finalBody;
  const streamBody = streamPreview(turn.stream?.text ?? "");
  if (streamBody) return streamBody;
  const lastRuntime = turn.runtimeEvents[turn.runtimeEvents.length - 1];
  if (lastRuntime) return runtimeEventBody(lastRuntime);
  return "Working…";
}

function agentTurnTime(turn: AgentTurnFeedItem): string {
  return formatTime(turn.finalMessage?.createdAt || turn.stream?.startedAt || turn.createdAt);
}

function agentTurnDetailCount(turn: AgentTurnFeedItem): number {
  return turn.runtimeEvents.length + (turn.stream?.text.trim() ? 1 : 0);
}

function isOwnOutgoingFeedSource(
  source: SessionFeedSource,
  ownActorId?: string | null,
): boolean {
  return Boolean(
    ownActorId &&
      source.kind === "message" &&
      source.message.senderActorId === ownActorId,
  );
}

const turnMarkdown = {
  body: { color: hai.onyx, ...typography.body, marginBottom: 0, marginTop: 0 },
  code_inline: {
    backgroundColor: hai.pebble,
    borderRadius: 4,
    color: hai.onyx,
    paddingHorizontal: 4,
  },
  code_block: {
    backgroundColor: hai.pebble,
    borderRadius: 6,
    color: hai.onyx,
    padding: 8,
  },
  link: { color: hai.cinnabar, textDecorationLine: "underline" as const },
  paragraph: { color: hai.onyx, marginBottom: 0, marginTop: 0 },
};

function AgentTurnCard({
  onOpenDetail,
  onInterrupt,
  senderAvatarGlyph,
  senderAvatarUrl,
  senderName,
  turn,
}: {
  onOpenDetail?: (turn: AgentTurnFeedItem) => void;
  onInterrupt?: (agentId: string) => void;
  senderAvatarGlyph?: string | null;
  senderAvatarUrl?: string | null;
  senderName?: string;
  turn: AgentTurnFeedItem;
}) {
  const [cursorVisible, setCursorVisible] = useState(true);
  useEffect(() => {
    if (!turn.isActive || turn.stream?.isComplete) {
      setCursorVisible(false);
      return;
    }
    const timer = setInterval(() => {
      setCursorVisible((value) => !value);
    }, 420);
    return () => clearInterval(timer);
  }, [turn.isActive, turn.stream?.isComplete]);
  const displayName = senderName ?? "Agent";
  const avatarGlyph = senderAvatarGlyph ?? (displayName.charAt(0).toUpperCase() || "AI");
  const preview = agentTurnPreview(turn);
  const time = agentTurnTime(turn);
  const detailCount = agentTurnDetailCount(turn);
  const isWorking = turn.isActive && !turn.stream?.isComplete;
  return (
    <View style={[styles.row, styles.rowOther]}>
      <View style={styles.senderAvatar}>
        {senderAvatarUrl ? (
          <Image
            accessibilityRole="image"
            source={{ uri: senderAvatarUrl }}
            style={styles.senderAvatarImage}
          />
        ) : (
          <Text style={styles.senderAvatarText}>{avatarGlyph}</Text>
        )}
      </View>
      <Pressable
        accessibilityHint="Open agent turn details"
        accessibilityRole="button"
        onPress={onOpenDetail ? () => onOpenDetail(turn) : undefined}
        style={({ pressed }) => [
          styles.turnCard,
          turn.isActive ? styles.turnCardActive : null,
          pressed && onOpenDetail ? styles.turnCardPressed : null,
        ]}
      >
        <View style={styles.turnHeader}>
          <View style={styles.turnTitleRow}>
            <StatusDot kind={isWorking ? "working" : "active"} size={7} />
            <Text numberOfLines={1} style={styles.turnTitle}>
              {displayName}
            </Text>
            <Text style={styles.turnBadge}>
              {turn.isActive ? (turn.stream?.isComplete ? "同步中" : "正在回复") : "回复"}
            </Text>
          </View>
          <View style={styles.turnActions}>
            {time ? <Text style={styles.turnTime}>{time}</Text> : null}
            <Ionicons color={colors.slate} name="chevron-forward" size={14} />
          </View>
          {isWorking && onInterrupt ? (
            <Pressable
              accessibilityLabel={`Interrupt ${displayName}`}
              accessibilityRole="button"
              hitSlop={6}
              onPress={() => onInterrupt(turn.agentId)}
              style={styles.turnStopButton}
            >
              <Ionicons color={colors.cinnabarDeep} name="stop" size={10} />
            </Pressable>
          ) : null}
        </View>
        {(turn.finalMessage?.model || turn.stream?.model) ? (
          <Text numberOfLines={1} style={styles.turnModel}>
            {turn.finalMessage?.model || turn.stream?.model}
          </Text>
        ) : null}
        {turn.finalMessage ? (
          <Markdown style={turnMarkdown}>{preview || "(empty message)"}</Markdown>
        ) : (
          <Text numberOfLines={4} style={styles.turnPreview}>
            {preview}
            {isWorking && cursorVisible ? " ▌" : ""}
          </Text>
        )}
        {detailCount > 0 ? (
          <View style={styles.turnDetailRow}>
            <Ionicons color={colors.slate} name="list-outline" size={13} />
            <Text style={styles.turnDetailText}>
              过程 · {detailCount} {detailCount === 1 ? "event" : "events"}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

function AgentTurnDetailModal({
  onClose,
  senderName,
  turn,
}: {
  onClose: () => void;
  senderName?: string;
  turn: AgentTurnFeedItem | null;
}) {
  const displayName = senderName ?? "Agent";
  const isWorking = Boolean(turn?.isActive && !turn.stream?.isComplete);
  const detailGroups = turn ? buildAgentTurnDetailGroups(turn.runtimeEvents) : [];
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={turn !== null}
    >
      {turn ? (
        <View style={styles.detailScreen}>
          <View style={styles.detailHeader}>
            <Pressable
              accessibilityLabel="Close detail"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onClose}
              style={styles.detailHeaderButton}
            >
              <Ionicons color={colors.onyx} name="chevron-back" size={24} />
            </Pressable>
            <View style={styles.detailTitleBlock}>
              <Text numberOfLines={1} style={styles.detailTitle}>
                {displayName}
              </Text>
              <View style={styles.detailSubtitleRow}>
                <StatusDot kind={isWorking ? "working" : "active"} size={6} />
                <Text style={styles.detailSubtitle}>
                  {turn.isActive ? "Streaming detail" : "Turn detail"}
                </Text>
              </View>
            </View>
            <Pressable
              accessibilityLabel="Close detail"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onClose}
              style={styles.detailHeaderButton}
            >
              <Ionicons color={colors.onyx} name="close" size={21} />
            </Pressable>
          </View>
          <Hairline />
          <ScrollView contentContainerStyle={styles.detailContent}>
            {detailGroups.length > 0 ? (
              <View style={styles.detailSection}>
                <Text style={styles.detailSectionLabel}>Runtime</Text>
                {detailGroups.map((group) => (
                  <View key={`${group.kind}:${group.eventIds.join(":")}`} style={styles.detailEventRow}>
                    <View style={styles.detailEventIcon}>
                      <Ionicons
                        color={colors.basalt}
                        name={detailGroupIcon(group.kind)}
                        size={14}
                      />
                    </View>
                    <View style={styles.detailEventBody}>
                      <View style={styles.detailEventHeader}>
                        <Text style={styles.detailEventTitle}>
                          {group.title}
                          {group.count > 1 ? ` · ${group.count}` : ""}
                        </Text>
                        {formatTime(group.createdAt) ? (
                          <Text style={styles.detailEventTime}>
                            {formatTime(group.createdAt)}
                          </Text>
                        ) : null}
                      </View>
                      <Text selectable style={styles.detailEventText}>
                        {group.body}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {turn.stream?.text.trim() ? (
              <View style={styles.detailSection}>
                <Text style={styles.detailSectionLabel}>Live output</Text>
                <View style={styles.detailPaper}>
                  <Text selectable style={styles.detailEventText}>
                    {turn.stream.text.trim()}
                  </Text>
                </View>
              </View>
            ) : null}

            {turn.finalMessage ? (
              <View style={styles.detailSection}>
                <Text style={styles.detailSectionLabel}>Final reply</Text>
                <View style={styles.detailPaper}>
                  <Markdown style={turnMarkdown}>
                    {turn.finalMessage.content.trim() || "(empty message)"}
                  </Markdown>
                </View>
              </View>
            ) : null}

            {detailGroups.length === 0 && !turn.stream?.text.trim() && !turn.finalMessage ? (
              <View style={styles.detailEmpty}>
                <Ionicons color={colors.slate} name="sparkles-outline" size={22} />
                <Text style={styles.detailEmptyText}>No detail events yet.</Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      ) : null}
    </Modal>
  );
}

export function SessionDetailScreen(props: SessionDetailScreenProps) {
  const {
    agentChips,
    composerText,
    connectionState,
    headerAvatars,
    isMuted,
    isSending,
    mentionPool,
    onAgentInterrupt,
    onAgentRemove,
    onAttach,
    onBack,
    onChangeComposerText,
    onChangeRuntimeModel,
    onClearReply,
    onDeleteMessage,
    onEditMessage,
    onGrantPermission,
    onDenyPermission,
    resolvedPermissionsByRequestId,
    onOpenMembers,
    onReconnect,
    onRefresh,
    onRetryFailed,
    onReplyToMessage,
    onSend,
    onShare,
    onToggleMute,
    ownActorId,
    replyTarget,
    runtimeInfo,
    isRefreshing,
    senderAvatars,
    senderAvatarGlyphs,
    senderNames,
    sendErrorMessage,
    slashCommands,
    streamingAgentIds,
    todoText,
    state,
  } = props;
  const { session } = state;

  type FeedItem =
    | { kind: "separator"; key: string; label: string }
    | { kind: "message"; key: string; message: SessionMessage }
    | { kind: "agentTurn"; key: string; turn: AgentTurnFeedItem };

  const feedSources = useMemo(
    () =>
      buildSessionFeedSources(state.messages, state.streamingByAgent, {
        ownActorId,
      }),
    [ownActorId, state.messages, state.streamingByAgent],
  );
  const [selectedTurnKey, setSelectedTurnKey] = useState<string | null>(null);
  const selectedTurn = useMemo(() => {
    const source = feedSources.find((item) => item.key === selectedTurnKey);
    return source?.kind === "agentTurn" ? source.turn : null;
  }, [feedSources, selectedTurnKey]);

  const feedItems: FeedItem[] = [];
  for (let i = 0; i < feedSources.length; i += 1) {
    const current = feedSources[i];
    const prev = i > 0 ? feedSources[i - 1] : null;
    if (!prev || !isSameCalendarDay(prev.createdAt, current.createdAt)) {
      feedItems.push({
        kind: "separator" as const,
        key: `sep:${current.key}`,
        label: dayLabel(current.createdAt),
      });
    }
    if (current.kind === "message") {
      feedItems.push({
        kind: "message",
        key: current.key,
        message: current.message,
      });
    } else {
      feedItems.push({
        kind: "agentTurn",
        key: current.key,
        turn: current.turn,
      });
    }
  }

  const hasMessages = feedSources.length > 0;

  const messageListRef = useRef<FlatList<FeedItem> | null>(null);
  const lastMessageCount = useRef(feedSources.length);
  const hasMeasuredFeedLayout = useRef(false);
  const shouldStickToFeedBottom = useRef(true);

  const outboxByMessageId = useSyncExternalStore(
    subscribeOutbox,
    getOutboxSnapshot,
    getOutboxSnapshot,
  );
  const pendingAttachments = useSyncExternalStore(
    subscribePendingAttachments,
    () => getPendingAttachmentSnapshot(state.session.teamId, state.session.sessionId),
    () => getPendingAttachmentSnapshot(state.session.teamId, state.session.sessionId),
  );

  const planSnapshots = useMemo<AgentPlanSnapshot[]>(
    () =>
      deriveAgentPlanSnapshots(state.messages, (agentId) => {
        return senderNames?.get(agentId) ?? "";
      }),
    [state.messages, senderNames],
  );
  const activeTodoText = todoText ?? planSnapshots[0]?.text ?? "";
  const [plansPanelOpen, setPlansPanelOpen] = useState(true);
  useEffect(() => {
    // Reopen the panel automatically whenever a *new* agent gains an
    // unfinished plan. Doesn't reopen when the same set of agents just
    // updates their items.
    if (planSnapshots.length === 0) return;
    setPlansPanelOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planSnapshots.length]);

  const separatorIndices = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < feedItems.length; i += 1) {
      if (feedItems[i].kind === "separator") out.push(i);
    }
    return out;
    // feedItems is derived from feedSources each render; safe to depend on length only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedSources.length]);

  useEffect(() => {
    if (feedSources.length > lastMessageCount.current) {
      const newSources = feedSources.slice(lastMessageCount.current);
      const hasOwnOutgoingMessage = newSources.some((source) =>
        isOwnOutgoingFeedSource(source, ownActorId),
      );
      if (
        shouldAutoScrollForNewFeedItem({
          isOwnOutgoingMessage: hasOwnOutgoingMessage,
          wasNearBottom: shouldStickToFeedBottom.current,
        })
      ) {
        shouldStickToFeedBottom.current = true;
        // New message appended while the user is already following the tail.
        requestAnimationFrame(() => {
          messageListRef.current?.scrollToEnd({ animated: true });
        });
      }
    }
    lastMessageCount.current = feedSources.length;
  }, [feedSources, feedSources.length, ownActorId]);

  const handleFeedScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    shouldStickToFeedBottom.current = isFeedNearBottom({
      contentHeight: contentSize.height,
      offsetY: contentOffset.y,
      viewportHeight: layoutMeasurement.height,
    });
  };

  return (
    <View style={styles.screen}>
      <SessionHeader
        connectionState={connectionState}
        headerAvatars={headerAvatars}
        isMuted={isMuted}
        onBack={onBack}
        onOpenMembers={onOpenMembers}
        onShare={onShare}
        onTogglePlans={
          planSnapshots.length > 0
            ? () => setPlansPanelOpen((value) => !value)
            : undefined
        }
        plansPanelOpen={plansPanelOpen && planSnapshots.length > 0}
        onToggleMute={onToggleMute}
        session={session}
      />
      <ConnectionBannerOverlay
        connectionState={connectionState}
        onReconnect={onReconnect}
      />
      {plansPanelOpen && planSnapshots.length > 0 ? (
        <SessionPlansPanel
          onClose={() => setPlansPanelOpen(false)}
          snapshots={planSnapshots}
        />
      ) : null}
      {runtimeInfo ? (
        <Pressable
          accessibilityRole={onChangeRuntimeModel ? "button" : undefined}
          disabled={!onChangeRuntimeModel}
          onPress={onChangeRuntimeModel}
          style={({ pressed }) => [
            styles.runtimeBar,
            pressed && onChangeRuntimeModel ? styles.runtimeBarPressed : null,
          ]}
        >
          <StatusDot kind={runtimeStatusKind(runtimeInfo.status)} size={6} />
          <Text style={styles.runtimeLabel}>
            Runtime · {runtimeInfo.status}
            {runtimeInfo.currentModel ? ` · ${runtimeInfo.currentModel}` : ""}
          </Text>
          {onChangeRuntimeModel ? (
            <Ionicons color={colors.slate} name="chevron-down" size={12} />
          ) : null}
        </Pressable>
      ) : null}

      {state.status === "error" ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{state.errorMessage}</Text>
        </View>
      ) : null}

      <View style={styles.feed}>
        {hasMessages ? (
          <FlatList
            contentContainerStyle={styles.feedContent}
            data={feedItems}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            keyExtractor={(item) => item.key}
            onContentSizeChange={() => {
              const isInitialLayout = !hasMeasuredFeedLayout.current;
              hasMeasuredFeedLayout.current = true;
              if (
                shouldAutoScrollFeed({
                  isInitialLayout,
                  wasNearBottom: shouldStickToFeedBottom.current,
                })
              ) {
                messageListRef.current?.scrollToEnd({ animated: false });
              }
            }}
            onScroll={handleFeedScroll}
            refreshControl={
              onRefresh ? (
                <RefreshControl
                  onRefresh={onRefresh}
                  refreshing={Boolean(isRefreshing)}
                  tintColor={colors.slate}
                />
              ) : undefined
            }
            ref={messageListRef}
            scrollEventThrottle={80}
            stickyHeaderIndices={separatorIndices}
            renderItem={({ item }) => {
              if (item.kind === "separator") {
                return <DaySeparator label={item.label} />;
              }
              if (item.kind === "agentTurn") {
                return (
                  <AgentTurnCard
                    onOpenDetail={() => setSelectedTurnKey(item.key)}
                    onInterrupt={onAgentInterrupt}
                    senderAvatarGlyph={
                      senderAvatarGlyphs?.get(item.turn.agentId) ?? null
                    }
                    senderAvatarUrl={senderAvatars?.get(item.turn.agentId) ?? null}
                    senderName={senderNames?.get(item.turn.agentId) ?? undefined}
                    turn={item.turn}
                  />
                );
              }
              const msg = item.message;
              const isOwn = ownActorId ? msg.senderActorId === ownActorId : false;
              const replyToMessage =
                msg.replyToMessageId && msg.replyToMessageId.length > 0
                  ? state.messages.find((m) => m.messageId === msg.replyToMessageId) ??
                    null
                  : null;
              return (
                <SessionMessageRow
                  isOwnMessage={isOwn}
                  message={msg}
                  onDelete={onDeleteMessage}
                  onEdit={
                    onEditMessage
                      ? (m) => onEditMessage(m.messageId, m.content)
                      : undefined
                  }
                  onJumpToReply={(targetId) => {
                    const index = feedItems.findIndex(
                      (entry) => entry.kind === "message" && entry.message.messageId === targetId,
                    );
                    if (index >= 0) {
                      messageListRef.current?.scrollToIndex({
                        animated: true,
                        index,
                        viewPosition: 0.3,
                      });
                    }
                  }}
                  onRetryOutbox={onRetryFailed}
                  onReply={
                    onReplyToMessage
                      ? (m) => onReplyToMessage(m.messageId)
                      : undefined
                  }
                  outboxStatus={
                    isOwn
                      ? (outboxByMessageId.get(msg.messageId) as OutboxStatus | undefined)
                      : undefined
                  }
                  onGrantPermission={onGrantPermission}
                  onDenyPermission={onDenyPermission}
                  resolvedPermission={(() => {
                    if (msg.kind.trim().toLowerCase() !== "permission_request")
                      return null;
                    const meta =
                      msg.metadata && typeof msg.metadata === "object"
                        ? (msg.metadata as Record<string, unknown>)
                        : {};
                    const requestId =
                      (typeof meta.tool_id === "string" && (meta.tool_id as string)) ||
                      (typeof meta.request_id === "string" &&
                        (meta.request_id as string)) ||
                      msg.messageId;
                    const decision = resolvedPermissionsByRequestId?.get(requestId);
                    return decision === undefined ? null : { granted: decision };
                  })()}
                  replyToMessage={replyToMessage}
                  senderAvatarGlyph={
                    !isOwn ? senderAvatarGlyphs?.get(msg.senderActorId) ?? null : null
                  }
                  senderAvatarUrl={
                    !isOwn ? senderAvatars?.get(msg.senderActorId) ?? null : null
                  }
                  senderName={
                    !isOwn ? senderNames?.get(msg.senderActorId) ?? undefined : undefined
                  }
                />
              );
            }}
          />
        ) : (
          <View style={styles.empty}>
            <Ionicons
              color={colors.slate}
              name="chatbubbles-outline"
              size={40}
            />
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptyBody}>
              Be the first to write in this session.
            </Text>
          </View>
        )}
      </View>

      {replyTarget ? (
        <View style={styles.replyBar}>
          <View style={styles.replyBarAccent} />
          <View style={styles.replyBarBody}>
            <Text style={styles.replyBarLabel}>Replying to message</Text>
            <Text numberOfLines={1} style={styles.replyBarPreview}>
              {replyTarget.content || "(empty message)"}
            </Text>
          </View>
          {onClearReply ? (
            <Pressable hitSlop={6} onPress={onClearReply} style={styles.replyBarClose}>
              <Ionicons color={colors.slate} name="close" size={16} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <AgentTurnDetailModal
        onClose={() => setSelectedTurnKey(null)}
        senderName={
          selectedTurn ? senderNames?.get(selectedTurn.agentId) ?? undefined : undefined
        }
        turn={selectedTurn}
      />

      {activeTodoText ? <TodoDock text={activeTodoText} /> : null}

      {(() => {
        const prefix = slashPrefix(composerText);
        if (prefix === null) return null;
        const candidates = filterSlashCommands(slashCommands ?? BUILT_IN_SLASH_COMMANDS, prefix);
        return (
          <SlashCommandsPopup
            candidates={candidates}
            onSelect={(command) => {
              onChangeComposerText(`/${command.name} `);
            }}
          />
        );
      })()}

      {(() => {
        if (!mentionPool || mentionPool.length === 0) return null;
        const query = mentionQuery(composerText);
        if (query === null) return null;
        const candidates = filterMentionCandidates(mentionPool, query);
        return (
          <MentionsPopup
            candidates={candidates}
            onSelect={(target) => onChangeComposerText(applyMention(composerText, target))}
          />
        );
      })()}

      {agentChips && agentChips.length > 0 ? (
        <AgentChipBar
          chips={agentChips}
          onInterrupt={onAgentInterrupt}
          onRemove={onAgentRemove}
          streamingAgentIds={streamingAgentIds}
        />
      ) : null}

      <KeyboardAvoidingView
        behavior={Platform.select({ ios: "padding", android: undefined })}
        keyboardVerticalOffset={Platform.select({ ios: 8, default: 0 })}
      >
        <SessionComposerShell
          composerText={composerText}
          connectionState={connectionState}
          isSending={isSending}
          onAttach={onAttach}
          onChangeText={onChangeComposerText}
          onRemovePendingAttachment={(path) => {
            removePendingAttachment(state.session.teamId, state.session.sessionId, path);
          }}
          onSend={onSend}
          pendingAttachments={pendingAttachments}
          sendErrorMessage={sendErrorMessage}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    alignItems: "center",
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    paddingHorizontal: spacing.xxl,
  },
  emptyBody: {
    color: colors.basalt,
    textAlign: "center",
    ...typography.secondaryBody,
  },
  emptyTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  errorBanner: {
    backgroundColor: "rgba(184,75,54,0.10)",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  errorBannerText: {
    color: colors.cinnabarDeep,
    ...typography.caption,
  },
  feed: {
    flex: 1,
  },
  feedContent: {
    paddingVertical: spacing.sm,
  },
  row: {
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    width: "100%",
  },
  rowOther: {
    alignItems: "flex-start",
  },
  senderAvatar: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: hai.basalt,
    borderRadius: 999,
    height: 24,
    justifyContent: "center",
    marginBottom: 4,
    overflow: "hidden",
    width: 24,
  },
  senderAvatarImage: {
    height: "100%",
    width: "100%",
  },
  senderAvatarText: {
    color: hai.paper,
    fontSize: 10,
    fontWeight: "700",
  },
  turnActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 3,
  },
  turnBadge: {
    color: colors.cinnabarDeep,
    ...typography.caption,
    fontSize: 10,
    fontWeight: "700",
  },
  turnPreview: {
    color: colors.onyx,
    ...typography.secondaryBody,
  },
  turnCard: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: 5,
    maxWidth: "86%",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  turnCardActive: {
    borderColor: "rgba(184,75,54,0.24)",
  },
  turnCardPressed: {
    opacity: 0.88,
  },
  turnDetailRow: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(226,223,217,0.55)",
    borderRadius: 8,
    flexDirection: "row",
    gap: 5,
    marginTop: 2,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  turnDetailText: {
    color: colors.basalt,
    ...typography.caption,
    fontWeight: "600",
  },
  turnHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  turnModel: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  turnStopButton: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.14)",
    borderRadius: 999,
    height: 18,
    justifyContent: "center",
    width: 18,
  },
  turnTime: {
    color: colors.slate,
    ...typography.monoMeta,
    fontSize: 10,
  },
  turnTitle: {
    color: colors.onyx,
    flexShrink: 1,
    ...typography.caption,
    fontWeight: "700",
  },
  turnTitleRow: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 6,
  },
  detailContent: {
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  detailEmpty: {
    alignItems: "center",
    gap: 8,
    paddingVertical: spacing.xxl,
  },
  detailEmptyText: {
    color: colors.slate,
    ...typography.caption,
  },
  detailEventBody: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  detailEventHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  detailEventIcon: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    borderRadius: 8,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  detailEventRow: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  detailEventText: {
    color: colors.onyx,
    ...typography.secondaryBody,
  },
  detailEventTime: {
    color: colors.slate,
    ...typography.monoMeta,
    fontSize: 10,
  },
  detailEventTitle: {
    color: colors.basalt,
    flex: 1,
    ...typography.caption,
    fontWeight: "700",
  },
  detailHeader: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flexDirection: "row",
    minHeight: 52,
    paddingHorizontal: spacing.xs,
  },
  detailHeaderButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 42,
    minWidth: 42,
  },
  detailPaper: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  detailScreen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  detailSection: {
    gap: 8,
  },
  detailSectionLabel: {
    color: colors.slate,
    ...typography.pill,
  },
  detailSubtitle: {
    color: colors.slate,
    ...typography.caption,
  },
  detailSubtitleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
    justifyContent: "center",
    marginTop: 1,
  },
  detailTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  detailTitleBlock: {
    alignItems: "center",
    flex: 1,
    paddingHorizontal: spacing.xs,
  },
  headerBar: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flexDirection: "row",
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  headerSeparator: {
    color: colors.slate,
    paddingHorizontal: 2,
    ...typography.caption,
  },
  headerAvatarImage: {
    height: "100%",
    width: "100%",
  },
  headerAvatarInitial: {
    color: hai.paper,
    fontSize: 10,
    fontWeight: "700",
  },
  headerAvatarTile: {
    alignItems: "center",
    backgroundColor: hai.basalt,
    borderColor: colors.mist,
    borderRadius: 999,
    borderWidth: 1.5,
    height: 22,
    justifyContent: "center",
    overflow: "hidden",
    width: 22,
  },
  headerAvatars: {
    alignItems: "center",
    flexDirection: "row",
    marginLeft: 4,
    marginRight: 8,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  replyBar: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },
  runtimeBar: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: 4,
  },
  runtimeBarPressed: {
    opacity: 0.7,
  },
  runtimeLabel: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  replyBarAccent: {
    backgroundColor: hai.cinnabar,
    borderRadius: 2,
    height: 28,
    width: 3,
  },
  replyBarBody: {
    flex: 1,
    gap: 1,
  },
  replyBarClose: {
    padding: 4,
  },
  replyBarLabel: {
    color: hai.cinnabar,
    ...typography.caption,
    fontWeight: "700",
  },
  replyBarPreview: {
    color: colors.basalt,
    ...typography.caption,
  },
  headerStatus: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
    marginTop: 1,
  },
  headerStatusLabel: {
    color: colors.slate,
    ...typography.caption,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  headerTitleBlock: {
    alignItems: "center",
    flex: 1,
    paddingHorizontal: spacing.xs,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
});
