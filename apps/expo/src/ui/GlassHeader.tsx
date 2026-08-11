import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { GlassSurface } from "./GlassSurface";
import { colors, spacing } from "./theme";

/**
 * Pinned, translucent top bar — the RN stand-in for the iOS navigation bar.
 *
 * iOS tints its bar `Color.amux.mist.opacity(0.85)` over the system material
 * (`.toolbarBackground` in `IdeaDetailView`, `MemberListContent`,
 * `SessionDetailView`); screens that set nothing get the system glass. Either
 * way the bar is translucent and content passes beneath it, so this pins the
 * header and lets the scroll view run underneath.
 *
 * Screens using this must add `GLASS_HEADER_HEIGHT` to their scroll content's
 * `paddingTop`, or the first row starts underneath the bar.
 */

/** Matches the `minHeight: 48` every hand-rolled `headerBar` already used. */
export const GLASS_HEADER_HEIGHT = 48;

export type GlassHeaderProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function GlassHeader({ children, style }: GlassHeaderProps) {
  return (
    <View style={[styles.header, style]}>
      {/* Mist at 85%, the tint iOS puts on the bar — heavier than the tab
          bar's 14% because a title has to stay readable over any content. */}
      <GlassSurface tint={colors.mist} tintOpacity={0.85} />
      <View style={styles.row}>{children}</View>
      <View style={styles.hairline} />
    </View>
  );
}

const styles = StyleSheet.create({
  hairline: {
    backgroundColor: colors.hairline,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: "absolute",
    right: 0,
  },
  header: {
    left: 0,
    minHeight: GLASS_HEADER_HEIGHT,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 10,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: GLASS_HEADER_HEIGHT,
    paddingHorizontal: spacing.xs,
  },
});

export default GlassHeader;
