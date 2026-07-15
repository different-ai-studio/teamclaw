import { Pressable, StyleSheet, Text, View } from "react-native";

import { actorAvatarColor } from "../../../lib/actor-color";
import { formatRelativeTime } from "../../../lib/relative-time";
import { AgentBadge } from "../../../ui/atoms/AgentBadge";
import { AvatarStack, type AvatarEntry } from "../../../ui/atoms/AvatarStack";
import { UnreadDot } from "../../../ui/atoms/UnreadDot";
import { colors, spacing, typography } from "../../../ui/theme";
import type { SessionSummary } from "../session-types";

type SessionRowProps = {
  /** Per-actor glyph override (e.g. "CC"/"OC"/"CX" for known agent kinds). */
  actorGlyphById?: ReadonlyMap<string, string>;
  isActive?: boolean;
  isPinned?: boolean;
  session: SessionSummary;
  onLongPress?: (session: SessionSummary) => void;
  onPress?: (session: SessionSummary) => void;
  unreadCount?: number;
};


const BADGE_INDENT = 38;

function fallbackGlyph(
  session: SessionSummary,
  actorGlyphById?: ReadonlyMap<string, string>,
): string {
  for (const actorId of session.participantActorIds) {
    const glyph = actorGlyphById?.get(actorId);
    if (glyph && glyph.length > 1) return glyph;
  }
  const source = (session.title || session.sessionId).trim();
  const last = source.split("/").pop() ?? source;
  if (!last) return "·";
  const ch = last.charAt(0);
  return ch.toUpperCase() || "·";
}

function buildAvatars(
  session: SessionSummary,
  actorGlyphById?: ReadonlyMap<string, string>,
): AvatarEntry[] {
  const ids = session.participantActorIds.length
    ? session.participantActorIds.slice(0, 3)
    : [session.createdBy].filter(Boolean);

  return ids.map((id) => {
    const palette = actorAvatarColor(id);
    const override = actorGlyphById?.get(id);
    const initials =
      override ?? (id.replace(/[^A-Za-z0-9一-龥]/g, "").slice(0, 2) || "·");
    return {
      id,
      initials,
      bg: palette.bg,
      fg: palette.fg,
    };
  });
}

export function SessionRow({
  actorGlyphById,
  isActive = false,
  isPinned = false,
  session,
  onLongPress,
  onPress,
  unreadCount = 0,
}: SessionRowProps) {
  const title = session.title.trim() || "Untitled session";
  const lastMessage = session.lastMessagePreview.trim();
  const timestamp = session.lastMessageAt || session.createdAt;
  const timeLabel = formatRelativeTime(timestamp);
  const isUnread = unreadCount > 0 || Boolean(session.hasUnread);

  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      delayLongPress={350}
      disabled={!onPress}
      onLongPress={onLongPress ? () => onLongPress(session) : undefined}
      onPress={() => onPress?.(session)}
      style={({ pressed }) => [
        styles.row,
        isActive ? styles.activeRow : null,
        pressed && onPress ? styles.pressed : null,
      ]}
    >
      <View style={styles.headerRow}>
        <AgentBadge
          label={fallbackGlyph(session, actorGlyphById)}
          status="active"
          bg={colors.pebble}
          fg={colors.basalt}
        />
        <Text style={styles.title} numberOfLines={1}>
          {isPinned ? "📌 " : ""}
          {title}
        </Text>
        <UnreadDot hidden={!isUnread} />
        <Text style={styles.time}>{timeLabel}</Text>
      </View>

      {lastMessage ? (
        <Text style={styles.summary} numberOfLines={1}>
          {lastMessage}
        </Text>
      ) : null}

      <View style={styles.metaStrip}>
        <Text style={styles.participantCount}>
          {session.participantCount} {session.participantCount === 1 ? "actor" : "actors"}
        </Text>
        <View style={styles.metaSpacer} />
        <AvatarStack avatars={buildAvatars(session, actorGlyphById)} max={3} size={22} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  activeRow: {
    backgroundColor: colors.paper,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  metaSpacer: {
    flex: 1,
  },
  metaStrip: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingLeft: BADGE_INDENT,
  },
  participantCount: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  pressed: {
    backgroundColor: "rgba(34,32,29,0.03)",
  },
  row: {
    backgroundColor: "transparent",
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  summary: {
    color: colors.basalt,
    paddingLeft: BADGE_INDENT,
    ...typography.secondaryBody,
  },
  time: {
    color: colors.slate,
    ...typography.caption,
  },
  title: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
    fontWeight: "600",
  },
});
