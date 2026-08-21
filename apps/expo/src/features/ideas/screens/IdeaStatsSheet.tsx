import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { GlassHeader, GLASS_HEADER_HEIGHT } from "../../../ui/GlassHeader";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { Actor } from "../../actors/actor-types";
import {
  buildIdeaStats,
  STATS_PERIODS,
  type ContributorStat,
  type StatsPeriod,
  type WorkspaceStat,
} from "../idea-stats";
import type { Idea } from "../idea-types";

/**
 * Team-wide idea statistics, ported from the iOS `IdeaStatsSheet`: a period
 * picker, three summary cards, a contributor ranking and a per-workspace
 * breakdown, all computed from real idea rows (active + archived).
 */

export type IdeaStatsSheetProps = {
  actors: ReadonlyArray<Actor>;
  ideas: ReadonlyArray<Idea>;
  onClose: () => void;
};

export function IdeaStatsSheet({ actors, ideas, onClose }: IdeaStatsSheetProps) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<StatsPeriod>("week");
  const stats = useMemo(
    () => buildIdeaStats({ actors, ideas, period }),
    [actors, ideas, period],
  );
  const maxWorkspaceCount = Math.max(1, ...stats.workspaces.map((row) => row.count));

  return (
    <View style={styles.screen}>
      <GlassHeader>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>{t("Idea Statistics")}</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </GlassHeader>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.periodPicker}>
          {STATS_PERIODS.map((option) => {
            const selected = option.value === period;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={option.value}
                onPress={() => setPeriod(option.value)}
                style={[styles.periodOption, selected ? styles.periodOptionSelected : null]}
              >
                <Text
                  style={[
                    styles.periodLabel,
                    selected ? styles.periodLabelSelected : null,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.summaryRow}>
          <SummaryCard icon="bulb-outline" label={t("TOTAL")} value={stats.total} />
          <SummaryCard icon="ellipse-outline" label={t("OPEN")} value={stats.open} />
          <SummaryCard icon="checkmark-circle-outline" label={t("DONE")} value={stats.done} />
        </View>

        {stats.contributors.length === 0 ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>{t("No ideas in this period")}</Text>
            <Text style={styles.emptyBody}>{t("Pick a longer period, or create an idea.")}</Text>
          </View>
        ) : (
          <View style={styles.section}>
            <SectionEyebrow label={t("TOP CONTRIBUTORS")} style={styles.sectionEyebrow} />
            <View style={styles.card}>
              {stats.contributors.map((stat, index) => (
                <View key={stat.actorId || `unattributed-${index}`}>
                  <ContributorRow rank={index + 1} stat={stat} />
                  {index < stats.contributors.length - 1 ? <Hairline /> : null}
                </View>
              ))}
            </View>
          </View>
        )}

        {stats.workspaces.length > 0 ? (
          <View style={styles.section}>
            <SectionEyebrow label={t("BY WORKSPACE")} style={styles.sectionEyebrow} />
            <View style={styles.card}>
              {stats.workspaces.map((stat, index) => (
                <View key={stat.id}>
                  <WorkspaceRow max={maxWorkspaceCount} stat={stat} />
                  {index < stats.workspaces.length - 1 ? <Hairline /> : null}
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  value: number;
}) {
  return (
    <View style={styles.summaryCard}>
      <Ionicons color={colors.basalt} name={icon} size={14} />
      <Text numberOfLines={1} style={styles.summaryValue}>
        {value}
      </Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function ContributorRow({ rank, stat }: { rank: number; stat: ContributorStat }) {
  const isTop = rank === 1;
  return (
    <View style={[styles.rankRow, isTop ? styles.rankRowTop : null]}>
      <Text style={[styles.rank, isTop ? styles.rankTop : null]}>{rank}</Text>
      <View
        style={[
          styles.actorTile,
          stat.isAgent ? styles.actorTileAgent : styles.actorTileHuman,
        ]}
      >
        <Text style={styles.actorTileText}>
          {stat.name.trim().charAt(0).toUpperCase() || "?"}
        </Text>
        {stat.isOnline ? <View style={styles.onlinePip} /> : null}
      </View>
      <Text numberOfLines={1} style={styles.rankName}>
        {stat.name}
      </Text>
      <Text style={[styles.rankCount, isTop ? styles.rankTop : null]}>{stat.count}</Text>
    </View>
  );
}

function WorkspaceRow({ max, stat }: { max: number; stat: WorkspaceStat }) {
  const ratio = Math.max(0, Math.min(1, stat.count / max));
  return (
    <View style={styles.workspaceRow}>
      <View style={styles.workspaceHeader}>
        <Text numberOfLines={1} style={styles.workspaceName}>
          {stat.name}
        </Text>
        <Text style={styles.workspaceCount}>{stat.count}</Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${ratio * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actorTile: {
    alignItems: "center",
    height: 26,
    justifyContent: "center",
    width: 26,
  },
  actorTileAgent: {
    backgroundColor: hai.pebble,
    borderRadius: 6,
  },
  actorTileHuman: {
    backgroundColor: hai.pebble,
    borderRadius: 13,
  },
  actorTileText: {
    color: hai.basalt,
    fontSize: 11,
    fontWeight: "700",
  },
  barFill: {
    backgroundColor: hai.basalt,
    borderRadius: 2,
    height: "100%",
  },
  barTrack: {
    backgroundColor: hai.pebble,
    borderRadius: 2,
    height: 4,
    overflow: "hidden",
    width: "100%",
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
    paddingTop: GLASS_HEADER_HEIGHT + spacing.lg,
  },
  emptyBlock: {
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
  emptyBody: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  emptyTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
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
  onlinePip: {
    backgroundColor: hai.sage,
    borderColor: colors.paper,
    borderRadius: 4,
    borderWidth: 1.5,
    bottom: -1,
    height: 8,
    position: "absolute",
    right: -1,
    width: 8,
  },
  periodLabel: {
    color: colors.basalt,
    ...typography.caption,
    fontWeight: "600",
  },
  periodLabelSelected: {
    color: colors.onyx,
  },
  periodOption: {
    alignItems: "center",
    borderRadius: radii.chip,
    flex: 1,
    paddingVertical: 6,
  },
  periodOptionSelected: {
    backgroundColor: colors.paper,
  },
  periodPicker: {
    backgroundColor: hai.pebble,
    borderRadius: radii.button,
    flexDirection: "row",
    padding: 2,
  },
  rank: {
    color: colors.slate,
    textAlign: "center",
    width: 18,
    ...typography.monoMeta,
    fontWeight: "700",
  },
  rankCount: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  rankName: {
    color: colors.onyx,
    flex: 1,
    ...typography.secondaryBody,
  },
  rankRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  rankRowTop: {
    backgroundColor: "rgba(184,75,54,0.04)",
  },
  rankTop: {
    color: hai.cinnabar,
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
  summaryCard: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: 6,
    paddingVertical: 14,
  },
  summaryLabel: {
    color: colors.slate,
    fontSize: 9,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  summaryRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  summaryValue: {
    color: colors.onyx,
    fontSize: 20,
    fontWeight: "700",
    ...typography.mono,
  },
  workspaceCount: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  workspaceHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  workspaceName: {
    color: colors.onyx,
    flex: 1,
    ...typography.secondaryBody,
  },
  workspaceRow: {
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
});

export default IdeaStatsSheet;
