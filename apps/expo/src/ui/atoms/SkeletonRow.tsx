import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

import { colors, spacing } from "../theme";

export type SkeletonRowProps = {
  avatar?: boolean;
};

/**
 * A neutral, breathing placeholder row used while a list is loading.
 * Mirrors the iOS "redacted" skeletons shown before Supabase loads
 * complete. Animates opacity 0.55 ↔ 1 on a 1.4s loop, matching the
 * StatusDot `active` cadence.
 */
export function SkeletonRow({ avatar = true }: SkeletonRowProps) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.55,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View style={[styles.row, { opacity }]}>
      {avatar ? <View style={styles.avatar} /> : null}
      <View style={styles.body}>
        <View style={[styles.bar, { width: "62%" }]} />
        <View style={[styles.bar, { width: "92%" }]} />
        <View style={[styles.bar, { width: "40%" }]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: colors.pebble,
    borderRadius: 999,
    height: 26,
    width: 26,
  },
  bar: {
    backgroundColor: colors.pebble,
    borderRadius: 4,
    height: 10,
  },
  body: {
    flex: 1,
    gap: 6,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
});

export default SkeletonRow;
