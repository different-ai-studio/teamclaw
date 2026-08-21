import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";

import { formatRelativeTime } from "../../../lib/relative-time";
import { t } from "../../../lib/i18n";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { IdeaActivity } from "../idea-types";

/**
 * Vertical activity feed for an idea, ported from the iOS
 * `IdeaDetailView.activityTimelineSection` + `IdeaActivityRow`: a glyph rail
 * with a connector line, the acting actor's avatar/name (with an AGENT tag),
 * the activity label, its body, and any attached images.
 *
 * Rows arrive newest-first (the Cloud API orders `created_at DESC`) and are
 * rendered in that order, matching iOS.
 */

export type IdeaActivityAuthor = {
  actorId: string;
  displayName: string;
  avatarUrl: string | null;
  isAgent: boolean;
};

export type IdeaActivityTimelineProps = {
  activities: ReadonlyArray<IdeaActivity>;
  authorsById?: Readonly<Record<string, IdeaActivityAuthor>>;
  isLoading?: boolean;
  onSelectImage?: (url: string) => void;
};

const HUMAN_PALETTE = [hai.basalt, hai.slate, hai.cinnabar, hai.basalt];

function hashActorId(actorId: string): number {
  let hash = 0;
  for (let i = 0; i < actorId.length; i += 1) hash = (hash + actorId.charCodeAt(i)) >>> 0;
  return hash;
}

function avatarInitials(name: string): string {
  const parts = name
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return name.slice(0, 1).toUpperCase();
  return parts.map((part) => part.charAt(0).toUpperCase()).join("");
}

type ActivityPresentation = {
  glyph: React.ComponentProps<typeof Ionicons>["name"];
  glyphColor: string;
  label: string;
};

/** Mirrors iOS `IdeaActivityRow.iconName` / `activityLabel`. */
export function presentActivity(activity: IdeaActivity): ActivityPresentation {
  switch (activity.activityType) {
    case "status_change":
      return { glyph: "sync-outline", glyphColor: hai.basalt, label: t("Status changed") };
    case "reorder":
      return { glyph: "swap-vertical-outline", glyphColor: hai.cinnabar, label: t("Reordered") };
    default:
      return { glyph: "chevron-forward-outline", glyphColor: hai.cinnabar, label: t("Progress") };
  }
}

export function IdeaActivityTimeline({
  activities,
  authorsById,
  isLoading,
  onSelectImage,
}: IdeaActivityTimelineProps) {
  const { t: tHook } = useTranslation();
  if (isLoading && activities.length === 0) {
    return (
      <View style={styles.stateRow}>
        <ActivityIndicator color={colors.slate} />
        <Text style={styles.stateText}>{tHook("Loading activity…")}</Text>
      </View>
    );
  }

  if (activities.length === 0) {
    return <Text style={styles.emptyText}>{tHook("No activity yet.")}</Text>;
  }

  return (
    <View style={styles.timeline}>
      {activities.map((activity, index) => (
        <IdeaActivityRow
          activity={activity}
          author={authorsById?.[activity.actorId] ?? null}
          isLast={index === activities.length - 1}
          key={activity.id}
          onSelectImage={onSelectImage}
        />
      ))}
    </View>
  );
}

function IdeaActivityRow({
  activity,
  author,
  isLast,
  onSelectImage,
}: {
  activity: IdeaActivity;
  author: IdeaActivityAuthor | null;
  isLast: boolean;
  onSelectImage?: (url: string) => void;
}) {
  const { t } = useTranslation();
  const presentation = presentActivity(activity);
  const actorName = author?.displayName.trim() || t("Unknown");
  const body = activity.content.trim() || activity.activityType;

  return (
    <View style={styles.row}>
      <View style={styles.rail}>
        <View style={styles.railBadge}>
          <Ionicons color={presentation.glyphColor} name={presentation.glyph} size={11} />
        </View>
        {isLast ? null : <View style={styles.railLine} />}
      </View>

      <View style={[styles.rowBody, isLast ? null : styles.rowBodySpaced]}>
        <View style={styles.rowHeader}>
          <ActorAvatar author={author} />
          <Text numberOfLines={1} style={styles.actorName}>
            {actorName}
          </Text>
          {author?.isAgent ? (
            <View style={styles.agentTag}>
              <Text style={styles.agentTagText}>{t("AGENT")}</Text>
            </View>
          ) : null}
          <View style={styles.rowHeaderSpacer} />
          <Text style={styles.timestamp}>
            {activity.createdAt ? formatRelativeTime(activity.createdAt) : ""}
          </Text>
        </View>

        <Text style={styles.activityLabel}>{presentation.label}</Text>
        <Text style={styles.activityBody}>{body}</Text>

        {activity.attachmentUrls.length > 0 ? (
          <View style={styles.imageGrid}>
            {activity.attachmentUrls.map((url) => (
              <Pressable
                accessibilityRole="image"
                disabled={!onSelectImage}
                key={url}
                onPress={onSelectImage ? () => onSelectImage(url) : undefined}
                style={({ pressed }) => [styles.thumb, pressed ? styles.thumbPressed : null]}
              >
                <Image resizeMode="cover" source={{ uri: url }} style={styles.thumbImage} />
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ActorAvatar({ author }: { author: IdeaActivityAuthor | null }) {
  if (!author) {
    return <View style={[styles.avatar, styles.avatarCircle, { backgroundColor: hai.pebble }]} />;
  }
  const foreground = HUMAN_PALETTE[hashActorId(author.actorId) % HUMAN_PALETTE.length];
  const shape = author.isAgent ? styles.avatarSquare : styles.avatarCircle;
  if (author.avatarUrl) {
    return (
      <Image
        resizeMode="cover"
        source={{ uri: author.avatarUrl }}
        style={[styles.avatar, shape]}
      />
    );
  }
  return (
    <View style={[styles.avatar, shape, { backgroundColor: hai.pebble }]}>
      <Text style={[styles.avatarText, { color: foreground }]}>
        {avatarInitials(author.displayName)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actorName: {
    color: colors.onyx,
    ...typography.caption,
  },
  activityBody: {
    color: colors.onyx,
    ...typography.secondaryBody,
  },
  activityLabel: {
    color: colors.slate,
    ...typography.caption,
  },
  agentTag: {
    backgroundColor: hai.pebble,
    borderRadius: radii.hairline,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  agentTagText: {
    color: hai.basalt,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  avatar: {
    alignItems: "center",
    height: 20,
    justifyContent: "center",
    overflow: "hidden",
    width: 20,
  },
  avatarCircle: {
    borderRadius: 10,
  },
  avatarSquare: {
    borderRadius: 5,
  },
  avatarText: {
    fontSize: 8.5,
    fontWeight: "700",
  },
  emptyText: {
    color: colors.slate,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    ...typography.secondaryBody,
  },
  imageGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingTop: 2,
  },
  rail: {
    alignItems: "center",
    width: 24,
  },
  railBadge: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    borderRadius: 12,
    height: 24,
    justifyContent: "center",
    width: 24,
  },
  railLine: {
    backgroundColor: colors.hairline,
    flex: 1,
    marginTop: 4,
    width: 1,
  },
  row: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  rowBody: {
    flex: 1,
    gap: 6,
  },
  rowBodySpaced: {
    paddingBottom: 14,
  },
  rowHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  rowHeaderSpacer: {
    flex: 1,
  },
  stateRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  stateText: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  thumb: {
    borderRadius: radii.card,
    height: 72,
    overflow: "hidden",
    width: 72,
  },
  thumbImage: {
    height: "100%",
    width: "100%",
  },
  thumbPressed: {
    opacity: 0.8,
  },
  timeline: {
    gap: 0,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  timestamp: {
    color: colors.slate,
    ...typography.caption,
  },
});

export default IdeaActivityTimeline;
