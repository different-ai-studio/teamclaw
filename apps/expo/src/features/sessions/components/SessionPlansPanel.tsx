import { Ionicons } from "@expo/vector-icons";
import { useMemo, useRef, useState } from "react";
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import type {
  AgentPlanSnapshot,
  TodoItem,
  TodoItemStatus,
} from "../plan-snapshot";
import { colors, radii, shadows, spacing, typography } from "../../../ui/theme";

export type SessionPlansPanelProps = {
  snapshots: AgentPlanSnapshot[];
  onClose?: () => void;
};

const PANEL_HEIGHT = 280;
const ITEM_GAP = 14;

type Glyph = { name: React.ComponentProps<typeof Ionicons>["name"]; tint: string };

function glyphForStatus(status: TodoItemStatus): Glyph {
  switch (status) {
    case "completed":
      return { name: "checkmark-circle", tint: colors.sage };
    case "in_progress":
      return { name: "ellipse", tint: colors.cinnabar };
    case "cancelled":
      return { name: "close-circle", tint: colors.slate };
    case "pending":
    default:
      return { name: "ellipse-outline", tint: colors.slate };
  }
}

/**
 * Top-anchored panel showing live plan_update snapshots for each active agent.
 * Multiple agents page horizontally — mirrors `apps/ios/.../SessionPlansPanelView.swift`.
 * Mounted as a sticky top region by SessionDetailScreen when `snapshots.length > 0`.
 */
export function SessionPlansPanel({ snapshots, onClose }: SessionPlansPanelProps) {
  const [pageWidth, setPageWidth] = useState(
    Dimensions.get("window").width - spacing.lg * 2,
  );
  const [pageIndex, setPageIndex] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  const handleLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width > 0 && width !== pageWidth) {
      setPageWidth(width);
    }
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (pageWidth <= 0) return;
    const next = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
    if (next !== pageIndex && next >= 0 && next < snapshots.length) {
      setPageIndex(next);
    }
  };

  if (snapshots.length === 0) return null;

  return (
    <View accessibilityLabel="Plans panel" style={styles.outer}>
      <View style={styles.panel} onLayout={handleLayout}>
        <ScrollView
          decelerationRate="fast"
          horizontal
          onScroll={handleScroll}
          pagingEnabled
          ref={scrollRef}
          scrollEventThrottle={16}
          showsHorizontalScrollIndicator={false}
          style={styles.pager}
        >
          {snapshots.map((snapshot) => (
            <View key={snapshot.agentId} style={[styles.page, { width: pageWidth }]}>
              <PlanPage snapshot={snapshot} onClose={onClose} />
            </View>
          ))}
        </ScrollView>
        {snapshots.length > 1 ? (
          <View style={styles.dots}>
            {snapshots.map((snapshot, index) => (
              <View
                key={snapshot.agentId}
                style={[
                  styles.dot,
                  index === pageIndex ? styles.dotActive : null,
                ]}
              />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function PlanPage({
  snapshot,
  onClose,
}: {
  snapshot: AgentPlanSnapshot;
  onClose?: () => void;
}) {
  const completedCount = useMemo(
    () => snapshot.items.filter((item) => item.status === "completed").length,
    [snapshot.items],
  );
  return (
    <View style={styles.pageInner}>
      <View style={styles.headerRow}>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {snapshot.agentName} — Plans
        </Text>
        <Text style={styles.headerCounter}>
          {completedCount} / {snapshot.items.length}
        </Text>
        {onClose ? (
          <Pressable
            accessibilityLabel="Close plans panel"
            accessibilityRole="button"
            hitSlop={8}
            onPress={onClose}
            style={styles.closeButton}
          >
            <Ionicons color={colors.slate} name="chevron-up" size={16} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={styles.itemsContent} style={styles.items}>
        {snapshot.items.map((item, index) => (
          <PlanItemRow index={index} item={item} key={`${index}-${item.content}`} />
        ))}
      </ScrollView>
    </View>
  );
}

function PlanItemRow({ index, item }: { index: number; item: TodoItem }) {
  const glyph = glyphForStatus(item.status);
  return (
    <View style={styles.itemRow}>
      <Text style={styles.itemIndex}>{index + 1}.</Text>
      <Ionicons color={glyph.tint} name={glyph.name} size={12} style={styles.itemGlyph} />
      <Text
        style={[
          styles.itemText,
          item.status === "completed" ? styles.itemTextDone : null,
        ]}
      >
        {item.content}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  closeButton: {
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
    minHeight: 24,
    minWidth: 24,
  },
  dot: {
    backgroundColor: colors.slate,
    borderRadius: 999,
    height: 6,
    opacity: 0.35,
    width: 6,
  },
  dotActive: {
    opacity: 1,
  },
  dots: {
    alignItems: "center",
    bottom: 8,
    flexDirection: "row",
    gap: 4,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
  },
  headerCounter: {
    color: colors.basalt,
    ...typography.caption,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  headerTitle: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
    fontWeight: "600",
  },
  itemGlyph: {
    paddingTop: 3,
  },
  itemIndex: {
    color: colors.slate,
    minWidth: 18,
    textAlign: "right",
    ...typography.caption,
  },
  itemRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: ITEM_GAP / 2,
  },
  itemText: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
    fontSize: 14,
  },
  itemTextDone: {
    color: colors.slate,
    textDecorationLine: "line-through",
  },
  items: {
    marginTop: 8,
  },
  itemsContent: {
    gap: 6,
    paddingBottom: 24,
  },
  outer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  page: {
    height: PANEL_HEIGHT,
  },
  pageInner: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  pager: {
    height: PANEL_HEIGHT,
  },
  panel: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.panel,
    borderWidth: StyleSheet.hairlineWidth,
    height: PANEL_HEIGHT,
    overflow: "hidden",
    ...shadows.card,
  },
});

export default SessionPlansPanel;
