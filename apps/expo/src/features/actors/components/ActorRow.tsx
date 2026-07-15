import { Image, StyleSheet, Text, View } from "react-native";

import { StatusDot } from "../../../ui/atoms/StatusDot";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import { type Actor, isActorOnline } from "../actor-types";

const HUMAN_PALETTE = [hai.basalt, hai.slate, hai.sage, hai.onyx];

type AvatarStyle = { background: string; foreground: string; isSquare: boolean };

function avatarInitials(displayName: string): string {
  const parts = displayName
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return displayName.slice(0, 1).toUpperCase();
  return parts.map((part) => part.charAt(0).toUpperCase()).join("");
}

function hashActorId(actorId: string): number {
  let hash = 0;
  for (let i = 0; i < actorId.length; i += 1) {
    hash = (hash + actorId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function deriveAvatar(actor: Actor, isMe: boolean): AvatarStyle {
  if (actor.actorType === "agent") {
    return { background: hai.pebble, foreground: hai.basalt, isSquare: true };
  }
  if (isMe) {
    return { background: hai.cinnabar, foreground: hai.paper, isSquare: false };
  }
  const background = HUMAN_PALETTE[hashActorId(actor.actorId) % HUMAN_PALETTE.length];
  return { background, foreground: hai.paper, isSquare: false };
}

type Tag = { text: string; foreground: string; background: string };

function deriveTag(actor: Actor, isMe: boolean): Tag | null {
  if (isMe) {
    return {
      text: "YOU",
      foreground: hai.cinnabar,
      background: "rgba(184,75,54,0.10)",
    };
  }
  if (actor.role === "owner") {
    return { text: "OWNER", foreground: hai.basalt, background: hai.pebble };
  }
  if (actor.actorType === "agent") {
    return { text: "AGENT", foreground: hai.basalt, background: hai.pebble };
  }
  return null;
}

function deriveSubtitle(actor: Actor, isMe: boolean): string {
  if (isMe) return "you";
  if (actor.actorType === "member") return actor.role ?? "member";
  if (actor.actorType === "agent") {
    if (actor.agentKind) {
      const kind =
        actor.agentKind.charAt(0).toUpperCase() + actor.agentKind.slice(1);
      return `Agent · ${kind}`;
    }
    return "Agent";
  }
  return "External";
}

export type ActorRowProps = {
  actor: Actor;
  isMe?: boolean;
};

function agentKindGlyph(actor: Actor): string | null {
  if (actor.actorType !== "agent") return null;
  switch (actor.agentKind) {
    case "claude":
      return "CC";
    case "opencode":
      return "OC";
    case "codex":
      return "CX";
    default:
      return null;
  }
}

export function ActorRow({ actor, isMe = false }: ActorRowProps) {
  const avatar = deriveAvatar(actor, isMe);
  const tag = deriveTag(actor, isMe);
  const subtitle = deriveSubtitle(actor, isMe);
  const initials = agentKindGlyph(actor) ?? avatarInitials(actor.displayName);
  const online = isActorOnline(actor);
  const subtitleStyle = isMe || actor.actorType !== "member" ? styles.subtitleMono : styles.subtitle;

  return (
    <View style={styles.row}>
      <View
        style={[
          styles.avatar,
          { backgroundColor: avatar.background, borderRadius: avatar.isSquare ? 10 : 999 },
        ]}
      >
        {actor.avatarUrl ? (
          <Image
            accessibilityRole="image"
            source={{ uri: actor.avatarUrl }}
            style={[styles.avatarImage, { borderRadius: avatar.isSquare ? 10 : 999 }]}
          />
        ) : (
          <Text style={[styles.avatarText, { color: avatar.foreground }]}>{initials}</Text>
        )}
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={styles.title}>
            {actor.displayName}
          </Text>
          {tag ? (
            <View style={[styles.tag, { backgroundColor: tag.background }]}>
              <Text style={[styles.tagText, { color: tag.foreground }]}>{tag.text}</Text>
            </View>
          ) : null}
        </View>
        <Text numberOfLines={1} style={subtitleStyle}>
          {subtitle}
        </Text>
      </View>

      <View style={styles.trailing}>
        <StatusDot kind={online ? "active" : "muted"} size={6} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    overflow: "hidden",
    width: 40,
  },
  avatarImage: {
    height: "100%",
    width: "100%",
  },
  avatarText: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  subtitle: {
    color: colors.slate,
    ...typography.caption,
  },
  subtitleMono: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  tag: {
    alignItems: "center",
    borderRadius: radii.chip,
    height: 16,
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  tagText: {
    fontSize: 9.5,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  title: {
    color: colors.onyx,
    flexShrink: 1,
    ...typography.body,
    fontWeight: "600",
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  trailing: {
    alignItems: "center",
    justifyContent: "center",
    width: 14,
  },
});

export default ActorRow;
