import { Ionicons } from "@expo/vector-icons";
import { useCallback, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { matchesAnyField } from "../../search/search-matcher";
import { SkeletonRow } from "../../../ui/atoms/SkeletonRow";


import {
  SegmentedFilter,
  type SegmentedFilterSegment,
} from "../../actors/components/SegmentedFilter";
import { Hairline } from "../../../ui/atoms/Hairline";
import { PrimaryButton } from "../../../ui/button";
import { PageHeader } from "../../../ui/PageHeader";
import { SwipeableRow } from "../../../ui/SwipeableRow";
import { impactLight, selectionTick } from "../../../lib/haptics";
import { colors, radii, spacing, typography } from "../../../ui/theme";
import { IdeaRow } from "../components/IdeaRow";
import {
  isDoneIdea,
  isMineIdea,
  isOpenIdea,
  type IdeasListState,
} from "../idea-types";

type Filter = "all" | "mine" | "open" | "done";

export type IdeasListScreenProps = {
  actorNames?: ReadonlyMap<string, string>;
  currentActorId: string | null;
  onArchiveBatch?: (ideaIds: string[]) => Promise<void>;
  onCreate?: () => void;
  onLoad: () => void;
  onOpenArchived?: () => void;
  onRefresh: () => void;
  onSelectIdea?: (ideaId: string) => void;
  state: IdeasListState;
};

function HeaderBar({
  count,
  onCreate,
  onOpenArchived,
}: {
  count: number;
  onCreate?: () => void;
  onOpenArchived?: () => void;
}) {
  return (
    <PageHeader
      count={count}
      right={
        <View style={styles.toolbarGroup}>
          {onOpenArchived ? (
            <Pressable
              accessibilityLabel="Archived ideas"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onOpenArchived}
              style={styles.toolbarButton}
            >
              <Ionicons color={colors.onyx} name="archive-outline" size={22} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Create Idea"
            accessibilityRole="button"
            disabled={!onCreate}
            hitSlop={8}
            onPress={onCreate}
            style={styles.toolbarButton}
          >
            <Ionicons
              color={onCreate ? colors.onyx : colors.slate}
              name="add"
              size={26}
            />
          </Pressable>
        </View>
      }
      title="Ideas"
    />
  );
}

export function IdeasListScreen({
  actorNames,
  currentActorId,
  onArchiveBatch,
  onCreate,
  onLoad,
  onOpenArchived,
  onRefresh,
  onSelectIdea,
  state,
}: IdeasListScreenProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [isBatchBusy, setIsBatchBusy] = useState(false);
  const selectionMode = selection.size > 0;

  const workspaceOptions = useMemo(() => {
    const names = new Set<string>();
    for (const idea of state.ideas) {
      if (idea.workspaceName) names.add(idea.workspaceName);
    }
    return [...names].sort();
  }, [state.ideas]);

  const toggleSelection = (id: string) => {
    selectionTick();
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelection(new Set());

  const showRowContextMenu = useCallback(
    (ideaId: string) => {
      impactLight();
      const labels = ["归档", "选择更多…", "取消"];
      const dispatch = (index: number) => {
        switch (index) {
          case 0:
            if (onArchiveBatch) void onArchiveBatch([ideaId]);
            break;
          case 1:
            toggleSelection(ideaId);
            break;
          default:
            break;
        }
      };
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: labels,
            cancelButtonIndex: 2,
            destructiveButtonIndex: 0,
          },
          dispatch,
        );
        return;
      }
      Alert.alert("想法操作", undefined, [
        { text: labels[0], style: "destructive", onPress: () => dispatch(0) },
        { text: labels[1], onPress: () => dispatch(1) },
        { text: labels[2], style: "cancel" },
      ]);
    },
    [onArchiveBatch],
  );

  const handleArchiveSelected = async () => {
    if (!onArchiveBatch || selection.size === 0) return;
    setIsBatchBusy(true);
    try {
      await onArchiveBatch(Array.from(selection));
      clearSelection();
    } finally {
      setIsBatchBusy(false);
    }
  };

  const searched = useMemo(() => {
    const queryFiltered =
      query.trim().length === 0
        ? state.ideas
        : state.ideas.filter((idea) =>
            matchesAnyField([idea.title, idea.description, idea.workspaceName], query),
          );
    if (!workspaceFilter) return queryFiltered;
    return queryFiltered.filter((idea) => idea.workspaceName === workspaceFilter);
  }, [state.ideas, query, workspaceFilter]);

  const counts = useMemo(() => {
    let mine = 0;
    let open = 0;
    let done = 0;
    for (const idea of searched) {
      if (isMineIdea(idea, currentActorId)) mine += 1;
      if (isOpenIdea(idea)) open += 1;
      if (isDoneIdea(idea)) done += 1;
    }
    return { mine, open, done };
  }, [searched, currentActorId]);

  const segments: SegmentedFilterSegment<Filter>[] = [
    { tag: "all", title: "All", count: searched.length },
    ...(currentActorId
      ? [{ tag: "mine" as const, title: "Mine", count: counts.mine }]
      : []),
    { tag: "open", title: "Open", count: counts.open },
    { tag: "done", title: "Done", count: counts.done },
  ];

  const filteredIdeas = searched.filter((idea) => {
    if (filter === "all") return true;
    if (filter === "mine") return isMineIdea(idea, currentActorId);
    if (filter === "open") return isOpenIdea(idea);
    if (filter === "done") return isDoneIdea(idea);
    return true;
  });

  const headerBar = (
    <HeaderBar
      count={state.ideas.length}
      onCreate={onCreate}
      onOpenArchived={onOpenArchived}
    />
  );

  if (state.status === "loading" || (state.status === "idle" && state.ideas.length === 0)) {
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
          <SkeletonRow avatar={false} />
          <SkeletonRow avatar={false} />
          <SkeletonRow avatar={false} />
        </View>
      </ScrollView>
    );
  }

  if (state.status === "error" && state.ideas.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        {headerBar}
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>Couldn't load ideas</Text>
          <Text style={styles.stateBody}>{state.errorMessage ?? "Try again in a moment."}</Text>
          <PrimaryButton fullWidth={false} label="Retry" onPress={onLoad} />
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
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
      style={{ flex: 1 }}
    >
      {headerBar}

      <View style={styles.searchField}>
        <Ionicons color={colors.slate} name="search" size={16} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Search ideas"
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

      {workspaceOptions.length > 0 ? (
        <View style={styles.workspaceRow}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setWorkspaceFilter(null)}
            style={[
              styles.workspaceChip,
              !workspaceFilter ? styles.workspaceChipSelected : null,
            ]}
          >
            <Text
              style={[
                styles.workspaceChipText,
                !workspaceFilter ? styles.workspaceChipTextSelected : null,
              ]}
            >
              All workspaces
            </Text>
          </Pressable>
          {workspaceOptions.map((name) => {
            const selected = workspaceFilter === name;
            return (
              <Pressable
                accessibilityRole="button"
                key={name}
                onPress={() => setWorkspaceFilter(name)}
                style={[
                  styles.workspaceChip,
                  selected ? styles.workspaceChipSelected : null,
                ]}
              >
                <Text
                  style={[
                    styles.workspaceChipText,
                    selected ? styles.workspaceChipTextSelected : null,
                  ]}
                >
                  {name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {state.ideas.length === 0 ? (
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>No Ideas</Text>
          <Text style={styles.stateBody}>Tap + to create an idea.</Text>
        </View>
      ) : filteredIdeas.length === 0 ? (
        <View style={styles.stateBlock}>
          <Text style={styles.emptyFilterTitle}>
            {filter === "mine"
              ? "Nothing here yet"
              : filter === "open"
              ? "No open ideas"
              : filter === "done"
              ? "No completed ideas"
              : "No ideas"}
          </Text>
          <Text style={styles.emptyFilterBody}>
            {filter === "mine"
              ? "Ideas you create will show up here."
              : filter === "open"
              ? "Open ideas will appear once created."
              : filter === "done"
              ? "Mark an idea as Done to see it here."
              : "Tap + to create an idea."}
          </Text>
        </View>
      ) : (
        <View>
          {filteredIdeas.map((idea, index) => {
            const checked = selection.has(idea.ideaId);
            return (
              <View key={idea.ideaId}>
                <SwipeableRow
                  enabled={!selectionMode && !!onArchiveBatch}
                  trailingActions={
                    onArchiveBatch
                      ? [
                          {
                            label: "Archive",
                            iconName: "archive-outline",
                            destructive: true,
                            onPress: () => {
                              void onArchiveBatch([idea.ideaId]);
                            },
                          },
                        ]
                      : []
                  }
                >
                  <Pressable
                    onLongPress={() => {
                      if (selectionMode) {
                        toggleSelection(idea.ideaId);
                      } else {
                        showRowContextMenu(idea.ideaId);
                      }
                    }}
                    onPress={() => {
                      if (selectionMode) {
                        toggleSelection(idea.ideaId);
                      } else if (onSelectIdea) {
                        onSelectIdea(idea.ideaId);
                      }
                    }}
                    style={({ pressed }) => [
                      styles.ideaRowOuter,
                      checked ? styles.ideaRowChecked : null,
                      pressed ? styles.ideaRowPressed : null,
                    ]}
                  >
                    {selectionMode ? (
                      <View style={[styles.checkbox, checked ? styles.checkboxOn : null]}>
                        {checked ? (
                          <Ionicons color="#F8F6F1" name="checkmark" size={14} />
                        ) : null}
                      </View>
                    ) : null}
                    <View style={styles.ideaRowBody}>
                      <IdeaRow
                        creatorName={
                          idea.createdByActorId
                            ? actorNames?.get(idea.createdByActorId) ?? null
                            : null
                        }
                        idea={idea}
                      />
                    </View>
                  </Pressable>
                </SwipeableRow>
                {index < filteredIdeas.length - 1 ? (
                  <Hairline style={styles.rowDivider} />
                ) : null}
              </View>
            );
          })}
        </View>
      )}
      </ScrollView>

      {selectionMode ? (
        <View style={styles.batchBar}>
          <Text style={styles.batchCount}>{selection.size} selected</Text>
          <Pressable
            accessibilityRole="button"
            onPress={clearSelection}
            style={({ pressed }) => [
              styles.batchAction,
              pressed ? styles.batchActionPressed : null,
            ]}
          >
            <Text style={styles.batchActionText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={isBatchBusy || !onArchiveBatch}
            onPress={handleArchiveSelected}
            style={({ pressed }) => [
              styles.batchPrimary,
              isBatchBusy ? styles.batchPrimaryBusy : null,
              pressed && !isBatchBusy ? styles.batchActionPressed : null,
            ]}
          >
            <Text style={styles.batchPrimaryText}>
              {isBatchBusy ? "Archiving…" : "Archive"}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  emptyFilterBody: {
    color: colors.slate,
    ...typography.caption,
  },
  emptyFilterTitle: {
    color: colors.basalt,
    ...typography.secondaryBody,
    fontWeight: "600",
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  rowDivider: {
    marginHorizontal: spacing.lg,
  },
  batchAction: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  batchActionPressed: {
    opacity: 0.7,
  },
  batchActionText: {
    color: colors.basalt,
    ...typography.body,
  },
  batchBar: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
  },
  batchCount: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
    fontWeight: "600",
  },
  batchPrimary: {
    backgroundColor: "rgba(184,75,54,0.12)",
    borderRadius: radii.button,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  batchPrimaryBusy: {
    opacity: 0.5,
  },
  batchPrimaryText: {
    color: colors.cinnabar,
    ...typography.body,
    fontWeight: "700",
  },
  checkbox: {
    alignItems: "center",
    borderColor: colors.slate,
    borderRadius: 999,
    borderWidth: 1.5,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  checkboxOn: {
    backgroundColor: colors.cinnabar,
    borderColor: colors.cinnabar,
  },
  ideaRowBody: {
    flex: 1,
  },
  ideaRowChecked: {
    backgroundColor: "rgba(184,75,54,0.06)",
  },
  ideaRowOuter: {
    alignItems: "center",
    flexDirection: "row",
    paddingLeft: spacing.lg,
  },
  ideaRowPressed: {
    opacity: 0.88,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  workspaceChip: {
    backgroundColor: colors.pebble,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  workspaceChipSelected: {
    backgroundColor: colors.basalt,
  },
  workspaceChipText: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  workspaceChipTextSelected: {
    color: colors.paper,
  },
  workspaceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
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
    flexDirection: "row",
  },
});

export default IdeasListScreen;
