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
 * Segmented filter at the top of the Actors and Ideas lists, ported from iOS
 * `SegmentedFilterBar`.
 *
 * The structure matters more than the colours here. iOS puts every pill on one
 * Pebble track and leaves the inactive ones transparent, so the control reads
 * as a single segmented switch. Expo gave each pill its own Pebble fill and no
 * track, which reads as three separate chips that happen to sit in a row —
 * different affordance, and the selected state has to work harder to stand out.
 *
 * Pills also share the width evenly, as iOS's `frame(maxWidth: .infinity)`
 * does, so the control does not reflow when a count goes from 9 to 10.
 */
export function SegmentedFilter<T extends string>({
  segments,
  selection,
  onSelect,
}: SegmentedFilterProps<T>) {
  return (
    <View style={styles.row}>
      <View style={styles.track}>
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
              <Text
                numberOfLines={1}
                style={[styles.title, selected ? styles.titleSelected : null]}
              >
                {segment.title}
              </Text>
              <Text style={[styles.separator, selected ? styles.separatorSelected : null]}>
                ·
              </Text>
              <Text style={[styles.count, selected ? styles.countSelected : null]}>
                {segment.count}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  count: {
    color: colors.slate,
    fontFamily: typography.monoMeta.fontFamily,
    fontSize: 13,
  },
  countSelected: {
    // 70% rather than solid: the count is secondary to the label even when
    // the segment is the active one.
    color: "rgba(255,255,255,0.7)",
  },
  pill: {
    alignItems: "center",
    // Transparent until selected — the track behind provides the surface.
    backgroundColor: "transparent",
    borderRadius: radii.pill,
    flex: 1,
    flexDirection: "row",
    gap: 5,
    justifyContent: "center",
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  pillSelected: {
    backgroundColor: colors.onyx,
  },
  row: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
  },
  separator: {
    color: colors.slate,
    fontSize: 13,
  },
  separatorSelected: {
    color: "rgba(255,255,255,0.65)",
  },
  title: {
    color: colors.basalt,
    flexShrink: 1,
    fontSize: 14,
    fontWeight: "600",
  },
  titleSelected: {
    color: "#FFFFFF",
  },
  /** The Pebble track every pill sits on. iOS fills it at 55%. */
  track: {
    backgroundColor: "rgba(226,223,217,0.55)",
    borderRadius: 999,
    flexDirection: "row",
    gap: 4,
    padding: 4,
  },
});

export default SegmentedFilter;
