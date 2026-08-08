import { Ionicons } from "@expo/vector-icons";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";

import { resolveSwipeRest } from "./swipeable-row-rest";
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
  /** Trailing-edge actions (revealed by swiping the row leftwards). */
  trailingActions?: SwipeableRowAction[];
  /** Whether the row should react to swipes. Default true. */
  enabled?: boolean;
};


/**
 * "Swipe row to reveal action buttons" — the interaction iOS gets for free from
 * `.swipeActions`. Keeps the row visual untouched; actions use Hai tokens.
 *
 * Built on the Gesture Handler v3 pan API plus React Native's own `Animated`.
 * It deliberately does **not** use `ReanimatedSwipeable`, which would drag in
 * `react-native-reanimated` — a native dependency this app does not have, and
 * which would also need a babel plugin. `runOnJS` keeps the callbacks on the JS
 * thread, which is where `Animated.Value.setValue` has to run anyway.
 *
 * (This replaces an import of `Swipeable`, which Gesture Handler 3 removed. That
 * import resolved to `undefined`, so every row with actions threw
 * "Element type is invalid" on render.)
 *
 * Requires `GestureHandlerRootView` at the app root — mounted in `app/_layout`.
 */
export function SwipeableRow({
  children,
  trailingActions = [],
  enabled = true,
}: SwipeableRowProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  /** Where the row rests between gestures: 0 shut, -actionsWidth open. */
  const restOffset = useRef(0);
  /**
   * Last values seen by `onUpdate`. `onFinalize` is typed with the *base* pan
   * payload, which carries no translation or velocity — and it is the only
   * callback guaranteed to fire, including when the gesture is cancelled
   * mid-drag. Stashing them here is what lets the row settle from every exit
   * path rather than only a clean release.
   */
  const lastTranslation = useRef(0);
  const lastVelocity = useRef(0);
  const [actionsWidth, setActionsWidth] = useState(0);

  const active = enabled && trailingActions.length > 0;

  const settle = useCallback(
    (to: number) => {
      restOffset.current = to;
      Animated.spring(translateX, {
        toValue: to,
        useNativeDriver: true,
        bounciness: 0,
        speed: 20,
      }).start();
    },
    [translateX],
  );

  const close = useCallback(() => settle(0), [settle]);

  // A row that stops being swipeable (selection mode, actions removed) must not
  // stay parked open — it would leave buttons stranded under a row that can no
  // longer be dragged shut.
  useEffect(() => {
    if (!active && restOffset.current !== 0) close();
  }, [active, close]);

  const pan = usePanGesture({
    enabled: active && actionsWidth > 0,
    runOnJS: true,
    // Only claim the gesture once it is clearly horizontal, and bail as soon as
    // it looks vertical — otherwise the row steals the list's scroll.
    activeOffsetX: [-12, 12],
    failOffsetY: [-10, 10],
    onBegin: () => {
      lastTranslation.current = 0;
      lastVelocity.current = 0;
    },
    onUpdate: (event) => {
      lastTranslation.current = event.translationX;
      lastVelocity.current = event.velocityX;
      const next = restOffset.current + event.translationX;
      // Rubber-banding is not worth it here: clamping to the strip keeps the
      // buttons from ever being over- or under-revealed.
      translateX.setValue(Math.max(-actionsWidth, Math.min(0, next)));
    },
    onFinalize: () => {
      settle(
        resolveSwipeRest({
          restOffset: restOffset.current,
          translation: lastTranslation.current,
          velocity: lastVelocity.current,
          actionsWidth,
        }),
      );
    },
  });

  const onActionsLayout = (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    if (width !== actionsWidth) setActionsWidth(width);
  };

  if (!active) {
    return <View>{children}</View>;
  }

  return (
    <View style={styles.container}>
      <View onLayout={onActionsLayout} style={styles.actionGroup}>
        {trailingActions.map((action) => (
          <Pressable
            accessibilityLabel={action.label}
            accessibilityRole="button"
            key={action.label}
            onPress={() => {
              // Shut the row first so it is not left open over a list that has
              // just changed underneath it (archiving removes this very row).
              close();
              action.onPress();
            }}
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

      <GestureDetector gesture={pan}>
        <Animated.View style={{ transform: [{ translateX }] }}>
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
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
    bottom: 0,
    flexDirection: "row",
    position: "absolute",
    right: 0,
    top: 0,
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
  container: {
    overflow: "hidden",
  },
});

export default SwipeableRow;
