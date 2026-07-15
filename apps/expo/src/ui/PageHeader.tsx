import React from "react";
import type { ReactNode } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { colors, spacing, typography } from "./theme";

type PageHeaderProps = {
  count?: number;
  left?: ReactNode;
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
  title: string;
};

export function PageHeader({ count, left, right, style, title }: PageHeaderProps) {
  return (
    <View style={style ? [styles.header, style] : styles.header}>
      <View style={styles.leftSlot}>{left}</View>
      <View style={styles.titleBlock}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {count && count > 0 ? <Text style={styles.count}>· {count}</Text> : null}
      </View>
      <View style={styles.rightSlot}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  count: {
    color: colors.slate,
    ...typography.caption,
  },
  header: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flexDirection: "row",
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  leftSlot: {
    alignItems: "flex-start",
    justifyContent: "center",
    minHeight: 40,
    width: 80,
  },
  rightSlot: {
    alignItems: "flex-end",
    justifyContent: "center",
    minHeight: 40,
    width: 80,
  },
  title: {
    color: colors.onyx,
    ...typography.sectionTitle,
    fontWeight: "700",
  },
  titleBlock: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: spacing.xs,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
});
