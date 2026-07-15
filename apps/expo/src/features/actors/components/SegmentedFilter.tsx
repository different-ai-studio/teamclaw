import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radii, spacing, typography } from "../../../ui/theme";

export type SegmentedFilterSegment<T extends string> = {
  tag: T;
  title: string;
  count: number;
};

export type SegmentedFilterProps<T extends string> = {
  segments: SegmentedFilterSegment<T>[];
  selection: T;
  onSelect: (tag: T) => void;
};

/**
 * Three-pill horizontal filter used by Actors list (All/Humans/Agents)
 * and the iOS `SegmentedFilterBar`. Selected pill is filled with onyx;
 * the others stay paper-on-pebble until tapped.
 */
export function SegmentedFilter<T extends string>({
  segments,
  selection,
  onSelect,
}: SegmentedFilterProps<T>) {
  return (
    <View style={styles.row}>
      {segments.map((segment) => {
        const selected = segment.tag === selection;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            hitSlop={4}
            key={segment.tag}
            onPress={() => onSelect(segment.tag)}
            style={[styles.pill, selected ? styles.pillSelected : null]}
          >
            <Text style={[styles.title, selected ? styles.titleSelected : null]}>
              {segment.title}
            </Text>
            <Text style={[styles.count, selected ? styles.countSelected : null]}>
              {segment.count}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  count: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  countSelected: {
    color: colors.paper,
  },
  pill: {
    alignItems: "center",
    backgroundColor: colors.pebble,
    borderRadius: radii.pill,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  pillSelected: {
    backgroundColor: colors.onyx,
  },
  row: {
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  title: {
    color: colors.basalt,
    ...typography.caption,
    fontWeight: "600",
  },
  titleSelected: {
    color: colors.paper,
  },
});

export default SegmentedFilter;
