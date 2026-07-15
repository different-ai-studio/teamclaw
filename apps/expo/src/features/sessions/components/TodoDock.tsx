import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import {
  countCompleted,
  parseTodoText,
  type TodoItemStatus,
} from "./todo-dock-parser";

type IconName = ComponentProps<typeof Ionicons>["name"];

function iconForStatus(status: TodoItemStatus): IconName {
  switch (status) {
    case "completed":
      return "checkmark-circle";
    case "in_progress":
      return "ellipse-outline";
    case "cancelled":
      return "close-circle-outline";
    case "pending":
    default:
      return "ellipse-outline";
  }
}

function colorForStatus(status: TodoItemStatus): string {
  switch (status) {
    case "completed":
      return hai.sage;
    case "in_progress":
      return hai.cinnabar;
    case "pending":
    case "cancelled":
    default:
      return hai.slate;
  }
}

export type TodoDockProps = {
  text: string;
};

/**
 * Bottom dock that renders the latest todo snapshot for the current
 * session. Mirrors `TodoDockView.swift`: collapsible header showing
 * "TO-DO · done/total" + an expanded list of items with per-status
 * icons and strikethrough for completed entries. Returns null when
 * there are no parseable items so the dock reserves no space.
 */
export function TodoDock({ text }: TodoDockProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const items = parseTodoText(text);
  if (items.length === 0) return null;

  const completed = countCompleted(items);

  return (
    <View style={styles.dock}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !isCollapsed }}
        hitSlop={4}
        onPress={() => setIsCollapsed((value) => !value)}
        style={styles.header}
      >
        <Text style={styles.headerLabel}>TO-DO</Text>
        <Text style={styles.headerCount}>{`· ${completed} / ${items.length}`}</Text>
        <View style={styles.headerSpacer} />
        <Ionicons
          color={colors.slate}
          name={isCollapsed ? "chevron-down" : "chevron-up"}
          size={14}
        />
      </Pressable>
      {!isCollapsed ? (
        <ScrollView
          contentContainerStyle={styles.listContent}
          style={styles.list}
        >
          {items.map((item, index) => {
            const isDone = item.status === "completed";
            return (
              <View key={`${index}:${item.content}`} style={styles.row}>
                <Text style={styles.index}>{index + 1}.</Text>
                <Ionicons
                  color={colorForStatus(item.status)}
                  name={iconForStatus(item.status)}
                  size={14}
                  style={styles.statusIcon}
                />
                <Text
                  numberOfLines={3}
                  style={[styles.itemText, isDone ? styles.itemTextDone : null]}
                >
                  {item.content}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.xs,
    marginHorizontal: spacing.lg,
    overflow: "hidden",
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerCount: {
    color: colors.slate,
    ...typography.caption,
  },
  headerLabel: {
    color: colors.slate,
    ...typography.eyebrow,
    fontWeight: "700",
  },
  headerSpacer: {
    flex: 1,
  },
  index: {
    color: colors.slate,
    minWidth: 20,
    textAlign: "right",
    ...typography.caption,
  },
  itemText: {
    color: colors.onyx,
    flex: 1,
    ...typography.secondaryBody,
  },
  itemTextDone: {
    color: colors.slate,
    textDecorationLine: "line-through",
  },
  list: {
    maxHeight: 175,
  },
  listContent: {
    gap: 6,
    paddingBottom: 12,
    paddingHorizontal: 14,
  },
  row: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 8,
  },
  statusIcon: {
    marginTop: 3,
  },
});

export default TodoDock;
