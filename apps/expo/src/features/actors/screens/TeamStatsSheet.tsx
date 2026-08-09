import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import { STATS_PERIODS, type StatsPeriod } from "../../ideas/idea-stats";
import type { Idea } from "../../ideas/idea-types";
import type { SessionSummary } from "../../sessions/session-types";
import type { Actor } from "../actor-types";
import { buildTeamStats, type ActorActivityStat } from "../team-stats";

/**
 * Team activity, opened from the Actors tab. Same shape as the iOS
 * `TeamStatsSheet` — period picker, summary cards, per-actor ranking — but the
 * numbers are real: iOS still shows placeholder token counts there.
 */

export type TeamStatsSheetProps = {
  actors: ReadonlyArray<Actor>;
  ideas: ReadonlyArray<Idea>;
  onClose: () => void;
  sessions: ReadonlyArray<SessionSummary>;
};

export function TeamStatsSheet({ actors, ideas, onClose, sessions }: TeamStatsSheetProps) {
  const [period, setPeriod] = useState<StatsPeriod>("week");
  const stats = useMemo(
    () => buildTeamStats({ actors, ideas, period, sessions }),
    [actors, ideas, period, sessions],
  );
  const ranked = stats.actors.filter((actor) => actor.total > 0);

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Team Statistics</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

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
                  style={[styles.periodLabel, selected ? styles.periodLabelSelected : null]}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.summaryRow}>
          <SummaryCard icon="people-outline" label="HUMANS" value={stats.members} />
          <SummaryCard icon="sparkles-outline" label="AGENTS" value={stats.agents} />
        </View>
        <View style={styles.summaryRow}>
          <SummaryCard
            icon="chatbubbles-outline"
            label="SESSIONS"
            value={stats.sessions}
          />
          <SummaryCard icon="bulb-outline" label="IDEAS" value={stats.ideas} />
        </View>

        {ranked.length === 0 ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>No activity in this period</Text>
            <Text style={styles.emptyBody}>Pick a longer period to see more.</Text>
          </View>
        ) : (
          <View style={styles.section}>
            <SectionEyebrow label="MOST ACTIVE" style={styles.sectionEyebrow} />
            <View style={styles.card}>
              {ranked.map((stat, index) => (
                <View key={stat.actorId}>
                  <ActorRankRow rank={index + 1} stat={stat} />
                  {index < ranked.length - 1 ? <Hairline /> : null}
                </View>
              ))}
            </View>
          </View>
        )}
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

function ActorRankRow({ rank, stat }: { rank: number; stat: ActorActivityStat }) {
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
      <View style={styles.rankBody}>
        <Text numberOfLines={1} style={styles.rankName}>
          {stat.name}
        </Text>
        <Text style={styles.rankMeta}>
          {stat.sessions} session{stat.sessions === 1 ? "" : "s"} · {stat.ideas} idea
          {stat.ideas === 1 ? "" : "s"}
        </Text>
      </View>
      <Text style={[styles.rankCount, isTop ? styles.rankTop : null]}>{stat.total}</Text>
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
  rankBody: {
    flex: 1,
    gap: 2,
  },
  rankCount: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  rankMeta: {
    color: colors.slate,
    ...typography.caption,
  },
  rankName: {
    color: colors.onyx,
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
});

export default TeamStatsSheet;
