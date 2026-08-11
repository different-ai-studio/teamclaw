import { Ionicons } from "@expo/vector-icons";
import { Redirect } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { routeToHref, useOnboarding } from "./_layout";
import { groupMembershipsByOrg } from "../src/features/teams/membership-groups";
import { Hairline } from "../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../src/ui/atoms/SectionEyebrow";
import { colors, iosType, radii, spacing } from "../src/ui/theme";

/**
 * Team picker shown after auth when the user is on more than one team and has
 * not chosen — iOS `OrgTeamPickerView`, reached from `route == .selectTeam`.
 *
 * Grouped by org, because the org is what decides whether the team works at
 * all: the session activates one org, and teams outside it come back filtered
 * to empty. The choice is remembered, so this is asked once.
 */
export default function SelectTeamRoute() {
  const { state, controller } = useOnboarding();
  const [busyTeamId, setBusyTeamId] = useState<string | null>(null);

  if (state.route !== "selectTeam") {
    const href = routeToHref(state.route);
    return href ? <Redirect href={href} /> : null;
  }

  const groups = groupMembershipsByOrg(state.teamChoices);

  const pick = (teamId: string) => {
    if (busyTeamId) return;
    setBusyTeamId(teamId);
    void Promise.resolve(controller.selectTeam(teamId)).finally(() =>
      setBusyTeamId(null),
    );
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerBlock}>
          <Text style={styles.title}>Choose a team</Text>
          <Text style={styles.body}>
            You're on more than one. Pick where to start — TeamClu will remember
            it.
          </Text>
        </View>

        {state.errorMessage ? (
          <Text style={styles.errorText}>{state.errorMessage}</Text>
        ) : null}

        {groups.map((group) => (
          <View key={group.org} style={styles.section}>
            <SectionEyebrow
              label={`${group.org.toUpperCase()} · ${group.memberships.length}`}
              style={styles.sectionEyebrow}
            />
            <View style={styles.card}>
              {group.memberships.map((team, index) => (
                <View key={team.id}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busyTeamId !== null }}
                    disabled={busyTeamId !== null}
                    onPress={() => pick(team.id)}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && busyTeamId === null ? styles.rowPressed : null,
                    ]}
                  >
                    <View style={styles.rowBody}>
                      <Text numberOfLines={1} style={styles.rowLabel}>
                        {team.name}
                      </Text>
                      <Text numberOfLines={1} style={styles.rowMeta}>
                        {team.slug || team.id.slice(0, 8)} · {team.role}
                      </Text>
                    </View>
                    {busyTeamId === team.id ? (
                      <ActivityIndicator color={colors.slate} size="small" />
                    ) : (
                      <Ionicons color={colors.slate} name="chevron-forward" size={16} />
                    )}
                  </Pressable>
                  {index < group.memberships.length - 1 ? <Hairline /> : null}
                </View>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.basalt,
    ...iosType.subheadline,
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
    paddingTop: spacing.xxxl,
  },
  errorText: {
    color: colors.cinnabarDeep,
    ...iosType.footnote,
  },
  headerBlock: {
    gap: spacing.sm,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.onyx,
    ...iosType.body,
  },
  rowMeta: {
    color: colors.slate,
    ...iosType.caption,
  },
  rowPressed: {
    backgroundColor: colors.mist,
  },
  section: {
    gap: spacing.sm,
  },
  sectionEyebrow: {
    paddingHorizontal: spacing.xs,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  title: {
    color: colors.onyx,
    ...iosType.title3,
  },
});
