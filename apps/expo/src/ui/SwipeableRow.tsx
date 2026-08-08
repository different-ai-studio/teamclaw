import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Swipeable } from "react-native-gesture-handler";

import { colors, spacing, typography } from "./theme";

export type SwipeableRowAction = {
  /** Short label shown under the icon (e.g. "Archive"). */
  label: string;
  /** Ionicons icon name (e.g. "archive-outline"). */
  iconName: React.ComponentProps<typeof Ionicons>["name"];
  /** Action handler. Receives nothing — the row identity is captured by the parent. */
  onPress: () => void;
  /** Render the action with the destructive (cinnabar) palette. Defaults to neutral. */
  destructive?: boolean;
};

export type SwipeableRowProps = {
  children: ReactNode;
  /** Trailing-edge actions (revealed by swiping left-to-right out from the right edge). */
  trailingActions?: SwipeableRowAction[];
  /** Whether the row should react to swipes. Default true. */
  enabled?: boolean;
};

/**
 * Thin wrapper over `react-native-gesture-handler` Swipeable that produces
 * the same "swipe row to reveal action buttons" interaction iOS gets for
 * free via `.swipeActions`. Keeps the row visual untouched — actions are
 * styled with Hai tokens.
 *
 * Requires `GestureHandlerRootView` to be mounted at the app root.
 */
export function SwipeableRow({
  children,
  trailingActions = [],
  enabled = true,
}: SwipeableRowProps) {
  if (!enabled || trailingActions.length === 0) {
    return <View>{children}</View>;
  }

  const renderRightActions = () => (
    <View style={styles.actionGroup}>
      {trailingActions.map((action) => (
        <Pressable
          accessibilityLabel={action.label}
          accessibilityRole="button"
          key={action.label}
          onPress={action.onPress}
          style={({ pressed }) => [
            styles.action,
            action.destructive ? styles.actionDestructive : styles.actionNeutral,
            pressed ? styles.actionPressed : null,
          ]}
        >
          <Ionicons
            color={action.destructive ? colors.paper : colors.basalt}
            name={action.iconName}
            size={20}
          />
          <Text
            style={[
              styles.actionLabel,
              action.destructive ? styles.actionLabelDestructive : null,
            ]}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <Swipeable
      friction={2}
      overshootRight={false}
      renderRightActions={renderRightActions}
      rightThreshold={32}
    >
      {children}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    gap: 4,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  actionDestructive: {
    backgroundColor: colors.cinnabar,
  },
  actionGroup: {
    flexDirection: "row",
  },
  actionLabel: {
    color: colors.basalt,
    ...typography.caption,
    fontSize: 11,
    fontWeight: "600",
  },
  actionLabelDestructive: {
    color: colors.paper,
  },
  actionNeutral: {
    backgroundColor: colors.pebble,
  },
  actionPressed: {
    opacity: 0.7,
  },
});

export default SwipeableRow;
