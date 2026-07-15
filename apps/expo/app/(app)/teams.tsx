import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { supabase } from "../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { createTeamsApi } from "../../src/features/teams/teams-api";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";

type Membership = {
  teamId: string;
  name: string;
  slug: string;
  role: string;
};

export default function TeamsRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const memberActorId = state.currentMemberActorId;
  const activeTeamId = state.currentTeam?.id ?? "";
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const teamsApi = useMemo(
    () => createTeamsApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );

  const commitRename = async (teamId: string) => {
    const next = renameDraft.trim();
    if (!next) return;
    try {
      await teamsApi.renameTeam(teamId, next);
      setMemberships((prev) =>
        prev.map((m) => (m.teamId === teamId ? { ...m, name: next } : m)),
      );
      setEditingTeamId(null);
      setRenameDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rename team.");
    }
  };

  const confirmLeave = (membership: Membership) => {
    if (!memberActorId) return;
    Alert.alert(
      "Leave team",
      `You'll lose access to ${membership.name}. Continue?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: async () => {
            try {
              await teamsApi.leaveTeam(membership.teamId, memberActorId);
              setMemberships((prev) =>
                prev.filter((m) => m.teamId !== membership.teamId),
              );
            } catch (err) {
              setError(err instanceof Error ? err.message : "Couldn't leave team.");
            }
          },
        },
      ],
    );
  };

  const load = useCallback(async () => {
    if (!memberActorId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const { memberships: next } = await teamsApi.listMemberships();
      setMemberships(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load teams.");
    } finally {
      setIsLoading(false);
    }
  }, [memberActorId, teamsApi]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Teams</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              void load();
            }}
            refreshing={isLoading && memberships.length > 0}
            tintColor={colors.slate}
          />
        }
      >
        {isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.body}>Loading teams…</Text>
          </View>
        ) : error ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>Couldn't load teams</Text>
            <Text style={styles.body}>{error}</Text>
          </View>
        ) : memberships.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>No memberships</Text>
            <Text style={styles.body}>You're not on any teams yet.</Text>
          </View>
        ) : (
          <View style={styles.section}>
            <SectionEyebrow label={`MEMBER OF · ${memberships.length}`} style={styles.sectionEyebrow} />
            <View style={styles.card}>
              {memberships.map((membership, index) => {
                const isActive = membership.teamId === activeTeamId;
                const isEditing = editingTeamId === membership.teamId;
                const isOwnerOrAdmin =
                  membership.role === "owner" || membership.role === "admin";
                return (
                  <View key={membership.teamId}>
                    <View style={styles.row}>
                      <View style={styles.iconTile}>
                        <Text style={styles.iconText}>
                          {membership.name.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.rowBody}>
                        {isEditing ? (
                          <TextInput
                            autoFocus
                            maxLength={64}
                            onBlur={() => {
                              if (renameDraft.trim()) {
                                void commitRename(membership.teamId);
                              } else {
                                setEditingTeamId(null);
                              }
                            }}
                            onChangeText={setRenameDraft}
                            onSubmitEditing={() => void commitRename(membership.teamId)}
                            returnKeyType="done"
                            selectionColor={colors.cinnabar}
                            style={styles.rowLabel}
                            value={renameDraft}
                          />
                        ) : (
                          <Text style={styles.rowLabel}>{membership.name}</Text>
                        )}
                        <Text style={styles.rowMeta}>
                          {membership.slug || membership.teamId.slice(0, 8)} · {membership.role}
                        </Text>
                      </View>
                      {isActive ? (
                        <Ionicons
                          color={colors.cinnabar}
                          name="checkmark-circle"
                          size={20}
                        />
                      ) : (
                        <Pressable
                          accessibilityLabel="Leave team"
                          accessibilityRole="button"
                          hitSlop={6}
                          onPress={() => confirmLeave(membership)}
                          style={styles.rowAction}
                        >
                          <Ionicons color={colors.cinnabar} name="exit-outline" size={18} />
                        </Pressable>
                      )}
                      {isOwnerOrAdmin && !isEditing ? (
                        <Pressable
                          accessibilityLabel="Rename team"
                          accessibilityRole="button"
                          hitSlop={6}
                          onPress={() => {
                            setEditingTeamId(membership.teamId);
                            setRenameDraft(membership.name);
                          }}
                          style={styles.rowAction}
                        >
                          <Ionicons color={colors.slate} name="create-outline" size={18} />
                        </Pressable>
                      ) : null}
                    </View>
                    {index < memberships.length - 1 ? <Hairline /> : null}
                  </View>
                );
              })}
            </View>
            <Text style={styles.footnote}>
              Cross-team switching commits to the onboarding store in a
              follow-up — the picker surfaces every membership today so
              the user can audit their access.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.basalt,
    ...typography.secondaryBody,
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
  footnote: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
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
  iconText: {
    color: hai.paper,
    fontSize: 16,
    fontWeight: "700",
  },
  iconTile: {
    alignItems: "center",
    backgroundColor: hai.onyx,
    borderRadius: 999,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowAction: {
    padding: 4,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  rowMeta: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  rowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
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
    gap: spacing.sm,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
});
