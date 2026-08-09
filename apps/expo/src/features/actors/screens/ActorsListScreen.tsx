import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import {
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
import { SkeletonRow } from "../../../ui/atoms/SkeletonRow";
import { PrimaryButton } from "../../../ui/button";
import { PageHeader } from "../../../ui/PageHeader";
import { colors, radii, spacing, typography } from "../../../ui/theme";
import { ActorRow } from "../components/ActorRow";
import {
  SegmentedFilter,
  type SegmentedFilterSegment,
} from "../components/SegmentedFilter";
import {
  isAgentActor,
  isMemberActor,
  type Actor,
  type ActorsListState,
} from "../actor-types";
import { matchesQuery } from "../../search/search-matcher";

type Filter = "all" | "humans" | "agents";

export type ActorsListScreenProps = {
  currentActorId: string | null;
  onInvite?: () => void;
  onLoad: () => void;
  onOpenStats?: () => void;
  onRefresh: () => void;
  /** True when the signed-in user has zero accessible agents in this team. */
  showAddYourAgentNotice?: boolean;
  onSelectActor?: (actorId: string) => void;
  state: ActorsListState;
};

function HeaderBar({
  count,
  onInvite,
  onOpenStats,
}: {
  count: number;
  onInvite?: () => void;
  onOpenStats?: () => void;
}) {
  return (
    <PageHeader
      count={count}
      right={
        <View style={styles.toolbarGroup}>
          {onOpenStats ? (
            <Pressable
              accessibilityLabel="Team statistics"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onOpenStats}
              style={styles.toolbarButton}
            >
              <Ionicons color={colors.onyx} name="stats-chart-outline" size={20} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Invite Member"
            accessibilityRole="button"
            disabled={!onInvite}
            hitSlop={8}
            onPress={onInvite}
            style={styles.toolbarButton}
          >
            <Ionicons
              color={onInvite ? colors.onyx : colors.slate}
              name="person-add-outline"
              size={22}
            />
          </Pressable>
        </View>
      }
      title="Actors"
    />
  );
}

function Section({
  actors,
  currentActorId,
  onSelectActor,
  title,
}: {
  actors: Actor[];
  currentActorId: string | null;
  onSelectActor?: (actorId: string) => void;
  title: string;
}) {
  return (
    <View style={styles.section}>
      <SectionEyebrow label={title} style={styles.sectionLabel} />
      <View>
        {actors.map((actor, index) => (
          <View key={actor.actorId}>
            <Pressable
              onPress={onSelectActor ? () => onSelectActor(actor.actorId) : undefined}
            >
              <ActorRow actor={actor} isMe={actor.actorId === currentActorId} />
            </Pressable>
            {index < actors.length - 1 ? <Hairline style={styles.rowDivider} /> : null}
          </View>
        ))}
      </View>
    </View>
  );
}

export function ActorsListScreen({
  currentActorId,
  onInvite,
  onLoad,
  onOpenStats,
  onRefresh,
  onSelectActor,
  showAddYourAgentNotice = false,
  state,
}: ActorsListScreenProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const searched = useMemo(
    () =>
      query.trim().length === 0
        ? state.actors
        : state.actors.filter((actor) =>
            matchesQuery(
              [actor.displayName, actor.role ?? "", actor.actorType].join(" "),
              query,
            ),
          ),
    [state.actors, query],
  );
  const humans = useMemo(() => searched.filter(isMemberActor), [searched]);
  const agents = useMemo(() => searched.filter(isAgentActor), [searched]);

  const segments: SegmentedFilterSegment<Filter>[] = [
    { tag: "all", title: "All", count: humans.length + agents.length },
    { tag: "humans", title: "Humans", count: humans.length },
    { tag: "agents", title: "Agents", count: agents.length },
  ];

  const visibleHumans = filter === "agents" ? [] : humans;
  const visibleAgents = filter === "humans" ? [] : agents;

  const headerBar = (
    <HeaderBar
      count={humans.length + agents.length}
      onInvite={onInvite}
      onOpenStats={onOpenStats}
    />
  );

  if (state.status === "loading" || (state.status === "idle" && state.actors.length === 0)) {
    return (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={onRefresh}
            refreshing={state.isRefreshing}
            tintColor={colors.slate}
          />
        }
        style={styles.screen}
      >
        {headerBar}
        <View>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      </ScrollView>
    );
  }

  if (state.status === "error" && state.actors.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        {headerBar}
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>Couldn't load actors</Text>
          <Text style={styles.stateBody}>{state.errorMessage ?? "Try again in a moment."}</Text>
          <PrimaryButton fullWidth={false} label="Retry" onPress={onLoad} />
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          onRefresh={onRefresh}
          refreshing={state.isRefreshing}
          tintColor={colors.slate}
        />
      }
      style={styles.screen}
    >
      {headerBar}

      <View style={styles.searchField}>
        <Ionicons color={colors.slate} name="search" size={16} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Search actors"
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.searchInput}
          value={query}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityLabel="Clear search"
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => setQuery("")}
          >
            <Ionicons color={colors.slate} name="close-circle" size={16} />
          </Pressable>
        ) : null}
      </View>

      <SegmentedFilter onSelect={setFilter} segments={segments} selection={filter} />

      {/* "The current user has no accessible agent" — distinct from "the team
          has none", which the zero-agent reminder sheet covers on first run. */}
      {showAddYourAgentNotice && onInvite ? (
        <Pressable
          accessibilityRole="button"
          onPress={onInvite}
          style={({ pressed }) => [styles.ownAgentNotice, pressed ? { opacity: 0.8 } : null]}
          testID="members.addYourAgentNotice"
        >
          <Ionicons color={colors.cinnabar} name="bulb-outline" size={16} />
          <Text style={styles.ownAgentNoticeText}>Add your own agent</Text>
          <Ionicons color={colors.slate} name="chevron-forward" size={14} />
        </Pressable>
      ) : null}

      {humans.length + agents.length === 0 ? (
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>No Actors Yet</Text>
          <Text style={styles.stateBody}>
            Invite teammates or agents to see them here.
          </Text>
        </View>
      ) : (
        <View style={styles.groups}>
          {visibleHumans.length > 0 ? (
            <Section
              actors={visibleHumans}
              currentActorId={currentActorId}
              onSelectActor={onSelectActor}
              title={`Humans · ${visibleHumans.length}`}
            />
          ) : null}
          {visibleAgents.length > 0 ? (
            <Section
              actors={visibleAgents}
              currentActorId={currentActorId}
              onSelectActor={onSelectActor}
              title={`Agent Actors · ${visibleAgents.length}`}
            />
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  groups: {
    gap: spacing.lg,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  rowDivider: {
    marginLeft: 70,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  searchField: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  searchInput: {
    color: colors.onyx,
    flex: 1,
    padding: 0,
    ...typography.body,
  },
  section: {
    gap: spacing.sm,
  },
  sectionLabel: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
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
  toolbarButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  toolbarGroup: {
    alignItems: "center",
    flexDirection: "row",
  },
  ownAgentNotice: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.10)",
    borderRadius: radii.button,
    flexDirection: "row",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  ownAgentNoticeText: {
    color: colors.onyx,
    flex: 1,
    ...typography.secondaryBody,
    fontWeight: "600",
  },
});

export default ActorsListScreen;
