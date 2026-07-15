import { StyleSheet, Text, View } from "react-native";

import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { Idea, IdeaStatus } from "../idea-types";

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

export type IdeaRowProps = {
  creatorName?: string | null;
  idea: Idea;
};

export function IdeaRow({ creatorName, idea }: IdeaRowProps) {
  const pill = statusPill(idea.status);
  const isDone = idea.status === "done";

  return (
    <View style={styles.row}>
      <View style={styles.metaRow}>
        <View style={[styles.pill, { backgroundColor: pill.background }]}>
          <Text style={[styles.pillText, { color: pill.foreground }]}>{pill.label}</Text>
        </View>
        {idea.workspaceName ? (
          <Text numberOfLines={1} style={styles.workspace}>
            {idea.workspaceName}
          </Text>
        ) : null}
      </View>

      <Text
        numberOfLines={2}
        style={[styles.title, isDone ? styles.titleDone : null]}
      >
        {idea.title}
      </Text>

      {idea.description ? (
        <Text numberOfLines={2} style={styles.body}>
          {idea.description}
        </Text>
      ) : null}

      {creatorName ? (
        <View style={styles.creatorFooter}>
          <Text style={styles.creatorFooterPrefix}>Created by</Text>
          <View style={styles.creatorAvatar}>
            <Text style={styles.creatorAvatarText}>
              {creatorName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <Text numberOfLines={1} style={styles.creatorFooterName}>
            {creatorName}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  metaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  pill: {
    alignItems: "center",
    borderRadius: radii.chip,
    height: 18,
    justifyContent: "center",
    paddingHorizontal: 7,
  },
  pillText: {
    fontSize: 9.5,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  row: {
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  titleDone: {
    color: colors.slate,
    textDecorationLine: "line-through",
  },
  workspace: {
    color: colors.slate,
    flexShrink: 1,
    ...typography.monoMeta,
  },
  creatorFooter: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    paddingTop: 2,
  },
  creatorFooterPrefix: {
    color: colors.slate,
    ...typography.caption,
  },
  creatorFooterName: {
    color: colors.onyx,
    flexShrink: 1,
    ...typography.caption,
    fontWeight: "600",
  },
  creatorAvatar: {
    alignItems: "center",
    backgroundColor: hai.basalt,
    borderRadius: 9,
    height: 18,
    justifyContent: "center",
    width: 18,
  },
  creatorAvatarText: {
    color: hai.paper,
    fontSize: 9,
    fontWeight: "700",
  },
});

export default IdeaRow;
